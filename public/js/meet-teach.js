/* Lestha Send — Outils de l'enseignant pendant une réunion ou un cours (3.14)

   1. Fenêtre flottante : quand on présente et qu'on passe sur PowerPoint ou un autre onglet,
      une petite fenêtre reste au-dessus de tout (Chrome, Edge) avec les mains levées, les réactions,
      la discussion, « compris / perdu », le minuteur et les commandes utiles.
      Ailleurs : notifications du système, titre de l'onglet qui clignote et petit son.
   2. Annotations sur la présentation ou le tableau blanc : stylo, surligneur, encre éphémère,
      formes, flèches, texte, notes, tampons, pointeur laser, gomme, annuler, tout effacer.
      Coordonnées de 0 à 1 dans l'image : le trait tombe au même endroit chez tout le monde.
   3. Minuteur commun, « J'ai compris / Je suis perdu », qui suit le cours (page ouverte ou non). */
import { $, esc, ls, toast, modal } from './core.js';

let X = null;                                      // accès à la réunion (fourni par meet.js)
export function teachInit(ctx) { X = ctx; }
const S = () => X.S;
const can = () => { const s = S(); return !!(s.self && (X.isStaff() || s.sharing || (s.meeting && s.meeting.inkAll))); };
const mayAll = () => { const s = S(); return !!(s.self && (X.isStaff() || s.sharing)); };
const rid = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

/* Petites icônes (trait = couleur du texte) */
const P = {
  laser: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  hl: '<path d="m9 15-3 5h6l1.5-2.5"/><path d="m9 15 7.5-11 4 2.5L13 17.5z"/>',
  fade: '<path d="M13 3 6 13h5l-2 8 9-12h-5z"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  note: '<path d="M5 4h14v10l-6 6H5z"/><path d="M13 20v-6h6"/>',
  stamp: '<path d="M9 4h6l-1 7h4a2 2 0 0 1 2 2v2H4v-2a2 2 0 0 1 2-2h4z"/><path d="M5 19h14"/>',
  eraser: '<path d="m7 20-4-4 10-10 7 7-7 7z"/><path d="M7 20h13M9 10l7 7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"/>',
  board: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20l4-4 4 4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micoff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.5 2.5M12 18v3M3 3l18 18"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 16.5a1.5 1.5 0 0 1 2.3-1.9L8 17"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  back: '<path d="M10 6 4 12l6 6M4 12h16"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>'
};
export const svg = (k, cls = '') => `<svg class="ti ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[k] || ''}</svg>`;

/* ======================================================================
   SONS ET ALERTES
   ====================================================================== */
