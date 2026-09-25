/* TransferX — utilitaires partagés */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
export const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 3;
export const isWebView = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|; ?wv\)/i.test(navigator.userAgent || '');

export function esc(t) {
  return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function bytes(n, digits) {
  n = Number(n) || 0;
  if (n <= 0) return '0 o';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, i);
  const d = digits != null ? digits : (i < 2 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0);
  return v.toFixed(d).replace('.', ',') + ' ' + u[i];
}
export const speed = (bps) => (bps > 0 ? bytes(bps) + '/s' : '—');
export function duration(sec) {
  if (!isFinite(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  if (sec < 60) return sec + ' s';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + ' min ' + (s ? String(s).padStart(2, '0') + ' s' : '');
  const h = Math.floor(m / 60);
  return h + ' h ' + String(m % 60).padStart(2, '0');
}
export function timeLeft(ms) {
  if (ms <= 0) return 'Expiré';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return d + ' j ' + h + ' h';
  if (h > 0) return h + ' h ' + m + ' min';
  return Math.max(1, m) + ' min';
}
export function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'à l\'instant';
  if (s < 60) return 'il y a ' + s + ' s';
  const m = Math.round(s / 60); if (m < 60) return 'il y a ' + m + ' min';
  const h = Math.round(m / 60); if (h < 24) return 'il y a ' + h + ' h';
  const d = Math.round(h / 24); if (d < 30) return 'il y a ' + d + ' j';
  return new Date(ts).toLocaleDateString('fr-FR');
}
export const fmtDate = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const num = (n) => (Number(n) || 0).toLocaleString('fr-FR');

/** Type de fichier → icône + couleur */
export function fileKind(name = '', type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (type.startsWith('image/') || /^(jpe?g|png|gif|webp|heic|avif|svg|bmp)$/.test(ext)) return { icon: 'image', c: '#f472b6', kind: 'image' };
  if (type.startsWith('video/') || /^(mp4|mov|mkv|avi|webm|m4v)$/.test(ext)) return { icon: 'video', c: '#a78bfa', kind: 'video' };
  if (type.startsWith('audio/') || /^(mp3|wav|m4a|aac|ogg|flac|opus)$/.test(ext)) return { icon: 'music', c: '#fbbf24', kind: 'audio' };
  if (/^(zip|rar|7z|tar|gz|bz2|xz|iso)$/.test(ext)) return { icon: 'zip', c: '#fb923c', kind: 'archive' };
  if (/^(pdf)$/.test(ext) || type.includes('pdf')) return { icon: 'doc', c: '#f87171', kind: 'pdf' };
  if (/^(docx?|odt|rtf|txt|md|xlsx?|csv|pptx?|pages|key|numbers)$/.test(ext)) return { icon: 'doc', c: '#60a5fa', kind: 'doc' };
  if (/^(js|ts|py|html|css|json|php|java|c|cpp|go|rs|sh|sql|xml|yml|yaml)$/.test(ext)) return { icon: 'code', c: '#34d399', kind: 'code' };
  return { icon: 'file', c: '#22d3ee', kind: 'file' };
}

/* ---------------- Stockage local (toujours protégé) ---------------- */
export const ls = {
  get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};
export const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }
};

export function visitorId() {
  let v = ls.get('tx_vid');
  if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); ls.set('tx_vid', v); }
  return v;
}

/** Transferts cloud possédés par cet appareil */
export const owned = {
  all() { return ls.get('tx_owned', []); },
  get(id) { return this.all().find(x => x.id === id); },
  upsert(item) {
    const list = this.all().filter(x => x.id !== item.id);
    const prev = this.all().find(x => x.id === item.id) || {};
    list.unshift(Object.assign(prev, item));
    ls.set('tx_owned', list.slice(0, 300));
  },
  remove(id) { ls.set('tx_owned', this.all().filter(x => x.id !== id)); }
};

/* ---------------- API ---------------- */
export async function api(path, { method = 'GET', body, key, token, signal, headers: extra } = {}) {
  const headers = Object.assign({}, extra || {});
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Owner-Key'] = key;
  if (token) headers['X-Access-Token'] = token;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error('Connexion impossible. Vérifiez votre réseau.'), { network: true });
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw Object.assign(new Error(data.error || ('Erreur ' + res.status)), { status: res.status, data });
  return data;
}

let _config = null;
export async function getConfig() {
  if (_config) return _config;
  try { _config = await api('/api/config'); } catch (e) { _config = { driver: 'local', maxTransferBytes: 250 * 1024 ** 3, maxFiles: 10000, email: false, p2p: true }; }
  return _config;
}

