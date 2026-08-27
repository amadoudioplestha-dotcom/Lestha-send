/* TransferX — client final (session persistante + historique + dashboard + OPFS) */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const CHUNK_SIZE = 64 * 1024;
const MAX_FILE_SIZE = (isMobile ? 2 : 5) * 1024 * 1024 * 1024;
const MEM_SINK_LIMIT = 400 * 1024 * 1024;

let socket = null;
let role = null, roomId = null;
let selectedFile = null;
let transferAborted = false;
let iceServers = null;
let sendGeneration = 0;

// ✅ Multi-connexions (session persistante)
let activePeerConnections = new Map(); // receiverId -> {pc, dc, progress, speedText}
let currentTransfer = null; // {roomId, expiresAt, fileName, fileSize, pin}
let downloadCount = 0;
let timeLeftInterval = null;
let historyInterval = null;

// ✅ Réception (destinataire)
let expectedName = '', expectedSize = 0, receivedSize = 0, transferStart = 0;
let remoteDescriptionSet = false;
let pendingIce = [];
let pc = null;
let sink = null;

const LIBS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
};

function need(name) {
  const has = (name === 'jszip' && window.JSZip) || (name === 'qr' && window.QRCode);
  if (has) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIBS[name]; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Bibliothèque non chargée : ' + name));
    document.head.appendChild(s);
  });
}

/* ---------- Utilitaires ---------- */
function showStep(id) {
  document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
  const el = $(id);
  if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}

function error(message, box) {
  const el = $(box || 'errorBox');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  console.error(message);
  setTimeout(() => { if (el.textContent === message) el.classList.add('hidden'); }, 8000);
}

function clearErrors() {
  document.querySelectorAll('.error-box').forEach(el => { el.textContent = ''; el.classList.add('hidden'); });
}

function bytes(n) {
  if (!n || isNaN(n)) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + units[i];
}

function speed(n) { return n > 0 ? bytes(n) + '/s' : ''; }

function setSocketReady(ready) {
  const btn = $('btnStartSend');
  if (btn) { btn.disabled = !ready; btn.title = ready ? '' : 'Connexion au serveur en cours…'; }
}

function updateProgress(current, total, started) {
  const start = started || transferStart;
  const pct = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const fill = $('progressFill'); if (fill) fill.style.width = pct + '%';
  const txt = $('progressText'); if (txt) txt.textContent = pct + ' %';
  const sp = $('speedText'); if (sp && start) sp.textContent = speed(current / Math.max((Date.now() - start) / 1000, 0.1));
}

function showPreview(file) {
  const info = $('fileInfo'), box = $('filePreview');
  if (!info || !box) return;
  info.innerHTML = '<div class="file-preview-name"></div><div class="file-preview-size"></div>';
  const n = info.querySelector('.file-preview-name'); if (n) n.textContent = '📎 ' + file.name;
  const s = info.querySelector('.file-preview-size'); if (s) s.textContent = bytes(file.size);
  box.classList.remove('hidden');
}

function formatTimeLeft(ms) {
  if (ms <= 0) return 'Expiré';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return d + 'j ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'min';
  return m + 'min';
}

