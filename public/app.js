/* TransferX - client synchronized with server.js (Socket.IO + WebRTC) */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const CHUNK_SIZE = mobile ? 16 * 1024 : 64 * 1024;

  let socket = null;
  let pc = null;
  let dc = null;
  let role = null;
  let roomId = null;
  let selectedFile = null;
  let transferAborted = false;
  let socketReady = false;
  let offerInFlight = false;
  let remoteDescriptionSet = false;
  let pendingIce = [];
  let iceServers = null;
  let expectedName = '';
  let expectedSize = 0;
  let receivedSize = 0;
  let transferStart = 0;
  let writer = null;
  let fallbackChunks = [];
  let sendGeneration = 0;

  function showStep(id) {
    document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
    $(id)?.classList.add('active');
    window.scrollTo(0, 0);
  }
  function error(message, box = 'errorBox') {
    const el = $(box);
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    console.error(message);
    setTimeout(() => { if (el.textContent === message) el.classList.add('hidden'); }, 8000);
  }
  function clearErrors() {
    document.querySelectorAll('.error-box').forEach((el) => { el.textContent = ''; el.classList.add('hidden'); });
  }
  function bytes(n) {
    if (!n) return '0 o';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
  }
  function speed(n) { return n > 0 ? `${bytes(n)}/s` : ''; }
  function setSocketReady(ready) {
    socketReady = ready;
    const btn = $('btnStartSend');
    if (btn) {
      btn.disabled = !ready;
      btn.title = ready ? '' : 'Connexion au serveur en cours…';
    }
  }
  function updateProgress(current, total, started = transferStart) {
    const pct = total ? Math.min(100, Math.round(current / total * 100)) : 0;
    if ($('progressFill')) $('progressFill').style.width = `${pct}%`;
    if ($('progressText')) $('progressText').textContent = `${pct}%`;
    if ($('speedText') && started) $('speedText').textContent = speed(current / Math.max((Date.now() - started) / 1000, 0.1));
  }

  async function getIceServers() {
    if (iceServers) return iceServers;
    try {
      const res = await fetch('/api/ice-config', { cache: 'no-store' });
      iceServers = (await res.json()).iceServers;
    } catch (_) {
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    }
    return iceServers;
  }
  async function newPeerConnection() {
    return new RTCPeerConnection({ iceServers: await getIceServers() });
  }
  function wirePeer() {
    pc.onicecandidate = (event) => {
      if (event.candidate && socket?.connected && roomId) socket.emit('ice-candidate', { roomId, candidate: event.candidate });
    };
    pc.oniceconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.iceConnectionState) && !transferAborted) error('❌ Connexion WebRTC interrompue', 'errorBox3');
    };
  }
  async function flushIce() {
    if (!pc || !remoteDescriptionSet) return;
    const queued = pendingIce.splice(0);
    for (const candidate of queued) { try { await pc.addIceCandidate(candidate); } catch (_) {} }
  }
  function requestQueuedIce() {
    if (!socket?.connected || !roomId) return;
    socket.emit('get-ice-candidates', { roomId }, (reply) => {
      for (const candidate of (reply?.candidates || [])) {
        if (!remoteDescriptionSet) pendingIce.push(candidate);
        else pc?.addIceCandidate(candidate).catch(() => {});
      }
    });
  }

  function setupSenderChannel() {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => { $('transferTitle').textContent = 'Envoi en cours…'; sendFile(); };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.msgType === 'complete') { showStep('step-done'); $('transferTitle').textContent = 'Transfert réussi !'; }
        if (msg.msgType === 'error') error(`❌ ${msg.message}`, 'errorBox3');
      } catch (_) {}
    };
  }
  async function sendFile() {
    const generation = ++sendGeneration;
    if (!selectedFile || dc?.readyState !== 'open') return error('❌ Canal de transfert non prêt', 'errorBox3');
    transferStart = Date.now();
    dc.send(JSON.stringify({ msgType: 'metadata', name: selectedFile.name, size: selectedFile.size, type: selectedFile.type || 'application/octet-stream' }));
    let offset = 0;
    let count = 0;
    const read = (blob) => safari ? new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(blob); }) : blob.arrayBuffer();
    while (offset < selectedFile.size && !transferAborted && generation === sendGeneration) {
      if (dc.readyState !== 'open') return;
      if (dc.bufferedAmount > 1024 * 1024) { await new Promise((r) => setTimeout(r, 40)); continue; }
      const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
      try { dc.send(await read(selectedFile.slice(offset, end))); } catch (e) { return error(`❌ Erreur d’envoi : ${e.message}`, 'errorBox3'); }
      offset = end; count += 1;
      updateProgress(offset, selectedFile.size);
      if (mobile && count % 10 === 0) await new Promise((r) => setTimeout(r, 10));
    }
  }
  function setupReceiverChannel() {
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = 'arraybuffer';
      let gotMetadata = false;
      let started = 0;
      channel.onopen = () => { $('transferTitle').textContent = 'Réception en cours…'; started = Date.now(); };
      channel.onmessage = async (msgEvent) => {
        if (transferAborted) return;
        if (!gotMetadata) {
          try {
            const meta = JSON.parse(typeof msgEvent.data === 'string' ? msgEvent.data : new TextDecoder().decode(msgEvent.data));
            if (meta.msgType === 'metadata') {
              gotMetadata = true; expectedName = meta.name || 'fichier'; expectedSize = Number(meta.size) || 0; receivedSize = 0; fallbackChunks = [];
              try { if (window.streamSaver) { const stream = streamSaver.createWriteStream(expectedName, { size: expectedSize }); writer = stream.getWriter(); } } catch (_) { writer = null; }
              if (expectedSize === 0) await finishReceive(channel);
              return;
            }
          } catch (_) {}
        }
        const chunk = msgEvent.data;
        const part = new Uint8Array(chunk);
        if (writer) { try { await writer.write(part); } catch (e) { return error(`❌ Erreur d’écriture : ${e.message}`, 'errorBox3'); } }
        else fallbackChunks.push(part);
        receivedSize += part.byteLength;
        updateProgress(receivedSize, expectedSize, started);
        if (expectedSize && receivedSize >= expectedSize) await finishReceive(channel);
      };
    };
  }
  async function finishReceive(channel) {
    if (writer) { await writer.close().catch(() => {}); writer = null; }
    else if (fallbackChunks.length) { const url = URL.createObjectURL(new Blob(fallbackChunks)); $('downloadLink').href = url; $('downloadLink').download = expectedName; $('downloadLink').classList.remove('hidden'); }
    try { channel.send(JSON.stringify({ msgType: 'complete' })); } catch (_) {}
    showStep('step-done'); $('doneSubtitle').textContent = `${expectedName} — transfert terminé`;
  }

  async function startSender() {
    if (!selectedFile) return error('❌ Sélectionnez un fichier');
    if (!socket?.connected) return error('❌ Connexion au serveur en cours, réessayez dans un instant');
    clearErrors(); role = 'sender'; transferAborted = false; showStep('step-waiting'); $('waitingMsg').textContent = 'Connexion…';
    socket.emit('create-room', async (reply) => {
      if (!reply?.success || !reply.roomId) { showStep('step-select'); return error(`❌ ${reply?.error || 'Impossible de créer la room'}`, 'errorBox2'); }
      roomId = reply.roomId; $('linkOutput').value = `${location.origin}?room=${encodeURIComponent(roomId)}`; $('waitingMsg').textContent = '⏳ En attente du destinataire…';
      try {
        pc = await newPeerConnection(); wirePeer(); dc = pc.createDataChannel('file', { ordered: true }); setupSenderChannel();
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        socket.emit('send-offer', { roomId, offer: pc.localDescription }); offerInFlight = true; requestQueuedIce();
      } catch (e) { error(`❌ Erreur WebRTC : ${e.message}`, 'errorBox2'); resetConnection(); showStep('step-select'); }
    });
  }

  function joinRoom() {
    if (!socket?.connected || !roomId) return;
    socket.emit('join-room', { roomId }, (reply) => {
      if (!reply?.success) { error(`❌ ${reply?.error || 'Lien invalide'}`, 'errorBox3'); showStep('step-select'); return; }
      requestQueuedIce();
    });
  }
  async function startReceiver() {
    role = 'receiver'; showStep('step-transfer'); $('transferTitle').textContent = 'Connexion au pair…';
    try { pc = await newPeerConnection(); wirePeer(); setupReceiverChannel(); joinRoom(); }
    catch (e) { error(`❌ Erreur connexion : ${e.message}`, 'errorBox3'); }
  }
  function resetConnection() {
    sendGeneration += 1; pendingIce = []; remoteDescriptionSet = false; offerInFlight = false;
    if (writer) { writer.close().catch(() => {}); writer = null; }
    try { dc?.close(); } catch (_) {} try { pc?.close(); } catch (_) {}
    dc = null; pc = null;
  }
  function resetUI() {
    selectedFile = null; $('fileInput').value = ''; $('folderInput').value = ''; $('filePreview').classList.add('hidden');
    $('progressFill').style.width = '0%'; $('progressText').textContent = '0%'; $('speedText').textContent = ''; $('emailInput').value = ''; $('downloadLink').classList.add('hidden');
  }
  function cancelTransfer() { transferAborted = true; if (roomId && socket?.connected) socket.emit('cancel-transfer', { roomId }); resetConnection(); roomId = null; role = null; resetUI(); showStep('step-select'); }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
    socket.on('connect', () => {
      setSocketReady(true);
      const urlRoom = new URLSearchParams(location.search).get('room');
      if (!role && urlRoom) { roomId = urlRoom; startReceiver(); }
      else if (role === 'receiver') joinRoom();
      else if (role === 'sender') { error('⚠️ Connexion rétablie : le lien précédent doit être régénéré.', 'errorBox2'); showStep('step-select'); }
    });
    socket.on('disconnect', () => { setSocketReady(false); if (role && !transferAborted) error('⚠️ Connexion signalisation perdue — reconnexion automatique…', role === 'sender' ? 'errorBox2' : 'errorBox3'); });
    socket.on('connect_error', () => setSocketReady(false));
    socket.on('offer-received', async ({ offer }) => {
      if (role !== 'receiver' || !pc) return;
      try { await pc.setRemoteDescription(offer); remoteDescriptionSet = true; await flushIce(); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); socket.emit('send-answer', { roomId, answer: pc.localDescription }); requestQueuedIce(); }
      catch (e) { error(`❌ Offre invalide : ${e.message}`, 'errorBox3'); }
    });
    socket.on('answer-received', async ({ answer }) => { if (!pc) return; try { await pc.setRemoteDescription(answer); remoteDescriptionSet = true; await flushIce(); showStep('step-transfer'); requestQueuedIce(); } catch (e) { error(`❌ Réponse invalide : ${e.message}`, 'errorBox2'); } });
    socket.on('ice-candidate', (candidate) => { if (!pc) return; if (!remoteDescriptionSet) pendingIce.push(candidate); else pc.addIceCandidate(candidate).catch(() => {}); });
    socket.on('receiver-joined', () => { if (role === 'sender') $('waitingMsg').textContent = '✅ Destinataire connecté !'; requestQueuedIce(); });
    socket.on('receiver-left', () => { if (role === 'sender' && !transferAborted) { $('waitingMsg').textContent = '⏳ Destinataire déconnecté, en attente…'; try { dc?.close(); } catch (_) {} } });
    socket.on('peer-disconnected', () => { if (!transferAborted) { error('❌ Pair déconnecté', role === 'sender' ? 'errorBox2' : 'errorBox3'); resetConnection(); showStep('step-select'); } });
    socket.on('peer-cancelled', () => { error('❌ Expéditeur annulé', 'errorBox3'); resetConnection(); showStep('step-select'); });
  }

  function bindUI() {
    $('btnModeFile').onclick = () => $('fileInput').click();
    $('btnModeFolder').onclick = () => $('folderInput').click();
    $('fileInput').onchange = (e) => { selectedFile = e.target.files[0] || null; if (selectedFile) showPreview(selectedFile); };
    $('folderInput').onchange = async (e) => { const files = [...e.target.files]; if (!files.length) return; try { const zip = new JSZip(); files.forEach((file) => zip.file(file.webkitRelativePath || file.name, file)); const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 }, streamFiles: true }); const root = (files[0].webkitRelativePath || 'dossier').split('/')[0] || 'dossier'; selectedFile = new File([blob], `${root}.zip`, { type: 'application/zip' }); showPreview(selectedFile); } catch (_) { error('❌ Erreur compression'); } };
    $('btnStartSend').onclick = startSender; $('btnCancelSend').onclick = cancelTransfer; $('btnCancelTransfer').onclick = cancelTransfer;
    $('btnRestart').onclick = () => { cancelTransfer(); history.replaceState({}, document.title, '/'); };
    $('btnCopyLink').onclick = async () => { try { await navigator.clipboard.writeText($('linkOutput').value); } catch (_) { $('linkOutput').select(); document.execCommand('copy'); } $('btnCopyLink').textContent = '✅ Copié'; setTimeout(() => $('btnCopyLink').textContent = '📋 Copier', 2000); };
    $('btnSendEmail').onclick = sendEmail;
  }
  function showPreview(file) { $('fileInfo').innerHTML = `<div class="file-preview-name">${file.name}</div><div class="file-preview-size">${bytes(file.size)}</div>`; $('filePreview').classList.remove('hidden'); }
  async function sendEmail() { const to = $('emailInput').value.trim(); const link = $('linkOutput').value; if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return error('❌ Email invalide', 'errorBox2'); const btn = $('btnSendEmail'); btn.disabled = true; try { const res = await fetch('/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, link, fileName: selectedFile?.name }) }); const data = await res.json(); if (!res.ok || !data.success) throw new Error(data.error || 'Échec'); btn.textContent = '✅ Envoyé'; } catch (e) { error(`❌ ${e.message}`, 'errorBox2'); } finally { setTimeout(() => { btn.disabled = false; btn.textContent = '✉️ Envoyer'; }, 2500); } }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && socket && !socket.connected) socket.connect(); });
  window.addEventListener('pageshow', () => { if (socket && !socket.connected) socket.connect(); });
  window.addEventListener('pagehide', () => { /* Ne pas fermer socket/PC : Android peut restaurer la page. */ });
  window.addEventListener('beforeunload', (e) => { if (role && !transferAborted && expectedSize && receivedSize < expectedSize) { e.preventDefault(); e.returnValue = 'Transfert en cours. Quitter ?'; } });
  setInterval(() => { if (socket?.connected) socket.emit('ping-keepalive'); }, 20000);

  document.addEventListener('DOMContentLoaded', async () => {
    bindUI(); setSocketReady(false);
    if (!window.RTCPeerConnection) return error('❌ WebRTC non supporté');
    initSocket();
  });
})();
