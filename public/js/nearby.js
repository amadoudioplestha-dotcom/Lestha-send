/* Lestha Send — « À proximité » : partage instantané entre appareils (Android, iPhone, Mac, Windows, Linux)
 * Découverte automatique sur le même Wi-Fi + appareils appairés par code.
 * Les fichiers passent directement d'un appareil à l'autre (WebRTC), jamais par le serveur. */
import { $, $$, esc, icon, bytes, speed, fileKind, ls, toast, modal, confirmDialog, copyText, keepAwake, notify, getSocket, isMobile, lowMemory, renderQR } from './core.js';
import { pick } from './send.js';
import { validateDirectFiles } from './direct-limits.mjs';
import { track, afterSuccess } from './ux.js';

const WINDOW = lowMemory ? 8 << 20 : isMobile ? 24 << 20 : 64 << 20;
const BUF_HIGH = 8 << 20, BUF_LOW = 2 << 20;
const READ = isMobile ? 1 << 20 : 4 << 20;

/* ---------------- identité de l'appareil ---------------- */
function deviceId() {
  let id = ls.get('tx_device_id');
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/[^A-Za-z0-9-]/g, ''); ls.set('tx_device_id', id); }
  return id;
}
function detect() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  const kind = /iPad|Tablet/.test(ua) || os === 'iPad' ? 'tablet' : /Mobi|Android|iPhone/.test(ua) ? 'mobile' : 'desktop';
  const model = (ua.match(/Android [\d.]+; ([^;)]+)\)/) || [])[1];
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const nice = model && !/^K$/.test(model) ? (/^SM-/.test(model) ? 'Galaxy ' + model.replace('SM-', '') : model) : os;
  return { os, kind, name: `${nice}${browser && kind === 'desktop' ? ' · ' + browser : ''}` };
}
const me = () => ({ deviceId: deviceId(), name: ls.get('tx_near_name') || detect().name, kind: detect().kind, os: detect().os });
const pairs = () => ls.get('tx_pairs', []);
const osIcon = (p) => p.kind === 'mobile' ? 'phone' : p.kind === 'tablet' ? 'phone' : 'monitor';

/* ---------------- état ---------------- */
const N = { root: null, sock: null, peers: [], transfers: new Map(), bound: false, joined: false, tag: '', crowded: false };

export default {
  async render(root, { params }) {
    N.root = root;
    renderShell();
    await join();
    const code = params.get('pair');
    if (code && /^\d{6}$/.test(code)) { history.replaceState(history.state, '', '/proximite'); joinPair(code); }
  },
  destroy() {
    N.root = null;
    // on reste visible tant qu'un transfert est en cours
    if (N.sock && ![...N.transfers.values()].some(t => t.status === 'active')) { N.sock.emit('near-leave'); N.joined = false; }
  }
};

async function join() {
  N.sock = await getSocket();
  bindSocket();
  const doJoin = () => N.sock.emit('near-join', Object.assign(me(), { pairs: pairs().map(p => ({ peer: p.peer, token: p.token })) }), (r) => {
    if (r && r.ok) { N.joined = true; N.peers = r.peers; N.crowded = !!r.crowded; N.tag = r.tag || ''; renderTag(); renderPeers(); }
  });
  if (N.sock.connected) doJoin(); else N.sock.once('connect', doJoin);
  N.rejoin = doJoin;
}

function bindSocket() {
  if (N.bound) return;
  N.bound = true;
  const s = N.sock;
  s.on('connect', () => { if (N.root || N.joined) N.rejoin && N.rejoin(); });
  s.on('near-changed', () => s.emit('near-list', (r) => { N.peers = (r && r.peers) || []; N.crowded = !!(r && r.crowded); renderPeers(); }));
  s.on('pair-done', ({ peer, token }) => { savePair(peer, token); toast(`Appareil associé : ${peer.name}`, 'success'); N.rejoin && N.rejoin(); });
  s.on('near-incoming', onIncoming);
  s.on('near-reply', onReply);
  s.on('near-signal', onSignal);
  s.on('near-cancel', ({ offerId }) => { const t = N.transfers.get(offerId); if (t && t.status !== 'done') { fail(t, 'Annulé par l\'autre appareil'); } });
}

function savePair(peer, token) {
  const list = pairs().filter(p => p.peer !== peer.deviceId);
  list.unshift({ peer: peer.deviceId, token, name: peer.name, kind: peer.kind, os: peer.os, at: Date.now() });
  ls.set('tx_pairs', list.slice(0, 50));
}