async function renderQR(text) {
  const box = $('qrBox');
  if (!box) return;
  box.innerHTML = '';
  try {
    await need('qr');
    if (window.QRCode) new QRCode(box, { text, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) { console.warn('QR non généré :', e.message); }
}

/* ---------- ICE / PeerConnection ---------- */
async function getIceServers() {
  if (iceServers) return iceServers;
  try {
    const res = await fetch('/api/ice-config', { cache: 'no-store' });
    iceServers = (await res.json()).iceServers;
  } catch (e) {
    iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  }
  return iceServers;
}

async function newPeerConnection() { return new RTCPeerConnection({ iceServers: await getIceServers() }); }

function wirePeer(peer, receiverId) {
  peer.onicecandidate = (event) => {
    if (event.candidate && socket?.connected && roomId) {
      socket.emit('ice-candidate', { roomId, candidate: event.candidate, targetId: receiverId || null });
    }
  };
  peer.oniceconnectionstatechange = () => {
    if (['failed', 'closed'].includes(peer.iceConnectionState) && !transferAborted) {
      error('❌ Connexion WebRTC interrompue', role === 'sender' ? 'errorBox2' : 'errorBox3');
    }
  };
}

async function flushIce(peer) {
  if (!peer || !remoteDescriptionSet) return;
  const queued = pendingIce.splice(0);
  for (const c of queued) { try { await peer.addIceCandidate(c); } catch (e) {} }
}

function requestQueuedIce(receiverId) {
  if (!socket?.connected || !roomId) return;
  socket.emit('get-ice-candidates', { roomId }, (reply) => {
    const targetPc = receiverId ? (activePeerConnections.get(receiverId)?.pc) : pc;
    for (const c of ((reply && reply.candidates) || [])) {
      if (!remoteDescriptionSet) pendingIce.push(c);
      else if (targetPc) targetPc.addIceCandidate(c).catch(() => {});
    }
  });
}

/* ---------- EXPÉDITEUR (multi-connexions) ---------- */
function setupSenderChannel(dc, receiverId) {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    const t = $('transferTitle');
    if (t && !isMultiView()) t.textContent = 'Envoi en cours…';
    sendFile(dc, receiverId);
  };
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.msgType === 'complete') {
        console.log('✅ Destinataire ' + receiverId + ' a terminé');
        const peer = activePeerConnections.get(receiverId);
        if (peer) { try { peer.pc.close(); } catch (e) {} activePeerConnections.delete(receiverId); }
        updateDashboard();
      } else if (msg.msgType === 'error') {
        error('❌ ' + msg.message, 'errorBox2');
      }
    } catch (e) {}
  };
}

function isMultiView() { return role === 'sender'; }

async function sendFile(dc, receiverId) {
  const generation = ++sendGeneration;
  if (!selectedFile || dc?.readyState !== 'open') return error('❌ Canal de transfert non prêt', 'errorBox2');
  const start = Date.now();
  dc.send(JSON.stringify({
    msgType: 'metadata', 
    name: selectedFile.name, 
    size: selectedFile.size,
    fileType: selectedFile.type || 'application/octet-stream'
  }));
  
  let offset = 0;
  const read = (blob) => safari
    ? new Promise((resolve, reject) => { 
        const r = new FileReader(); 
        r.onload = () => resolve(r.result); 
        r.onerror = reject; 
        r.readAsArrayBuffer(blob); 
      })
    : blob.arrayBuffer();
  
  while (offset < selectedFile.size && !transferAborted && generation === sendGeneration) {
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 1024 * 1024) { 
      await new Promise((r) => setTimeout(r, 40)); 
      continue; 
    }
    const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
    try { 
      dc.send(await read(selectedFile.slice(offset, end))); 
    }
    catch (e) { 
      return error('❌ Erreur d\'envoi : ' + e.message, 'errorBox2'); 
    }
    offset = end;

    // ⬅️ Mémoriser la progression pour ce destinataire précis
    const peerInfo = activePeerConnections.get(receiverId);
    if (peerInfo) {
      const pct = selectedFile.size ? Math.round((offset / selectedFile.size) * 100) : 0;
      const spd = offset / Math.max((Date.now() - start) / 1000, 0.1);
      peerInfo.progress = pct;
      peerInfo.speedText = speed(spd);
      renderReceiversList();
    }
    if (!isMultiView()) updateProgress(offset, selectedFile.size, start);
  }
  
  if (offset >= selectedFile.size) {
    const peerInfo = activePeerConnections.get(receiverId);
    if (peerInfo) { 
      peerInfo.progress = 100; 
      peerInfo.speedText = ''; 
      renderReceiversList(); 
    }
    console.log('✅ Envoi terminé (' + receiverId + ')');
  }
}

