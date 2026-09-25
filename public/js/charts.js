/* TransferX — graphiques SVG légers + fil d'activité */
import { esc, icon, relTime, num } from './core.js';

/** Regroupe des événements par jour (ou heure) : [{ key, label, views, downloads }] */
export function bucketize(events, { days = 14, hours = 0 } = {}) {
  const out = [];
  const now = new Date();
  if (hours) {
    const base = new Date(now); base.setMinutes(0, 0, 0);
    for (let i = hours - 1; i >= 0; i--) {
      const d = new Date(base.getTime() - i * 3600e3);
      out.push({ start: d.getTime(), end: d.getTime() + 3600e3, label: d.getHours() + 'h', long: d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit' }) + 'h', views: 0, downloads: 0 });
    }
  } else {
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(base); d.setDate(base.getDate() - i);
      const e = new Date(d); e.setDate(d.getDate() + 1);
      out.push({ start: d.getTime(), end: e.getTime(), label: d.toLocaleDateString('fr-FR', { day: '2-digit' }), long: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), views: 0, downloads: 0 });
    }
  }
  for (const ev of events) {
    const b = out.find(x => ev.t >= x.start && ev.t < x.end);
    if (!b) continue;
    if (ev.type === 'view') b.views++;
    else if (ev.type === 'download' || ev.type === 'zip') b.downloads++;
  }
  return out;
}

/** Histogramme groupé vues / téléchargements, avec info-bulle */
export function barChart(el, buckets) {
  if (!el) return;
  const W = Math.max(300, Math.round(el.clientWidth || 640)), H = 200, padL = 28, padB = 22, padT = 10;
  const max = Math.max(1, ...buckets.map(b => Math.max(b.views, b.downloads)));
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const cw = (W - padL) / buckets.length;
  const bw = Math.max(3, Math.min(14, cw * 0.32));
  const y = (v) => H - padB - (v / nice) * (H - padB - padT);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = Math.round(nice * i / 4), yy = y(v);
    g += `<line class="gridline" x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="axis" x="${padL - 6}" y="${yy + 3}" text-anchor="end">${v}</text>`;
  }
  const every = Math.ceil(buckets.length / 14);
  buckets.forEach((b, i) => {
    const cx = padL + cw * i + cw / 2;
    g += `<g class="col" data-i="${i}">
      <rect class="bar-v" x="${cx - bw - 1}" y="${y(b.views)}" width="${bw}" height="${H - padB - y(b.views)}" rx="3"/>
      <rect class="bar-d" x="${cx + 1}" y="${y(b.downloads)}" width="${bw}" height="${H - padB - y(b.downloads)}" rx="3"/>
      <rect class="hit" x="${padL + cw * i}" y="0" width="${cw}" height="${H}"/>
      ${i % every === 0 ? `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>` : ''}
    </g>`;
  });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Vues et téléchargements">${g}</svg>`;
  let tip = null;
  const svg = el.querySelector('svg');
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  svg.addEventListener('pointermove', (e) => {
    const col = e.target.closest('g.col'); if (!col) return hide();
    const b = buckets[+col.dataset.i];
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
    tip.innerHTML = `<b>${esc(b.long)}</b><br>${icon('eye', 'sm')} ${num(b.views)} vue${b.views > 1 ? 's' : ''} · ${icon('download', 'sm')} ${num(b.downloads)} téléch.`;
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
  });
  svg.addEventListener('pointerleave', hide);
  el._cleanup = hide;
}

const EV = {
  view: { ic: 'eye', c: '#00b4d8', txt: 'Lien ouvert' },
  download: { ic: 'download', c: '#06d6a0', txt: 'Téléchargement' },
  zip: { ic: 'zip', c: '#10d49a', txt: 'Téléchargement ZIP complet' },
  pin_fail: { ic: 'lock', c: '#fb7185', txt: 'Code PIN erroné' },
  ready: { ic: 'check', c: '#8b7bff', txt: 'Envoi terminé, lien actif' },
  extended: { ic: 'clock', c: '#fbbf24', txt: 'Expiration prolongée' }
};

export function feedItem(ev, title, isNew = false) {
  const m = EV[ev.type] || { ic: 'sparkles', c: '#8ea2bf', txt: ev.type };
  const who = [ev.d, ev.b].filter(Boolean).join(' · ');
  return `<div class="feed-item ${isNew ? 'new' : ''}">
    <div class="feed-dot" style="--fc:${m.c}">${icon(m.ic)}</div>
    <div style="min-width:0">
      <div class="small" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.txt)}${ev.f ? ' — ' + esc(ev.f) : ''}</div>
      <div class="tiny faint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title ? esc(title) + (who ? ' · ' : '') : ''}${esc(who)}${ev.v ? ' · visiteur #' + esc(ev.v) : ''}</div>
    </div>
    <span class="feed-time" data-ts="${ev.t}">${relTime(ev.t)}</span>
  </div>`;
}

/** Rafraîchit les temps relatifs d'un conteneur */
export function refreshTimes(root) { root && root.querySelectorAll('[data-ts]').forEach(el => { el.textContent = relTime(+el.dataset.ts); }); }