/* ---------------- interface ---------------- */
function renderShell() {
  const m = me();
  N.root.innerHTML = `
  <section class="stack">
    <div class="dash-head" style="margin-bottom:6px">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span>À proximité</span>
        <h2 style="margin-top:8px">Partage instantané</h2>
        <p class="muted small" style="margin-top:4px;max-width:560px">Ouvrez Lestha Send sur vos autres appareils connectés au même Wi-Fi : ils apparaissent ici. Android, iPhone, Mac, Windows : tout le monde se parle. Les appareils que vous n'avez pas associés ne voient jamais votre nom, seulement un repère comme « Android · <span class="near-tag">K7F</span> ».</p>
      </div>
      <div class="row wrap">
        <button type="button" class="btn sm" id="nPair">${icon('link', 'sm')}Associer un appareil</button>
      </div>
    </div>
    <div class="card glow radar-card">
      <div class="radar" id="radar">
        <span class="radar-ring r1"></span><span class="radar-ring r2"></span><span class="radar-ring r3"></span><span class="radar-sweep"></span>
        <button type="button" class="radar-me" id="nMe" title="Renommer cet appareil">
          <span class="radar-avatar">${icon(osIcon(m), 'lg')}</span>
          <b id="nMeName">${esc(m.name)}</b><small>Cet appareil <span class="near-tag" id="nMeTag"></span> ${icon('edit', 'sm')}</small>
        </button>
        <div id="nPeers"></div>
      </div>
      <p class="center small muted" id="nHint" style="margin-top:14px"></p>
    </div>
    <div class="card" id="nTransfersCard" style="display:none"><div class="card-title"><h3>${icon('bolt')}Transferts</h3></div><div class="stack" style="gap:10px" id="nTransfers"></div></div>
    <div class="tip">${icon('shield')}<span>Les fichiers vont <b>directement</b> d'un appareil à l'autre par le réseau local : rapide, et ça ne consomme pas votre forfait Internet. Certains Wi-Fi publics isolent les appareils : utilisez alors le partage de connexion du téléphone, ou associez vos appareils.</span></div>
  </section>`;
  $('#nMe').onclick = rename;
  $('#nPair').onclick = pairDialog;
  $('#nPeers').onclick = (e) => { const b = e.target.closest('[data-peer]'); if (b) peerMenu(b.dataset.peer); };
  const radar = $('#radar');
  radar.addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
  radar.addEventListener('drop', (e) => {
    const b = e.target.closest('[data-peer]'); if (!b) return;
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) sendFiles(b.dataset.peer, files.map(f => ({ file: f, path: null })));
  });
  renderPeers();
  renderTransfers();
}

function renderTag() {
  const el = N.root && $('#nMeTag', N.root);
  if (el) el.textContent = N.tag ? '· ' + N.tag : '';
}

function renderPeers() {
  if (!N.root) return;
  const box = $('#nPeers'); if (!box) return;
  const list = N.peers;
  const n = list.length;
  box.innerHTML = list.map((p, i) => {
    const ang = (-90 + (360 / Math.max(n, 1)) * i + (n === 1 ? 0 : 20)) * Math.PI / 180;
    const r = 38;
    const x = 50 + Math.cos(ang) * r, y = 50 + Math.sin(ang) * r;
    return `<button type="button" class="radar-peer" data-peer="${esc(p.deviceId)}" style="left:${x}%;top:${y}%;animation-delay:${i * 80}ms" title="Envoyer à ${esc(p.name)}">
      <span class="radar-avatar peer">${icon(osIcon(p), 'lg')}${p.paired ? `<i class="peer-badge" title="Appareil associé">${icon('link', 'sm')}</i>` : ''}</span>
      <b>${esc(p.name)}</b><small>${p.via === 'paired' ? 'Associé · à distance' : esc(p.os || 'Même réseau')}</small>
    </button>`;
  }).join('');
  const hint = $('#nHint');
  const crowd = N.crowded ? `<br><span style="color:var(--amber, #fbbf24)">Vous êtes sur un réseau partagé par beaucoup de monde (données mobiles, Wi-Fi public) : pour votre sécurité, seuls vos appareils associés apparaissent. Touchez « Associer un appareil ».</span>` : '';
  if (hint) hint.innerHTML = (n ? `Touchez un appareil pour lui envoyer des fichiers ou du texte${isMobile ? '' : ' — ou glissez des fichiers dessus'}. Vérifiez son repère (${esc(N.tag ? 'le vôtre : ' + N.tag : 'trois caractères')}) avant d'envoyer.` : `<span class="spinner" style="display:inline-block;vertical-align:middle;width:16px;height:16px;border-width:2px;margin-right:8px"></span>Recherche d'appareils… Ouvrez <b>${esc(location.host)}/proximite</b> sur l'autre appareil.`) + crowd;
}

