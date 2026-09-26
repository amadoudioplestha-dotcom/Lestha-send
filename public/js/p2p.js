/* TransferX — mode Direct P2P (WebRTC, zéro stockage)
 * Améliorations clés :
 *  - le lien SURVIT quand l'expéditeur quitte l'appli un instant (veille, autre appli, réseau)
 *  - reprise à l'octet près (écriture disque en place côté destinataire)
 *  - plusieurs fichiers / dossiers envoyés à la suite, sans ZIP ni copie
 *  - contrôle de flux : la mémoire du téléphone destinataire ne sature plus
 */
import { $, esc, icon, bytes, speed, duration, timeLeft, fileKind, ls, toast, modal, renderQR, keepAwake, notify, getSocket, confetti, isMobile, lowMemory, confirmDialog } from './core.js';
import { navigate } from './router.js';

const HOUR = 3600e3;
const WINDOW = lowMemory ? 8 * 1024 * 1024 : isMobile ? 24 * 1024 * 1024 : 64 * 1024 * 1024;
const BUF_HIGH = 8 * 1024 * 1024, BUF_LOW = 2 * 1024 * 1024;
const READ_SIZE = isMobile ? 1024 * 1024 : 4 * 1024 * 1024;

let iceServers = null;
async function getIce() {
  if (iceServers) return iceServers;
  try { iceServers = (await (await fetch('/api/ice-config', { cache: 'no-store' })).json()).iceServers; }
  catch (e) { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  return iceServers;
}
const emitAck = (socket, ev, data) => new Promise((res) => { socket.timeout(10000).emit(ev, data, (err, r) => res(err ? null : r)); });

/* ======================================================================
   EXPÉDITEUR
   ====================================================================== */
const P = { active: false, peers: new Map(), downloads: 0, socketBound: false, online: true };
let senderRoot = null, tick = null;

export const isSending = () => P.active;

function roomLink() { return location.origin + '/?room=' + encodeURIComponent(P.roomId); }
function sig(items) { return items.map(it => ({ name: it.file.name, size: it.file.size, lastModified: it.file.lastModified, path: it.path || null })); }

export async function startSend(items, { ttl, pin, destroy }) {
  const socket = await getSocket();
  bindSenderSocket(socket);
  if (!socket.connected) await new Promise(r => socket.once('connect', r));
  const info = { files: items.map(it => ({ name: it.path || it.file.name, size: it.file.size })) };
  const r = await emitAck(socket, 'create-room', { ttl, pin: pin || null, destroyOnDownload: !!destroy, info });
  if (!r || !r.success) throw new Error('Impossible de créer le lien. Réessayez.');
  Object.assign(P, { active: true, roomId: r.roomId, senderKey: r.senderKey, expiresAt: r.expiresAt, pin: pin || '', destroy: !!destroy, items, info, total: items.reduce((s, it) => s + it.file.size, 0), downloads: 0 });
  P.peers.clear();
  ls.set('tx_p2p_active', { roomId: P.roomId, senderKey: P.senderKey, expiresAt: P.expiresAt, pin: P.pin, destroy: P.destroy, info, sig: sig(items) });
  const hist = ls.get('transferx_history', []);
  hist.unshift({ roomId: P.roomId, expiresAt: P.expiresAt, fileName: items.length === 1 ? items[0].file.name : (items[0].path ? items[0].path.split('/')[0] : items.length + ' fichiers'), fileSize: P.total, fileCount: items.length, pin: P.pin || null, createdAt: Date.now(), downloadCount: 0, destroyOnDownload: P.destroy });
  ls.set('transferx_history', hist.slice(0, 100));
  keepAwake(true);
}

/** Après un rechargement de page : réactiver le lien direct avec les mêmes fichiers */
export function restorable() {
  const a = ls.get('tx_p2p_active', null);
  if (!a || P.active) return null;
  if (Date.now() > a.expiresAt) { ls.del('tx_p2p_active'); return null; }
  return a;
}
export async function restore(pickFn) {
  const a = restorable(); if (!a) return false;
  const matched = [];
  const need = a.sig.slice();
  while (matched.length < need.length) {
    const files = await pickFn(need.some(s => s.path) ? 'folder' : 'files');
    if (!files.length) return false;
    for (const s of need) {
      if (matched.find(m => m.sig === s)) continue;
      const f = files.find(x => x.name === s.name && x.size === s.size);
      if (f) matched.push({ sig: s, file: f, path: s.path });
    }
    if (matched.length < need.length) toast(`${matched.length}/${need.length} fichiers retrouvés — sélectionnez les autres`, 'warn');
  }
  const items = need.map(s => { const m = matched.find(x => x.sig === s); return { file: m.file, path: m.path }; });
  const socket = await getSocket();
  bindSenderSocket(socket);
  if (!socket.connected) await new Promise(r => socket.once('connect', r));
  Object.assign(P, { active: true, roomId: a.roomId, senderKey: a.senderKey, expiresAt: a.expiresAt, pin: a.pin, destroy: a.destroy, items, info: a.info, total: items.reduce((s, it) => s + it.file.size, 0) });
  const ok = await reclaim(socket);
  if (!ok) { P.active = false; ls.del('tx_p2p_active'); toast('Ce lien direct a expiré', 'error'); return false; }
  keepAwake(true);
  toast('Lien direct réactivé', 'success');
  return true;
}
export function forgetRestorable() { ls.del('tx_p2p_active'); }

async function reclaim(socket) {
  const r = await emitAck(socket, 'reclaim-room', { roomId: P.roomId, senderKey: P.senderKey, expiresAt: P.expiresAt, pin: P.pin || null, destroyOnDownload: P.destroy, info: P.info });
  if (!r || !r.success) return false;
  if (typeof r.downloadCount === 'number') P.downloads = Math.max(P.downloads, r.downloadCount);
  (r.receivers || []).forEach(id => createPeer(socket, id));
  renderSenderLive();
  return true;
}

function bindSenderSocket(socket) {
  if (P.socketBound) return;
  P.socketBound = true;
  socket.on('connect', async () => {
    P.online = true; renderSenderLive();
    if (P.active) { const ok = await reclaim(socket); if (!ok) { toast('Le lien direct a expiré', 'error'); stopSend(false); } }
  });
  socket.on('disconnect', () => { P.online = false; renderSenderLive(); });
  socket.on('receiver-joined', ({ receiverId }) => { if (P.active && receiverId) createPeer(socket, receiverId); });
  socket.on('answer-received', async ({ answer, receiverId }) => {
    const peer = P.peers.get(receiverId); if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(answer);
      peer.pending.splice(0).forEach(c => peer.pc.addIceCandidate(c).catch(() => {}));
    } catch (e) { console.warn('answer', e); }
  });
  socket.on('ice-candidate', ({ candidate, from }) => {
    const peer = P.peers.get(from); if (!peer || !candidate) return;
    if (peer.pc.remoteDescription) peer.pc.addIceCandidate(candidate).catch(() => {}); else peer.pending.push(candidate);
  });
  socket.on('receiver-left', ({ receiverId }) => {
    const peer = P.peers.get(receiverId);
    if (peer) { if (!peer.done) peer.status = 'left'; try { peer.pc.close(); } catch (e) { /* ignore */ } }
    renderSenderLive();
  });
  socket.on('download-notification', ({ totalDownloads }) => {
    P.downloads = totalDownloads || P.downloads + 1;
    const hist = ls.get('transferx_history', []);
    const h = hist.find(x => x.roomId === P.roomId); if (h) { h.downloadCount = P.downloads; ls.set('transferx_history', hist); }
    toast('Téléchargement #' + P.downloads + ' terminé ✅', 'success');
    notify('Fichiers téléchargés', 'Un destinataire a terminé le téléchargement');
    renderSenderLive();
  });
  socket.on('transfer-destroyed', () => { toast('Lien auto-détruit après le téléchargement 🔥', 'info'); stopSend(false); });
}