const sound = () => ls.get('tx_teach_sound', true) !== false;
function chime(kind) {
  if (!sound()) return;
  const a = X.audioCtx(); if (!a) return;
  try {
    const notes = kind === 'timer' ? [880, 660, 880, 660] : kind === 'hand' ? [660, 990] : kind === 'lost' ? [520, 390] : [740];
    notes.forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain(), t = a.currentTime + i * 0.13;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.25);
    });
  } catch (e) { /* ignore */ }
}
/* Titre de l'onglet qui clignote quand la page est cachée : « (2) ✋ Awa lève la main » */
const T = { base: '', n: 0, msg: '', timer: null };
function flashTitle(msg) {
  if (!document.hidden) return;
  if (!T.timer) T.base = document.title;
  T.n++; T.msg = msg;
  clearInterval(T.timer); let on = true;
  T.timer = setInterval(() => { document.title = on ? `(${T.n}) ${T.msg}` : T.base; on = !on; }, 1200);
  document.title = `(${T.n}) ${T.msg}`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && T.timer) { clearInterval(T.timer); T.timer = null; T.n = 0; document.title = T.base || document.title; }
  awayReport();
});
/** Quelqu'un lève la main, écrit, est perdu : on prévient l'animateur même s'il est sur PowerPoint */
export function alert(kind, title, body) {
  if (!X || !S().self) return;
  const hidden = document.hidden, fl = !!F.win;
  if (!hidden && !fl) return;                      // la page est sous les yeux : les toasts suffisent
  if (kind === 'hand' || kind === 'lost' || kind === 'timer' || (kind === 'chat' && X.isStaff())) chime(kind);
  if (fl) { floatFlash(kind); return; }
  flashTitle(title);
  try {
    if (window.Notification && Notification.permission === 'granted') {
      const n = new Notification(title, { body: body || '', tag: 'meet-' + kind, renotify: true, icon: '/icon-192.png' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (e) { /* ignore */ }
}
export function askNotify() {
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch (e) { /* ignore */ }
}

/* ======================================================================
   QUI SUIT LE COURS : la page est-elle sous les yeux du participant ?
   ====================================================================== */
let awayT = null;
function awayReport() {
  if (!X) return;
  const s = S(); if (!s.self || s.ended || !s.socket) return;
  clearTimeout(awayT);
  const away = document.hidden && !F.win;
  // On attend 8 s avant de signaler « ailleurs » : un coup d'œil à WhatsApp ne compte pas
  awayT = setTimeout(() => { const now = document.hidden && !F.win; if (!!s.self.away !== now) X.sendState({ away: now }); }, away ? 8000 : 0);
}

/* ======================================================================
   ANNOTATIONS
   ====================================================================== */
const COLORS = ['#ef4444', '#f59e0b', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899', '#ffffff', '#111827'];
const SIZES = [[2, 'Fin'], [4, 'Moyen'], [8, 'Épais']];
const STAMPS = ['✅', '❌', '⭐', '❓', '❗', '👍', '💡', '➡️', '①', '②', '③', '🎯'];
const SHAPES = [['line', 'Ligne'], ['arrow', 'Flèche'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse']];
const TOOLS = [['laser', 'Pointeur laser'], ['pen', 'Stylo'], ['hl', 'Surligneur'], ['fade', 'Encre éphémère'], ['shape', 'Lignes et formes'], ['text', 'Zone de texte'], ['note', 'Note'], ['stamp', 'Tampons'], ['eraser', 'Gomme']];
const I = {
  strokes: [], live: new Map(), lasers: new Map(), mine: [],
  tool: null, open: false, color: ls.get('tx_ink_c', '#ef4444'), size: +ls.get('tx_ink_w', 4) || 4,
  shape: ls.get('tx_ink_shape', 'arrow'), stamp: ls.get('tx_ink_stamp', '✅'), pop: null,
  cur: null, sent: 0, lastSend: 0, raf: 0, laserAt: 0
};
const FADE_MS = 3000, LASER_MS = 1400;

/** Rectangle de l'image présentée dans la scène (object-fit: contain), en pixels CSS */
function contentRect() {
  const st = $('#mtStage'); if (!st) return null;
  const W = st.clientWidth, H = st.clientHeight; if (!W || !H) return null;
  const v = $('#mtStageV');
  let vw = 16, vh = 9;
  if (!boardOn() && v && v.videoWidth) { vw = v.videoWidth; vh = v.videoHeight; }
  const k = Math.min(W / vw, H / vh), w = vw * k, h = vh * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
export const boardOn = () => { const s = S(); return !!(s.meeting && s.meeting.board && !s.sharing && ![...s.people.values()].some(p => p.screen && p.streams && p.streams.s)); };

/** Dessine tous les traits dans un rectangle donné (scène, ou image de l'enregistrement) */
export function inkPaint(c, r, now = performance.now()) {
  const all = I.strokes.concat([...I.live.values()]);
  if (I.cur) all.push(I.cur);
  for (const s of all) drawStroke(c, s, r, now);
  I.lasers.forEach((l) => drawLaser(c, l, r, now));
}
function px(r, s, k = 1) { return Math.max(1.2, s.w * r.w / 1000 * k); }
function drawStroke(c, s, r, now) {
  const p = s.pts; if (!p || p.length < 2) return;
  const X0 = (i) => r.x + p[i] * r.w, Y0 = (i) => r.y + p[i + 1] * r.h;
  c.save();
  let alpha = 1;
  if (s.tool === 'fade') { alpha = s.done ? 1 - Math.min(1, (now - s.done) / FADE_MS) : 1; if (alpha <= 0) { c.restore(); return; } }
  c.globalAlpha = alpha; c.strokeStyle = s.c; c.fillStyle = s.c; c.lineCap = 'round'; c.lineJoin = 'round';
  if (s.tool === 'pen' || s.tool === 'fade' || s.tool === 'hl') {
    c.lineWidth = px(r, s, s.tool === 'hl' ? 4 : 1);
    if (s.tool === 'hl') { c.globalAlpha = 0.38; c.lineCap = 'butt'; }
    if (s.tool === 'fade') { c.shadowColor = s.c; c.shadowBlur = 8; }
    c.beginPath(); c.moveTo(X0(0), Y0(0));
    if (p.length === 2) c.lineTo(X0(0) + 0.1, Y0(0) + 0.1);
    for (let i = 2; i < p.length - 2; i += 2) { const mx = (X0(i) + X0(i + 2)) / 2, my = (Y0(i) + Y0(i + 2)) / 2; c.quadraticCurveTo(X0(i), Y0(i), mx, my); }
    if (p.length > 2) c.lineTo(X0(p.length - 2), Y0(p.length - 2));
    c.stroke();
  } else if (['line', 'arrow', 'rect', 'ellipse'].includes(s.tool)) {
    const n = p.length - 2, x1 = X0(0), y1 = Y0(0), x2 = X0(n), y2 = Y0(n);
    c.lineWidth = px(r, s);
    c.beginPath();
    if (s.tool === 'rect') c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    else if (s.tool === 'ellipse') c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2 + 0.1, Math.abs(y2 - y1) / 2 + 0.1, 0, 0, 6.2832);
    else { c.moveTo(x1, y1); c.lineTo(x2, y2); }
    c.stroke();
    if (s.tool === 'arrow' && Math.hypot(x2 - x1, y2 - y1) > 4) {
      const a = Math.atan2(y2 - y1, x2 - x1), L = Math.max(10, c.lineWidth * 4);
      c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)); c.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)); c.closePath(); c.fill();
    }
  } else if (s.tool === 'text') {
    const fs = Math.max(11, px(r, s, 6));
    c.font = `700 ${fs}px Inter, system-ui, sans-serif`; c.textBaseline = 'top';
    c.lineWidth = Math.max(2, fs / 7); c.strokeStyle = isLight(s.c) ? 'rgba(0,0,0,.65)' : 'rgba(255,255,255,.85)';
    lines(c, s.t, r.w * 0.6).forEach((ln, i) => { c.strokeText(ln, X0(0), Y0(0) + i * fs * 1.2); c.fillText(ln, X0(0), Y0(0) + i * fs * 1.2); });
  } else if (s.tool === 'note') {
    const fs = Math.max(10, px(r, s, 4)), wmax = Math.max(90, r.w * 0.2), pad = fs * 0.7;
    c.font = `600 ${fs}px Inter, system-ui, sans-serif`; c.textBaseline = 'top';
    const ls2 = lines(c, s.t, wmax - pad * 2), h = ls2.length * fs * 1.25 + pad * 2;
    c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 10; c.shadowOffsetY = 3;
    c.fillStyle = pastel(s.c); c.fillRect(X0(0), Y0(0), wmax, h);
    c.shadowColor = 'transparent';
    c.fillStyle = '#111827'; ls2.forEach((ln, i) => c.fillText(ln, X0(0) + pad, Y0(0) + pad + i * fs * 1.25));
  } else if (s.tool === 'stamp') {
    const fs = Math.max(16, px(r, s, 10));
    c.font = `${fs}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(s.t, X0(0), Y0(0));
  }
  c.restore();
}
/* Note : couleur choisie adoucie, le texte reste lisible en noir */
const pastel = (hex) => { if (hex === '#111827' || hex === '#ffffff') return '#fde68a'; const n = parseInt(hex.slice(1), 16), m = (v) => Math.round(v + (255 - v) * 0.55); return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`; };
const isLight = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150; };
function lines(c, t, max) {
  const out = [];
  String(t || '').split('\n').forEach(par => {
    let cur = '';
    par.split(/\s+/).forEach(w => { const test = cur ? cur + ' ' + w : w; if (c.measureText(test).width > max && cur) { out.push(cur); cur = w; } else cur = test; });
    out.push(cur);
  });
  return out.slice(0, 12);
}
function drawLaser(c, l, r, now) {
  const age = now - l.at; if (age > LASER_MS || l.off) return;
  const x = r.x + l.x * r.w, y = r.y + l.y * r.h;
  c.save();
  l.trail = (l.trail || []).filter(t => now - t.at < 260);
  l.trail.forEach((t, i) => { c.globalAlpha = (i + 1) / (l.trail.length + 1) * 0.35; c.fillStyle = l.c; c.beginPath(); c.arc(r.x + t.x * r.w, r.y + t.y * r.h, 5, 0, 6.2832); c.fill(); });
  c.globalAlpha = Math.max(0, 1 - Math.max(0, age - LASER_MS + 400) / 400);
  const g = c.createRadialGradient(x, y, 0, x, y, 18); g.addColorStop(0, l.c); g.addColorStop(0.35, l.c + 'aa'); g.addColorStop(1, l.c + '00');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, 18, 0, 6.2832); c.fill();
  c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 3, 0, 6.2832); c.fill();
  c.restore();
}

/** Redessine le calque (et continue tant qu'une encre éphémère ou un laser est visible) */
function redraw() {
  cancelAnimationFrame(I.raf); I.raf = 0;
  const cv = $('#mtInk'), st = $('#mtStage'); if (!cv || !st) return;
  const W = st.clientWidth, H = st.clientHeight, d = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
  const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, W, H);
  const r = contentRect(); if (!r) return;
  const bd = $('#mtBoard'); if (bd) Object.assign(bd.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  const now = performance.now();
  I.strokes = I.strokes.filter(s => !(s.tool === 'fade' && s.done && now - s.done > FADE_MS));
  inkPaint(c, r, now);
  const busy = I.strokes.some(s => s.tool === 'fade') || [...I.lasers.values()].some(l => !l.off && now - l.at < LASER_MS);
  if (busy) I.raf = requestAnimationFrame(redraw);
}
const later = () => { if (!I.raf) I.raf = requestAnimationFrame(redraw); };

/** Messages reçus du serveur */
export function onInk(d) {
  if (!d) return;
  const now = performance.now();
  if (d.op === 'add') { I.live.delete(d.s.id); I.strokes = I.strokes.filter(x => x.id !== d.s.id); I.strokes.push(Object.assign(d.s, d.s.tool === 'fade' ? { done: now } : {})); }
  else if (d.op === 'live') {
    let s = I.live.get(d.s.id);
    if (!s) { s = Object.assign({}, d.s, { pts: [] }); I.live.set(s.id, s); }
    if (['line', 'arrow', 'rect', 'ellipse'].includes(s.tool)) s.pts = d.pts;
    else { s.pts.length = Math.min(s.pts.length, d.at); s.pts.push(...d.pts); }
    s.seen = now;
  }
  else if (d.op === 'del') { I.strokes = I.strokes.filter(x => !d.ids.includes(x.id)); }
  else if (d.op === 'clear') { I.strokes = []; I.live.clear(); I.mine = []; }
  else if (d.op === 'laser') { const l = I.lasers.get(d.pid) || { trail: [] }; if (l.x != null) l.trail.push({ x: l.x, y: l.y, at: now }); Object.assign(l, { x: d.x, y: d.y, c: d.c, at: now, off: d.off }); I.lasers.set(d.pid, l); }
  // Trait en cours abandonné (connexion coupée) : on l'oublie au bout de 10 s
  I.live.forEach((s, id) => { if (now - s.seen > 10e3) I.live.delete(id); });
  later();
}
export function inkLoad(list) { I.strokes = Array.isArray(list) ? list.slice() : []; I.live.clear(); I.lasers.clear(); I.mine = []; later(); }
export function inkForget(pid) { I.lasers.delete(pid); }

const send = (d) => { const s = S(); if (s.socket) s.socket.emit('meet-ink', d); };

/** Mise en place dans la scène : calque, fond du tableau blanc, bouton « Annoter », barre d'outils */
export function inkMount() {
  const st = $('#mtStage'); if (!st || $('#mtInk')) return;
  st.insertAdjacentHTML('afterbegin', '<div class="mt-board hidden" id="mtBoard"></div>');
  const v = $('#mtStageV'); v.insertAdjacentHTML('afterend', '<canvas class="mt-ink" id="mtInk" aria-label="Annotations"></canvas>');
  st.insertAdjacentHTML('beforeend', `<button type="button" class="meet-ann hidden" id="mtInkBtn" aria-label="Annoter" title="Annoter la présentation">${svg('pen')}<span>Annoter</span></button><div class="ink-bar hidden" id="mtInkBar" role="toolbar" aria-label="Outils d'annotation"></div>`);
  $('#mtInkBtn').onclick = () => inkOpen(!I.open);
  const cv = $('#mtInk');
  cv.addEventListener('pointerdown', down);
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { if (I.tool === 'laser') send({ op: 'laser', x: 0, y: 0, off: true }); });
  if (window.ResizeObserver) new ResizeObserver(() => later()).observe(st);
  v.addEventListener('resize', later); v.addEventListener('loadedmetadata', later);
  document.addEventListener('keydown', (e) => {
    if (!I.open || !$('#mtInkBar') || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { if (I.pop) closePop(); else inkOpen(false); }
  });
  inkRefresh();
}
/** État de la scène : bouton visible si l'on a le droit d'annoter, tableau blanc, taille */
export function inkRefresh() {
  const st = $('#mtStage'); if (!st) return;
  const shown = !st.classList.contains('hidden');
  const ok = shown && can();
  $('#mtInkBtn').classList.toggle('hidden', !ok || I.open);
  if (!ok && I.open) inkOpen(false);
  $('#mtBoard').classList.toggle('hidden', !boardOn());
  st.classList.toggle('board', boardOn());
  later();
}
export function inkOpen(on) {
  if (on && !can()) return;
  I.open = !!on;
  if (!on) { setTool(null); closePop(); }
  else if (!I.tool) setTool(ls.get('tx_ink_tool', 'pen'));
  drawInkBar();
  inkRefresh();
}
export const inkIsOpen = () => I.open;
function setTool(t) {
  I.tool = t;
  if (t) ls.set('tx_ink_tool', t);
  const st = $('#mtStage'); if (st) { st.classList.toggle('inking', !!t); st.dataset.tool = t || ''; }
  drawInkBar();
}
function drawInkBar() {
  const el = $('#mtInkBar'); if (!el) return;
  el.classList.toggle('hidden', !I.open);
  if (!I.open) { el.innerHTML = ''; return; }
  const staff = X.isStaff(), s = S();
  const b = (k, label, ico, cls = '') => `<button type="button" class="ib ${cls} ${I.tool === k || (k === 'shape' && SHAPES.some(x => x[0] === I.tool)) ? 'on' : ''}" data-k="${k}" aria-label="${esc(label)}" title="${esc(label)}">${ico}</button>`;
  el.innerHTML = `
    ${TOOLS.map(([k, l]) => b(k, l, k === 'shape' ? svg(SHAPES.some(x => x[0] === I.tool) ? I.tool : I.shape) : k === 'stamp' ? `<span class="ib-emo">${I.stamp}</span>` : svg(k))).join('')}
    <i class="ib-sep"></i>
    <button type="button" class="ib" data-k="color" aria-label="Couleur" title="Couleur et épaisseur"><span class="ib-dot" style="background:${I.color}"></span></button>
    ${b('undo', 'Annuler (Ctrl+Z)', svg('undo'))}
    ${mayAll() ? b('clear', 'Tout effacer', svg('trash')) : ''}
    ${staff ? b('all', s.meeting.inkAll ? 'Les participants peuvent annoter : retirer' : 'Autoriser les participants à annoter', svg('users'), s.meeting.inkAll ? 'on' : '') : ''}
    <i class="ib-sep"></i>
    ${b('close', 'Arrêter l\'annotation', svg('x'))}`;
  el.onclick = (e) => {
    const t = e.target.closest('[data-k]'); if (!t) return;
    const k = t.dataset.k;
    if (k === 'close') return inkOpen(false);
    if (k === 'undo') return undo();
    if (k === 'clear') { I.strokes = []; I.live.clear(); I.mine = []; send({ op: 'clear' }); later(); return; }
    if (k === 'all') { s.socket.emit('meet-host', { action: 'inkAll', value: !s.meeting.inkAll }); toast(s.meeting.inkAll ? 'Seuls vous et le présentateur pouvez annoter' : 'Les participants peuvent maintenant annoter', 'info', { duration: 2500 }); return; }
    if (k === 'color') return openPop(t, 'color');
    if (k === 'shape') return openPop(t, 'shape');
    if (k === 'stamp') return openPop(t, 'stamp');
    closePop(); setTool(k);
  };
}
function closePop() { if (I.pop) { I.pop.remove(); I.pop = null; } }
function openPop(anchor, kind) {
  closePop();
  const el = document.createElement('div'); el.className = 'ink-pop'; I.pop = el;
  if (kind === 'color') {
    el.innerHTML = `<div class="ink-colors">${COLORS.map(c => `<button type="button" data-c="${c}" class="${c === I.color ? 'on' : ''}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join('')}</div>
      <div class="ink-sizes">${SIZES.map(([w, l]) => `<button type="button" data-w="${w}" class="${w === I.size ? 'on' : ''}"><i style="width:${w * 2 + 2}px;height:${w * 2 + 2}px;background:${I.color}"></i>${l}</button>`).join('')}</div>`;
  } else if (kind === 'shape') {
    el.innerHTML = `<div class="ink-list">${SHAPES.map(([k, l]) => `<button type="button" data-s="${k}" class="${I.tool === k ? 'on' : ''}">${svg(k)}${l}</button>`).join('')}</div>`;
  } else {
    el.innerHTML = `<div class="ink-stamps">${STAMPS.map(x => `<button type="button" data-st="${x}" class="${x === I.stamp ? 'on' : ''}">${x}</button>`).join('')}</div>`;
  }
  $('#mtInkBar').appendChild(el);
  el.style.left = Math.max(0, anchor.offsetLeft + anchor.offsetWidth / 2 - el.offsetWidth / 2) + 'px';
  el.onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.c) { I.color = t.dataset.c; ls.set('tx_ink_c', I.color); if (!I.tool || ['eraser', 'laser'].includes(I.tool)) setTool('pen'); }
    if (t.dataset.w) { I.size = +t.dataset.w; ls.set('tx_ink_w', I.size); }
    if (t.dataset.s) { I.shape = t.dataset.s; ls.set('tx_ink_shape', I.shape); setTool(I.shape); }
    if (t.dataset.st) { I.stamp = t.dataset.st; ls.set('tx_ink_stamp', I.stamp); setTool('stamp'); }
    closePop(); drawInkBar();
  };
}

/* Dessin à la souris, au doigt ou au stylet */
function point(e) {
  const cv = $('#mtInk'), r = contentRect(); if (!cv || !r) return null;
  const b = cv.getBoundingClientRect();
  return [Math.round(((e.clientX - b.left - r.x) / r.w) * 1e4) / 1e4, Math.round(((e.clientY - b.top - r.y) / r.h) * 1e4) / 1e4];
}
const inside = (p) => p && p[0] >= -0.02 && p[0] <= 1.02 && p[1] >= -0.02 && p[1] <= 1.02;
function down(e) {
  if (!I.tool || !can()) return;
  const p = point(e); if (!inside(p)) return;
  e.preventDefault();
  closePop();
  const cv = $('#mtInk'); try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
  if (I.tool === 'laser') { I.lasering = true; return laser(p); }
  if (I.tool === 'eraser') { I.erasing = true; return erase(p); }
  if (I.tool === 'text' || I.tool === 'note') return typeAt(p, I.tool);
  if (I.tool === 'stamp') return commit({ id: rid(), tool: 'stamp', c: I.color, w: I.size, pts: p, t: I.stamp });
  const w = I.tool === 'hl' ? Math.max(4, I.size) : I.size;
  I.cur = { id: rid(), tool: I.tool, c: I.tool === 'hl' && I.color === '#111827' ? '#facc15' : I.color, w, pts: p.concat(p), by: S().self.pid };
  if (!['line', 'arrow', 'rect', 'ellipse'].includes(I.tool)) I.cur.pts = p;
  I.sent = 0; I.lastSend = 0; later();
}
function move(e) {
  const p = point(e); if (!p) return;
  if (I.tool === 'laser' && (I.lasering || e.pointerType === 'mouse')) return laser(p);
  if (I.tool === 'eraser' && I.erasing) return erase(p);
  if (!I.cur) return;
  e.preventDefault();
  const pts = I.cur.pts;
  if (['line', 'arrow', 'rect', 'ellipse'].includes(I.cur.tool)) { pts[2] = p[0]; pts[3] = p[1]; }
  else {
    const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
    if (Math.hypot(p[0] - lx, p[1] - ly) < 0.0025) return;
    if (pts.length >= 3990) return up(e);              // trait très long : on le termine et on en commence un autre
    pts.push(p[0], p[1]);
  }
  redraw();
  const now = performance.now();
  if (now - I.lastSend > 60) {                         // aperçu en direct pour les autres, 16 fois par seconde
    I.lastSend = now;
    const shape = ['line', 'arrow', 'rect', 'ellipse'].includes(I.cur.tool);
    const at = shape ? 0 : I.sent, chunk = shape ? pts : pts.slice(at);
    if (chunk.length >= 2) { send({ op: 'live', s: { id: I.cur.id, tool: I.cur.tool, c: I.cur.c, w: I.cur.w }, pts: chunk, at }); I.sent = pts.length; }
  }
}
function up() {
  I.erasing = false;
  if (I.lasering) { I.lasering = false; }
  if (!I.cur) return;
  const s = I.cur; I.cur = null;
  commit(s);
}
function commit(s) {
  s.by = S().self.pid;
  if (s.tool === 'fade') s.done = performance.now();
  I.strokes.push(s); if (s.tool !== 'fade') I.mine.push(s.id);
  const { done, ...out } = s; send({ op: 'add', s: out });
  later();
}
function laser(p) {
  const now = performance.now(), me = S().self.pid;
  const l = I.lasers.get(me) || { trail: [] }; if (l.x != null) l.trail.push({ x: l.x, y: l.y, at: now });
  Object.assign(l, { x: p[0], y: p[1], c: I.color === '#111827' || I.color === '#ffffff' ? '#ef4444' : I.color, at: now, off: false }); I.lasers.set(me, l);
  later();
  if (now - I.laserAt > 40) { I.laserAt = now; send({ op: 'laser', x: p[0], y: p[1], c: l.c }); }
}
/** Gomme : efface le trait touché (les siens seulement, sauf animateur ou présentateur) */
function erase(p) {
  const r = contentRect(); if (!r) return;
  const x = p[0] * r.w, y = p[1] * r.h, tol = 12, me = S().self.pid, all = mayAll();
  for (let i = I.strokes.length - 1; i >= 0; i--) {
    const s = I.strokes[i];
    if (!all && s.by !== me) continue;
    if (hit(s, x, y, r, tol)) { I.strokes.splice(i, 1); send({ op: 'del', ids: [s.id] }); later(); return; }
  }
}
function hit(s, x, y, r, tol) {
  const P2 = (i) => [s.pts[i] * r.w, s.pts[i + 1] * r.h];
  if (['text', 'note', 'stamp'].includes(s.tool)) { const [a, b] = P2(0); const w = s.tool === 'stamp' ? 30 : Math.max(90, r.w * 0.2), h = s.tool === 'stamp' ? 30 : 60; return s.tool === 'stamp' ? Math.abs(x - a) < w && Math.abs(y - b) < h : x >= a - tol && x <= a + w && y >= b - tol && y <= b + h; }
  const segs = [];
  if (['rect', 'ellipse'].includes(s.tool)) {
    const [a, b] = P2(0), [c, d] = P2(s.pts.length - 2);
    return x >= Math.min(a, c) - tol && x <= Math.max(a, c) + tol && y >= Math.min(b, d) - tol && y <= Math.max(b, d) + tol;
  }
  for (let i = 0; i < s.pts.length - 2; i += 2) segs.push([P2(i), P2(i + 2)]);
  if (!segs.length) segs.push([P2(0), P2(0)]);
  const t2 = tol + px(r, s, s.tool === 'hl' ? 2 : 0.5);
  return segs.some(([[a, b], [c, d]]) => { const dx = c - a, dy = d - b, L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((x - a) * dx + (y - b) * dy) / L)) : 0; return Math.hypot(x - (a + t * dx), y - (b + t * dy)) < t2; });
}
function undo() {
  while (I.mine.length) {
    const id = I.mine.pop();
    if (I.strokes.some(s => s.id === id)) { I.strokes = I.strokes.filter(s => s.id !== id); send({ op: 'del', ids: [id] }); later(); return; }
  }
}
/** Zone de texte ou note : on tape directement à l'endroit choisi */
function typeAt(p, tool) {
  const st = $('#mtStage'), r = contentRect(); if (!st || !r) return;
  const old = st.querySelector('.ink-type'); if (old) old.remove();
  const ta = document.createElement('textarea');
  ta.className = 'ink-type' + (tool === 'note' ? ' note' : ''); ta.rows = tool === 'note' ? 3 : 1; ta.maxLength = 300;
  ta.placeholder = tool === 'note' ? 'Note…' : 'Texte…';
  Object.assign(ta.style, { left: (r.x + p[0] * r.w) + 'px', top: (r.y + p[1] * r.h) + 'px', color: tool === 'note' ? '#111827' : I.color, background: tool === 'note' ? pastel(I.color) : '' });
  st.appendChild(ta); ta.focus(); setTimeout(() => ta.focus(), 0);
  let done = false; const t0 = Date.now();
  const fin = (ok) => { if (done) return; done = true; const t = ta.value.trim(); ta.remove(); if (ok && t) commit({ id: rid(), tool, c: I.color, w: I.size, pts: p, t }); };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fin(true); } else if (e.key === 'Escape') { e.preventDefault(); fin(false); } e.stopPropagation(); });
  // Le clic qui a créé la zone peut lui retirer le focus juste après : on le lui rend
  ta.addEventListener('blur', () => { if (Date.now() - t0 < 400) { setTimeout(() => ta.focus(), 0); return; } fin(true); });
}

/* ======================================================================
   MINUTEUR COMMUN
   ====================================================================== */
const TM = { end: 0, sec: 0, label: '', rang: false };
export function onInfo(m) {
  if (!m || !('timer' in m)) return;
  const t = m.timer;
  if (t) { const end = Date.now() + t.left; if (Math.abs(end - TM.end) > 1500 || t.sec !== TM.sec) Object.assign(TM, { end, sec: t.sec, label: t.label || '', rang: false }); }
  else if (TM.end > Date.now() + 1000) Object.assign(TM, { end: 0, sec: 0, label: '', rang: false });   // arrêté par l'animateur
  drawChips(); floatDraw();
}
export function tick() {
  if (F.win && Date.now() - (F.drawn || 0) > 1000) { F.drawn = Date.now(); floatDraw(true); }
  if (!TM.end) return;
  const left = TM.end - Date.now();
  if (left <= 0 && !TM.rang) {
    TM.rang = true; chime('timer');
    toast('⏰ Temps écoulé' + (TM.label ? ' : ' + TM.label : ''), 'warn', { duration: 6000 });
    alert('timer', '⏰ Temps écoulé', TM.label);
    setTimeout(() => { if (TM.rang && TM.end <= Date.now()) { TM.end = 0; drawChips(); floatDraw(); } }, 12000);
  }
  const el = $('#mtTimer');
  if (el) { el.querySelector('b').textContent = left > 0 ? X.fmtClock(left + 999) : 'Terminé'; el.classList.toggle('soon', left > 0 && left < 10500); el.classList.toggle('over', left <= 0); }
  const f = F.win && F.win.document.getElementById('fwTimer'); if (f) { f.textContent = left > 0 ? X.fmtClock(left + 999) : 'Terminé'; f.classList.toggle('soon', left > 0 && left < 10500); }
}
export async function timerDialog() {
  const s = S();
  const presets = [1, 2, 3, 5, 10, 15, 20, 30];
  const r = await modal({
    title: 'Minuteur pour toute la classe',
    body: `<p class="muted small">Le compte à rebours s'affiche chez tous les participants, avec un signal sonore à la fin.</p>
      <div class="tm-presets">${presets.map(n => `<button type="button" class="btn" data-min="${n}">${n} min</button>`).join('')}</div>
      <div class="row" style="gap:8px;margin-top:10px"><label class="field" style="flex:1"><span>Autre durée (minutes)</span><input class="input" id="tmMin" type="number" min="0.5" max="240" step="0.5" placeholder="Ex. : 7"></label>
      <label class="field" style="flex:2"><span>Intitulé (facultatif)</span><input class="input" id="tmLbl" maxlength="40" placeholder="Ex. : Exercice 2"></label></div>`,
    actions: [...(TM.end > Date.now() ? [{ label: 'Arrêter le minuteur', cls: 'ghost', value: 'stop' }] : []), { label: 'Annuler', cls: 'ghost', value: null }, { label: 'Démarrer', cls: 'primary', handler: (bd) => { const v = parseFloat(bd.querySelector('#tmMin').value); return v > 0 ? { min: v, label: bd.querySelector('#tmLbl').value } : (toast('Choisissez une durée', 'warn'), false); } }],
    onMount(el) { el.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { el.querySelector('#tmMin').value = b.dataset.min; el.querySelectorAll('[data-min]').forEach(x => x.classList.toggle('primary', x === b)); }); }
  });
  if (r === 'stop') return s.socket.emit('meet-host', { action: 'timerStop' });
  if (r && r.min) s.socket.emit('meet-host', { action: 'timer', value: { sec: Math.round(r.min * 60), label: r.label } }, (x) => { if (x && x.error) toast(x.error, 'warn'); });
}

/* ======================================================================
   COMPRIS / PERDU, QUI SUIT
   ====================================================================== */
export function pulseStats() {
  const ps = [...S().people.values()].filter(p => !p.host && !p.cohost);
  return { ok: ps.filter(p => p.pulse === 'ok'), lost: ps.filter(p => p.pulse === 'lost'), away: ps.filter(p => p.away), n: ps.length };
}
export function setPulse(v) {
  const s = S(); const next = s.self.pulse === v ? '' : v;
  s.self.pulse = next; X.sendState({ pulse: next });
  if (next) toast(next === 'ok' ? '👍 L\'enseignant voit que vous avez compris' : '🤔 L\'enseignant voit que vous avez besoin d\'une explication', 'info', { duration: 2500 });
  floatDraw();
}
/** Pastilles dans l'en-tête : minuteur (tous) et état de la classe (animateurs) */
export function drawChips() {
  const top = $('#mtTop'); if (!top) return;
  let box = $('#mtChips'); if (!box) { box = document.createElement('div'); box.id = 'mtChips'; box.className = 'mt-chips'; const inv = $('#mtInvite'); top.insertBefore(box, inv); }
  const s = S(), st = X.isStaff() ? pulseStats() : null, course = X.isCourse();
  const parts = [];
  if (TM.end) parts.push(`<button type="button" class="mt-chip timer" id="mtTimer" title="Minuteur${TM.label ? ' : ' + esc(TM.label) : ''}">${svg('timer')}<b>${X.fmtClock(Math.max(0, TM.end - Date.now()) + 999)}</b>${TM.label ? `<small>${esc(TM.label)}</small>` : ''}</button>`);
  if (st && (st.ok.length || st.lost.length)) parts.push(`<button type="button" class="mt-chip pulse ${st.lost.length ? 'lost' : ''}" id="mtPulse" title="Compris / perdu">👍 ${st.ok.length}<i class="mt-sep"></i>🤔 ${st.lost.length}</button>`);
  if (st && course && st.away.length) parts.push(`<button type="button" class="mt-chip away" id="mtAway" title="Participants qui ont quitté la page du cours">👀 ${st.n - st.away.length}/${st.n} suivent</button>`);
  box.innerHTML = parts.join('');
  const tb = $('#mtTimer'); if (tb && X.isStaff()) tb.onclick = timerDialog;
  const pb = $('#mtPulse'); if (pb) pb.onclick = pulseDialog;
  const ab = $('#mtAway'); if (ab) ab.onclick = pulseDialog;
  if (s.meeting) tick();
}
export async function pulseDialog() {
  const st = pulseStats(), row = (p, tag) => `<div class="mt-row"><span class="mt-dot" style="--h:${X.hue(p.pid)}">${esc(X.initials(p.name))}</span><span class="mt-rn">${esc(p.name)}</span>${tag}</div>`;
  const r = await modal({
    title: 'Où en est la classe ?',
    body: `<div class="stack" style="gap:12px">
      <div><b>🤔 Ont besoin d'une explication (${st.lost.length})</b>${st.lost.map(p => row(p, `<button type="button" class="btn sm" data-ask="${esc(p.pid)}">Donner la parole</button>`)).join('') || '<p class="small faint">Personne.</p>'}</div>
      <div><b>👍 Ont compris (${st.ok.length})</b>${st.ok.map(p => row(p, '')).join('') || '<p class="small faint">Personne pour l\'instant.</p>'}</div>
      ${X.isCourse() ? `<div><b>👀 Ont quitté la page du cours (${st.away.length})</b>${st.away.map(p => row(p, '<small class="faint">autre onglet ou application</small>')).join('') || '<p class="small faint">Tout le monde suit.</p>'}</div>` : ''}
      <p class="small faint">Chaque participant choisit « J'ai compris » ou « Je suis perdu » dans le menu des réactions. Remettez à zéro avant la question suivante.</p></div>`,
    actions: [{ label: 'Remettre à zéro', cls: 'ghost', value: 'reset' }, { label: 'Fermer', cls: 'primary', value: null }],
    onMount(el) { el.querySelectorAll('[data-ask]').forEach(b => b.onclick = () => { S().socket.emit('meet-host', { action: 'floor', pid: b.dataset.ask }); b.disabled = true; b.textContent = 'Parole donnée'; }); }
  });
  if (r === 'reset') S().socket.emit('meet-host', { action: 'pulseReset' });
}