async function rename() {
  const v = await modal({ title: 'Nom de cet appareil', body: `<p class="small muted" style="margin-bottom:10px">C'est le nom que verront vos autres appareils.</p><input class="input" id="dn" maxlength="40" value="${esc(me().name)}">`, actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Enregistrer', cls: 'primary', handler: (bd) => bd.querySelector('#dn').value.trim() || false }] });
  if (!v) return;
  ls.set('tx_near_name', v);
  const el = $('#nMeName'); if (el) el.textContent = v;
  N.sock.emit('near-rename', v);
}

async function peerMenu(id) {
  const p = N.peers.find(x => x.deviceId === id); if (!p) return;
  const choice = await modal({
    title: 'Envoyer à ' + p.name,
    body: `<div class="share-grid near-actions">
      <button type="button" class="btn" data-v="files">${icon('file')}Fichiers</button>
      ${isMobile ? `<button type="button" class="btn" data-v="gallery">${icon('image')}Photos</button>` : `<button type="button" class="btn" data-v="folder">${icon('folder')}Dossier</button>`}
      <button type="button" class="btn" data-v="text">${icon('clipboard')}Texte / lien</button>
      <button type="button" class="btn" data-v="paste">${icon('copy')}Mon presse-papiers</button>
    </div>`,
    actions: [{ label: 'Fermer', cls: 'ghost', value: null }],
    onMount: (m, close) => m.querySelectorAll('[data-v]').forEach(b => b.onclick = () => close(b.dataset.v))
  });
  if (!choice) return;
  if (choice === 'text') {
    const text = await modal({ title: 'Texte ou lien à envoyer', body: '<textarea class="input" id="ntx" maxlength="20000" placeholder="Collez ou écrivez ici…" style="min-height:120px"></textarea>', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Envoyer', cls: 'primary', icon: 'arrow-right', handler: (bd) => bd.querySelector('#ntx').value || false }] });
    if (text) sendText(id, text);
  } else if (choice === 'paste') {
    try { const t = await navigator.clipboard.readText(); if (!t) return toast('Presse-papiers vide', 'warn'); sendText(id, t); }
    catch (e) { toast('Accès au presse-papiers refusé par le navigateur : utilisez « Texte / lien »', 'warn'); }
  } else {
    const files = await pick(choice);
    if (files.length) sendFiles(id, files.map(f => ({ file: f, path: choice === 'folder' ? f.webkitRelativePath || null : null })));
  }
}

/* ---------------- appairage ---------------- */
async function pairDialog() {
  const list = pairs();
  await modal({
    title: 'Associer un appareil',
    body: `<p class="small muted" style="margin-bottom:14px">Une fois associés, vos appareils se retrouvent <b>même sur des réseaux différents</b> (le transfert passe alors par Internet).</p>
      <div class="segmented" id="pTabs" data-value="cloud" style="margin-bottom:14px"><span class="seg-pill"></span><button type="button" class="active" data-t="show">Afficher un code</button><button type="button" data-t="enter">Saisir un code</button></div>
      <div id="pBody"></div>
      ${list.length ? `<h3 style="margin:18px 0 8px">Appareils associés</h3><div class="stack" style="gap:6px">${list.map(p => `<div class="receiver-item"><div class="receiver-top"><span class="row">${icon(osIcon(p), 'sm')}<b>${esc(p.name)}</b></span><button type="button" class="btn sm ghost" data-unpair="${esc(p.peer)}">Retirer</button></div></div>`).join('')}</div>` : ''}`,
    actions: [{ label: 'Fermer', cls: 'ghost', value: null }],
    onMount: (m, close) => {
      const body = m.querySelector('#pBody');
      const show = () => {
        body.innerHTML = `<div class="center"><div class="spinner" style="margin:20px auto"></div></div>`;
        N.sock.emit('pair-create', (r) => {
          if (!r || !r.code) { body.innerHTML = '<p class="small">Connexion impossible.</p>'; return; }
          const url = `${location.origin}/proximite?pair=${r.code}`;
          body.innerHTML = `<div class="qr-card" style="justify-content:center"><div class="qr" id="pQr"></div><div class="stack" style="gap:6px"><span class="small muted">Sur l'autre appareil, saisissez :</span><div class="pair-code">${r.code.slice(0, 3)} ${r.code.slice(3)}</div><span class="tiny faint">ou scannez le QR code · valable 5 minutes</span></div></div>`;
          renderQR(m.querySelector('#pQr'), url);
        });
      };
      const enter = () => {
        body.innerHTML = `<form id="pf" class="stack" style="gap:10px"><input class="input pin-input" id="pc" inputmode="numeric" maxlength="7" placeholder="123 456" autocomplete="off"><button class="btn primary" type="submit">${icon('link')}Associer</button></form>`;
        const f = m.querySelector('#pf');
        f.onsubmit = (e) => { e.preventDefault(); const v = m.querySelector('#pc').value.replace(/\D/g, ''); if (v.length !== 6) return toast('Le code contient 6 chiffres', 'warn'); close(null); joinPair(v); };
        setTimeout(() => m.querySelector('#pc').focus(), 50);
      };
      m.querySelector('#pTabs').onclick = (e) => {
        const b = e.target.closest('[data-t]'); if (!b) return;
        m.querySelectorAll('#pTabs button').forEach(x => x.classList.toggle('active', x === b));
        m.querySelector('#pTabs').dataset.value = b.dataset.t === 'show' ? 'cloud' : 'p2p';
        b.dataset.t === 'show' ? show() : enter();
      };
      m.querySelectorAll('[data-unpair]').forEach(b => b.onclick = () => { ls.set('tx_pairs', pairs().filter(p => p.peer !== b.dataset.unpair)); b.closest('.receiver-item').remove(); N.rejoin && N.rejoin(); });
      show();
    }
  });
}
function joinPair(code) {
  N.sock.emit('pair-join', code, (r) => {
    if (!r || !r.ok) return toast((r && r.error) || 'Association impossible', 'error');
    savePair(r.peer, r.token);
    toast(`Appareil associé : ${r.peer.name}`, 'success');
    N.rejoin && N.rejoin();
  });
}

/* ---------------- envoi ---------------- */
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function sendText(to, text) {
  N.sock.emit('near-send', { to, kind: 'text', offerId: newId(), text }, (r) => {
    if (r && r.ok) toast('Texte envoyé ✅', 'success'); else toast((r && r.error) || 'Envoi impossible', 'error');
  });
}

function sendFiles(to, items) {
  const validation = validateDirectFiles(items.map(it => it.file));
  if (!validation.ok) return toast(validation.error, 'error');
  const peer = N.peers.find(p => p.deviceId === to) || { name: 'Appareil' };
  const offerId = newId();
  const files = items.map(it => ({ name: it.path || it.file.name, size: it.file.size, type: it.file.type || 'application/octet-stream' }));
  const t = { id: offerId, dir: 'out', peer: to, peerName: peer.name, files, items, total: files.reduce((s, f) => s + f.size, 0), pos: 0, acked: 0, status: 'waiting', samples: [], waiters: [] };
  N.transfers.set(offerId, t);
  renderTransfers();
  N.sock.emit('near-send', { to, kind: 'files', offerId, files }, (r) => { if (!r || !r.ok) fail(t, (r && r.error) || 'Appareil injoignable'); });
}

function onReply({ from, offerId, accept }) {
  const t = N.transfers.get(offerId); if (!t || t.dir !== 'out') return;
  if (!accept) return fail(t, `${from.name} a refusé`);
  t.status = 'active'; keepAwake(true);
  startSender(t);
  renderTransfers();
}

async function iceServers() {
  try { return (await (await fetch('/api/ice-config', { cache: 'no-store' })).json()).iceServers; } catch (e) { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
}
function signal(t, data) { N.sock.emit('near-signal', { to: t.peer, offerId: t.id, data }); }

async function startSender(t) {
  const pc = t.pc = new RTCPeerConnection({ iceServers: await iceServers() });
  const dc = t.dc = pc.createDataChannel('near', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUF_LOW;
  pc.onicecandidate = (e) => { if (e.candidate) signal(t, { ice: e.candidate }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail(t, 'Connexion impossible entre les deux appareils'); };
  dc.onbufferedamountlow = () => wake(t);
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.t === 'ack') { t.acked = m.pos; wake(t); }
    else if (m.t === 'done') done(t);
    else if (m.t === 'error') fail(t, m.message);
  };
  dc.onopen = () => pump(t);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal(t, { sdp: pc.localDescription });
}
function wake(t) { t.waiters.splice(0).forEach(f => f()); }
const wait = (t) => new Promise(r => { t.waiters.push(r); setTimeout(r, 800); });

async function pump(t) {
  const dc = t.dc;
  const max = (t.pc.sctp && t.pc.sctp.maxMessageSize) || 65536;
  const chunk = max >= 262144 ? 256 * 1024 : max >= 65536 ? 64 * 1024 : 16 * 1024;
  try {
    for (let i = 0; i < t.items.length; i++) {
      const file = t.items[i].file;
      dc.send(JSON.stringify({ t: 'file', i }));
      for (let off = 0; off < file.size;) {
        const buf = await file.slice(off, Math.min(off + READ, file.size)).arrayBuffer();
        for (let p = 0; p < buf.byteLength; p += chunk) {
          while ((dc.bufferedAmount > BUF_HIGH || t.pos - t.acked > WINDOW) && dc.readyState === 'open' && t.status === 'active') await wait(t);
          if (dc.readyState !== 'open' || t.status !== 'active') return;
          const part = buf.slice(p, Math.min(p + chunk, buf.byteLength));
          dc.send(part); t.pos += part.byteLength;
        }
        off += buf.byteLength;
      }
      dc.send(JSON.stringify({ t: 'end', i }));
    }
    dc.send(JSON.stringify({ t: 'all' }));
  } catch (e) { fail(t, 'Envoi interrompu : ' + e.message); }
}

/* ---------------- réception ---------------- */
async function onIncoming(p) {
  if (p.kind === 'text') {
    const isUrl = /^https?:\/\/\S+$/.test(p.text.trim());
    notify('Texte reçu de ' + p.from.name, p.text.slice(0, 80));
    const act = await modal({
      title: `${p.from.name} vous envoie ${isUrl ? 'un lien' : 'un texte'}`,
      body: `<div class="message-bubble" style="max-height:50vh;overflow:auto">${esc(p.text)}</div>`,
      actions: [{ label: 'Fermer', cls: 'ghost', value: null }, ...(isUrl ? [{ label: 'Ouvrir', icon: 'external', value: 'open' }] : []), { label: 'Copier', cls: 'primary', icon: 'copy', value: 'copy' }]
    });
    if (act === 'copy') { await copyText(p.text); toast('Copié dans le presse-papiers', 'success'); }
    if (act === 'open') window.open(p.text.trim(), '_blank', 'noopener');
    return;
  }
  const validation = validateDirectFiles(p.files);
  if (!validation.ok || validation.total !== p.total) {
    N.sock.emit('near-reply', { to: p.from.deviceId, offerId: p.offerId, accept: false });
    toast(validation.error || 'Métadonnées du transfert invalides.', 'error');
    return;
  }
  notify('Fichiers entrants', `${p.from.name} veut vous envoyer ${p.files.length} fichier(s)`);
  const accept = await modal({
    title: `${p.from.name} veut vous envoyer ${p.files.length} fichier${p.files.length > 1 ? 's' : ''}`,
    body: `<p class="small muted" style="margin-bottom:10px">${bytes(p.total)} · directement depuis l'appareil</p><div class="file-list" style="max-height:240px">${p.files.slice(0, 50).map(f => { const k = fileKind(f.name, f.type); return `<div class="file-row"><div class="ficon" style="--c:${k.c};width:34px;height:34px">${icon(k.icon, 'sm')}</div><div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${bytes(f.size)}</div></div></div>`; }).join('')}${p.files.length > 50 ? `<div class="small faint center">+ ${p.files.length - 50} autres</div>` : ''}</div>`,
    actions: [{ label: 'Refuser', cls: 'ghost', value: false }, { label: 'Accepter', cls: 'primary', icon: 'download', value: true }]
  });
  if (!accept) {
    N.sock.emit('near-reply', { to: p.from.deviceId, offerId: p.offerId, accept: false });
    return;
  }
  const t = { id: p.offerId, dir: 'in', peer: p.from.deviceId, peerName: p.from.name, files: p.files, total: p.total, pos: 0, status: 'active', samples: [], cur: -1, curPos: 0, parts: null, buf: [], bufBytes: 0, writing: Promise.resolve(), written: [], mode: null };
  N.transfers.set(t.id, t);
  try {
    await initNearSink(t);
  } catch (e) {
    N.sock.emit('near-reply', { to: p.from.deviceId, offerId: p.offerId, accept: false });
    fail(t, e.message);
    return;
  }
  N.sock.emit('near-reply', { to: p.from.deviceId, offerId: p.offerId, accept: true });
  keepAwake(true);
  if (location.pathname !== '/proximite') toast(`Réception depuis ${p.from.name}…`, 'info', { action: 'Voir', onAction: () => { history.pushState({ idx: ((history.state && history.state.idx) || 0) + 1 }, '', '/proximite'); dispatchEvent(new PopStateEvent('popstate')); } });
  renderTransfers();
}

function onSignal({ offerId, data }) {
  const t = N.transfers.get(offerId); if (!t || !data) return;
  // traitement strictement séquentiel : les candidats ICE ne passent jamais avant la description SDP
  t.sigQ = (t.sigQ || Promise.resolve()).then(() => handleSignal(t, data));
}
async function handleSignal(t, data) {
  try {
    if (t.dir === 'in') {
      if (data.sdp) {
        const pc = t.pc = new RTCPeerConnection({ iceServers: await iceServers() });
        pc.onicecandidate = (e) => { if (e.candidate) signal(t, { ice: e.candidate }); };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && t.status === 'active') fail(t, 'Connexion impossible entre les deux appareils'); };
        pc.ondatachannel = (e) => setupReceiver(t, e.channel);
        await pc.setRemoteDescription(data.sdp);
        (t.pendingIce || []).forEach(c => pc.addIceCandidate(c).catch(() => {}));
        await pc.setLocalDescription(await pc.createAnswer());
        signal(t, { sdp: pc.localDescription });
      } else if (data.ice) { if (t.pc && t.pc.remoteDescription) t.pc.addIceCandidate(data.ice).catch(() => {}); else (t.pendingIce = t.pendingIce || []).push(data.ice); }
    } else {
      if (data.sdp) await t.pc.setRemoteDescription(data.sdp);
      else if (data.ice) t.pc.addIceCandidate(data.ice).catch(() => {});
    }
  } catch (e) { console.warn('near signal', e); }
}

function setupReceiver(t, dc) {
  dc.binaryType = 'arraybuffer';
  t.dc = dc;
  t.lastAck = 0;
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'file') {
        if (!Number.isInteger(m.i) || m.i < 0 || m.i >= t.files.length) return fail(t, 'Séquence de fichiers invalide.');
        flushNearBuffer(t); t.cur = m.i; t.curPos = 0;
      } else if (m.t === 'end') { flushNearBuffer(t); t.cur = -1; }
      else if (m.t === 'all') finishReceive(t).catch(e => fail(t, e.message));
      return;
    }
    if (t.cur < 0 || t.status !== 'active') return;
    if (t.curPos + e.data.byteLength > t.files[t.cur].size || t.pos + e.data.byteLength > t.total) {
      return fail(t, 'Le volume reçu ne correspond pas aux fichiers annoncés.');
    }
    t.buf.push(e.data);
    t.bufBytes += e.data.byteLength;
    t.pos += e.data.byteLength;
    t.curPos += e.data.byteLength;
    const memLimit = isMobile ? 500 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
    if (t.mode === 'memory' && t.pos > memLimit) {
      const message = `Le stockage disque sécurisé n'est pas disponible dans ce navigateur. La réception en mémoire est limitée à ${bytes(memLimit)} ; ouvrez Lestha Send dans un navigateur récent avec stockage OPFS.`;
      try { dc.send(JSON.stringify({ t: 'error', message })); } catch (x) { /* ignore */ }
      return fail(t, message);
    }
    if (t.bufBytes >= 2 * 1024 * 1024) flushNearBuffer(t);
  };
}

