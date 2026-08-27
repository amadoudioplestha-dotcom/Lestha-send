/* TransferX — client final (unifié desktop/mobile + 5 Go + chargement à la demande) */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// ✅ UNIFIÉ : mêmes chunks que les ordinateurs (64 Ko) — plus aucun code spécial mobile
const CHUNK_SIZE = 64 * 1024;
// ✅ LIMITE MAXIMUM PORTÉE À 5 GO
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;

let socket = null, pc = null, dc = null;
let role = null, roomId = null;
let selectedFile = null;
let transferAborted = false;
let remoteDescriptionSet = false;
let pendingIce = [];
let iceServers = null;
let expectedName = '', expectedSize = 0, receivedSize = 0, transferStart = 0;
let writer = null, fallbackChunks = [];
let sendGeneration = 0;

// ✅ CHARGEMENT À LA DEMANDE : la page démarre légère, les bibliothèques
//    ne sont téléchargées QUE si on en a besoin (dossier / grosse réception)
const LIBS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  streamsaver: 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js'
};
function need(name) {
  if ((name === 'jszip' && window.JSZip) || (name === 'streamsaver' && window.streamSaver)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIBS[name]; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Bibliothèque non chargée'));
    document.head.appendChild(s);
  });
}

/* ---------- Utilitaires ---------- */
function showStep(id) {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
  const el = $(id); if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}
function error(message, box) {
  const el = $(box || 'errorBox'); if (!el) return;
  el.textContent = message; el.classList.remove('hidden');
  console.error(message);
  setTimeout(() => { if (el.textContent === message) el.classList.add('hidden'); }, 8000);
}
function clearErrors() {
  document.querySelectorAll('.error-box').forEach((el) => { el.textContent = ''; el.classList.add('hidden'); });
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
  const n = info.querySelector('.file-preview-name'); if (n) n.textContent = file.name;
  const s = info.querySelector('.file-preview-size'); if (s) s.textContent = bytes(file.size);
  box.classList.remove('hidden');
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
function wirePeer() {
  pc.onicecandidate = (event) => {
    if (event.candidate && socket && socket.connected && roomId) socket.emit('ice-candidate', { roomId, candidate: event.candidate });
  };
  pc.oniceconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.iceConnectionState) && !transferAborted) error('❌ Connexion WebRTC interrompue', 'errorBox3');
  };
}
async function flushIce() {
  if (!pc || !remoteDescriptionSet) return;
  const queued = pendingIce.splice(0);
  for (const c of queued) { try { await pc.addIceCandidate(c); } catch (e) {} }
}
function requestQueuedIce() {
  if (!socket || !socket.connected || !roomId) return;
  socket.emit('get-ice-candidates', { roomId }, (reply) => {
    for (const c of ((reply && reply.candidates) || [])) {
      if (!remoteDescriptionSet) pendingIce.push(c);
      else if (pc) pc.addIceCandidate(c).catch(() => {});
    }
  });
}

/* ---------- Expéditeur ---------- */
function setupSenderChannel() {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => { const t = $('transferTitle'); if (t) t.textContent = 'Envoi en cours…'; sendFile(); };
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.msgType === 'complete') {
        showStep('step-done');
        const t = $('transferTitle'); if (t) t.textContent = 'Transfert réussi !';
      } else if (msg.msgType === 'error') error('❌ ' + msg.message, 'errorBox3');
    } catch (e) {}
  };
}