async function createPeer(socket, receiverId) {
  const old = P.peers.get(receiverId);
  if (old) { old.gen = (old.gen || 0) + 1; try { old.pc.close(); } catch (e) { /* ignore */ } }
  const pc = new RTCPeerConnection({ iceServers: await getIce() });
  const dc = pc.createDataChannel('file', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUF_LOW;
  const peer = { id: receiverId, pc, dc, pending: [], status: 'connexion', pos: 0, acked: 0, speed: 0, samples: [], done: old ? old.done : false, gen: 0, waiters: [] };
  P.peers.set(receiverId, peer);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('ice-candidate', { roomId: P.roomId, candidate: e.candidate, targetId: receiverId }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { peer.status = 'reconnexion'; renderSenderLive(); }
  };
  dc.onbufferedamountlow = () => wake(peer);
  dc.onopen = () => {
    peer.status = 'connecté';
    dc.send(JSON.stringify({ msgType: 'metadata', v: 2, total: P.total, files: P.items.map(it => ({ name: it.file.name, path: it.path || null, size: it.file.size, type: it.file.type || 'application/octet-stream' })) }));
    renderSenderLive();
  };
  dc.onclose = () => { peer.gen++; wake(peer); if (!peer.done && peer.status !== 'left') peer.status = 'interrompu'; renderSenderLive(); };
  dc.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.msgType === 'resume') streamFrom(peer, m.fileIndex || 0, m.offset || 0);
    else if (m.msgType === 'ack') { peer.acked = m.pos; wake(peer); }
    else if (m.msgType === 'complete') { peer.done = true; peer.status = 'terminé'; renderSenderLive(); }
    else if (m.msgType === 'error') { peer.status = 'erreur'; toast('Destinataire : ' + m.message, 'warn'); renderSenderLive(); }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('send-offer', { roomId: P.roomId, offer: pc.localDescription, receiverId });
  socket.emit('get-ice-candidates', { roomId: P.roomId }, (r) => { (r && r.candidates || []).forEach(c => peer.pending.push(c)); });
  renderSenderLive();
}

