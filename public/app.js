/* TransferX — client final (unifié, RAM-safe mobile via OPFS) */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

const CHUNK_SIZE = 64 * 1024;
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
// ✅ Limite adaptée : mobile = écran + OPFS, desktop = 5 Go
const MAX_FILE_SIZE = isMobile ? 2 * 1024 * 1024 * 1024 : 5 * 1024 * 1024 * 1024;
const MEM_SINK_LIMIT = 400 * 1024 * 1024; // plafond si réception en RAM uniquement

let socket = null, pc = null, dc = null;
let role = null, roomId = null;
let selectedFile = null;
let transferAborted = false;
let remoteDescriptionSet = false;
let pendingIce = [];
let iceServers = null;
let expectedName = '', expectedSize = 0, receivedSize = 0, transferStart = 0;
let sink = null;               // ✅ remplace writer/fallbackChunks
let sendGeneration = 0;

// ✅ StreamSaver SUPPRIMÉ (inutilisable sur mobile)
const LIBS = {
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  qr: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
};

function need(name) {
  const has = (name === 'jszip' && window.JSZip)
           || (name === 'qr' && window.QRCode);
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
  document.querySelectorAll('.error-box').forEach(el => {
    el.textContent = '';
    el.classList.add('hidden');
  });
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
  if (btn) {
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Connexion au serveur en cours…';
  }
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

async function renderQR(text) {
  const box = $('qrBox');
  if (!box) return;
  box.innerHTML = '';
  try {
    await need('qr');
    if (window.QRCode) {
      new QRCode(box, {
        text: text,
        width: 168,
        height: 168,
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  } catch (e) {
    console.warn('QR non généré :', e.message);
  }
}

/* ---------- ICE / PeerConnection ---------- */
async function getIceServers() {
  if (iceServers) return iceServers;
  try {
    const res = await fetch('/api/ice-config', { cache: 'no-store' });
    iceServers = (await res.json()).iceServers;
  } catch (e) {
    iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }
  return iceServers;
}

async function newPeerConnection() {
  return new RTCPeerConnection({ iceServers: await getIceServers() });
}

function wirePeer() {
  pc.onicecandidate = (event) => {
    if (event.candidate && socket?.connected && roomId) {
      socket.emit('ice-candidate', { roomId, candidate: event.candidate });
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.iceConnectionState) && !transferAborted) {
      error('❌ Connexion WebRTC interrompue', 'errorBox3');
    }
  };
}

async function flushIce() {
  if (!pc || !remoteDescriptionSet) return;
  const queued = pendingIce.splice(0);
  for (const c of queued) {
    try { await pc.addIceCandidate(c); } catch (e) {}
  }
}

function requestQueuedIce() {
  if (!socket?.connected || !roomId) return;
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
  dc.onopen = () => {
    const t = $('transferTitle');
    if (t) t.textContent = 'Envoi en cours…';
    sendFile();
  };
  dc.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.msgType === 'complete') {
        showStep('step-done');
        const t = $('transferTitle');
        if (t) t.textContent = 'Transfert réussi !';
      } else if (msg.msgType === 'error') {
        error('❌ ' + msg.message, 'errorBox3');
      }
    } catch (e) {}
  };
}

async function sendFile() {
  const generation = ++sendGeneration;
  if (!selectedFile || dc?.readyState !== 'open') {
    return error('❌ Canal de transfert non prêt', 'errorBox3');
  }
  transferStart = Date.now();
  dc.send(JSON.stringify({
    msgType: 'metadata',
    name: selectedFile.name,
    size: selectedFile.size,
    fileType: selectedFile.type || 'application/octet-stream'
  }));

  let offset = 0;
  const read = (blob) => blob.arrayBuffer();

  while (offset < selectedFile.size && !transferAborted && generation === sendGeneration) {
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
    try {
      dc.send(await read(selectedFile.slice(offset, end)));
    } catch (e) {
      return error('❌ Erreur d\'envoi : ' + e.message, 'errorBox3');
    }
    offset = end;
    updateProgress(offset, selectedFile.size);
  }
  if (offset >= selectedFile.size) console.log('✅ Envoi terminé');
}