/* ======================================================================
   FENÊTRE FLOTTANTE (Document Picture-in-Picture : Chrome et Edge sur ordinateur)
   ====================================================================== */
const F = { win: null, feed: [], auto: false, video: null, flash: 0 };
export const floatSupported = () => 'documentPictureInPicture' in window || !!(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream);
export const floatOpenNow = () => !!F.win || !!F.video;
export const floatAuto = () => ls.get('tx_float_auto', true) !== false;

export async function floatOpen(auto) {
  if (F.win || F.video) { if (!auto) floatClose(); return true; }
  if ('documentPictureInPicture' in window) {
    try {
      const w = await window.documentPictureInPicture.requestWindow({ width: 360, height: 600 });
      F.win = w; F.auto = !!auto;
      const d = w.document;
      d.title = 'Réunion · Lestha Send';
      const st = d.createElement('style'); st.textContent = FW_CSS; d.head.appendChild(st);
      d.body.innerHTML = '<div id="fw"></div>';
      w.addEventListener('pagehide', () => { F.win = null; floatButtons(); awayReport(); });
      floatDraw(true); floatButtons(); awayReport();
      return true;
    } catch (e) { if (!auto) toast('La fenêtre flottante n\'a pas pu s\'ouvrir : ' + (e.message || e.name), 'warn'); return false; }
  }
  // Safari : image flottante (lecture seule) avec les mains levées et les derniers messages
  if (document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream) {
    try {
      const cv = document.createElement('canvas'); cv.width = 480; cv.height = 360;
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = cv.captureStream(4);
      v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;left:0'; document.body.appendChild(v);
      F.video = v; F.cv = cv; paintCard(); await v.play(); await v.requestPictureInPicture();
      F.cvT = setInterval(paintCard, 500);
      v.addEventListener('leavepictureinpicture', () => { clearInterval(F.cvT); v.remove(); F.video = null; floatButtons(); awayReport(); });
      floatButtons(); awayReport();
      return true;
    } catch (e) { if (F.video) { F.video.remove(); F.video = null; } clearInterval(F.cvT); if (!auto) toast('Fenêtre flottante impossible dans ce navigateur. Utilisez Chrome ou Edge sur ordinateur.', 'warn'); return false; }
  }
  if (!auto) toast('Fenêtre flottante disponible dans Chrome et Edge sur ordinateur. Vous serez prévenu par une notification.', 'info', { duration: 6000 });
  return false;
}
export function floatClose() {
  if (F.win) { try { F.win.close(); } catch (e) { /* ignore */ } F.win = null; }
  if (F.video) { try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch (e) { /* ignore */ } clearInterval(F.cvT); F.video.remove(); F.video = null; }
  floatButtons();
}
/** Le présentateur vient de cliquer « Présenter » : on ouvre la fenêtre tant que le clic compte encore */
export async function beforeShare() {
  if (!floatAuto() || F.win || !('documentPictureInPicture' in window)) return false;
  return floatOpen(true);
}
function floatButtons() { const b = $('#bFloat'); if (b) b.classList.toggle('on', floatOpenNow()); }
function floatFlash(kind) {
  const d = F.win && F.win.document; if (!d) return;
  const el = d.getElementById('fw'); if (!el) return;
  el.classList.remove('flash-hand', 'flash-chat', 'flash-lost'); void el.offsetWidth; el.classList.add('flash-' + (kind === 'timer' ? 'lost' : kind));
}
export function feed(pid, r, t) {
  const p = pid === (S().self && S().self.pid) ? { name: 'Vous' } : S().people.get(pid); if (!p) return;
  F.feed.unshift({ name: p.name, e: X.emo(r, t), at: Date.now() }); F.feed.length = Math.min(F.feed.length, 8);
  floatDraw();
}