function supportsWorkerOPFS() { return !!(window.Worker && navigator.storage && navigator.storage.getDirectory && window.FileSystemFileHandle && isSecureContext); }

async function initNearSink(t) {
  const validation = validateDirectFiles(t.files);
  if (!validation.ok) throw new Error(validation.error);
  if (validation.total !== t.total) throw new Error('Métadonnées du transfert invalides.');
  if (supportsWorkerOPFS()) {
    let quotaFailure = false;
    try {
      t.worker = new Worker('/js/opfs-worker.js');
      t.wcb = new Map();
      t.wid = 0;
      t.worker.onmessage = (e) => {
        const cb = t.wcb.get(e.data.id);
        if (!cb) return;
        t.wcb.delete(e.data.id);
        e.data.ok ? cb.resolve(e.data) : cb.reject(new Error(e.data.error));
      };
      try { await navigator.storage.persist(); } catch (e) { /* ignore */ }
      const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && t.total > estimate.quota - estimate.usage) {
        quotaFailure = true;
        throw new Error(`Espace disque insuffisant : il faut ${bytes(t.total)} libres sur cet appareil.`);
      }
      for (let i = 0; i < t.files.length; i++) {
        await nearWorkerCall(t, { cmd: 'open', name: nearFileName(t, i) });
        await nearWorkerCall(t, { cmd: 'truncate', name: nearFileName(t, i), size: 0 });
      }
      t.mode = 'disk';
      t.written = t.files.map(() => 0);
      ls.set('tx_near_recv_' + t.id, { at: Date.now() });
      return;
    } catch (e) {
      if (t.worker) {
        t.worker.terminate();
        t.worker = null;
        if (navigator.storage && navigator.storage.getDirectory) {
          navigator.storage.getDirectory().then(async root => {
            for (let i = 0; i < t.files.length; i++) await root.removeEntry(nearFileName(t, i)).catch(() => {});
          }).catch(() => {});
        }
      }
      if (quotaFailure) throw e;
      console.warn('OPFS indisponible', e);
    }
  }
  const limit = isMobile ? 500 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
  if (t.total > limit) throw new Error(`Le stockage disque sécurisé n'est pas disponible dans ce navigateur. La réception en mémoire est limitée à ${bytes(limit)} ; ouvrez Lestha Send dans un navigateur récent avec stockage OPFS.`);
  t.mode = 'memory';
  t.parts = t.files.map(() => []);
  t.written = t.files.map(() => 0);
}

