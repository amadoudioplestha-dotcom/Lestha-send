/* TransferX — client léger & robuste (chargement à la demande = plus de "mémoire insuffisante") */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.warn('⚠️ Élément #' + id + ' introuvable (ignoré)');
}
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

/* ---------- Chargement À LA DEMANDE des bibliothèques lourdes ---------- */
const LIBS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  streamsaver: 'https://cdn.jsdelivr.net/npm/streamsaver@2.0.6/StreamSaver.min.js'
};
function need(name) {
  const has = (name === 'jszip' && window.JSZip) || (name === 'qr' && window.QRCode) || (name === 'streamsaver' && window.streamSaver);
  if (has) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIBS[name]; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error('Bibliothèque non chargée'));
    document.head.appendChild(s);
  });
}

/* ---------- Détection appareil ---------- */
const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const LOW_RAM = (navigator.deviceMemory || 8) <= 2;
const CHUNK_SIZE = LOW_RAM ? 8 * 1024 : (mobile ? 16 * 1024 : 64 * 1024);
const BUFFER_MAX = LOW_RAM ? 512 * 1024 : 1024 * 1024;

/* ---------- État ---------- */
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
let wakeLock = null;

/* ---------- Garde-fou sélecteur de fichiers (Android recharge la page) ---------- */
function guardPicker(open) {
  try { open ? sessionStorage.setItem('pickerOpen', '1') : sessionStorage.removeItem('pickerOpen'); } catch (e) {}
}

/* ---------- Utilitaires ---------- */
function bytes(n) {
  if (!n || isNaN(n)) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1) + ' ' + units[i];
}
const speed = (n) => (n > 0 ? bytes(n) + '/s' : '');

function showStep(id) {
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
  const el = $(id); if (el) el.classList.add('active');
  window.scrollTo(0, 0);
}
function error(message, boxId) {
  const el = $(boxId) || $('errorBox');
  if (!el) { console.error(message); return; }
  el.textContent = message; el.classList.remove('hidden');
  console.error(message);
  setTimeout(() => { if (el.textContent === message) el.classList.add('hidden'); }, 8000);
}
function clearErrors() {
  document.querySelectorAll('.error-box').forEach((el) => { el.textContent = ''; el.classList.add('hidden'); });
}
function setSocketReady(ready) {
  const btn = $('btnStartSend');
  if (btn) { btn.disabled = !ready; btn.title = ready ? '' : 'Connexion au serveur en cours…'; }
}
function updateProgress(current, total, started) {
  const start = started || transferStart;
  const pct = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const fill = $('progressFill'); if (fill) fill.style.width = pct + '%';
  setText('progressText', pct + ' %');
  if (start) setText('speedText', speed(current / Math.max((Date.now() - start) / 1000, 0.1)));
}
function showPreview(file) {
  const box = $('filePreview'), info = $('fileInfo');
  if (!box || !info) return;
  info.innerHTML = '<div class="file-preview-name"></div><div class="file-preview-size"></div>';
  info.querySelector('.file-preview-name').textContent = '📎 ' + file.name;
  info.querySelector('.file-preview-size').textContent = bytes(file.size);
  box.classList.remove('hidden');
}
async function renderQR(text) {
  const box = $('qrBox'); if (!box) return;
  box.innerHTML = '';
  try { await need('qr'); new QRCode(box, { text, width: 168, height: 168, correctLevel: QRCode.CorrectLevel.M }); }
  catch (e) { box.innerHTML = ''; }
}
async function keepAwake(enable) {
  try {
    if (!('wakeLock' in navigator)) return;
    if (enable && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!enable && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
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
    const st = pc.iceConnectionState;
    if ((st === 'failed' || st === 'closed') && !transferAborted) error('❌ Connexion WebRTC interrompue', role === 'sender' ? 'errorBox2' : 'errorBox3');
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
    const list = (reply && reply.candidates) || [];
    for (const c of list) {
      if (!remoteDescriptionSet) pendingIce.push(c);
      else if (pc) pc.addIceCandidate(c).catch(() => {});
    }
  });
}