/* ---------- ✅ SINK RAM-SAFE (OPFS disque → mémoire plafonnée) ---------- */
async function createSink() {
  // 1) OPFS : écrit sur le DISQUE du navigateur → 0 RAM
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      try { await navigator.storage.persist(); } catch (e) {}
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('transferx.tmp', { create: true });
      const writable = await handle.createWritable();
      return {
        disk: true,
        write: (p) => writable.write(p),
        close: async () => {
          await writable.close();
          return await handle.getFile();
        },
        abort: () => writable.close().catch(() => {})
      };
    }
  } catch (e) { console.warn('OPFS indisponible :', e.message); }
  // 2) Fallback mémoire AVEC PLAFOND (au lieu d'exploser la RAM)
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

/* ---------- Destinataire ---------- */
function setupReceiverChannel() {
  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    let gotMetadata = false;
    let started = 0;

    channel.onopen = () => {
      const t = $('transferTitle');
      if (t) t.textContent = 'Réception en cours…';
      started = Date.now();
    };

    channel.onmessage = async (msgEvent) => {
      if (transferAborted) return;

      if (!gotMetadata) {
        try {
          const raw = typeof msgEvent.data === 'string'
            ? msgEvent.data
            : new TextDecoder().decode(msgEvent.data);
          const meta = JSON.parse(raw);
          if (meta.msgType === 'metadata') {
            gotMetadata = true;
            expectedName = meta.name || 'fichier';
            expectedSize = Number(meta.size) || 0;
            receivedSize = 0;
            if (expectedSize > MAX_FILE_SIZE) {
              try {
                channel.send(JSON.stringify({
                  msgType: 'error',
                  message: 'Fichier trop volumineux (max ' + bytes(MAX_FILE_SIZE) + ')'
                }));
              } catch (e) {}
              return error('❌ Fichier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')', 'errorBox3');
            }
            // ✅ Vérifier l'espace disque avant de commencer
            if (navigator.storage?.estimate) {
              const { quota } = await navigator.storage.estimate();
              if (quota && expectedSize > quota * 0.9) {
                return error('❌ Espace de stockage insuffisant sur cet appareil', 'errorBox3');
              }
            }
            try {
              sink = await createSink();   // ✅ disque, pas de RAM
            } catch (e) {
              sink = null;
              return error('❌ ' + e.message, 'errorBox3');
            }
            if (expectedSize === 0) await finishReceive(channel);
            return;
          }
        } catch (e) {}
      }

      const part = new Uint8Array(msgEvent.data);
      if (sink) {
        try {
          await sink.write(part);
        } catch (e) {
          sink = null;
          return error('❌ Erreur d\'écriture : ' + e.message, 'errorBox3');
        }
      }
      receivedSize += part.byteLength;
      updateProgress(receivedSize, expectedSize, started);
      if (expectedSize && receivedSize >= expectedSize) await finishReceive(channel);
    };
  };
}

async function finishReceive(channel) {
  if (sink) {
    try {
      const file = await sink.close();
      const url = URL.createObjectURL(file);
      const link = $('downloadLink');
      if (link) {
        link.href = url;
        link.download = expectedName;
        link.classList.remove('hidden');
        link.textContent = '⬇️ Télécharger ' + expectedName + ' (' + bytes(file.size) + ')';
      }
    } catch (e) {
      error('❌ Finalisation : ' + e.message, 'errorBox3');
    }
    sink = null;
  }
  try {
    channel.send(JSON.stringify({ msgType: 'complete' }));
  } catch (e) {}
  showStep('step-done');
  const sub = $('doneSubtitle');
  if (sub) sub.textContent = expectedName + ' — transfert terminé';
}