const nearFileName = (t, i) => `near_${t.id}_${i}`;

function nearWorkerCall(t, msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++t.wid;
    t.wcb.set(id, { resolve, reject });
    t.worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
}

function flushNearBuffer(t) {
  if (!t.bufBytes || t.cur < 0 || t.status !== 'active') return t.writing;
  const index = t.cur, pos = t.curPos - t.bufBytes, data = new Uint8Array(t.bufBytes);
  let offset = 0;
  for (const part of t.buf) { data.set(new Uint8Array(part), offset); offset += part.byteLength; }
  t.buf = [];
  t.bufBytes = 0;
  t.writing = t.writing.then(async () => {
    if (t.mode === 'disk') await nearWorkerCall(t, { cmd: 'write', name: nearFileName(t, index), pos, data: data.buffer }, [data.buffer]);
    else t.parts[index].push(data);
    t.written[index] = pos + offset;
    const committed = t.written.reduce((sum, size) => sum + size, 0);
    if (committed - t.lastAck >= 2 * 1024 * 1024 && t.dc.readyState === 'open') {
      t.lastAck = committed;
      t.dc.send(JSON.stringify({ t: 'ack', pos: committed }));
    }
  });
  t.writing.catch(e => {
    try { if (t.dc.readyState === 'open') t.dc.send(JSON.stringify({ t: 'error', message: 'Écriture du fichier impossible : ' + e.message })); } catch (x) { /* ignore */ }
    fail(t, 'Écriture du fichier impossible : ' + e.message);
  });
  return t.writing;
}