function wake(peer) { const w = peer.waiters.splice(0); w.forEach(f => f()); }
const waitFor = (peer) => new Promise(r => { peer.waiters.push(r); setTimeout(r, 1000); });

async function streamFrom(peer, fileIndex, offset) {
  const gen = ++peer.gen;
  const dc = peer.dc;
  const maxMsg = Math.min((peer.pc.sctp && peer.pc.sctp.maxMessageSize) || 65536, 256 * 1024);
  const chunk = Math.max(16 * 1024, maxMsg >= 262144 ? 256 * 1024 : maxMsg >= 65536 ? 64 * 1024 : 16 * 1024);
  const starts = []; let acc = 0;
  P.items.forEach(it => { starts.push(acc); acc += it.file.size; });
  peer.pos = (starts[fileIndex] || 0) + offset;
  peer.acked = Math.max(peer.acked, peer.pos);
  peer.status = 'envoi';
  peer.startedAt = Date.now(); peer.startPos = peer.pos; peer.samples = [];
  renderSenderLive();
  try {
    for (let i = fileIndex; i < P.items.length; i++) {
      const file = P.items[i].file;
      let off = i === fileIndex ? offset : 0;
      if (gen !== peer.gen || dc.readyState !== 'open') return;
      dc.send(JSON.stringify({ msgType: 'file-start', index: i, offset: off }));
      while (off < file.size) {
        if (gen !== peer.gen || dc.readyState !== 'open') return;
        const buf = await file.slice(off, Math.min(off + READ_SIZE, file.size)).arrayBuffer();
        for (let p = 0; p < buf.byteLength; p += chunk) {
          while ((dc.bufferedAmount > BUF_HIGH || peer.pos - peer.acked > WINDOW) && gen === peer.gen && dc.readyState === 'open') await waitFor(peer);
          if (gen !== peer.gen || dc.readyState !== 'open') return;
          const part = buf.slice(p, Math.min(p + chunk, buf.byteLength));
          dc.send(part);
          peer.pos += part.byteLength;
        }
        off += buf.byteLength;
      }
      dc.send(JSON.stringify({ msgType: 'file-end', index: i }));
    }
    dc.send(JSON.stringify({ msgType: 'all-sent' }));
  } catch (e) {
    if (gen === peer.gen) { peer.status = 'interrompu'; console.warn('stream', e); renderSenderLive(); }
  }
}

export async function stopSend(notifyServer = true) {
  const socket = await getSocket();
  if (notifyServer && P.roomId) socket.emit('cancel-transfer', { roomId: P.roomId });
  P.peers.forEach(p => { p.gen++; try { p.pc.close(); } catch (e) { /* ignore */ } });
  P.peers.clear();
  P.active = false;
  ls.del('tx_p2p_active');
  keepAwake(false);
  clearInterval(tick); tick = null;
  if (senderRoot && location.pathname === '/') { senderRoot = null; navigate('/', { replace: true }); }
}