async function sendFile() {
  const generation = ++sendGeneration;
  if (!selectedFile || !dc || dc.readyState !== 'open') return error('❌ Canal de transfert non prêt', 'errorBox3');
  transferStart = Date.now();

  dc.send(JSON.stringify({
    msgType: 'metadata', name: selectedFile.name, size: selectedFile.size,
    fileType: selectedFile.type || 'application/octet-stream'
  }));

  let offset = 0;
  const read = (blob) => safari
    ? new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(blob); })
    : blob.arrayBuffer();

  // ✅ MÊME BOUCLE POUR TOUS LES APPAREILS (backpressure standard, aucune pause spéciale)
  while (offset < selectedFile.size && !transferAborted && generation === sendGeneration) {
    if (!dc || dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 1024 * 1024) { await new Promise((r) => setTimeout(r, 40)); continue; }
    const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
    try { dc.send(await read(selectedFile.slice(offset, end))); }
    catch (e) { return error('❌ Erreur d\'envoi : ' + e.message, 'errorBox3'); }
    offset = end;
    updateProgress(offset, selectedFile.size);
  }
  if (offset >= selectedFile.size) console.log('✅ Envoi terminé');
}

/* ---------- Destinataire ---------- */
function setupReceiverChannel() {
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    let gotMetadata = false;
    let started = 0;
    channel.onopen = () => { const t = $('transferTitle'); if (t) t.textContent = 'Réception en cours…'; started = Date.now(); };
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
            receivedSize = 0; fallbackChunks = [];
            // ✅ Limite 5 Go côté destinataire aussi
            if (expectedSize > MAX_FILE_SIZE) {
              try { channel.send(JSON.stringify({ msgType: 'error', message: 'Fichier trop volumineux (max 5 Go)' })); } catch (e) {}
              return error('❌ Fichier trop volumineux (maximum 5 Go)', 'errorBox3');
            }
            try {
              await need('streamsaver'); // ✅ chargé SEULEMENT ici, au besoin
              if (window.streamSaver) writer = streamSaver.createWriteStream(expectedName, { size: expectedSize }).getWriter();
            } catch (e) { writer = null; }
            if (expectedSize === 0) await finishReceive(channel);
            return;
          }
        } catch (e) {}
      }
      const part = new Uint8Array(msgEvent.data);
      if (writer) {
        try { await writer.write(part); }
        catch (e) { return error('❌ Erreur d\'écriture : ' + e.message, 'errorBox3'); }
      } else fallbackChunks.push(part);
      receivedSize += part.byteLength;
      updateProgress(receivedSize, expectedSize, started);
      if (expectedSize && receivedSize >= expectedSize) await finishReceive(channel);
    };
  };
}

async function finishReceive(channel) {
  if (writer) { await writer.close().catch(() => {}); writer = null; }
  else if (fallbackChunks.length) {
    const url = URL.createObjectURL(new Blob(fallbackChunks));
    const link = $('downloadLink');
    if (link) { link.href = url; link.download = expectedName; link.classList.remove('hidden'); }
  }
  try { channel.send(JSON.stringify({ msgType: 'complete' })); } catch (e) {}
  showStep('step-done');
  const sub = $('doneSubtitle'); if (sub) sub.textContent = expectedName + ' — transfert terminé';
}

/* ---------- Flux expéditeur ---------- */
async function startSender() {
  if (!selectedFile) return error('❌ Sélectionnez un fichier');
  if (!socket || !socket.connected) return error('❌ Connexion au serveur en cours, réessayez dans un instant');
  clearErrors();
  role = 'sender'; transferAborted = false;
  showStep('step-waiting');
  const wm = $('waitingMsg'); if (wm) wm.textContent = 'Connexion…';

  socket.emit('create-room', async (reply) => {
    if (!reply || !reply.success || !reply.roomId) {
      showStep('step-select');
      return error('❌ ' + ((reply && reply.error) || 'Impossible de créer la room'), 'errorBox2');
    }
    roomId = reply.roomId;
    const out = $('linkOutput'); if (out) out.value = location.origin + '?room=' + encodeURIComponent(roomId);
    const wm2 = $('waitingMsg'); if (wm2) wm2.textContent = '⏳ En attente du destinataire…';
    try {
      pc = await newPeerConnection(); wirePeer();
      dc = pc.createDataChannel('file', { ordered: true });
      setupSenderChannel();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('send-offer', { roomId, offer: pc.localDescription });
      requestQueuedIce();
    } catch (e) {
      error('❌ Erreur WebRTC : ' + e.message, 'errorBox2');
      resetConnection(); showStep('step-select');
    }
  });
}