async function finishReceive(t) {
  if (t.finishing || t.status !== 'active') return;
  t.finishing = true;
  await flushNearBuffer(t);
  await t.writing;
  if (t.written.some((size, index) => size !== t.files[index].size)) {
    const message = 'Réception incomplète : certains fichiers ne correspondent pas à la taille annoncée.';
    try { if (t.dc.readyState === 'open') t.dc.send(JSON.stringify({ t: 'error', message })); } catch (e) { /* ignore */ }
    fail(t, message);
    return;
  }
  const urls = [];
  if (t.mode === 'disk') {
    await Promise.all(t.files.map((f, i) => nearWorkerCall(t, { cmd: 'close', name: nearFileName(t, i) })));
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < t.files.length; i++) {
      const file = t.files[i], handle = await root.getFileHandle(nearFileName(t, i));
      const received = await handle.getFile();
      if (received.size !== file.size) throw new Error('Le fichier enregistré ne correspond pas à la taille annoncée.');
      urls.push({ name: file.name.split('/').pop(), path: file.name, size: file.size, type: file.type, url: URL.createObjectURL(received) });
    }
    t.worker.terminate();
    t.worker = null;
  } else {
    t.files.forEach((file, i) => urls.push({ name: file.name.split('/').pop(), path: file.name, size: file.size, type: file.type, url: URL.createObjectURL(new Blob(t.parts[i], { type: file.type })) }));
    t.parts = null;
  }
  t.urls = urls;
  try { t.dc.send(JSON.stringify({ t: 'done' })); } catch (e) { /* ignore */ }
  done(t);
}

