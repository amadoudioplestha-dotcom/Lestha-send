/* Lestha Send — Replay léger d'un cours (3.16)
   Pendant l'enregistrement, on ne filme pas l'écran : on note ce qui se passe.
     - la voix (MP3 mono 24 kbit/s, encodé par mp3-worker.js),
     - chaque page présentée (une seule image par page, même si on y revient),
     - les annotations (traits, formes, textes, tampons, pointeur laser) avec leur moment,
     - qui parle, les messages de la discussion,
     - pour un partage d'écran : une image seulement quand l'écran change vraiment.
   À la fin, tout tient dans UN fichier .html qui se lit hors ligne, sur téléphone comme sur ordinateur,
   et s'envoie par WhatsApp ou Lestha Send. Environ 12 à 15 Mo par heure de cours. */
import * as T from './meet-teach.js';
import * as D from './meet-doc.js';

const TICK = 200;                       // relevé de l'état, en ms
const PAGE_W = 1280;                    // largeur des pages gardées dans le replay
const SCREEN_EVERY = 3000;              // partage d'écran : on regarde s'il a changé toutes les 3 s
const SCREEN_BUDGET = 45e6;             // au-delà, une image d'écran toutes les 30 s seulement

let X = null, P = null;

const r4 = (v) => Math.round(v * 1e4) / 1e4;
function cleanStroke(s) {
  const o = { id: s.id, tool: s.tool, c: s.c, w: s.w, pts: (s.pts || []).map(r4) };
  if (s.t != null) o.t = String(s.t).slice(0, 2000);
  return o;
}

/** Début de l'enregistrement « replay ». ctx : { S, title, host } */
export function replayBegin(ctx) {
  X = ctx;
  P = {
    t0: Date.now(), ev: [], imgs: {}, bytes: 0, view: '', strokes: new Map(), spk: '', chat: new WeakSet(),
    pending: null, shot: { at: 0, sig: null, n: 0 }, laser: '', timer: 0
  };
  (X.S.messages || []).forEach(m => P.chat.add(m));          // messages d'avant l'enregistrement : ignorés
  sample();
  P.timer = setInterval(sample, TICK);
}
export const replayOn = () => !!P;

const now = () => Date.now() - P.t0;
const push = (...e) => P.ev.push([now(), ...e]);

function keep(key, cv, q) {
  if (P.imgs[key]) return;
  const url = cv.toDataURL('image/jpeg', q);
  P.imgs[key] = url; P.bytes += url.length;
}
function toCanvas(src, sw, sh, maxW) {
  const k = Math.min(1, maxW / sw), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * k)); cv.height = Math.max(1, Math.round(sh * k));
  const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}
