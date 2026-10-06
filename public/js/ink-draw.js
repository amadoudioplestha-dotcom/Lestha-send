/* Lestha Send — dessin des annotations (stylo, formes, texte, notes, tampons, laser).
   Partagé par la réunion et par le lecteur de replay : aucun import, pour pouvoir être recopié
   tel quel dans un fichier replay hors ligne. Coordonnées de 0 à 1 dans le rectangle r. */
export const FADE_MS = 3000, LASER_MS = 1400;
export function px(r, s, k = 1) { return Math.max(1.2, s.w * r.w / 1000 * k); }
export function drawStroke(c, s, r, now) {
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
export const pastel = (hex) => { if (hex === '#111827' || hex === '#ffffff') return '#fde68a'; const n = parseInt(hex.slice(1), 16), m = (v) => Math.round(v + (255 - v) * 0.55); return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`; };
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
export function drawLaser(c, l, r, now) {
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