async function createPeerForReceiver(receiverId) {
  try {
    const peer = await newPeerConnection();
    wirePeer(peer, receiverId);
    const dc = peer.createDataChannel('file', { ordered: true });
    setupSenderChannel(dc, receiverId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('send-offer', { roomId, offer: peer.localDescription, receiverId });
    activePeerConnections.set(receiverId, { pc: peer, dc, progress: 0, speedText: '' });
    requestQueuedIce(receiverId);
    updateDashboard();
  } catch (e) { console.error('❌ Erreur création PC:', e); }
}

/* ---------- DASHBOARD ---------- */
function updateDashboard() {
  const sc = $('statConnected'); if (sc) sc.textContent = activePeerConnections.size;
  const sd = $('statDownloads'); if (sd) sd.textContent = downloadCount;
  renderReceiversList();
}

function renderReceiversList() {
  const list = $('receiversList');
  if (!list) return;
  if (activePeerConnections.size === 0) { list.innerHTML = ''; return; }
  let html = '';
  activePeerConnections.forEach((peer, id) => {
    const pct = peer.progress || 0;
    const done = pct >= 100;
    html += '<div class="receiver-item">' +
      '<div class="receiver-item-top">' +
        '<span class="receiver-id">👤 ' + id.slice(0, 8) + '…</span>' +
        '<span class="receiver-status">' + (done ? '✅ Terminé' : '⬇️ ' + pct + ' %') + '</span>' +
      '</div>' +
      '<div class="receiver-progress-bar"><div class="receiver-progress-fill" style="width:' + pct + '%"></div></div>' +
      (peer.speedText && !done ? '<div class="receiver-speed">' + peer.speedText + '</div>' : '') +
    '</div>';
  });
  list.innerHTML = html;
}

function startTimeLeftTicker() {
  if (timeLeftInterval) clearInterval(timeLeftInterval);
  timeLeftInterval = setInterval(() => {
    const el = $('statTimeLeft');
    const badge = $('dashboardStatus');
    if (!currentTransfer || !el) return;
    const left = currentTransfer.expiresAt - Date.now();
    el.textContent = formatTimeLeft(left);
    if (badge) {
      if (left <= 0) { badge.textContent = '🔴 Expiré'; badge.classList.add('expired'); }
      else { badge.textContent = '🟢 Actif'; badge.classList.remove('expired'); }
    }
  }, 30000);
}

/* ---------- HISTORIQUE (localStorage) ---------- */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('transferx_history') || '[]'); } catch (e) { return []; }
}

function setHistory(h) { localStorage.setItem('transferx_history', JSON.stringify(h)); }

function saveToHistory(entry) {
  const h = getHistory();
  h.unshift(entry);
  if (h.length > 50) h.length = 50;
  setHistory(h);
}

function updateHistoryDownloads(rid, count) {
  const h = getHistory();
  const item = h.find(x => x.roomId === rid);
  if (item) { item.downloadCount = count; setHistory(h); }
}

function showHistory() {
  showStep('step-history');
  renderHistory();
  if (historyInterval) clearInterval(historyInterval);
  historyInterval = setInterval(renderHistory, 5000);
}

function hideHistory() {
  if (historyInterval) { clearInterval(historyInterval); historyInterval = null; }
  showStep('step-select');
}

function renderHistory() {
  const h = getHistory();
  const now = Date.now();
  const stats = $('historyStats');
  if (stats) {
    const active = h.filter(x => x.expiresAt > now).length;
    const totalDl = h.reduce((s, x) => s + (x.downloadCount || 0), 0);
    const totalSize = h.reduce((s, x) => s + (x.fileSize || 0), 0);
    stats.innerHTML =
      '<div class="stat-card"><span class="stat-number">' + h.length + '</span><span class="stat-label">Liens créés</span></div>' +
      '<div class="stat-card"><span class="stat-number">' + active + '</span><span class="stat-label">Actifs</span></div>' +
      '<div class="stat-card"><span class="stat-number">' + totalDl + '</span><span class="stat-label">Téléchargements</span></div>' +
      '<div class="stat-card"><span class="stat-number">' + bytes(totalSize) + '</span><span class="stat-label">Total</span></div>';
  }
  const list = $('historyList');
  if (!list) return;
  if (h.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:var(--muted);padding:30px;">Aucun lien créé pour le moment</p>';
    return;
  }
  list.innerHTML = h.map(item => {
    const isActive = item.expiresAt > now;
    return '<div class="history-item ' + (isActive ? '' : 'expired') + '">' +
      '<div class="history-item-header"><span class="history-item-name">📎 ' + escapeHtmlLocal(item.fileName) + '</span>' +
      '<span class="history-item-status ' + (isActive ? 'active' : 'expired') + '">' + (isActive ? 'Actif' : 'Expiré') + '</span></div>' +
      '<div class="history-item-details">' +
      '<span>📦 ' + bytes(item.fileSize) + '</span>' +
      '<span>📅 ' + new Date(item.createdAt).toLocaleDateString('fr-FR') + '</span>' +
      '<span>⏱️ ' + formatTimeLeft(item.expiresAt - now) + '</span>' +
      '<span>🔢 ' + (item.pin ? item.pin : '—') + '</span>' +
      '<span>⬇️ ' + (item.downloadCount || 0) + '</span>' +
      '</div>' +
      '<div class="history-item-actions">' +
      (isActive ? '<button class="btn secondary" onclick="window.__copyHistoryLink(\'' + item.roomId + '\')">📋 Copier</button>' +
        '<button class="btn secondary" onclick="window.__showHistoryQR(\'' + item.roomId + '\')">📱 QR</button>' : '') +
      '<button class="btn ghost" onclick="window.__deleteHistory(\'' + item.roomId + '\')">🗑️</button>' +
      '</div></div>';
  }).join('');
}

