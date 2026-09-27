/* TransferX — outils de revue vidéo partagés (lecteur + page de gestion)
 * timecodes image par image, dessin des annotations, exports EDL / CSV / PDF */
import { esc } from './core.js';

export const FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 60];

/** 83.4 s → "00:01:23:10" (images à la fin) */
export function tc(sec, fps = 25, offsetH = 0) {
  const r = Math.round(fps);
  let fr = Math.max(0, Math.floor((Number(sec) || 0) * fps + 1e-6));
  const f = fr % r; fr = Math.floor(fr / r);
  const s = fr % 60, m = Math.floor(fr / 60) % 60, h = Math.floor(fr / 3600) + offsetH;
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}
/** Affichage court : 1:23 ou 1:02:03 */
export function short(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

/** Rectangle réellement occupé par l'image dans un <video> (bandes noires exclues) */
export function contentRect(video, box) {
  const W = box.clientWidth, H = box.clientHeight;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const sc = Math.min(W / vw, H / vh);
  const w = vw * sc, h = vh * sc;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h, W, H };
}

/** Dessine des formes normalisées (0..1) dans un canvas */
export function drawShapes(ctx, shapes, rect, dpr = 1) {
  const lw = Math.max(2.5, rect.w * 0.0045) * dpr;
  const X = (v) => (rect.x + v * rect.w) * dpr, Y = (v) => (rect.y + v * rect.h) * dpr;
  (shapes || []).forEach(sh => {
    const p = sh.p; if (!p || p.length < 4) return;
    ctx.strokeStyle = sh.c || '#f43f5e'; ctx.fillStyle = sh.c || '#f43f5e';
    ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4 * dpr;
    ctx.beginPath();
    if (sh.t === 'pen') {
      ctx.moveTo(X(p[0]), Y(p[1]));
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(p[i]), Y(p[i + 1]));
      ctx.stroke();
    } else if (sh.t === 'rect') {
      ctx.strokeRect(X(Math.min(p[0], p[2])), Y(Math.min(p[1], p[3])), Math.abs(X(p[2]) - X(p[0])), Math.abs(Y(p[3]) - Y(p[1])));
    } else if (sh.t === 'circle') {
      const cx = (X(p[0]) + X(p[2])) / 2, cy = (Y(p[1]) + Y(p[3])) / 2;
      ctx.ellipse(cx, cy, Math.abs(X(p[2]) - X(p[0])) / 2 || 1, Math.abs(Y(p[3]) - Y(p[1])) / 2 || 1, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (sh.t === 'arrow') {
      const x1 = X(p[0]), y1 = Y(p[1]), x2 = X(p[2]), y2 = Y(p[3]);
      const a = Math.atan2(y2 - y1, x2 - x1), hl = lw * 4.2;
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - hl * Math.cos(a - 0.45), y2 - hl * Math.sin(a - 0.45));
      ctx.lineTo(x2 - hl * Math.cos(a + 0.45), y2 - hl * Math.sin(a + 0.45));
      ctx.closePath(); ctx.fill();
    }
  });
  ctx.shadowBlur = 0;
}

/* ------------------------------ exports ------------------------------ */
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const base = (name) => String(name || 'video').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
const top = (comments) => comments.filter(c => !c.parent).sort((a, b) => a.time - b.time);
const repliesOf = (comments, c) => comments.filter(r => r.parent === c.id).sort((a, b) => a.at - b.at);