/* ---------- Expéditeur ---------- */
function setupSenderChannel() {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => { setText('transferTitle', 'Envoi en cours…'); sendFile(); };
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.msgType === 'complete') {
        showStep('step-done');
        setText('transferTitle', 'Transfert réussi !');
        setText('doneSubtitle', 'Le destinataire a bien reçu le fichier.');
        keepAwake(false);
      } else if (msg.msgType === 'error') error('❌ ' + msg.message, 'errorBox2');
    } catch (e) {}
  };
}
async function sendFile() {
  const generation = ++sendGeneration;
  if (!selectedFile || !dc || dc.readyState !== 'open') { error('❌ Canal de transfert non prêt', 'errorBox2'); return; }
  transferStart = Date.now();
  keepAwake(true);
  dc.send(JSON.stringify({
    msgType: 'metadata', name: selectedFile.name, size: selectedFile.size,
    fileType: selectedFile.type || 'application/octet-stream'
  }));
  let offset = 0, count = 0;
  const read = (blob) => safari
    ? new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(blob); })
    : blob.arrayBuffer();
  while (offset < selectedFile.size && !transferAborted && generation === sendGeneration) {
    if (!dc || dc.readyState !== 'open') return;
    if (dc.bufferedAmount > BUFFER_MAX) { await new Promise((r) => setTimeout(r, 40)); continue; }
    const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
    try { dc.send(await read(selectedFile.slice(offset, end))); }
    catch (e) { error('❌ Erreur d\'envoi : ' + e.message, 'errorBox2'); return; }
    offset = end; count += 1;
    updateProgress(offset, selectedFile.size);
    if ((mobile || LOW_RAM) && count % 10 === 0) await new Promise((r) => setTimeout(r, 10));
  }
  if (offset >= selectedFile.size) console.log('✅ Envoi terminé');
}

/* ---------- Destinataire ---------- */
function setupReceiverChannel() {
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    let gotMetadata = false, started = 0;
    channel.onopen = () => {
      setText('transferTitle', 'Réception en cours…');
      started = Date.now(); transferStart = started;
      keepAwake(true);
    };
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
            try {
              await need('streamsaver');           // chargé SEULEMENT ici
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
        catch (e) { error('❌ Erreur d\'écriture : ' + e.message, 'errorBox3'); return; }
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
    if (link) { link.href = url; link.download = expectedName; link.classList.remove('hidden'); link.textContent = '⬇️ Télécharger ' + expectedName; }
  }
  try { channel.send(JSON.stringify({ msgType: 'complete' })); } catch (e) {}
  showStep('step-done');
  setText('doneSubtitle', expectedName + ' — transfert terminé');
  keepAwake(false);
}

/* ---------- create-room compatible ancien ET nouveau serveur ---------- */
function createRoom(payload, cb) {
  let done = false, t = null;
  const wrap = (reply) => { if (done) return; done = true; if (t) clearTimeout(t); cb(reply); };
  t = setTimeout(() => { if (!done) socket.emit('create-room', wrap); }, 3500);
  socket.emit('create-room', payload, wrap);
}