/* ---------------- Toasts ---------------- */
const TOAST_ICONS = { success: 'check', error: 'x', warn: 'bell', info: 'sparkles' };
export function toast(msg, type = 'info', { action, onAction, duration: dur } = {}) {
  const root = $('#toasts');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="t-ic">${icon(TOAST_ICONS[type] || 'sparkles')}</span><span class="t-msg">${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { onAction && onAction(); close(); };
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  const t = setTimeout(close, dur || Math.min(9000, Math.max(3200, msg.length * 70)));
  function close() { clearTimeout(t); el.classList.add('out'); setTimeout(() => el.remove(), 300); }
  return close;
}

/* ---------------- Modale ---------------- */
export function modal({ title, body = '', actions = [], wide = false, onMount }) {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop';
    bd.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || '')}">
      ${title ? `<h3>${esc(title)}</h3>` : ''}<div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.cls || ''}" data-i="${i}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    const close = (val) => { document.removeEventListener('keydown', onKey); bd.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    bd.addEventListener('click', (e) => {
      if (e.target === bd) return close(null);
      const b = e.target.closest('[data-i]');
      if (b) {
        const a = actions[+b.dataset.i];
        let v = a.value !== undefined ? a.value : a.label;
        if (a.handler) { const r = a.handler(bd); if (r === false) return; if (r !== undefined) v = r; }
        close(v);
      }
    });
    root.appendChild(bd);
    if (onMount) onMount(bd.querySelector('.modal'), close);
    const first = bd.querySelector('input, .btn.primary, .btn');
    if (first) setTimeout(() => first.focus(), 60);
  });
}
export const confirmDialog = (title, text, okLabel = 'Confirmer', danger = false) =>
  modal({ title, body: `<p class="muted">${esc(text)}</p>`, actions: [{ label: 'Annuler', cls: 'ghost', value: false }, { label: okLabel, cls: danger ? 'danger' : 'primary', value: true }] });

/* ---------------- Presse-papiers / partage ---------------- */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove(); return ok;
  }
}
export function shareTo(kind, { link, text = 'Je t\'ai envoyé des fichiers via TransferX', title = 'TransferX' }) {
  const t = encodeURIComponent(text), l = encodeURIComponent(link);
  if (kind === 'native') {
    if (navigator.share) return navigator.share({ title, text, url: link }).catch(() => {});
    return copyText(link).then(() => toast('Lien copié', 'success'));
  }
  const urls = {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text + ' : ' + link)}`,
    telegram: `https://t.me/share/url?url=${l}&text=${t}`,
    sms: `sms:?&body=${encodeURIComponent(text + ' : ' + link)}`,
    mail: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text + ' :\n' + link)}`
  };
  if (urls[kind]) window.open(urls[kind], kind === 'mail' || kind === 'sms' ? '_self' : '_blank', 'noopener');
}

/* ---------------- QR code (bibliothèque locale, chargée à la demande) ---------------- */
let qrLib = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('script')); document.head.appendChild(s); });
}
export async function renderQR(box, text) {
  if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    if (!window.qrcode) { qrLib = qrLib || loadScript('/vendor/qrcode.js'); await qrLib; }
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR code du lien' });
    const svg = box.querySelector('svg'); if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; }
  } catch (e) {
    box.innerHTML = '<span class="tiny" style="color:#04121f;text-align:center">QR indisponible</span>';
  }
}

/* ---------------- Effets ---------------- */
export function animateCount(el, to, fmt = num, ms = 900) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
export function confetti(n = 70) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('lite')) return;
  const colors = ['#00b4d8', '#06d6a0', '#8b7bff', '#fbbf24', '#f472b6', '#e8eef8'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', (Math.random() * 200 - 100) + 'px');
    c.style.setProperty('--rot', (Math.random() * 900 - 450) + 'deg');
    c.style.animationDuration = (1.8 + Math.random() * 1.8) + 's';
    c.style.animationDelay = (Math.random() * .3) + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4200);
  }
}
/** Effet d'ondulation sur tous les boutons */
export function enableRipples() {
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn');
    if (!b || document.documentElement.classList.contains('lite')) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('span');
    const d = Math.max(r.width, r.height);
    s.className = 'ripple';
    s.style.width = s.style.height = d + 'px';
    s.style.left = (e.clientX - r.left - d / 2) + 'px';
    s.style.top = (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }, { passive: true });
}

/* ---------------- Maintien de l'écran allumé ---------------- */
let wakeLock = null, wantWake = false;
export async function keepAwake(on) {
  wantWake = on;
  try {
    if (on && 'wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* non supporté */ }
}
document.addEventListener('visibilitychange', () => { if (wantWake && document.visibilityState === 'visible') keepAwake(true); });

/* ---------------- Notifications système ---------------- */
export function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification(title, { body, icon: '/icon-192.png', tag: 'transferx' });
    }
  } catch (e) { /* ignore */ }
}

/* ---------------- Socket.io (chargé seulement si nécessaire) ---------------- */
let sockPromise = null;
export function getSocket() {
  if (sockPromise) return sockPromise;
  sockPromise = (async () => {
    if (!window.io) await loadScript('/socket.io/socket.io.min.js').catch(() => loadScript('https://cdn.socket.io/4.7.5/socket.io.min.js'));
    const s = window.io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 800, reconnectionDelayMax: 8000 });
    setInterval(() => { if (!document.hidden && s.connected) s.emit('ping-keepalive'); }, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !s.connected) s.connect(); });
    window.addEventListener('pageshow', () => { if (!s.connected) s.connect(); });
    return s;
  })();
  return sockPromise;
}

/* ---------------- Mini-graphiques ---------------- */
export function sparkPath(values, w, h, pad = 2) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => `${i ? 'L' : 'M'}${(pad + i * step).toFixed(1)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`).join(' ');
}