let fwQueued = false;
export function floatDraw(now) {
  if (F.video) return;                             // l'image Safari se redessine toute seule
  if (!F.win) return;
  if (!now) { if (!fwQueued) { fwQueued = true; requestAnimationFrame(() => { fwQueued = false; floatDraw(true); }); } return; }
  const d = F.win.document, root = d.getElementById('fw'); if (!root) return;
  const s = S(); if (!s.self || !s.meeting) return;
  const staff = X.isStaff(), course = X.isCourse(), n = s.people.size + 1;
  const order = X.handOrder().filter(pid => pid !== s.self.pid).map(pid => s.people.get(pid)).filter(Boolean);
  const st = pulseStats();
  const msgs = (s.messages || []).slice(-30);
  const speaking = [...s.people.values()].filter(p => !p.muted && Date.now() - (p.loud || 0) < 900).map(p => p.name);
  const sharer = s.sharing ? null : [...s.people.values()].find(p => p.screen && p.streams && p.streams.s);
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.innerHTML = `
      <header class="fw-top"><div><b id="fwTitle"></b><span id="fwSub"></span></div><span class="fw-timer" id="fwTimer" hidden></span></header>
      <div class="fw-stage" id="fwStage" hidden><video id="fwStageV" autoplay playsinline muted></video></div>
      <div class="fw-pulse" id="fwPulse"></div>
      <div class="fw-speak" id="fwSpeak"></div>
      <section class="fw-sec" id="fwHands"></section>
      <section class="fw-sec fw-feed" id="fwFeed"></section>
      <section class="fw-sec fw-chat"><h4>Discussion</h4><div class="fw-msgs" id="fwMsgs"></div>
        <form id="fwForm" class="fw-send" autocomplete="off"><input id="fwIn" maxlength="500" placeholder="Répondre à la classe…"><button type="submit" aria-label="Envoyer">${svg('send')}</button></form></section>
      <footer class="fw-bar" id="fwBar"></footer>`;
    const f = d.getElementById('fwForm');
    f.onsubmit = (e) => { e.preventDefault(); const i = d.getElementById('fwIn'); const t = i.value.trim(); if (!t) return; s.socket.emit('meet-chat', { text: t }); i.value = ''; };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fw]'); if (!b) return;
      const a = b.dataset.fw, pid = b.dataset.pid;
      if (a === 'floor' || a === 'lower') s.socket.emit('meet-host', { action: a, pid });
      else if (a === 'mic') X.setMuted(!s.muted);
      else if (a === 'hand') X.toggleHand();
      else if (a === 'stop') X.stopScreen();
      else if (a === 'back') { try { window.focus(); } catch (x) { /* ignore */ } }
      else if (a === 'ok' || a === 'lost') setPulse(a);
      else if (a === 'pulse') s.socket.emit('meet-host', { action: 'pulseReset' });
      else if (a === 'sound') { ls.set('tx_teach_sound', !sound()); floatDraw(); }
      else if (a === 'auto') { ls.set('tx_float_auto', !floatAuto()); floatDraw(); }
      else if (a === 'react') s.socket.emit('meet-react', { r: b.dataset.r, t: X.myTone() });
      floatDraw();
    });
  }
  d.getElementById('fwTitle').textContent = s.meeting.title;
  d.getElementById('fwSub').textContent = `${X.fmtClock(Date.now() - s.meeting.startedAt)} · ${n} participant${n > 1 ? 's' : ''}${s.sharing ? ' · vous présentez' : ''}${s.meeting.recording ? ' · 🔴 REC' : ''}`;
  const tm = d.getElementById('fwTimer'); tm.hidden = !TM.end;
  // Présentation d'un autre (élève qui a changé d'onglet) : on la garde sous les yeux
  const sg = d.getElementById('fwStage'), sv = d.getElementById('fwStageV');
  sg.hidden = !sharer;
  const want = sharer ? sharer.streams.s : null;
  if (sv.srcObject !== want) { sv.srcObject = want; if (want) sv.play().catch(() => {}); }
  d.getElementById('fwPulse').innerHTML = staff
    ? (st.ok.length || st.lost.length || (course && st.away.length) ? `<span class="ok">👍 ${st.ok.length} compris</span><span class="lost">🤔 ${st.lost.length} perdu${st.lost.length > 1 ? 's' : ''}</span>${course ? `<span class="aw">👀 ${st.n - st.away.length}/${st.n} suivent</span>` : ''}<button type="button" data-fw="pulse" title="Remettre à zéro">↺</button>` : '')
    : `<button type="button" class="pb ${s.self.pulse === 'ok' ? 'on ok' : ''}" data-fw="ok">👍 J'ai compris</button><button type="button" class="pb ${s.self.pulse === 'lost' ? 'on lost' : ''}" data-fw="lost">🤔 Je suis perdu</button>`;
  d.getElementById('fwPulse').hidden = !d.getElementById('fwPulse').innerHTML;
  d.getElementById('fwSpeak').textContent = speaking.length ? '🔊 ' + speaking.slice(0, 3).join(', ') + (speaking.length > 1 ? ' parlent' : ' parle') : '';
  const hands = d.getElementById('fwHands');
  hands.innerHTML = `<h4>✋ Mains levées <em>${order.length}</em></h4>` + (order.length ? order.map((p, i) => `<div class="fw-row"><span class="fw-n">${i + 1}</span><span class="fw-av" style="--h:${X.hue(p.pid)}">${esc(X.initials(p.name))}</span><span class="fw-nm">${esc(p.name)}${p.pulse === 'lost' ? ' 🤔' : ''}</span>${staff ? `${course && !p.floor ? `<button type="button" class="fw-b pri" data-fw="floor" data-pid="${esc(p.pid)}">Donner la parole</button>` : ''}<button type="button" class="fw-b" data-fw="lower" data-pid="${esc(p.pid)}" title="Baisser la main">${svg('x')}</button>` : ''}</div>`).join('') : '<p class="fw-empty">Personne pour l\'instant.</p>');
  const fresh = F.feed.filter(x => Date.now() - x.at < 60e3);
  d.getElementById('fwFeed').innerHTML = fresh.length ? `<h4>Réactions</h4><div class="fw-emos">${fresh.map(x => `<span title="${esc(x.name)}"><b>${x.e}</b>${esc(x.name.split(' ')[0])}</span>`).join('')}</div>` : '';
  const list = d.getElementById('fwMsgs'), atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.innerHTML = msgs.length ? msgs.map(m => `<div class="fw-msg ${m.pid === s.self.pid ? 'me' : ''}"><b>${esc(m.name)}</b> <small>${new Date(m.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</small><p>${esc(m.text)}</p></div>`).join('') : '<p class="fw-empty">Les questions écrites apparaîtront ici.</p>';
  if (atEnd) list.scrollTop = list.scrollHeight;
  d.getElementById('fwForm').hidden = !(s.meeting.chat || staff);
  const canTalk = !course || staff || s.self.floor;
  d.getElementById('fwBar').innerHTML = `
    <button type="button" class="fw-c ${s.muted ? 'off' : 'on'}" data-fw="mic" title="${s.muted ? 'Activer le micro' : 'Couper le micro'}" ${!canTalk && s.muted ? 'disabled' : ''}>${svg(s.muted ? 'micoff' : 'mic')}</button>
    ${!staff ? `<button type="button" class="fw-c ${s.hand ? 'hand' : ''}" data-fw="hand" title="${s.hand ? 'Baisser la main' : 'Lever la main'}">${svg('hand')}</button>` : ''}
    ${['clap', 'ok', 'q'].map(r => `<button type="button" class="fw-c emo" data-fw="react" data-r="${r}" title="Réaction">${X.emo(r, X.myTone())}</button>`).join('')}
    ${s.sharing ? `<button type="button" class="fw-c stop" data-fw="stop" title="Arrêter la présentation">${svg('stop')}</button>` : ''}
    <button type="button" class="fw-c ${sound() ? '' : 'off'}" data-fw="sound" title="${sound() ? 'Couper les sons d\'alerte' : 'Activer les sons d\'alerte'}">${svg('bell')}</button>
    <button type="button" class="fw-c" data-fw="back" title="Revenir à la réunion">${svg('back')}</button>`;
  root.classList.toggle('staff', staff);
}