/** Marqueurs de timeline pour DaVinci Resolve (Timeline › Import › Timeline Markers from EDL) */
export function exportEDL(file, comments, fps = 25, startHour = 1) {
  const list = top(comments);
  const lines = [`TITLE: ${base(file.name)}${file.v ? ' V' + file.v : ''}`, 'FCM: NON-DROP FRAME', ''];
  list.forEach((c, i) => {
    const dur = Math.max(1, Math.round(((c.end || c.time) - c.time) * fps) || 1);
    const a = tc(c.time, fps, startHour), b = tc(c.time + dur / fps, fps, startHour);
    const txt = `${c.name} : ${c.text}`.replace(/[\r\n|]+/g, ' ').slice(0, 250);
    lines.push(`${String(i + 1).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    lines.push(` |C:${c.resolved ? 'ResolveColorGreen' : 'ResolveColorRed'} |M:${txt} |D:${dur}`, '');
  });
  download(base(file.name) + (file.v ? '_V' + file.v : '') + '_marqueurs.edl', lines.join('\r\n'), 'text/plain');
}

/** Tableau (Excel, Google Sheets, Numbers) */
export function exportCSV(file, comments, fps = 25) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['N°', 'Version', 'Début', 'Fin', 'Auteur', 'Remarque', 'Dessin', 'Statut', 'Réponses', 'Date']];
  top(comments).forEach((c, i) => rows.push([i + 1, file.v ? 'V' + file.v : 'V1', tc(c.time, fps), c.end ? tc(c.end, fps) : '', c.name, c.text, c.draw ? 'oui' : '', c.resolved ? 'Traité' + (c.resolvedBy ? ' (' + c.resolvedBy + ')' : '') : 'À traiter',
    repliesOf(comments, c).map(r => r.name + ' : ' + r.text).join(' / '), new Date(c.at).toLocaleString('fr-FR')]));
  download(base(file.name) + (file.v ? '_V' + file.v : '') + '_remarques.csv', '﻿' + rows.map(r => r.map(q).join(';')).join('\r\n'), 'text/csv');
}

/** Rapport imprimable (→ « Enregistrer en PDF ») */
export function printReport(file, comments, fps = 25, reviews = []) {
  const list = top(comments);
  const open = list.filter(c => !c.resolved).length;
  const w = window.open('', '_blank');
  if (!w) return false;
  const verdict = { approved: '✅ Approuvé', changes: '✏️ Modifications demandées' };
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Remarques — ${esc(file.name)}</title><style>
    body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;margin:32px}
    h1{font-size:22px;margin:0 0 4px}.sub{color:#475569;margin-bottom:18px}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}
    th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
    .tc{font-family:ui-monospace,Menlo,monospace;white-space:nowrap;color:#0e7490;font-weight:600}
    .ok{color:#15803d;font-weight:600}.todo{color:#b91c1c;font-weight:600}.rep{color:#475569;font-size:13px;margin-top:4px}
    .chips span{display:inline-block;margin:0 8px 6px 0;padding:3px 10px;border-radius:99px;background:#f1f5f9}
    @media print{body{margin:12mm}}</style></head><body>
    <h1>${esc(file.name)}${file.v ? ' — V' + file.v : ''}</h1>
    <div class="sub">${list.length} remarque(s) · ${open} à traiter · ${new Date().toLocaleString('fr-FR')} · ${fps} i/s</div>
    ${reviews.length ? `<div class="chips">${reviews.map(r => `<span>${esc(r.name)} : ${verdict[r.status] || r.status}</span>`).join('')}</div>` : ''}
    <table><thead><tr><th>#</th><th>Timecode</th><th>Remarque</th><th>Statut</th></tr></thead><tbody>
    ${list.map((c, i) => `<tr><td>${i + 1}</td><td class="tc">${tc(c.time, fps)}${c.end ? '<br>→ ' + tc(c.end, fps) : ''}</td>
      <td><b>${esc(c.name)}</b> ${esc(c.text)}${c.draw ? ' <i>(annotation dessinée)</i>' : ''}${repliesOf(comments, c).map(r => `<div class="rep">↳ <b>${esc(r.name)}</b> ${esc(r.text)}</div>`).join('')}</td>
      <td class="${c.resolved ? 'ok' : 'todo'}">${c.resolved ? 'Traité' : 'À traiter'}</td></tr>`).join('')}
    </tbody></table><script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
  return true;
}
