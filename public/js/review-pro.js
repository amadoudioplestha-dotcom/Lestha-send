/* Lestha Send — revue vidéo « pro » : ce qui va au-delà des lecteurs classiques
 * - qualités 480p / 720p / 1080p / Original avec choix automatique selon la connexion (et descente en cas de saccades)
 * - aperçu de l'image au survol de la timeline, forme d'onde, carte des moments les plus commentés
 * - réactions emoji horodatées, remarques vocales, lien vers un instant précis
 * - repères de cadrage (16:9, 9:16, 1:1, 4:5, 4:3, 2.39), zones de sécurité, grille des tiers
 * - capture d'image PNG en pleine résolution avec timecode incrusté
 * - comparaison de deux versions côte à côte ou en rideau, lecture synchronisée
 * - filigrane au nom du spectateur (anti-fuite) */
import { $, esc, icon, ls, toast, copyText, shareTo, isMobile, visitorId } from './core.js';
import { tc, contentRect, drawShapes } from './review-tools.js';

/* ============================== qualités ============================== */
/** Sources disponibles pour un fichier : l'original + les qualités légères (du plus léger au plus lourd) */
let probe = null;
/** Le navigateur sait-il lire ce format ? (une qualité VP9/AV1 n'est pas lisible partout) */
const playable = (mime) => { if (!mime) return true; try { probe = probe || document.createElement('video'); return !!probe.canPlayType(mime); } catch (e) { return true; } };
export function sourcesOf(f) {
  const oh = f.vw && f.vh ? Math.min(f.vw, f.vh) : 0;
  const list = (f.q || []).filter(r => playable(r.mime)).map(r => ({ id: r.id, h: r.h, label: r.h + 'p' }));
  list.push({ id: f.id, h: oh || 10000, label: 'Original' + (oh ? ' · ' + resName(oh) : ''), original: true });
  return list;
}
const resName = (h) => (h >= 2100 ? '4K' : h >= 1400 ? '2K' : h + 'p');
/** Choix automatique : débit annoncé par le navigateur (Chrome, Edge, Android), sinon type d'appareil */
export function autoPick(list) {
  if (list.length === 1) return list[0];
  const c = navigator.connection || {};
  const dl = Number(c.downlink) || 0, save = !!c.saveData, slow = /(^|-)(2g|3g)$/.test(c.effectiveType || '');
  const byH = (h) => list.filter(s => !s.original && s.h <= h).pop() || list[0];
  const orig = list[list.length - 1];
  if (save || slow || (dl && dl < 1.6)) return byH(480);
  if (dl && dl < 4.5) return byH(720);
  if (dl && dl < 12) return orig.h <= 1080 ? orig : byH(1080);
  if (dl >= 12) return orig.h <= 1440 || dl >= 30 ? orig : byH(1080);
  return isMobile ? byH(720) : (orig.h <= 1080 ? orig : byH(1080));
}