function escapeHtmlLocal(t) {
  return String(t).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, ''');
}

window.__copyHistoryLink = (rid) => {
  const link = location.origin + '?room=' + encodeURIComponent(rid);
  if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
  alert('✅ Lien copié !');
};

window.__showHistoryQR = (rid) => {
  const link = location.origin + '?room=' + encodeURIComponent(rid);
  hideHistory();
  showStep('step-waiting');
  const out = $('linkOutput'); if (out) out.value = link;
  renderQR(link);
};

window.__deleteHistory = (rid) => {
  if (!confirm('Supprimer ce lien de l\'historique ?')) return;
  setHistory(getHistory().filter(x => x.roomId !== rid));
  renderHistory();
};

function exportHistory() {
  const blob = new Blob([JSON.stringify(getHistory(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transferx-historique-' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- SINK OPFS (réception) ---------- */
async function createSink() {
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      try { await navigator.storage.persist(); } catch (e) {}
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('transferx.tmp', { create: true });
      const writable = await handle.createWritable();
      return {
        disk: true,
        write: (p) => writable.write(p),
        close: async () => { await writable.close(); return await handle.getFile(); },
        abort: () => writable.close().catch(() => {})
      };
    }
  } catch (e) { console.warn('OPFS indisponible :', e.message); }
  const chunks = [];
  let size = 0;
  return {
    disk: false,
    write: async (p) => {
      size += p.byteLength;
      if (size > MEM_SINK_LIMIT) throw new Error('appareil sans stockage disque : fichier trop volumineux (max ' + bytes(MEM_SINK_LIMIT) + ')');
      chunks.push(p);
    },
    close: async () => new Blob(chunks),
    abort: () => {}
  };
}

/* ---------- DESTINATAIRE ---------- */
function setupReceiverChannel() {
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    let gotMetadata = false;
    let started = 0;
    channel.onopen = () => { const t = $('transferTitle'); if (t) t.textContent = 'Réception en cours…'; started = Date.now(); transferStart = started; };
    channel.onmessage = async (msgEvent) => {
      if (transferAborted) return;
      if (!gotMetadata) {
        try {
          const raw = typeof msgEvent.data === 'string' ? msgEvent.data : new TextDecoder().decode(msgEvent.data);
          const meta = JSON.parse(raw);
          if (meta.msgType === 'metadata') {
            gotMetadata = true;
            expectedName = meta.name || 'fichier';
            expectedSize = Number(meta.size) || 0;
            receivedSize = 0;
            if (expectedSize > MAX_FILE_SIZE) {
              try { channel.send(JSON.stringify({ msgType: 'error', message: 'Fichier trop volumineux (max ' + bytes(MAX_FILE_SIZE) + ')' })); } catch (e) {}
              return error('❌ Fichier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')', 'errorBox3');
            }
            if (navigator.storage?.estimate) {
              const { quota } = await navigator.storage.estimate();
              if (quota && expectedSize > quota * 0.9) return error('❌ Espace de stockage insuffisant sur cet appareil', 'errorBox3');
            }
            try { sink = await createSink(); }
            catch (e) { sink = null; return error('❌ ' + e.message, 'errorBox3'); }
            if (expectedSize === 0) await finishReceive(channel);
            return;
          }
        } catch (e) {}
      }
      const part = new Uint8Array(msgEvent.data);
      if (sink) {
        try { await sink.write(part); }
        catch (e) { sink = null; return error('❌ Erreur d\'écriture : ' + e.message, 'errorBox3'); }
      }
      receivedSize += part.byteLength;
      updateProgress(receivedSize, expectedSize, started);
      if (expectedSize && receivedSize >= expectedSize) await finishReceive(channel);
    };
  };
}

async function finishReceive(channel) {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  if (sink) {
    try {
      const file = await sink.close();
      const url = URL.createObjectURL(file);
      const link = $('downloadLink');
      if (link) { link.href = url; link.download = expectedName; link.classList.remove('hidden'); link.textContent = '⬇️ Télécharger ' + expectedName + ' (' + bytes(file.size) + ')'; }
    } catch (e) { error('❌ Finalisation : ' + e.message, 'errorBox3'); }
    sink = null;
  }
  try { channel.send(JSON.stringify({ msgType: 'complete' })); } catch (e) {}
  if (socket?.connected && roomId) socket.emit('download-complete', { roomId });
  showStep('step-done');
  const sub = $('doneSubtitle'); if (sub) sub.textContent = expectedName + ' — transfert terminé';
}

/* ---------- FLUX EXPÉDITEUR ---------- */
async function startSender() {
  if (!selectedFile) return error('❌ Sélectionnez un fichier');
  if (!socket?.connected) return error('❌ Connexion au serveur en cours, réessayez dans un instant');
  clearErrors();
  const ttlSel = $('expirySelect');
  const ttl = ttlSel ? parseInt(ttlSel.value, 10) || 86400000 : 86400000;
  const pinRaw = $('pinInput') ? $('pinInput').value.trim() : '';
  if (pinRaw && !/^\d{4,8}$/.test(pinRaw)) return error('❌ Le code PIN doit contenir 4 à 8 chiffres');

  role = 'sender';
  transferAborted = false;
  window.addEventListener('beforeunload', handleBeforeUnload);
  activePeerConnections = new Map();
  downloadCount = 0;
  showStep('step-waiting');
  const wm = $('waitingMsg'); if (wm) wm.textContent = 'Connexion…';

  socket.emit('create-room', { ttl, pin: pinRaw || null }, async (reply) => {
    if (!reply?.success || !reply.roomId) {
      showStep('step-select');
      return error('❌ ' + ((reply && reply.error) || 'Impossible de créer la room'), 'errorBox');
    }
    roomId = reply.roomId;
    currentTransfer = {
      roomId,
      expiresAt: reply.expiresAt || (Date.now() + ttl),
      fileName: selectedFile.name,
      fileSize: selectedFile.size,
      pin: pinRaw || null,
      createdAt: Date.now(),
      downloadCount: 0
    };
    saveToHistory(currentTransfer);
    const link = location.origin + '?room=' + encodeURIComponent(roomId);
    const out = $('linkOutput'); if (out) out.value = link;
    await renderQR(link);

    const badge = $('pinBadge');
    if (badge) {
      if (pinRaw) { badge.textContent = '🔢 PIN à communiquer séparément : ' + pinRaw; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
    const wm2 = $('waitingMsg'); if (wm2) wm2.textContent = '⏳ Partagez le lien — il reste actif jusqu\'à expiration';
    updateDashboard();
    startTimeLeftTicker();
  });
}

/* ---------- FLUX DESTINATAIRE ---------- */
function joinRoom(pin) {
  if (!socket?.connected || !roomId) return;
  socket.emit('join-room', { roomId, pin: pin || null }, (reply) => {
    if (reply && reply.pinRequired) {
      const t = $('transferTitle'); if (t) t.textContent = '🔒 Code PIN requis';
      const pinBox = $('pinBox'); if (pinBox) pinBox.classList.remove('hidden');
      if (reply.error) {
        error('❌ ' + reply.error, 'errorBox3');
        const pe = $('pinEntry'); if (pe) { pe.value = ''; pe.focus(); }
      }
      return;
    }
    if (!reply?.success) {
      error('❌ ' + ((reply && reply.error) || 'Lien invalide ou expiré'), 'errorBox3');
      showStep('step-select');
      return;
    }
    const pinBox = $('pinBox'); if (pinBox) pinBox.classList.add('hidden');
    requestQueuedIce();
  });
}

async function startReceiver() {
  role = 'receiver';
  window.addEventListener('beforeunload', handleBeforeUnload);
  showStep('step-transfer');
  const t = $('transferTitle'); if (t) t.textContent = 'Connexion au pair…';
  try {
    pc = await newPeerConnection();
    wirePeer(pc);
    setupReceiverChannel();
    joinRoom(null);
  } catch (e) { error('❌ Erreur connexion : ' + e.message, 'errorBox3'); }
}

/* ---------- RESET ---------- */
function resetConnection() {
  sendGeneration += 1;
  pendingIce = [];
  remoteDescriptionSet = false;
  if (sink) { sink.abort(); sink = null; }
  activePeerConnections.forEach(({ pc: peer }) => { try { peer.close(); } catch (e) {} });
  activePeerConnections.clear();
  try { if (pc) pc.close(); } catch (e) {}
  pc = null;
  if (timeLeftInterval) { clearInterval(timeLeftInterval); timeLeftInterval = null; }
}

function resetUI() {
  selectedFile = null;
  currentTransfer = null;
  downloadCount = 0;
  const fi = $('fileInput'); if (fi) fi.value = '';
  const fo = $('folderInput'); if (fo) fo.value = '';
  const fp = $('filePreview'); if (fp) fp.classList.add('hidden');
  const fill = $('progressFill'); if (fill) fill.style.width = '0%';
  const pt = $('progressText'); if (pt) pt.textContent = '0 %';
  const st = $('speedText'); if (st) st.textContent = '';
  const em = $('emailInput'); if (em) em.value = '';
  const dl = $('downloadLink'); if (dl) dl.classList.add('hidden');
  const qr = $('qrBox'); if (qr) qr.innerHTML = '';
  const pb = $('pinBadge'); if (pb) pb.classList.add('hidden');
  const pi = $('pinInput'); if (pi) pi.value = '';
  const pe = $('pinEntry'); if (pe) pe.value = '';
  const pbox = $('pinBox'); if (pbox) pbox.classList.add('hidden');
}

function cancelTransfer() {
  window.removeEventListener('beforeunload', handleBeforeUnload);
  transferAborted = true;
  if (roomId && socket?.connected) socket.emit('cancel-transfer', { roomId });
  resetConnection();
  roomId = null;
  role = null;
  resetUI();
  showStep('step-select');
}

/* ---------- SOCKET ---------- */
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });

  socket.on('connect', () => {
    setSocketReady(true);
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (!role && urlRoom) { roomId = urlRoom; startReceiver(); }
    else if (role === 'receiver') joinRoom(null);
  });
  socket.on('disconnect', () => {
    setSocketReady(false);
    if (role && !transferAborted) error('⚠️ Connexion signalisation perdue — reconnexion…', role === 'sender' ? 'errorBox2' : 'errorBox3');
  });
  socket.on('connect_error', () => setSocketReady(false));

  socket.on('offer-received', async ({ offer }) => {
    if (role !== 'receiver' || !pc) return;
    try {
      await pc.setRemoteDescription(offer);
      remoteDescriptionSet = true;
      await flushIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('send-answer', { roomId, answer: pc.localDescription });
      requestQueuedIce();
    } catch (e) { error('❌ Offre invalide : ' + e.message, 'errorBox3'); }
  });

  socket.on('answer-received', async ({ answer, receiverId }) => {
    const targetPc = receiverId ? (activePeerConnections.get(receiverId)?.pc) : pc;
    if (!targetPc) return;
    try {
      await targetPc.setRemoteDescription(answer);
      if (!receiverId) remoteDescriptionSet = true;
      await flushIce(targetPc);
      requestQueuedIce(receiverId);
    } catch (e) { error('❌ Réponse invalide : ' + e.message, 'errorBox2'); }
  });

  socket.on('ice-candidate', (data) => {
    const candidate = data.candidate || data;
    const from = data.from;
    if (!candidate) return;
    if (role === 'receiver') {
      if (!pc) return;
      if (!remoteDescriptionSet) pendingIce.push(candidate);
      else pc.addIceCandidate(candidate).catch(() => {});
    } else if (role === 'sender') {
      const peer = activePeerConnections.get(from);
      if (peer && peer.pc) peer.pc.addIceCandidate(candidate).catch(() => {});
    }
  });

  socket.on('receiver-joined', (data) => {
    if (role !== 'sender') return;
    if (data?.receiverId) createPeerForReceiver(data.receiverId);
    else { const wm = $('waitingMsg'); if (wm) wm.textContent = '✅ Destinataire connecté !'; }
  });

  socket.on('receiver-left', (data) => {
    if (role !== 'sender') return;
    if (data?.receiverId) {
      const peer = activePeerConnections.get(data.receiverId);
      if (peer) { try { peer.pc.close(); } catch (e) {} activePeerConnections.delete(data.receiverId); }
    }
    updateDashboard();
    const wm = $('waitingMsg');
    if (wm && !transferAborted) wm.textContent = '⏳ Lien toujours actif — en attente d\'autres destinataires…';
  });

  socket.on('download-notification', (data) => {
    downloadCount = data.totalDownloads || (downloadCount + 1);
    updateDashboard();
    if (currentTransfer) updateHistoryDownloads(currentTransfer.roomId, downloadCount);
    const wm = $('waitingMsg');
    if (wm) wm.textContent = '✅ Téléchargement #' + downloadCount + ' terminé — lien toujours actif';
  });

  socket.on('peer-disconnected', () => {
    if (!transferAborted) {
      error('❌ Pair déconnecté', role === 'sender' ? 'errorBox2' : 'errorBox3');
      resetConnection();
      showStep('step-select');
    }
  });

  socket.on('peer-cancelled', () => {
    error('❌ Expéditeur annulé', 'errorBox3');
    resetConnection();
    showStep('step-select');
  });
}

/* ---------- EMAIL ---------- */
async function sendEmail() {
  const toEl = $('emailInput'); const to = toEl ? toEl.value.trim() : '';
  const linkEl = $('linkOutput'); const link = linkEl ? linkEl.value : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return error('❌ Email invalide', 'errorBox2');
  if (!link) return error('❌ Aucun lien à envoyer', 'errorBox2');
  const btn = $('btnSendEmail'); if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/send-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, link, fileName: selectedFile ? selectedFile.name : '' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Échec');
    if (btn) btn.textContent = '✅ Envoyé';
    if (toEl) toEl.value = '';
  } catch (e) { error('❌ ' + e.message, 'errorBox2'); }
  finally { setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '✉️ Envoyer'; } }, 2500); }
}

/* ---------- UI ---------- */
function bindUI() {
  const bmf = $('btnModeFile');
  if (bmf) bmf.onclick = () => { clearErrors(); const i = $('fileInput'); if (i) i.click(); };
  const bmf2 = $('btnModeFolder');
  if (bmf2) bmf2.onclick = () => { clearErrors(); const i = $('folderInput'); if (i) i.click(); };

  const fi = $('fileInput');
  if (fi) fi.onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { error('❌ Fichier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')'); e.target.value = ''; return; }
    selectedFile = file;
    showPreview(file);
  };

  const fo = $('folderInput');
  if (fo) fo.onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    if (total > MAX_FILE_SIZE) { error('❌ Dossier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')'); e.target.value = ''; return; }

    const titleEl = $('transferTitle');
    const rootName = ((files[0].webkitRelativePath || 'dossier').split('/')[0]) || 'dossier';

    try {
      if (titleEl) titleEl.textContent = 'Préparation du dossier en cours...';

      await need('jszip');
      const zip = new JSZip();
      files.forEach(f => zip.file(f.webkitRelativePath || f.name, f));

      let finalFile;

      // 1️⃣ SOLUTION ROBUSTE : écriture sur disque (OPFS) avec vraie contre-pression
      if (navigator.storage && navigator.storage.getDirectory) {
        const rootDir = await navigator.storage.getDirectory();
        const handle = await rootDir.getFileHandle('transferx_sender.zip', { create: true });
        const writable = await handle.createWritable();

        try {
          await new Promise((resolve, reject) => {
            const stream = zip.generateInternalStream({
              type: 'uint8array',
              compression: 'STORE'
            });

            stream.on('data', (chunk) => {
              stream.pause();
              writable.write(chunk)
                .then(() => stream.resume())
                .catch((err) => { stream.pause(); reject(err); });
            });

            stream.on('error', reject);
            stream.on('end', resolve);
            stream.resume();
          });
        } catch (streamErr) {
          try { await writable.abort(); } catch (e) {}
          throw streamErr;
        }

        await writable.close();
        finalFile = await handle.getFile();

        Object.defineProperty(finalFile, 'name', {
          writable: true,
          value: rootName + '.zip'
        });

      } else {
        // 2️⃣ FALLBACK : RAM uniquement, strictement limité
        const MEM_ZIP_LIMIT = 200 * 1024 * 1024;
        if (total > MEM_ZIP_LIMIT) {
          throw new Error('Ce navigateur ne supporte pas le stockage disque (OPFS). Dossier limité à ' + bytes(MEM_ZIP_LIMIT) + ' — utilisez Chrome ou Edge récent.');
        }
        const parts = [];
        let accumulated = 0;
        await new Promise((resolve, reject) => {
          const stream = zip.generateInternalStream({ type: 'uint8array', compression: 'STORE' });
          stream.on('data', (chunk) => {
            accumulated += chunk.byteLength;
            if (accumulated > MEM_ZIP_LIMIT) {
              stream.pause();
              reject(new Error('Dossier trop volumineux pour la mémoire (max ' + bytes(MEM_ZIP_LIMIT) + ')'));
              return;
            }
            parts.push(new Blob([chunk]));
          });
          stream.on('error', reject);
          stream.on('end', resolve);
          stream.resume();
        });
        finalFile = new File(parts, rootName + '.zip', { type: 'application/zip' });
      }

      selectedFile = finalFile;
      if (titleEl) titleEl.textContent = 'Transfert Sécurisé';
      showPreview(selectedFile);
    } catch (err) {
      error('❌ Erreur préparation : ' + err.message);
      // Nettoyage du fichier temporaire OPFS
      if (navigator.storage?.getDirectory) {
        try {
          const rootDir = await navigator.storage.getDirectory();
          await rootDir.removeEntry('transferx_sender.zip');
        } catch (cleanupErr) {}
      }
    } finally {
      e.target.value = '';
    }
  };

  const bs = $('btnStartSend'); if (bs) bs.onclick = startSender;
  const bcs = $('btnCancelSend'); if (bcs) bcs.onclick = cancelTransfer;
  const bct = $('btnCancelTransfer'); if (bct) bct.onclick = cancelTransfer;
  const br = $('btnRestart'); if (br) br.onclick = () => { cancelTransfer(); history.replaceState({}, document.title, '/'); };
  const bcl = $('btnCopyLink');
  if (bcl) bcl.onclick = async () => {
    const out = $('linkOutput'); if (!out) return;
    try { await navigator.clipboard.writeText(out.value); }
    catch (e) { out.select(); document.execCommand('copy'); }
    bcl.textContent = '✅ Copié';
    setTimeout(() => { bcl.textContent = '📋 Copier'; }, 2000);
  };
  const bse = $('btnSendEmail'); if (bse) bse.onclick = sendEmail;

  const bsh = $('btnShowHistory'); if (bsh) bsh.onclick = showHistory;
  const bbh = $('btnBackFromHistory'); if (bbh) bbh.onclick = hideHistory;
  const beh = $('btnExportHistory'); if (beh) beh.onclick = exportHistory;

  const bsp = $('btnSubmitPin');
  if (bsp) bsp.onclick = () => {
    const pe = $('pinEntry');
    const pin = pe ? pe.value.trim() : '';
    if (!/^\d{4,8}$/.test(pin)) { error('❌ Le code PIN doit contenir 4 à 8 chiffres', 'errorBox3'); return; }
    clearErrors();
    const t = $('transferTitle'); if (t) t.textContent = 'Vérification du PIN…';
    joinRoom(pin);
  };
  const pe = $('pinEntry');
  if (pe) pe.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const b = $('btnSubmitPin'); if (b) b.click(); }
  });
}

/* ---------- CYCLE DE VIE ---------- */
document.addEventListener('visibilitychange', () => { if (!document.hidden && socket && !socket.connected) socket.connect(); });
window.addEventListener('pageshow', () => { if (socket && !socket.connected) socket.connect(); });

function handleBeforeUnload(e) {
  if (role && !transferAborted && expectedSize && receivedSize < expectedSize) {
    e.preventDefault();
    e.returnValue = 'Transfert en cours. Quitter ?';
  }
}

setInterval(() => { if (socket?.connected) socket.emit('ping-keepalive'); }, 20000);

document.addEventListener('DOMContentLoaded', () => {
  // ✅ Nettoyage robuste des fichiers temporaires OPFS
  if (window.isSecureContext && navigator.storage?.getDirectory) {
    navigator.storage.getDirectory().then(root => {
      root.removeEntry('transferx.tmp').catch(() => {});
      root.removeEntry('transferx_sender.zip').catch(() => {});
    }).catch(() => {});
  }
  bindUI();
  setSocketReady(false);
  if (!window.RTCPeerConnection) return error('❌ WebRTC non supporté');
  const wait = setInterval(() => {
    if (typeof io !== 'undefined') { clearInterval(wait); initSocket(); }
  }, 100);
  setTimeout(() => clearInterval(wait), 15000);
});
})();