/** Petite empreinte de l'image (24 × 14 niveaux de gris) pour savoir si l'écran partagé a changé */
function signature(v) {
  const cv = document.createElement('canvas'); cv.width = 24; cv.height = 14;
  const c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(v, 0, 0, 24, 14);
  const d = c.getImageData(0, 0, 24, 14).data, out = new Uint8Array(24 * 14);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
  return out;
}
const diff = (a, b) => { if (!a || !b) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

function sample() {
  if (!P) return;
  const S = X.S;
  try {
    /* 1. Ce qui est à l'écran */
    const st = document.getElementById('mtStage'), sv = document.getElementById('mtStageV');
    const visible = !!st && !st.classList.contains('hidden'), board = visible && T.boardOn();
    let v = { k: 'none' };
    if (board && D.docOn()) {
      const d = D.doc(), key = 'p' + d.id + '_' + d.page;
      v = { k: 'doc', img: key, asp: D.docAspect(), name: d.name, page: d.page + 1, n: d.n };
      if (!P.imgs[key]) {
        const im = D.docImage();
        if (im && im.dataset.key === d.id + '/' + d.page) { try { keep(key, toCanvas(im, im.naturalWidth, im.naturalHeight, PAGE_W), 0.72); } catch (e) { /* ignore */ } }
      }
    } else if (board) v = { k: 'board', asp: [16, 9] };
    else if (visible && sv && sv.videoWidth) {
      const t = Date.now(), every = P.bytes > SCREEN_BUDGET ? 30000 : SCREEN_EVERY;
      if (!P.shot.img || t - P.shot.at >= every) {
        P.shot.at = t;
        const sig = signature(sv), dd = diff(sig, P.shot.sig);
        if (dd > 4 || !P.shot.img) {
          const key = 's' + (++P.shot.n);
          keep(key, toCanvas(sv, sv.videoWidth, sv.videoHeight, PAGE_W), 0.6);
          P.shot.img = key; P.shot.sig = sig;
        }
      }
      v = { k: 'screen', img: P.shot.img, asp: [sv.videoWidth, sv.videoHeight] };
    }
    if (v.k !== 'screen') P.shot.img = null, P.shot.sig = null;
    const vs = JSON.stringify(v);
    const changed = vs !== P.view;
    if (changed) { P.view = vs; push('view', v); }

    /* 2. Annotations : à chaque changement de page on repart de la liste complète, sinon ajouts / retraits */
    const ink = T.inkState(), ids = new Set();
    if (changed && (P.strokes.size || ink.strokes.length)) {
      P.strokes = new Map(ink.strokes.map(s => [s.id, s]));
      push('set', ink.strokes.map(cleanStroke));
    } else {
      ink.strokes.forEach(s => {
        ids.add(s.id);
        if (P.strokes.get(s.id) !== s) { P.strokes.set(s.id, s); push('add', cleanStroke(s)); }
      });
      const gone = [...P.strokes.keys()].filter(id => !ids.has(id));
      if (gone.length) { gone.forEach(id => P.strokes.delete(id)); push('del', gone); }
    }
    // Pointeur laser (de l'enseignant ou d'un élève autorisé)
    let las = '';
    ink.lasers.forEach(l => { if (!l.off && performance.now() - l.at < 600) las = r4(l.x) + ',' + r4(l.y) + ',' + l.c; });
    if (las !== P.laser) { P.laser = las; push('las', las ? las.split(',').map((x, i) => i < 2 ? +x : x) : 0); }

    /* 3. Qui parle */
    const names = [...document.querySelectorAll('#mtGrid .mt-tile.speaking .mt-nm')].map(e => e.textContent.replace(/ \(vous\)$/, '').trim().slice(0, 40)).filter(Boolean).slice(0, 3).join(' · ');
    if (names !== P.spk) { P.spk = names; push('spk', names); }

    /* 4. Discussion */
    (S.messages || []).forEach(m => { if (!P.chat.has(m)) { P.chat.add(m); push('chat', String(m.name || '').slice(0, 60), String(m.text || '').slice(0, 1000)); } });
  } catch (e) { /* un relevé manqué n'arrête pas l'enregistrement */ }
}

/** Fin : attend le MP3, assemble le fichier .html autonome */
export async function replayEnd(audio, meta) {
  if (!P) return null;
  clearInterval(P.timer);
  sample();
  const rec = P; P = null;
  const dur = Date.now() - rec.t0;
  const b64 = await new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ko; fr.readAsDataURL(audio); });
  const data = {
    v: 1, app: 'Lestha Send', title: meta.title || 'Cours', host: meta.host || '', date: new Date(rec.t0).toISOString(),
    dur, audio: b64, imgs: rec.imgs, ev: rec.ev
  };
  const [ink, player] = await Promise.all(['/js/ink-draw.js', '/js/replay-player.js'].map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.text(); })));
  return new Blob([page(data, ink.replace(/^export /gm, ''), player)], { type: 'text/html' });
}
/** Annule sans rien produire (réunion quittée brutalement) */
export function replayCancel() { if (P) clearInterval(P.timer); P = null; }

const escHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* Le JSON est posé dans une balise <script type="application/json"> : on neutralise « </ » et les séparateurs de ligne */
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
const safeJs = (s) => s.replace(/<\/script/gi, '<\\/script');

function page(data, ink, player) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b1020">
<meta name="generator" content="Lestha Send">
<title>${escHtml(data.title)} · Replay</title>
</head><body>
<div id="lsReplay"><noscript>Ouvrez ce fichier dans un navigateur (Chrome, Safari, Firefox) pour revoir le cours.</noscript></div>
<script type="application/json" id="lsReplayData">${safeJson(data)}</script>
<script>${safeJs(ink)}</script>
<script>${safeJs(player)}</script>
</body></html>`;
}