/* ---------- Flux destinataire ---------- */
function joinRoom() {
  if (!socket || !socket.connected || !roomId) return;
  socket.emit('join-room', { roomId }, (reply) => {
    if (!reply || !reply.success) {
      error('❌ ' + ((reply && reply.error) || 'Lien invalide'), 'errorBox3');
      showStep('step-select');
      return;
    }
    requestQueuedIce();
  });
}
async function startReceiver() {
  role = 'receiver';
  showStep('step-transfer');
  const t = $('transferTitle'); if (t) t.textContent = 'Connexion au pair…';
  try {
    pc = await newPeerConnection(); wirePeer();
    setupReceiverChannel();
    joinRoom();
  } catch (e) { error('❌ Erreur connexion : ' + e.message, 'errorBox3'); }
}

/* ---------- Reset ---------- */
function resetConnection() {
  sendGeneration += 1;
  pendingIce = []; remoteDescriptionSet = false;
  if (writer) { writer.close().catch(() => {}); writer = null; }
  try { if (dc) dc.close(); } catch (e) {}
  try { if (pc) pc.close(); } catch (e) {}
  dc = null; pc = null;
}
function resetUI() {
  selectedFile = null;
  const fi = $('fileInput'); if (fi) fi.value = '';
  const fo = $('folderInput'); if (fo) fo.value = '';
  const fp = $('filePreview'); if (fp) fp.classList.add('hidden');
  const fill = $('progressFill'); if (fill) fill.style.width = '0%';
  const pt = $('progressText'); if (pt) pt.textContent = '0 %';
  const st = $('speedText'); if (st) st.textContent = '';
  const em = $('emailInput'); if (em) em.value = '';
  const dl = $('downloadLink'); if (dl) dl.classList.add('hidden');
}
function cancelTransfer() {
  transferAborted = true;
  if (roomId && socket && socket.connected) socket.emit('cancel-transfer', { roomId });
  resetConnection(); roomId = null; role = null;
  resetUI(); showStep('step-select');
}

/* ---------- Socket ---------- */
function initSocket() {
  socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
  socket.on('connect', () => {
    setSocketReady(true);
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (!role && urlRoom) { roomId = urlRoom; startReceiver(); }
    else if (role === 'receiver') joinRoom();
  });
  socket.on('disconnect', () => {
    setSocketReady(false);
    if (role && !transferAborted) error('⚠️ Connexion signalisation perdue — reconnexion automatique…', role === 'sender' ? 'errorBox2' : 'errorBox3');
  });
  socket.on('connect_error', () => setSocketReady(false));
  socket.on('offer-received', async (data) => {
    if (role !== 'receiver' || !pc) return;
    try {
      await pc.setRemoteDescription(data.offer);
      remoteDescriptionSet = true; await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('send-answer', { roomId, answer: pc.localDescription });
      requestQueuedIce();
    } catch (e) { error('❌ Offre invalide : ' + e.message, 'errorBox3'); }
  });
  socket.on('answer-received', async (data) => {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(data.answer);
      remoteDescriptionSet = true; await flushIce();
      showStep('step-transfer'); requestQueuedIce();
    } catch (e) { error('❌ Réponse invalide : ' + e.message, 'errorBox2'); }
  });
  socket.on('ice-candidate', (candidate) => {
    if (!pc) return;
    if (!remoteDescriptionSet) pendingIce.push(candidate);
    else pc.addIceCandidate(candidate).catch(() => {});
  });
  socket.on('receiver-joined', () => { const wm = $('waitingMsg'); if (wm && role === 'sender') wm.textContent = '✅ Destinataire connecté !'; requestQueuedIce(); });
  socket.on('receiver-left', () => { const wm = $('waitingMsg'); if (wm && role === 'sender' && !transferAborted) wm.textContent = '⏳ Destinataire déconnecté, en attente…'; });
  socket.on('peer-disconnected', () => {
    if (!transferAborted) { error('❌ Pair déconnecté', role === 'sender' ? 'errorBox2' : 'errorBox3'); resetConnection(); showStep('step-select'); }
  });
  socket.on('peer-cancelled', () => { error('❌ Expéditeur annulé', 'errorBox3'); resetConnection(); showStep('step-select'); });
}