/* ============================== timeline enrichie ============================== */
/** Aperçu de l'image au survol (planche d'aperçus fabriquée à l'envoi) */
export function bindHoverPreview(X) {
  const track = $('#track'), sp = X.cur.sprite; if (!track) return;
  let tip = $('#rvPrev');
  if (!tip) { tip = document.createElement('div'); tip.id = 'rvPrev'; tip.className = 'rv-preview hidden'; track.appendChild(tip); }
  const url = sp ? X.src(sp.id) : null;
  if (sp) { tip.style.width = sp.tw + 'px'; tip.style.height = sp.th + 'px'; }
  const move = (e) => {
    const p = X.player; if (!p.duration) return;
    const r = track.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, e.clientX - r.left)), t = x / r.width * p.duration;
    tip.classList.remove('hidden');
    tip.style.left = Math.max(sp ? sp.tw / 2 : 40, Math.min(r.width - (sp ? sp.tw / 2 : 40), x)) + 'px';
    if (sp) {
      const i = Math.min(sp.n - 1, Math.floor(t / sp.step));
      tip.style.backgroundImage = `url("${url}")`; tip.style.backgroundSize = `${sp.cols * sp.tw}px ${sp.rows * sp.th}px`;
      tip.style.backgroundPosition = `-${(i % sp.cols) * sp.tw}px -${Math.floor(i / sp.cols) * sp.th}px`;
    }
    tip.dataset.tc = tc(t, X.fps());
    tip.classList.toggle('text-only', !sp);
  };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerleave', () => tip.classList.add('hidden'));
}
/** Forme d'onde (0..255 par tranche) dessinée dans la timeline */
export function drawWave(X) {
  const track = $('#track'); if (!track || !X.cur.peaks) return;
  let cv = $('#rvWave');
  if (!cv) { cv = document.createElement('canvas'); cv.id = 'rvWave'; cv.className = 'rv-wave'; track.prepend(cv); track.classList.add('has-wave'); }
  const bin = atob(X.cur.peaks), n = bin.length;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = track.clientWidth, H = track.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = 'rgba(148, 197, 255, .38)';
  const cols = Math.max(1, Math.floor(W / 2));
  for (let x = 0; x < cols; x++) {
    let m = 0; const a = Math.floor(x / cols * n), b = Math.max(a + 1, Math.floor((x + 1) / cols * n));
    for (let i = a; i < b; i++) m = Math.max(m, bin.charCodeAt(i));
    const h = Math.max(1, m / 255 * (H - 4)) * dpr;
    g.fillRect(x * 2 * dpr, (cv.height - h) / 2, 1.2 * dpr, h);
  }
}
/** Carte des moments forts : remarques et réactions regroupées sur 120 tranches */
export function drawHeat(X, comments, reacts) {
  const el = $('#rvHeat'); const p = X.player; if (!el || !p.duration) return;
  const N = 120, bins = new Float32Array(N);
  const add = (t, w) => { const i = Math.min(N - 1, Math.max(0, Math.floor(t / p.duration * N))); for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < N) bins[j] += w * (1 - Math.abs(k) * 0.3); } };
  comments.filter(c => !c.parent).forEach(c => add(c.time, c.resolved ? 0.5 : 1));
  reacts.forEach(r => add(r.time, 0.6));
  const max = Math.max(...bins);
  if (!max) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.style.background = `linear-gradient(90deg, ${Array.from(bins, (v, i) => { const a = v / max; return `rgba(${Math.round(251 - a * 7)}, ${Math.round(191 - a * 128)}, ${Math.round(36 + a * 58)}, ${(a * 0.95).toFixed(2)}) ${(i / (N - 1) * 100).toFixed(2)}%`; }).join(',')})`;
  el.title = 'Moments les plus commentés';
}
/** Réactions sur la timeline */
export function paintReacts(X, reacts) {
  const box = $('#trReacts'); const p = X.player; if (!box || !p.duration) return;
  box.innerHTML = reacts.slice(-300).map(r => `<span class="rv-react" style="left:${(r.time / p.duration * 100).toFixed(3)}%" title="${esc(r.e + ' à ' + tc(r.time, X.fps()))}">${esc(r.e)}</span>`).join('');
}
export function burstReact(e) {
  const box = $('#pbox'); if (!box) return;
  const s = document.createElement('span'); s.className = 'rv-burst'; s.textContent = e;
  s.style.left = (30 + Math.random() * 40) + '%'; box.appendChild(s); setTimeout(() => s.remove(), 1800);
}