/* Safari : carte dessinée dans une image flottante */
function paintCard() {
  const c = F.cv && F.cv.getContext('2d'); if (!c) return;
  const s = S(); if (!s.self) return;
  c.fillStyle = '#0b1222'; c.fillRect(0, 0, 480, 360);
  c.fillStyle = '#fff'; c.font = '700 20px Inter, sans-serif'; c.fillText((s.meeting.title || '').slice(0, 34), 18, 34);
  c.fillStyle = '#9aa8c2'; c.font = '14px Inter, sans-serif'; c.fillText(`${X.fmtClock(Date.now() - s.meeting.startedAt)} · ${s.people.size + 1} participants${TM.end ? ' · ⏱ ' + X.fmtClock(Math.max(0, TM.end - Date.now()) + 999) : ''}`, 18, 56);
  const order = X.handOrder().filter(pid => pid !== s.self.pid).map(pid => s.people.get(pid)).filter(Boolean);
  c.fillStyle = '#fbbf24'; c.font = '700 17px Inter, sans-serif'; c.fillText(`✋ Mains levées : ${order.length}`, 18, 92);
  c.fillStyle = '#fff'; c.font = '16px Inter, sans-serif'; order.slice(0, 4).forEach((p, i) => c.fillText(`${i + 1}. ${p.name}`, 30, 118 + i * 22));
  const st = pulseStats(); c.fillStyle = '#a7f3d0'; c.fillText(`👍 ${st.ok.length} compris   🤔 ${st.lost.length} perdus`, 18, 218);
  c.fillStyle = '#67e8f9'; c.font = '700 15px Inter, sans-serif'; c.fillText('💬 Derniers messages', 18, 250);
  c.fillStyle = '#e9effb'; c.font = '14px Inter, sans-serif';
  (s.messages || []).slice(-4).forEach((m, i) => c.fillText((m.name + ' : ' + m.text).slice(0, 58), 18, 274 + i * 21));
}