/* ---------- Flux expéditeur ---------- */
async function startSender() {
  if (!selectedFile) return error('❌ Sélectionnez d\'abord un fichier');
  if (!socket || !socket.connected) return error('❌ Connexion au serveur en cours, réessayez dans un instant');
  clearErrors();
  const ttlSel = $('expirySelect');
  const ttl = ttlSel ? parseInt(ttlSel.value, 10) || 86400000 : 86400000;
  const pinRaw = $('pinInput') ? $('pinInput').value.trim() : '';
  if (pinRaw && !/^\d{4,8}$/.test(pinRaw)) return error('❌ Le code PIN doit contenir 4 à 8 chiffres');
  role = 'sender'; transferAborted = false;
  showStep('step-waiting');
  setText('waitingMsg', 'Connexion…');
  createRoom({ ttl, pin: pinRaw || null }, async (reply) => {
    if (!reply || !reply.success || !reply.roomId) {
      showStep('step-select');
      error('❌ ' + ((reply && reply.error) || 'Impossible de créer la room'));
      return;
    }
    roomId = reply.roomId;
    const link = location.origin + '?room=' + encodeURIComponent(roomId) + '&exp=' + (Date.now() + ttl);
    const out = $('linkOutput'); if (out) out.value = link;
    renderQR(link);
    const badge = $('pinBadge');
    if (badge) {
      if (pinRaw) { badge.textContent = '🔢 PIN à communiquer séparément : ' + pinRaw; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
    setText('waitingMsg', '⏳ En attente du destinataire…');
    try {
      pc = await newPeerConnection(); wirePeer();
      dc = pc.createDataChannel('file', { ordered: true });
      setupSenderChannel();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('send-offer', { roomId, offer: pc.localDescription });
      requestQueuedIce();
    } catch (e) {
      error('❌ Erreur WebRTC : ' + e.message);
      resetConnection(); showStep('step-select');
    }
  });
}

/* ---------- Flux destinataire (PIN si requis) ---------- */
function joinRoom(pin) {
  if (!socket || !socket.connected || !roomId) return;
  socket.emit('join-room', { roomId, pin: pin || null }, (reply) => {
    if (reply && reply.pinRequired) {
      setText('transferTitle', '🔒 Code PIN requis');
      const box = $('pinBox'); if (box) box.classList.remove('hidden');
      if (reply.error) error('❌ ' + reply.error, 'errorBox3');
      return;
    }
    if (!reply || !reply.success) {
      error('❌ ' + ((reply && reply.error) || 'Lien invalide ou expiré'), 'errorBox3');
      showStep('step-select');
      return;
    }
    const box = $('pinBox'); if (box) box.classList.add('hidden');
    requestQueuedIce();
  });
}
async function startReceiver() {
  const params = new URLSearchParams(location.search);
  const exp = parseInt(params.get('exp') || '0', 10);
  if (exp && Date.now() > exp) {
    showStep('step-transfer');
    error('❌ Ce lien a expiré. Demandez un nouveau lien à l\'expéditeur.', 'errorBox3');
    return;
  }
  role = 'receiver';
  showStep('step-transfer');
  setText('transferTitle', 'Connexion au pair…');
  try {
    pc = await newPeerConnection(); wirePeer();
    setupReceiverChannel();
    joinRoom(null);
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
  keepAwake(false);
}
function resetUI() {
  selectedFile = null;
  const fi = $('fileInput'); if (fi) fi.value = '';
  const fo = $('folderInput'); if (fo) fo.value = '';
  const fp = $('filePreview'); if (fp) fp.classList.add('hidden');
  const fill = $('progressFill'); if (fill) fill.style.width = '0%';
  setText('progressText', '0 %'); setText('speedText', '');
  const em = $('emailInput'); if (em) em.value = '';
  const dl = $('downloadLink'); if (dl) dl.classList.add('hidden');
  const qr = $('qrBox'); if (qr) qr.innerHTML = '';
  const pb = $('pinBadge'); if (pb) pb.classList.add('hidden');
  const pbox = $('pinBox'); if (pbox) pbox.classList.add('hidden');
  const pe = $('pinEntry'); if (pe) pe.value = '';
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
    else if (role === 'receiver') joinRoom(null);
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
  socket.on('receiver-joined', () => { if (role === 'sender') setText('waitingMsg', '✅ Destinataire connecté !'); requestQueuedIce(); });
  socket.on('receiver-left', () => { if (role === 'sender' && !transferAborted) setText('waitingMsg', '⏳ Destinataire déconnecté, en attente…'); });
  socket.on('peer-disconnected', () => {
    if (!transferAborted) { error('❌ Pair déconnecté', role === 'sender' ? 'errorBox2' : 'errorBox3'); resetConnection(); showStep('step-select'); }
  });
  socket.on('peer-cancelled', () => { error('❌ L\'expéditeur a annulé', 'errorBox3'); resetConnection(); showStep('step-select'); });
}

/* ---------- Email ---------- */
async function sendEmail() {
  const toEl = $('emailInput'); const to = toEl ? toEl.value.trim() : '';
  const linkEl = $('linkOutput'); const link = linkEl ? linkEl.value : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return error('❌ Adresse e-mail invalide', 'errorBox2');
  if (!link) return error('❌ Aucun lien à envoyer', 'errorBox2');
  const btn = $('btnSendEmail'); if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/send-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, link, fileName: selectedFile ? selectedFile.name : '' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Échec de l\'envoi');
    if (btn) btn.textContent = '✅ Envoyé';
    if (toEl) toEl.value = '';
  } catch (e) { error('❌ ' + e.message, 'errorBox2'); }
  finally { setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '✉️ Envoyer'; } }, 2500); }
}