/* ============================== cadrage ============================== */
export const GUIDES = [['', 'Cadrage'], ['16:9', '16:9'], ['9:16', '9:16 · Reels, TikTok'], ['1:1', '1:1 · carré'], ['4:5', '4:5 · Instagram'], ['4:3', '4:3'], ['2.39:1', '2.39:1 · cinéma']];
export function drawGuides(X, opt) {
  const cv = $('#rvGuides'), box = $('#pbox'); if (!cv || !box || !X.player) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(box.clientWidth * dpr) || cv.height !== Math.round(box.clientHeight * dpr)) { cv.width = Math.round(box.clientWidth * dpr); cv.height = Math.round(box.clientHeight * dpr); }
  const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
  if (!opt.aspect && !opt.safe && !opt.thirds) return;
  const R = contentRect(X.player, box);
  let a = { x: R.x, y: R.y, w: R.w, h: R.h };
  if (opt.aspect) {
    const [n, d] = opt.aspect.split(':').map(Number), ar = n / (d || 1);
    if (R.w / R.h > ar) { const w = R.h * ar; a = { x: R.x + (R.w - w) / 2, y: R.y, w, h: R.h }; } else { const h = R.w / ar; a = { x: R.x, y: R.y + (R.h - h) / 2, w: R.w, h }; }
    g.fillStyle = 'rgba(0, 0, 0, .58)';
    g.fillRect(R.x * dpr, R.y * dpr, R.w * dpr, (a.y - R.y) * dpr);
    g.fillRect(R.x * dpr, (a.y + a.h) * dpr, R.w * dpr, (R.y + R.h - a.y - a.h) * dpr);
    g.fillRect(R.x * dpr, a.y * dpr, (a.x - R.x) * dpr, a.h * dpr);
    g.fillRect((a.x + a.w) * dpr, a.y * dpr, (R.x + R.w - a.x - a.w) * dpr, a.h * dpr);
    g.strokeStyle = 'rgba(255, 255, 255, .85)'; g.lineWidth = 1.2 * dpr; g.setLineDash([]);
    g.strokeRect(a.x * dpr, a.y * dpr, a.w * dpr, a.h * dpr);
    g.font = `600 ${11 * dpr}px Inter, sans-serif`; g.fillStyle = 'rgba(255,255,255,.9)'; g.fillText(opt.aspect, (a.x + 8) * dpr, (a.y + 16) * dpr);
  }
  if (opt.safe) {
    // Zones de sécurité EBU R95 : action 93 %, titres 90 %
    [[0.93, 'rgba(34, 211, 238, .85)', 'Action'], [0.90, 'rgba(251, 191, 36, .9)', 'Titres']].forEach(([k, c, l]) => {
      const w = a.w * k, h = a.h * k, x = a.x + (a.w - w) / 2, y = a.y + (a.h - h) / 2;
      g.strokeStyle = c; g.lineWidth = 1 * dpr; g.setLineDash([6 * dpr, 4 * dpr]); g.strokeRect(x * dpr, y * dpr, w * dpr, h * dpr);
      g.setLineDash([]); g.font = `600 ${10 * dpr}px Inter, sans-serif`; g.fillStyle = c; g.fillText(l, (x + 6) * dpr, (y + h - 6) * dpr);
    });
  }
  if (opt.thirds) {
    g.strokeStyle = 'rgba(255, 255, 255, .45)'; g.lineWidth = 1 * dpr; g.setLineDash([]);
    g.beginPath();
    for (const k of [1 / 3, 2 / 3]) { g.moveTo((a.x + a.w * k) * dpr, a.y * dpr); g.lineTo((a.x + a.w * k) * dpr, (a.y + a.h) * dpr); g.moveTo(a.x * dpr, (a.y + a.h * k) * dpr); g.lineTo((a.x + a.w) * dpr, (a.y + a.h * k) * dpr); }
    g.stroke();
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    g.beginPath(); g.moveTo((cx - 8) * dpr, cy * dpr); g.lineTo((cx + 8) * dpr, cy * dpr); g.moveTo(cx * dpr, (cy - 8) * dpr); g.lineTo(cx * dpr, (cy + 8) * dpr); g.stroke();
  }
}