/* ---------- Flux expéditeur ---------- */
async function startSender() {
  if (!selectedFile) return error('❌ Sélectionnez un fichier');
  if (!socket?.connected) return error('❌ Connexion au serveur en cours, réessayez dans un instant');
  clearErrors();
  const ttlSel = $('expirySelect');
  const ttl = ttlSel ? parseInt(ttlSel.value, 10) || 86400000 : 86400000;
  const pinRaw = $('pinInput') ? $('pinInput').value.trim() : '';
  if (pinRaw && !/^\d{4,8}$/.test(pinRaw)) {
    return error('❌ Le code PIN doit contenir 4 à 8 chiffres');
  }

  role = 'sender';
  transferAborted = false;
  showStep('step-waiting');
  const wm = $('waitingMsg');
  if (wm) wm.textContent = 'Connexion…';

  socket.emit('create-room', { ttl, pin: pinRaw || null }, async (reply) => {
    if (!reply?.success || !reply.roomId) {
      showStep('step-select');
      return error('❌ ' + ((reply && reply.error) || 'Impossible de créer la room'), 'errorBox2');
    }
    roomId = reply.roomId;
    const link = location.origin + '?room=' + encodeURIComponent(roomId);
    const out = $('linkOutput');
    if (out) out.value = link;

    await renderQR(link);

    const badge = $('pinBadge');
    if (badge) {
      if (pinRaw) {
        badge.textContent = '🔢 PIN à communiquer séparément : ' + pinRaw;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }

    const wm2 = $('waitingMsg');
    if (wm2) wm2.textContent = '⏳ En attente du destinataire…';

    try {
      pc = await newPeerConnection();
      wirePeer();
      dc = pc.createDataChannel('file', { ordered: true });
      setupSenderChannel();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('send-offer', { roomId, offer: pc.localDescription });
      requestQueuedIce();
    } catch (e) {
      error('❌ Erreur WebRTC : ' + e.message, 'errorBox2');
      resetConnection();
      showStep('step-select');
    }
  });
}

/* ---------- Flux destinataire ---------- */
function joinRoom(pin) {
  if (!socket?.connected || !roomId) return;
  socket.emit('join-room', { roomId, pin: pin || null }, (reply) => {
    if (reply && reply.pinRequired) {
      const t = $('transferTitle');
      if (t) t.textContent = '🔒 Code PIN requis';
      if (reply.error) error('❌ ' + reply.error, 'errorBox3');
      return;
    }
    if (!reply?.success) {
      error('❌ ' + ((reply && reply.error) || 'Lien invalide ou expiré'), 'errorBox3');
      showStep('step-select');
      return;
    }
    requestQueuedIce();
  });
}

async function startReceiver() {
  role = 'receiver';
  showStep('step-transfer');
  const t = $('transferTitle');
  if (t) t.textContent = 'Connexion au pair…';
  try {
    pc = await newPeerConnection();
    wirePeer();
    setupReceiverChannel();
    joinRoom(null);
  } catch (e) {
    error('❌ Erreur connexion : ' + e.message, 'errorBox3');
  }
}

/* ---------- Reset ---------- */
function resetConnection() {
  sendGeneration += 1;
  pendingIce = [];
  remoteDescriptionSet = false;
  if (sink) { sink.abort(); sink = null; }
  try { if (dc) dc.close(); } catch (e) {}
  try { if (pc) pc.close(); } catch (e) {}
  dc = null;
  pc = null;
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
  const qr = $('qrBox'); if (qr) qr.innerHTML = '';
  const pb = $('pinBadge'); if (pb) pb.classList.add('hidden');
  const pi = $('pinInput'); if (pi) pi.value = '';
}

function cancelTransfer() {
  transferAborted = true;
  if (roomId && socket?.connected) socket.emit('cancel-transfer', { roomId });
  resetConnection();
  roomId = null;
  role = null;
  resetUI();
  showStep('step-select');
}

/* ---------- Socket ---------- */
function initSocket() {
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000
  });

  socket.on('connect', () => {
    setSocketReady(true);
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (!role && urlRoom) {
      roomId = urlRoom;
      startReceiver();
    } else if (role === 'receiver') {
      joinRoom(null);
    }
  });

  socket.on('disconnect', () => {
    setSocketReady(false);
    if (role && !transferAborted) {
      error('⚠️ Connexion signalisation perdue — reconnexion…', role === 'sender' ? 'errorBox2' : 'errorBox3');
    }
  });

  socket.on('connect_error', () => setSocketReady(false));

  socket.on('offer-received', async ({ offer }) => {
    if (role !== 'receiver' || !pc) return;
    try {
      await pc.setRemoteDescription(offer);
      remoteDescriptionSet = true;
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('send-answer', { roomId, answer: pc.localDescription });
      requestQueuedIce();
    } catch (e) {
      error('❌ Offre invalide : ' + e.message, 'errorBox3');
    }
  });

  socket.on('answer-received', async ({ answer }) => {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(answer);
      remoteDescriptionSet = true;
      await flushIce();
      showStep('step-transfer');
      requestQueuedIce();
    } catch (e) {
      error('❌ Réponse invalide : ' + e.message, 'errorBox2');
    }
  });

  socket.on('ice-candidate', (candidate) => {
    if (!pc) return;
    if (!remoteDescriptionSet) pendingIce.push(candidate);
    else pc.addIceCandidate(candidate).catch(() => {});
  });

  socket.on('receiver-joined', () => {
    const wm = $('waitingMsg');
    if (wm && role === 'sender') wm.textContent = '✅ Destinataire connecté !';
    requestQueuedIce();
  });

  socket.on('receiver-left', () => {
    const wm = $('waitingMsg');
    if (wm && role === 'sender' && !transferAborted) {
      wm.textContent = '⏳ Destinataire déconnecté, en attente…';
    }
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

/* ---------- Email ---------- */
async function sendEmail() {
  const toEl = $('emailInput');
  const to = toEl ? toEl.value.trim() : '';
  const linkEl = $('linkOutput');
  const link = linkEl ? linkEl.value : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return error('❌ Email invalide', 'errorBox2');
  if (!link) return error('❌ Aucun lien à envoyer', 'errorBox2');
  const btn = $('btnSendEmail');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, link, fileName: selectedFile ? selectedFile.name : '' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Échec');
    if (btn) btn.textContent = '✅ Envoyé';
    if (toEl) toEl.value = '';
  } catch (e) {
    error('❌ ' + e.message, 'errorBox2');
  } finally {
    setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✉️ Envoyer';
      }
    }, 2500);
  }
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
    if (file.size > MAX_FILE_SIZE) {
      error('❌ Fichier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')');
      e.target.value = '';
      return;
    }
    selectedFile = file;
    showPreview(file);
  };

  // ✅ DOSSIER : zip STREAMÉ + sans compression sur mobile (RAM-safe)
  const fo = $('folderInput');
  if (fo) fo.onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    if (total > MAX_FILE_SIZE) {
      error('❌ Dossier trop volumineux (maximum ' + bytes(MAX_FILE_SIZE) + ')');
      e.target.value = '';
      return;
    }
    const sizeEl = document.querySelector('.file-preview-size');
    try {
      await need('jszip');
      const zip = new JSZip();
      files.forEach(f => zip.file(f.webkitRelativePath || f.name, f));

      // Streaming : chunks → Blobs (le navigateur peut les paginer sur disque)
      const parts = [];
      await new Promise((resolve, reject) => {
        const stream = zip.generateInternalStream({
          type: 'uint8array',
          // ✅ STORE sur mobile = 0 buffer de compression en RAM
          compression: isMobile ? 'STORE' : 'DEFLATE',
          compressionOptions: { level: 1 }
        });
        stream.on('data', (chunk) => { parts.push(new Blob([chunk])); });
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.resume();
      });

      const root = ((files[0].webkitRelativePath || 'dossier').split('/')[0]) || 'dossier';
      selectedFile = new File(parts, root + '.zip', { type: 'application/zip' });
      showPreview(selectedFile);
    } catch (err) {
      error('❌ Erreur compression : ' + err.message);
    }
  };

  const bs = $('btnStartSend'); if (bs) bs.onclick = startSender;
  const bcs = $('btnCancelSend'); if (bcs) bcs.onclick = cancelTransfer;
  const bct = $('btnCancelTransfer'); if (bct) bct.onclick = cancelTransfer;
  const br = $('btnRestart'); if (br) br.onclick = () => { cancelTransfer(); history.replaceState({}, document.title, '/'); };

  const bcl = $('btnCopyLink');
  if (bcl) bcl.onclick = async () => {
    const out = $('linkOutput');
    if (!out) return;
    try {
      await navigator.clipboard.writeText(out.value);
    } catch (e) {
      out.select();
      document.execCommand('copy');
    }
    bcl.textContent = '✅ Copié';
    setTimeout(() => { bcl.textContent = '📋 Copier'; }, 2000);
  };

  const bse = $('btnSendEmail');
  if (bse) bse.onclick = sendEmail;
}

/* ---------- Cycle de vie ---------- */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && socket && !socket.connected) socket.connect();
});

window.addEventListener('pageshow', () => {
  if (socket && !socket.connected) socket.connect();
});

window.addEventListener('beforeunload', (e) => {
  if (role && !transferAborted && expectedSize && receivedSize < expectedSize) {
    e.preventDefault();
    e.returnValue = 'Transfert en cours. Quitter ?';
  }
});

setInterval(() => {
  if (socket?.connected) socket.emit('ping-keepalive');
}, 20000);

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  setSocketReady(false);
  if (!window.RTCPeerConnection) return error('❌ WebRTC non supporté');
  const wait = setInterval(() => {
    if (typeof io !== 'undefined') {
      clearInterval(wait);
      initSocket();
    }
  }, 100);
  setTimeout(() => clearInterval(wait), 15000);
});
})();