/* ---------------- suivi ---------------- */
function done(t) {
  t.status = 'done'; t.pos = t.total;
  if (t.dir === 'out') { track('sent', { m: 'nearby', b: t.total }); afterSuccess('nearby'); } else track('got', { m: 'nearby' });
  setTimeout(() => { try { t.pc && t.pc.close(); } catch (e) { /* ignore */ } }, 1500);
  if (![...N.transfers.values()].some(x => x.status === 'active')) keepAwake(false);
  toast(t.dir === 'in' ? `Reçu de ${t.peerName} ✅` : `Envoyé à ${t.peerName} ✅`, 'success');
  if (t.dir === 'in') notify('Réception terminée', `${t.files.length} fichier(s) de ${t.peerName}`);
  renderTransfers();
}
function fail(t, msg) {
  if (t.status === 'done' || t.status === 'failed') return;
  t.status = 'failed'; t.error = msg;
  try { t.pc && t.pc.close(); } catch (e) { /* ignore */ }
  if (t.dir === 'in' && t.worker) {
    const worker = t.worker;
    nearWorkerCall(t, { cmd: 'closeAll' }).catch(() => {}).finally(async () => {
      t.worker = null;
      worker.terminate();
      if (navigator.storage && navigator.storage.getDirectory) {
        try {
          const root = await navigator.storage.getDirectory();
          for (let i = 0; i < t.files.length; i++) await root.removeEntry(nearFileName(t, i)).catch(() => {});
        } catch (e) { console.warn('Nettoyage du transfert OPFS impossible', e); }
      }
    });
    ls.del('tx_near_recv_' + t.id);
  }
  if (t.dir === 'in') { t.buf = []; t.bufBytes = 0; t.parts = null; }
  if (![...N.transfers.values()].some(x => x.status === 'active')) keepAwake(false);
  toast(msg, 'error');
  renderTransfers();
}