/* ---------- Liaison UI sécurisée ---------- */
function bindUI() {
  on('btnModeFile', 'click', () => { clearErrors(); guardPicker(true); const i = $('fileInput'); if (i) i.click(); });
  on('btnModeFolder', 'click', () => { clearErrors(); guardPicker(true); const i = $('folderInput'); if (i) i.click(); });

  on('fileInput', 'change', (e) => {
    guardPicker(false);
    selectedFile = (e.target.files && e.target.files[0]) || null;
    if (selectedFile) showPreview(selectedFile);
  });

  on('folderInput', 'change', async (e) => {
    guardPicker(false);
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      await need('jszip');                       // JSZip chargé SEULEMENT ici
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
    const btn = $('btnCopyLink'); if (btn) btn.textContent = '✅ Copié';
    setTimeout(() => { if (btn) btn.textContent = '📋 Copier'; }, 2000);
  });
  on('btnSendEmail', 'click', sendEmail);
  on('btnSubmitPin', 'click', () => {
    const entry = $('pinEntry');
    const pin = entry ? entry.value.trim() : '';
    if (!/^\d{4,8}$/.test(pin)) return error('❌ Code PIN invalide (4 à 8 chiffres)', 'errorBox3');
    clearErrors();
    setText('transferTitle', 'Connexion au pair…');
    joinRoom(pin);
  });
}

/* ---------- Anti-rechargement / reprise ---------- */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (socket && !socket.connected) socket.connect();
    if (role) keepAwake(true);
  }
});
window.addEventListener('pageshow', () => { if (socket && !socket.connected) socket.connect(); });
window.addEventListener('beforeunload', (e) => {
  if (role && !transferAborted && expectedSize && receivedSize < expectedSize) {
    e.preventDefault(); e.returnValue = 'Transfert en cours. Quitter ?';
  }
});
setInterval(() => { if (socket && socket.connected) socket.emit('ping-keepalive'); }, 20000);

/* ---------- Démarrage ---------- */
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  setSocketReady(false);
  // Si Android a rechargé la page pendant le choix du fichier → message clair
  try {
    if (sessionStorage.getItem('pickerOpen')) {
      sessionStorage.removeItem('pickerOpen');
      error('ℹ️ Android a rechargé la page pendant le choix du fichier (mémoire faible). L\'application est maintenant allégée : sélectionnez à nouveau votre fichier.');
    }
  } catch (e) {}
  if (!window.RTCPeerConnection) { error('❌ WebRTC non supporté par ce navigateur'); return; }
  const waitIo = setInterval(() => {
    if (typeof io !== 'undefined') { clearInterval(waitIo); initSocket(); }
  }, 100);
  setTimeout(() => clearInterval(waitIo), 15000);
});
})();