/** Arrivée dans la réunion : annotations déjà faites, minuteur en cours, ouverture automatique sur Chrome */
export function teachJoined(r) {
  inkLoad(r.ink); onInfo(r.meeting); awayReport();
  // Chrome ouvre lui-même la fenêtre flottante quand on quitte l'onglet d'un appel (comme Google Meet)
  try { navigator.mediaSession.setActionHandler('enterpictureinpicture', () => { if (floatAuto() && !F.win) floatOpen(true); }); } catch (e) { /* navigateur sans cette option */ }
}
/** Fin de la présentation : la fenêtre ouverte automatiquement pour elle se referme */
export function onShareStop() { if (F.auto && F.win) floatClose(); }

export function teachReset() {
  floatClose(); inkLoad([]); I.open = false; I.tool = null; Object.assign(TM, { end: 0, sec: 0, label: '', rang: false }); F.feed = [];
  clearTimeout(awayT);
}

/* Styles de la fenêtre flottante (document séparé : rien n'est hérité de la page) */
const FW_CSS = `
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#070b14;color:#e9effb;font:14px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
#fw{display:flex;flex-direction:column;height:100%;padding:10px;gap:8px;transition:box-shadow .3s}
#fw.flash-hand{animation:fl 1.2s 2}#fw.flash-chat{animation:flc 1s 1}#fw.flash-lost{animation:fll 1.2s 2}
@keyframes fl{50%{box-shadow:inset 0 0 0 3px #fbbf24}}@keyframes flc{50%{box-shadow:inset 0 0 0 3px #67e8f9}}@keyframes fll{50%{box-shadow:inset 0 0 0 3px #fb7185}}
.ti{width:18px;height:18px;flex:none}
.fw-top{display:flex;align-items:center;gap:8px}.fw-top div{flex:1;min-width:0;display:flex;flex-direction:column}
.fw-top b{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fw-top span{font-size:11.5px;color:#9aa8c2}
.fw-timer{font:700 15px/1 Inter,system-ui;padding:6px 10px;border-radius:99px;background:rgba(103,232,249,.14);color:#67e8f9;font-variant-numeric:tabular-nums}
.fw-timer.soon{background:#e11d48;color:#fff}
.fw-stage{border-radius:12px;overflow:hidden;background:#000;aspect-ratio:16/9;flex:none}.fw-stage video{width:100%;height:100%;object-fit:contain}
.fw-pulse{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12.5px}
.fw-pulse span{padding:4px 9px;border-radius:99px;background:rgba(148,163,184,.12)}.fw-pulse .ok{color:#a7f3d0}.fw-pulse .lost{color:#fecdd3}.fw-pulse .aw{color:#cbd5e1}
.fw-pulse>button:not(.pb){margin-left:auto;border:0;background:rgba(148,163,184,.14);color:#e9effb;border-radius:8px;width:28px;height:28px;cursor:pointer}
.pb{flex:1;border:0;border-radius:12px;padding:9px;background:rgba(148,163,184,.12);color:#e9effb;font:600 13px Inter,system-ui;cursor:pointer}
.pb.on.ok{background:#059669;color:#fff}.pb.on.lost{background:#e11d48;color:#fff}
.fw-speak{font-size:12px;color:#6ff3cf;min-height:0}.fw-speak:empty{display:none}
.fw-sec h4{margin:4px 0 6px;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:#9aa8c2;display:flex;align-items:center;gap:6px}
.fw-sec h4 em{font-style:normal;background:#fbbf24;color:#1f1300;border-radius:99px;padding:0 7px;font-size:11px;letter-spacing:0}
.fw-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;background:rgba(251,191,36,.08);margin-bottom:4px}
.fw-n{font:700 12px Inter;color:#fbbf24;width:14px}.fw-av{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:700 11px Inter;background:hsl(var(--h) 55% 42%);flex:none}
.fw-nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.fw-b{border:0;border-radius:8px;height:28px;padding:0 8px;background:rgba(148,163,184,.16);color:#e9effb;font:600 12px Inter,system-ui;cursor:pointer;display:grid;place-items:center}
.fw-b.pri{background:#06d6a0;color:#04211a}.fw-b .ti{width:14px;height:14px}
.fw-empty{margin:0;color:#64748b;font-size:12.5px}
.fw-emos{display:flex;flex-wrap:wrap;gap:6px}.fw-emos span{display:flex;align-items:center;gap:4px;font-size:12px;color:#cbd5e1;padding:3px 8px 3px 4px;border-radius:99px;background:rgba(148,163,184,.1);animation:pop .3s}
.fw-emos b{font-size:18px;font-weight:400}@keyframes pop{from{transform:scale(.6);opacity:0}}
.fw-chat{flex:1;min-height:90px;display:flex;flex-direction:column}
.fw-msgs{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
.fw-msg{padding:6px 9px;border-radius:10px;background:rgba(148,163,184,.1)}.fw-msg.me{background:rgba(6,214,160,.12)}
.fw-msg b{font-size:12px}.fw-msg small{color:#64748b;font-size:10.5px}.fw-msg p{margin:2px 0 0;word-wrap:break-word}
.fw-send{display:flex;gap:6px;margin-top:6px}.fw-send[hidden]{display:none}.fw-send input{flex:1;min-width:0;border:1px solid rgba(148,163,184,.25);background:rgba(148,163,184,.08);color:#fff;border-radius:10px;padding:8px 10px;font:inherit}
.fw-send button{border:0;border-radius:10px;width:38px;background:#00b4d8;color:#fff;cursor:pointer;display:grid;place-items:center}
.fw-bar{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(148,163,184,.14)}
.fw-c{width:40px;height:40px;border:0;border-radius:12px;background:rgba(148,163,184,.14);color:#eef6ff;cursor:pointer;display:grid;place-items:center}
.fw-c.on{background:rgba(6,214,160,.2);color:#a7f3d0}.fw-c.off{background:rgba(251,113,133,.18);color:#fecdd3}.fw-c.hand{background:#fbbf24;color:#1f1300}
.fw-c.stop{background:#e11d48;color:#fff}.fw-c.emo{font-size:19px}.fw-c:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible{outline:2px solid #67e8f9;outline-offset:2px}
@media (prefers-reduced-motion:reduce){#fw,.fw-emos span{animation:none!important}}
`;