/* ============================== capture d'image ============================== */
/** Image en pleine résolution de la source lue, timecode et filigrane incrustés, annotations comprises */
export async function captureFrame(X, { shapes = [], wmText = '', staticWm = '' } = {}) {
  const p = X.player, t = p.currentTime;
  // L'original d'abord (pleine résolution), sinon la qualité en cours de lecture
  const urls = [...new Set([X.originalSrc, p.currentSrc || p.src].filter(Boolean))];
  let v = null;
  for (const u of urls) {
    const c = document.createElement('video');
    c.crossOrigin = 'anonymous'; c.muted = true; c.preload = 'auto'; c.playsInline = true; c.src = u;
    const ok = await new Promise((res) => { c.onloadeddata = () => res(c.videoWidth > 0); c.onerror = () => res(false); setTimeout(() => res(false), 15000); });
    if (ok) { v = c; break; }
    c.removeAttribute('src'); c.load();
  }
  if (!v) throw new Error('source');
  await new Promise((res) => { v.onseeked = res; v.currentTime = Math.min(t, (v.duration || t) - 0.001); setTimeout(res, 4000); });
  const W = v.videoWidth, H = v.videoHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.drawImage(v, 0, 0, W, H);
  if (shapes.length) drawShapes(g, shapes, { x: 0, y: 0, w: W, h: H, W, H }, 1);
  const fs = Math.max(14, Math.round(H / 38)), pad = Math.round(fs * 0.7);
  const label = `${tc(t, X.fps())} · ${X.cur.name}${X.cur.v ? ' · V' + X.cur.v : ''}`;
  g.font = `700 ${fs}px ui-monospace, Menlo, monospace`;
  const tw = g.measureText(label).width;
  g.fillStyle = 'rgba(0, 0, 0, .62)'; g.fillRect(pad, H - fs * 2 - pad, tw + pad * 2, fs * 1.7);
  g.fillStyle = '#fff'; g.fillText(label, pad * 2, H - fs * 0.85 - pad);
  if (staticWm) { g.save(); g.font = `700 ${fs}px Inter, sans-serif`; g.fillStyle = 'rgba(255,255,255,.3)'; g.textAlign = 'right'; g.fillText(staticWm, W - pad * 2, pad * 2 + fs); g.restore(); }
  if (wmText) { g.save(); g.font = `700 ${Math.round(fs * 1.2)}px Inter, sans-serif`; g.fillStyle = 'rgba(255,255,255,.22)'; g.translate(W / 2, H / 2); g.rotate(-0.35); g.textAlign = 'center'; for (let k = -2; k <= 2; k++) g.fillText(wmText, 0, k * fs * 4); g.restore(); }
  let blob;
  try { blob = await new Promise((res, rej) => { try { cv.toBlob(b => (b ? res(b) : rej(new Error('vide'))), 'image/png'); } catch (e) { rej(e); } }); }
  finally { v.removeAttribute('src'); v.load(); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${X.cur.name.replace(/\.[^.]+$/, '')}_${tc(t, X.fps()).replace(/:/g, '-')}.png`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return { W, H };
}

/* ============================== comparaison de versions ============================== */
/** Deux versions synchronisées : « côte à côte » ou « rideau » (glisser la poignée) */
export function startCompare(X, other, mode) {
  stopCompare(X);
  const box = $('#pbox'), main = X.player;
  box.classList.add('cmp', mode === 'side' ? 'cmp-side' : 'cmp-wipe');
  X.ctrlWas = X.ctrlWas == null ? main.controls : X.ctrlWas; main.controls = false;
  const v2 = document.createElement('video');
  v2.id = 'player2'; v2.className = 'player player2'; v2.muted = true; v2.playsInline = true; v2.preload = 'auto';
  v2.src = X.src(other.srcId);
  box.insertBefore(v2, main.nextSibling);
  const fit = () => { if (mode === 'side') return; v2.style.top = main.offsetTop + 'px'; v2.style.height = main.offsetHeight + 'px'; if (handle) { handle.style.top = main.offsetTop + 'px'; handle.style.height = main.offsetHeight + 'px'; } };
  window.addEventListener('resize', fit); document.addEventListener('fullscreenchange', fit);
  const lab = document.createElement('div'); lab.className = 'cmp-labels';
  lab.innerHTML = `<span class="cmp-l">${esc(X.curLabel)}</span><span class="cmp-r">${esc(other.label)}</span>`;
  box.appendChild(lab);
  let handle = null, pos = 50;
  if (mode !== 'side') {
    handle = document.createElement('div'); handle.className = 'cmp-handle'; handle.innerHTML = '<i></i>';
    box.appendChild(handle);
    const set = (pct) => { pos = Math.max(2, Math.min(98, pct)); v2.style.clipPath = `inset(0 0 0 ${pos}%)`; handle.style.left = pos + '%'; };
    set(50); fit();
    const drag = (e) => { const r = box.getBoundingClientRect(); set((e.clientX - r.left) / r.width * 100); };
    handle.addEventListener('pointerdown', (e) => { e.preventDefault(); handle.setPointerCapture(e.pointerId); handle.onpointermove = drag; });
    handle.addEventListener('pointerup', () => { handle.onpointermove = null; });
  }
  // À l'arrêt : alignement exact (comparaison image par image) ; en lecture : tolérance de 60 ms
  const sync = () => { if (main.paused ? v2.currentTime !== main.currentTime : Math.abs(v2.currentTime - main.currentTime) > 0.06) v2.currentTime = main.currentTime; };
  const on = {
    play: () => { sync(); v2.play().catch(() => {}); }, pause: () => { v2.pause(); sync(); },
    seeked: sync, ratechange: () => { v2.playbackRate = main.playbackRate; }
  };
  Object.entries(on).forEach(([k, f]) => main.addEventListener(k, f));
  v2.addEventListener('loadedmetadata', () => { v2.currentTime = main.currentTime; if (!main.paused) v2.play().catch(() => {}); }, { once: true });
  const timer = setInterval(() => { if (!main.paused) { const d = v2.currentTime - main.currentTime; if (Math.abs(d) > 0.12) v2.currentTime = main.currentTime; else v2.playbackRate = main.playbackRate * (1 - d * 0.5); } }, 250);
  X.compare = { v2, lab, handle, on, timer, other, mode, fit };
}
export function stopCompare(X) {
  const c = X.compare; if (!c) return;
  clearInterval(c.timer); window.removeEventListener('resize', c.fit); document.removeEventListener('fullscreenchange', c.fit);
  Object.entries(c.on).forEach(([k, f]) => X.player.removeEventListener(k, f));
  c.v2.pause(); c.v2.removeAttribute('src'); c.v2.load(); c.v2.remove(); c.lab.remove(); if (c.handle) c.handle.remove();
  $('#pbox').classList.remove('cmp', 'cmp-side', 'cmp-wipe');
  if (X.ctrlWas != null) { X.player.controls = X.ctrlWas; X.ctrlWas = null; }
  X.compare = null;
}

/* ============================== remarques vocales ============================== */
export function voiceRecorder(btn, onChange) {
  let rec = null, chunks = [], stream = null, t0 = 0, tick = null, blob = null, type = '', dur = 0;
  const pick = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const paint = () => { btn.innerHTML = rec ? `<span class="rec-dot"></span>${Math.floor((Date.now() - t0) / 1000)} s` : icon('mic', 'sm'); btn.classList.toggle('danger', !!rec); btn.classList.toggle('icon', !rec); btn.title = rec ? 'Arrêter l\'enregistrement' : blob ? 'Refaire la remarque vocale' : 'Remarque vocale (90 s au plus)'; };
  const stop = () => { if (rec && rec.state !== 'inactive') rec.stop(); };
  btn.onclick = async () => {
    if (rec) return stop();
    if (!window.MediaRecorder) return toast('L\'enregistrement vocal n\'est pas pris en charge par ce navigateur.', 'warn');
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { return toast('Micro refusé : autorisez-le dans le navigateur pour laisser une remarque vocale.', 'warn'); }
    type = pick(); chunks = [];
    rec = new MediaRecorder(stream, Object.assign({ audioBitsPerSecond: 32000 }, type ? { mimeType: type } : {}));
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      dur = (Date.now() - t0) / 1000; clearInterval(tick); stream.getTracks().forEach(t => t.stop());
      blob = new Blob(chunks, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] }); rec = null; paint(); onChange(blob, dur);
    };
    rec.start(500); t0 = Date.now(); paint();
    tick = setInterval(() => { paint(); if (Date.now() - t0 > 90e3) stop(); }, 500);
  };
  paint();
  return { clear: () => { blob = null; paint(); onChange(null, 0); }, stop, kill: () => { clearInterval(tick); if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } rec = null; if (stream) stream.getTracks().forEach(t => t.stop()); } };
}
export async function blobToB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ============================== partager un instant ============================== */
export async function shareMoment(X) {
  const t = X.player.currentTime;
  const url = `${location.origin}/w/${X.id}?f=${X.cur.id}&t=${t.toFixed(2)}`;
  await copyText(url);
  toast(`Lien vers ${tc(t, X.fps())} copié`, 'success', { action: 'WhatsApp', onAction: () => shareTo('whatsapp', { link: url, text: `Regarde à ${tc(t, X.fps())} : ` }), duration: 6000 });
  return url;
}

/* ============================== filigrane au nom du spectateur ============================== */
export function viewerWatermark(X, name) {
  const box = $('#pbox'); if (!box) return;
  let wm = $('#wmV');
  if (!wm) { wm = document.createElement('div'); wm.id = 'wmV'; wm.className = 'watermark wm-viewer'; box.appendChild(wm); }
  const d = new Date();
  wm.textContent = `${name} · ${d.toLocaleDateString('fr-FR')} · ${String(visitorId()).slice(0, 6)}`;
  const move = () => { wm.style.left = (6 + Math.random() * 58) + '%'; wm.style.top = (8 + Math.random() * 72) + '%'; };
  move(); clearInterval(X.wmVTimer); X.wmVTimer = setInterval(move, 7000);
}
export const savedName = () => String(ls.get('tx_comment_name', '') || '').trim();