export function renderSender(root) {
  senderRoot = root;
  const link = roomLink();
  root.innerHTML = `
  <section class="narrow stack">
    <div id="p2pBanner"></div>
    <div class="card glow stack">
      <div class="center">
        <span class="eyebrow"><span class="pulse-dot"></span>Lien direct actif</span>
        <h2 style="margin-top:8px">Partagez votre lien</h2>
        <p class="muted small" style="margin-top:6px">${P.items.length} fichier${P.items.length > 1 ? 's' : ''} · ${bytes(P.total)} · transfert d'appareil à appareil</p>
      </div>
      <div class="summary-line" style="justify-content:center">
        <span class="pill violet">${icon('bolt')}Direct P2P · zéro stockage</span>
        <span class="pill info">${icon('clock')}<span id="p2pLeft">${timeLeft(P.expiresAt - Date.now())}</span></span>
        ${P.pin ? `<span class="pill violet">${icon('lock')}PIN ${esc(P.pin)}</span>` : ''}
        ${P.destroy ? `<span class="pill warn">${icon('trash')}Auto-destruction</span>` : ''}
      </div>
      <div class="link-box"><input id="shareLink" readonly value="${esc(link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
      <div class="share-grid">
        <button type="button" class="btn" data-share="native">${icon('share')}Partager</button>
        <button type="button" class="btn" data-share="whatsapp">${icon('whatsapp')}WhatsApp</button>
        <button type="button" class="btn" data-share="telegram">${icon('telegram')}Telegram</button>
        <button type="button" class="btn" data-share="mail">${icon('mail')}E-mail</button>
      </div>
      <div class="qr-card"><div class="qr" id="qrBox"></div><div class="stack" style="gap:6px"><h3>Scannez pour recevoir</h3><p class="small muted">Le destinataire reçoit directement depuis votre appareil. S'il est interrompu, le téléchargement reprend à l'octet près.</p></div></div>
    </div>
    <div class="card">
      <div class="card-title"><h3>${icon('users')}Destinataires en direct</h3><span class="live-badge" id="p2pLive"><i></i>En ligne</span></div>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">
        <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Connectés</div><div class="kpi-value" id="p2pConn">0</div></div>
        <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Téléchargements</div><div class="kpi-value" id="p2pDl">0</div></div>
        <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Débit total</div><div class="kpi-value" id="p2pSpeed" style="font-size:20px">—</div></div>
      </div>
      <div class="stack" id="p2pPeers" style="gap:8px"></div>
    </div>
    <div class="row wrap">
      <button type="button" class="btn danger grow" id="btnStopP2P">${icon('power')}Arrêter le partage</button>
    </div>
  </section>`;
  const title = P.items.length === 1 ? P.items[0].file.name : P.items.length + ' fichiers';
  import('./send.js').then(m => m.bindShare(root, link, title, { p2p: true }));
  renderQR($('#qrBox', root), link);
  $('#btnStopP2P', root).onclick = async () => { if (await confirmDialog('Arrêter le partage ?', 'Le lien ne fonctionnera plus pour personne.', 'Arrêter', true)) stopSend(true); };
  clearInterval(tick);
  tick = setInterval(renderSenderLive, 1000);
  renderSenderLive();
}

function renderSenderLive() {
  if (!senderRoot || !document.body.contains(senderRoot) || !P.active) return;
  const list = $('#p2pPeers', senderRoot); if (!list) return;
  const now = Date.now();
  let totalSpeed = 0, connected = 0;
  const rows = [];
  P.peers.forEach(p => {
    p.samples.push({ t: now, b: p.pos }); while (p.samples.length > 6) p.samples.shift();
    const a = p.samples[0], z = p.samples[p.samples.length - 1];
    p.speed = z.t > a.t ? (z.b - a.b) / ((z.t - a.t) / 1000) : 0;
    if (p.status === 'envoi') totalSpeed += p.speed;
    if (!['left', 'interrompu'].includes(p.status)) connected++;
    const pct = P.total ? Math.min(100, Math.round(p.pos / P.total * 100)) : 100;
    const done = p.done;
    rows.push(`<div class="receiver-item"><div class="receiver-top"><span class="row">${icon('download', 'sm')}<b>Destinataire ${esc(p.id.slice(0, 5))}</b></span>
      <span class="pill ${done ? 'ok' : p.status === 'envoi' ? 'info' : p.status === 'left' ? '' : 'warn'}">${done ? 'Terminé' : p.status === 'envoi' ? pct + ' % · ' + speed(p.speed) : esc(p.status)}</span></div>
      <div class="progress-bar"><i style="width:${done ? 100 : pct}%"></i></div></div>`);
  });
  list.innerHTML = rows.length ? rows.join('') : `<div class="empty" style="padding:18px"><div class="spinner"></div><span class="small">En attente d'un destinataire… Partagez le lien ci-dessus.</span></div>`;
  $('#p2pConn', senderRoot).textContent = connected;
  $('#p2pDl', senderRoot).textContent = P.downloads;
  $('#p2pSpeed', senderRoot).textContent = totalSpeed > 0 ? speed(totalSpeed) : '—';
  const left = $('#p2pLeft', senderRoot); if (left) left.textContent = timeLeft(P.expiresAt - now);
  const live = $('#p2pLive', senderRoot); live.classList.toggle('off', !P.online); live.lastChild.textContent = P.online ? 'En ligne' : 'Reconnexion…';
  $('#p2pBanner', senderRoot).innerHTML = !P.online
    ? `<div class="banner warn">${icon('wifi-off')}<span>Connexion au serveur perdue — le lien reste valide, reconnexion automatique en cours…</span></div>`
    : `<div class="banner info">${icon('bolt')}<span><b>Gardez TransferX ouvert</b> pendant les téléchargements. Si vous changez d'appli, les transferts reprennent à votre retour.</span></div>`;
  if (now > P.expiresAt) { toast('Le lien direct a expiré', 'info'); stopSend(false); }
}

/* ======================================================================
   DESTINATAIRE
   ====================================================================== */
export const receiveView = {
  async render(root, { params }) {
    R.root = root;
    const room = (params.get('room') || '').toUpperCase().trim();
    if (!/^TX-[A-Z0-9]{6}$/.test(room)) { root.innerHTML = stateScreen('bad', 'x', 'Lien invalide', 'Vérifiez le lien reçu.'); return; }
    if (R.roomId !== room) resetReceiver(room);
    renderReceiver();
    if (!R.started) { R.started = true; connectReceiver(); }
  },
  destroy() { R.root = null; }
};