let ticker = null;
function renderTransfers() {
  if (!N.root) return;
  const card = $('#nTransfersCard'), box = $('#nTransfers'); if (!box) return;
  const list = [...N.transfers.values()].reverse();
  card.style.display = list.length ? '' : 'none';
  const now = Date.now();
  box.innerHTML = list.map(t => {
    t.samples.push({ t: now, b: t.pos }); while (t.samples.length > 6) t.samples.shift();
    const a = t.samples[0], z = t.samples[t.samples.length - 1];
    const sp = z.t > a.t ? (z.b - a.b) / ((z.t - a.t) / 1000) : 0;
    const pct = t.total ? Math.min(100, Math.round(t.pos / t.total * 100)) : 100;
    const label = t.status === 'waiting' ? 'En attente d\'acceptation…' : t.status === 'failed' ? esc(t.error || 'Échec') : t.status === 'done' ? (t.dir === 'in' ? 'Reçu' : 'Envoyé') : `${pct} % · ${speed(sp)}`;
    return `<div class="receiver-item">
      <div class="receiver-top"><span class="row">${icon(t.dir === 'in' ? 'download' : 'upload', 'sm')}<b>${t.dir === 'in' ? 'De' : 'Vers'} ${esc(t.peerName)}</b><span class="small faint">· ${t.files.length} fichier(s) · ${bytes(t.total)}</span></span>
      <span class="pill ${t.status === 'done' ? 'ok' : t.status === 'failed' ? 'bad' : 'info'}">${label}</span></div>
      <div class="progress-bar"><i style="width:${t.status === 'done' ? 100 : pct}%"></i></div>
      ${t.dir === 'in' && t.status === 'done' ? `<div class="stack" style="gap:6px;margin-top:10px">${t.urls.map(f => { const k = fileKind(f.name, f.type); return `<div class="dl-row"><div class="ficon" style="--c:${k.c};width:36px;height:36px">${f.type.startsWith('image/') && f.size < 20e6 ? `<img src="${f.url}" alt="">` : icon(k.icon, 'sm')}</div><div class="fmeta"><div class="fname">${esc(f.path)}</div><div class="fsub">${bytes(f.size)}</div></div><a class="btn sm primary dl-btn" href="${f.url}" download="${esc(f.name)}">${icon('download', 'sm')}<span>Enregistrer</span></a></div>`; }).join('')}
        ${t.urls.length > 1 ? `<button type="button" class="btn sm" data-saveall="${esc(t.id)}">${icon('download', 'sm')}Tout enregistrer</button>` : ''}</div>` : ''}
      ${t.status === 'active' || t.status === 'waiting' ? `<div style="margin-top:8px"><button type="button" class="btn sm ghost" data-cancel="${esc(t.id)}">${icon('x', 'sm')}Annuler</button></div>` : ''}
    </div>`;
  }).join('');
  box.onclick = async (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) { const t = N.transfers.get(c.dataset.cancel); if (t && await confirmDialog('Annuler ce transfert ?', '', 'Annuler le transfert', true)) { N.sock.emit('near-cancel', { to: t.peer, offerId: t.id }); fail(t, 'Transfert annulé'); } }
    const s = e.target.closest('[data-saveall]');
    if (s) { for (const a of s.parentElement.querySelectorAll('a[download]')) { a.click(); await new Promise(r => setTimeout(r, 700)); } }
  };
  clearInterval(ticker);
  if (list.some(t => t.status === 'active')) ticker = setInterval(renderTransfers, 800);
}