/* ---------- Email ---------- */
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

/* ---------- UI (liaisons sécurisées + glisser-déposer) ---------- */
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
}
function bindUI() {
  on('btnModeFile', 'click', () => { clearErrors(); const i = $('fileInput'); if (i) i.click(); });
  on('dropZone', 'click', () => { clearErrors(); const i = $('fileInput'); if (i) i.click(); });
  on('dropZone', 'dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); });
  on('dropZone', 'dragleave', (e) => e.currentTarget.classList.remove('dragover'));
  on('dropZone', 'drop', (e) => {
    e.preventDefault(); e.currentTarget.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) return error('❌ Fichier trop volumineux (maximum 5 Go)');
    selectedFile = file; showPreview(file);
  });
  on('btnModeFolder', 'click', () => { clearErrors(); const i = $('folderInput'); if (i) i.click(); });

  on('fileInput', 'change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { error('❌ Fichier trop volumineux (maximum 5 Go)'); e.target.value = ''; return; }
    selectedFile = file; showPreview(file);
  });

  on('folderInput', 'change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    if (total > MAX_FILE_SIZE) { error('❌ Dossier trop volumineux (maximum 5 Go)'); e.target.value = ''; return; }
    try {
      await need('jszip'); // ✅ JSZip chargé SEULEMENT ici
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.webkitRelativePath || f.name, f));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 }, streamFiles: true });
      const root = ((files[0].webkitRelativePath || 'dossier').split('/')[0]) || 'dossier';
      selectedFile = new File([blob], root + '.zip', { type: 'application/zip' });
      showPreview(selectedFile);
    } catch (err) { error('❌ Erreur compression : ' + err.message); }
  });

  on('btnStartSend', 'click', startSender);
  on('btnCancelSend', 'click', cancelTransfer);
  on('btnCancelTransfer', 'click', cancelTransfer);
  on('btnRestart', 'click', () => { cancelTransfer(); history.replaceState({}, document.title, '/'); });
  on('btnCopyLink', 'click', async () => {
    const out = $('linkOutput'); if (!out) return;
    try { await navigator.clipboard.writeText(out.value); }
    catch (e) { out.select(); document.execCommand('copy'); }
    const b = $('btnCopyLink'); if (b) b.textContent = '✅ Copié';
    setTimeout(() => { const b2 = $('btnCopyLink'); if (b2) b2.textContent = '📋 Copier'; }, 2000);
  });
  on('btnSendEmail', 'click', sendEmail);
}

/* ---------- Cycle de vie ---------- */
document.addEventListener('visibilitychange', () => { if (!document.hidden && socket && !socket.connected) socket.connect(); });
window.addEventListener('pageshow', () => { if (socket && !socket.connected) socket.connect(); });
window.addEventListener('beforeunload', (e) => {
  if (role && !transferAborted && expectedSize && receivedSize < expectedSize) {
    e.preventDefault(); e.returnValue = 'Transfert en cours. Quitter ?';
  }
});
setInterval(() => { if (socket && socket.connected) socket.emit('ping-keepalive'); }, 20000);

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  setSocketReady(false);
  if (!window.RTCPeerConnection) return error('❌ WebRTC non supporté');
  const wait = setInterval(() => {
    if (typeof io !== 'undefined') { clearInterval(wait); initSocket(); }
  }, 100);
  setTimeout(() => clearInterval(wait), 15000);
});
})();