const R = { root: null };
function resetReceiver(room) {
  if (R.pc) try { R.pc.close(); } catch (e) { /* ignore */ }
  Object.assign(R, { roomId: room, started: false, state: 'connecting', meta: null, info: null, written: [], cur: -1, curPos: 0, buf: [], bufBytes: 0, total: 0, pos: 0, samples: [], speed: 0, error: '', pc: null, dc: null, pending: [], worker: null, mem: null, done: false, fileUrls: [] });
}

function stateScreen(kind, ic, title, text, extra = '') {
  return `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon ${kind}">${icon(ic)}</div><h2>${esc(title)}</h2><p class="muted">${text}</p>${extra}</div></div></section>`;
}

function renderReceiver() {
  const root = R.root; if (!root) return;
  const files = (R.meta && R.meta.files) || (R.info && R.info.files) || [];
  const total = R.meta ? R.meta.total : files.reduce((s, f) => s + (f.size || 0), 0);
  if (R.state === 'pin') {
    root.innerHTML = stateScreen('info', 'lock', 'Transfert protégé', 'L\'expéditeur vous a communiqué un code PIN.', `
      <form id="pinForm" class="stack" style="width:100%;max-width:320px;margin-top:8px">
        <input class="input pin-input" id="pinEntry" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="one-time-code" placeholder="••••" aria-label="Code PIN">
        <button class="btn primary block" type="submit">${icon('unlock')}Déverrouiller</button>
        ${R.error ? `<p class="small" style="color:var(--rose)">${esc(R.error)}</p>` : ''}
      </form>`);
    const f = $('#pinForm', root);
    f.onsubmit = (e) => { e.preventDefault(); const v = $('#pinEntry', root).value.trim(); if (!/^\d{4,8}$/.test(v)) { R.error = 'PIN : 4 à 8 chiffres'; return renderReceiver(); } R.error = ''; joinRoom(v); };
    setTimeout(() => { const i = $('#pinEntry', root); if (i) i.focus(); }, 50);
    return;
  }
  if (R.state === 'error') { root.innerHTML = stateScreen('bad', 'x', 'Transfert indisponible', esc(R.error), `<a class="btn" href="/" data-link>${icon('upload')}Envoyer des fichiers</a>`); return; }
  if (R.state === 'done') return renderReceiverDone();
  const C = 2 * Math.PI * 104;
  const waiting = R.state === 'sender-offline';
  root.innerHTML = `
  <section class="narrow stack">
    <div class="card glow">
      <div class="progress-hero">
        <span class="eyebrow"><span class="pulse-dot"></span>Transfert direct chiffré</span>
        <h2 id="rxTitle">${waiting ? 'En attente de l\'expéditeur' : R.state === 'receiving' ? 'Réception en cours' : 'Connexion à l\'expéditeur…'}</h2>
        <div class="ring ${waiting ? 'paused' : ''}" id="rxRing">
          <svg viewBox="0 0 240 240"><circle class="glow" cx="120" cy="120" r="104"/><circle class="track" cx="120" cy="120" r="104"/><circle class="bar" id="rxBar" cx="120" cy="120" r="104" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
          <div class="ring-center"><div class="ring-pct"><span id="rxPct">0</span><small>%</small></div><div class="ring-sub" id="rxBytes">${total ? '0 o / ' + bytes(total) : 'Préparation…'}</div></div>
        </div>
        <div class="metrics"><div class="metric"><b id="rxSpeed">—</b><span>Vitesse</span></div><div class="metric"><b id="rxEta">—</b><span>Restant</span></div><div class="metric"><b id="rxFiles">${files.length || '—'}</b><span>Fichiers</span></div></div>
        <div id="rxBanner">${waiting ? `<div class="banner warn">${icon('clock')}<span>L'expéditeur a quitté TransferX un instant. <b>Le téléchargement reprendra automatiquement</b> dès son retour — gardez cette page ouverte.</span></div>` : ''}</div>
        <button type="button" class="btn ghost" id="rxStop">${icon('x')}Arrêter</button>
      </div>
    </div>
    ${files.length ? `<div class="card"><div class="card-title"><h3>${icon('file')}Contenu</h3><span class="small faint">${bytes(total)}</span></div><div class="file-list">${files.slice(0, 80).map(f => { const k = fileKind(f.name); return `<div class="file-row"><div class="ficon" style="--c:${k.c}">${icon(k.icon)}</div><div class="fmeta"><div class="fname">${esc(f.path || f.name)}</div><div class="fsub">${bytes(f.size)}</div></div></div>`; }).join('')}</div></div>` : ''}
  </section>`;
  $('#rxStop', root).onclick = async () => {
    if (!(await confirmDialog('Arrêter la réception ?', 'Vous pourrez reprendre plus tard en rouvrant le lien, tant que l\'expéditeur le garde actif.', 'Arrêter', true))) return;
    const s = await getSocket(); s.emit('leave-room', { roomId: R.roomId });
    if (R.pc) try { R.pc.close(); } catch (e) { /* ignore */ }
    keepAwake(false);
    R.started = false; navigate('/');
  };
  updateRxProgress();
}

function updateRxProgress() {
  const root = R.root; if (!root || !R.meta) return;
  const bar = $('#rxBar', root); if (!bar) return;
  const now = Date.now();
  R.samples.push({ t: now, b: R.pos }); while (R.samples.length > 8) R.samples.shift();
  const a = R.samples[0], z = R.samples[R.samples.length - 1];
  const inst = z.t > a.t ? (z.b - a.b) / ((z.t - a.t) / 1000) : 0;
  R.speed = inst;
  const pct = R.total ? R.pos / R.total : 1;
  const C = 2 * Math.PI * 104;
  bar.style.strokeDashoffset = String(C * (1 - pct));
  $('#rxPct', root).textContent = Math.floor(pct * 100);
  $('#rxBytes', root).textContent = bytes(R.pos) + ' / ' + bytes(R.total);
  $('#rxSpeed', root).textContent = R.state === 'receiving' && inst > 0 ? speed(inst) : '—';
  $('#rxEta', root).textContent = inst > 0 ? duration((R.total - R.pos) / inst) : '—';
  document.title = Math.floor(pct * 100) + ' % · Réception TransferX';
}

async function connectReceiver() {
  keepAwake(true);
  const socket = await getSocket();
  if (!R.bound) {
    R.bound = true;
    socket.on('connect', () => { if (R.roomId && R.started && !R.done) joinRoom(R.pin || null); });
    socket.on('offer-received', async ({ offer }) => {
      if (!R.roomId || R.done) return;
      try {
        if (R.pc) { try { R.pc.close(); } catch (e) { /* ignore */ } }
        await newReceiverPc(socket);
        await R.pc.setRemoteDescription(offer);
        R.pending.splice(0).forEach(c => R.pc.addIceCandidate(c).catch(() => {}));
        const ans = await R.pc.createAnswer();
        await R.pc.setLocalDescription(ans);
        socket.emit('send-answer', { roomId: R.roomId, answer: R.pc.localDescription });
        socket.emit('get-ice-candidates', { roomId: R.roomId }, (r) => (r && r.candidates || []).forEach(c => R.pc.addIceCandidate(c).catch(() => {})));
      } catch (e) { console.warn('offer', e); }
    });
    socket.on('ice-candidate', ({ candidate }) => {
      if (!R.pc || !candidate) return;
      if (R.pc.remoteDescription) R.pc.addIceCandidate(candidate).catch(() => {}); else R.pending.push(candidate);
    });
    socket.on('sender-offline', () => { if (!R.done) { R.state = 'sender-offline'; renderReceiver(); } });
    socket.on('sender-online', () => { if (!R.done && R.state === 'sender-offline') { R.state = 'connecting'; renderReceiver(); } });
    socket.on('peer-cancelled', () => { if (!R.done) { R.state = 'error'; R.error = 'L\'expéditeur a arrêté le partage.'; keepAwake(false); renderReceiver(); } });
    socket.on('peer-disconnected', (d) => { if (!R.done) { R.state = 'error'; R.error = d && d.reason === 'destroyed' ? 'Ce lien a été auto-détruit après un téléchargement.' : 'Ce lien a expiré.'; keepAwake(false); renderReceiver(); } });
  }
  if (socket.connected) joinRoom(null);
}

async function joinRoom(pin) {
  const socket = await getSocket();
  const r = await emitAck(socket, 'join-room', { roomId: R.roomId, pin: pin || null });
  if (!r) return setTimeout(() => joinRoom(pin), 2000);
  if (r.pinRequired) { R.state = 'pin'; R.error = r.error || ''; return renderReceiver(); }
  if (!r.success) {
    if (r.retry) { R.state = 'sender-offline'; renderReceiver(); setTimeout(() => { if (R.started && !R.done && R.state !== 'receiving') joinRoom(pin); }, 8000); return; }
    R.state = 'error'; R.error = r.error || 'Lien invalide.'; return renderReceiver();
  }
  R.pin = pin;
  R.info = r.info || R.info;
  if (!r.senderOnline) R.state = 'sender-offline';
  else if (R.state !== 'receiving') R.state = 'connecting';
  renderReceiver();
}

async function newReceiverPc(socket) {
  const pc = new RTCPeerConnection({ iceServers: await getIce() });
  R.pc = pc;
  let discTimer = null;
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('ice-candidate', { roomId: R.roomId, candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc !== R.pc) return;
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      clearTimeout(discTimer);
      discTimer = setTimeout(() => { if (pc === R.pc && !R.done && pc.connectionState !== 'connected') socket.emit('request-restart', { roomId: R.roomId }); }, pc.connectionState === 'failed' ? 500 : 5000);
    }
  };
  pc.ondatachannel = (e) => setupRxChannel(e.channel);
}

/* ---- Écriture disque ---- */
function supportsWorkerOPFS() { return !!(window.Worker && navigator.storage && navigator.storage.getDirectory && window.FileSystemFileHandle && isSecureContext); }
let wid = 0; const wcb = new Map();
function wcall(msg, transfer) {
  return new Promise((res, rej) => {
    const id = ++wid; wcb.set(id, { res, rej });
    R.worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
}
async function initSink(meta) {
  const need = meta.total;
  if (supportsWorkerOPFS()) {
    try {
      if (!R.worker) {
        R.worker = new Worker('/js/opfs-worker.js');
        R.worker.onmessage = (e) => { const cb = wcb.get(e.data.id); if (!cb) return; wcb.delete(e.data.id); e.data.ok ? cb.res(e.data) : cb.rej(new Error(e.data.error)); };
      }
      try { await navigator.storage.persist(); } catch (e) { /* ignore */ }
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const sizes = await Promise.all(meta.files.map((f, i) => wcall({ cmd: 'open', name: fname(i) }).then(r => r.size)));
      const already = sizes.reduce((s, x) => s + x, 0);
      if (est && est.quota && need - already > (est.quota - est.usage)) throw Object.assign(new Error(`Espace insuffisant : il faut ${bytes(need - already)} libres sur cet appareil.`), { fatal: true });
      R.written = sizes.map((s, i) => Math.min(s, meta.files[i].size));
      R.mode = 'disk';
      return;
    } catch (e) {
      if (e.fatal) throw e;
      console.warn('OPFS indisponible', e);
    }
  }
  const limit = isMobile ? 500 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;
  if (need > limit) throw Object.assign(new Error(`Ce navigateur ne peut pas recevoir ${bytes(need)} en direct. Ouvrez le lien dans Chrome, ou demandez un envoi en mode Cloud.`), { fatal: true });
  R.mode = 'memory';
  if (!R.mem) R.mem = meta.files.map(() => []);
  R.written = R.mem.map(parts => parts.reduce((s, p) => s + p.byteLength, 0));
}
const fname = (i) => `p2p_${R.roomId}_${i}`;

function setupRxChannel(dc) {
  dc.binaryType = 'arraybuffer';
  R.dc = dc;
  let writing = Promise.resolve();
  let lastAck = 0;
  const flushBuf = () => {
    if (!R.bufBytes) return writing;
    const idx = R.cur, pos = R.bufPos;
    const data = new Uint8Array(R.bufBytes);
    let o = 0; for (const b of R.buf) { data.set(new Uint8Array(b), o); o += b.byteLength; }
    R.buf = []; R.bufBytes = 0;
    writing = writing.then(async () => {
      if (R.mode === 'disk') await wcall({ cmd: 'write', name: fname(idx), pos, data: data.buffer }, [data.buffer]);
      else R.mem[idx].push(data);
      R.written[idx] = pos + data.byteLength;
      const committed = R.starts[idx] + R.written[idx];
      if (committed - lastAck >= 2 * 1024 * 1024 || committed >= R.total) { lastAck = committed; if (dc.readyState === 'open') dc.send(JSON.stringify({ msgType: 'ack', pos: committed })); }
    }).catch((e) => { R.state = 'error'; R.error = e.message; try { dc.send(JSON.stringify({ msgType: 'error', message: e.message })); } catch (x) { /* ignore */ } renderReceiver(); });
    return writing;
  };
  dc.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.msgType === 'metadata') {
        flushBuf();
        await writing;
        R.meta = m; R.total = m.total;
        R.starts = []; let acc = 0; m.files.forEach(f => { R.starts.push(acc); acc += f.size; });
        try { await initSink(m); } catch (err) { R.state = 'error'; R.error = err.message; try { dc.send(JSON.stringify({ msgType: 'error', message: err.message })); } catch (x) { /* ignore */ } return renderReceiver(); }
        ls.set('tx_p2p_recv_' + R.roomId, { at: Date.now(), files: m.files.map(f => f.name + ':' + f.size) });
        let fi = m.files.findIndex((f, i) => R.written[i] < f.size);
        R.pos = R.written.reduce((s, x) => s + x, 0);
        R.samples = [];
        lastAck = R.pos;
        if (fi === -1) return finishReceive();
        R.state = 'receiving';
        renderReceiver();
        dc.send(JSON.stringify({ msgType: 'resume', fileIndex: fi, offset: R.written[fi] }));
      } else if (m.msgType === 'file-start') {
        flushBuf();
        R.cur = m.index; R.curPos = m.offset; R.bufPos = m.offset;
      } else if (m.msgType === 'file-end') {
        flushBuf();
      } else if (m.msgType === 'all-sent') {
        await flushBuf();
        await writing;
        finishReceive();
      }
      return;
    }
    if (R.cur < 0) return;
    if (!R.bufBytes) R.bufPos = R.curPos;
    R.buf.push(e.data); R.bufBytes += e.data.byteLength;
    R.curPos += e.data.byteLength; R.pos += e.data.byteLength;
    if (R.bufBytes >= 2 * 1024 * 1024) flushBuf();
  };
  dc.onclose = () => { flushBuf(); };
  if (!R.ticker) R.ticker = setInterval(() => { if (R.state === 'receiving') updateRxProgress(); }, 700);
}

async function finishReceive() {
  if (R.done) return;
  R.done = true;
  clearInterval(R.ticker); R.ticker = null;
  const files = R.meta.files;
  R.fileUrls = [];
  if (R.mode === 'disk') {
    await wcall({ cmd: 'closeAll' });
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < files.length; i++) {
      const fh = await root.getFileHandle(fname(i));
      const f = await fh.getFile();
      R.fileUrls.push({ name: files[i].name, path: files[i].path, size: files[i].size, type: files[i].type, url: URL.createObjectURL(new File([f], files[i].name, { type: files[i].type })) });
    }
  } else {
    files.forEach((f, i) => R.fileUrls.push({ name: f.name, path: f.path, size: f.size, type: f.type, url: URL.createObjectURL(new Blob(R.mem[i], { type: f.type })) }));
    R.mem = null;
  }
  try { R.dc.send(JSON.stringify({ msgType: 'complete' })); } catch (e) { /* ignore */ }
  const socket = await getSocket();
  socket.emit('download-complete', { roomId: R.roomId });
  keepAwake(false);
  R.state = 'done';
  document.title = 'TransferX — Reçu';
  renderReceiver();
  confetti(50);
}

function renderReceiverDone() {
  const root = R.root;
  const files = R.fileUrls;
  const total = files.reduce((s, f) => s + f.size, 0);
  const media = files.find(f => /^(image|video|audio)\//.test(f.type || ''));
  root.innerHTML = `
  <section class="narrow stack">
    <div class="card glow stack">
      <div class="center"><div class="success-burst">${icon('check')}</div><h2>Réception terminée</h2><p class="muted" style="margin-top:6px">${files.length} fichier${files.length > 1 ? 's' : ''} · ${bytes(total)}</p></div>
      ${media ? (media.type.startsWith('image/') ? `<img class="preview-media" src="${media.url}" alt="">` : media.type.startsWith('video/') ? `<video class="preview-media" src="${media.url}" controls playsinline></video>` : `<audio src="${media.url}" controls style="width:100%"></audio>`) : ''}
      <div class="stack" style="gap:8px">${files.map((f, i) => { const k = fileKind(f.name, f.type); return `<div class="dl-row"><div class="ficon" style="--c:${k.c}">${icon(k.icon)}</div><div class="fmeta"><div class="fname">${esc(f.path || f.name)}</div><div class="fsub">${bytes(f.size)}</div></div><a class="btn sm primary dl-btn" href="${f.url}" download="${esc(f.name)}" data-i="${i}">${icon('download', 'sm')}Enregistrer</a></div>`; }).join('')}</div>
      ${files.length > 1 ? `<button type="button" class="btn primary block" id="rxAll">${icon('download')}Tout enregistrer</button>` : ''}
      <div class="tip">${icon('shield')}<span>Fichiers reçus directement depuis l'appareil de l'expéditeur, sans passer par un serveur. Enregistrez-les avant de fermer cette page.</span></div>
      <div class="row wrap"><a class="btn grow" href="/" data-link id="rxNew">${icon('upload')}Envoyer à mon tour</a></div>
    </div>
  </section>`;
  const all = $('#rxAll', root);
  if (all) all.onclick = async () => { for (const a of root.querySelectorAll('a[data-i]')) { a.click(); await new Promise(r => setTimeout(r, 700)); } };
}

/** Nettoyage des fichiers P2P temporaires de plus de 2 jours */
export async function cleanupOPFS() {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    const keep = new Set();
    Object.keys(localStorage).filter(k => k.startsWith('tx_p2p_recv_')).forEach(k => {
      const v = ls.get(k, null);
      if (v && Date.now() - v.at < 2 * 86400e3) keep.add(k.slice(12)); else ls.del(k);
    });
    for await (const name of root.keys()) {
      const m = name.match(/^p2p_(TX-[A-Z0-9]{6})_\d+$/);
      if ((m && !keep.has(m[1])) || /^transferx(\.tmp|_sender\.zip|_multi\.zip)$/.test(name)) root.removeEntry(name).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}
