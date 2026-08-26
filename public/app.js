// =========================================================
//  Variables globales
// =========================================================
let socket;
let pc;
let dataChannel;
let role = null;
let roomId = '';
let selectedFile = null;
let transferAborted = false;
let iceServersConfig = null;
let expectedSize = 0;
let expectedName = '';
let transferStartTime = 0;
let pendingIceCandidates = [];
let isRemoteDescriptionSet = false;
let wakeLock = null;

// ✅ DÉTECTION MOBILE ET RAM
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const DEVICE_RAM = navigator.deviceMemory || 4;
const IS_LOW_MEMORY = IS_MOBILE && DEVICE_RAM <= 3;

// ✅ CHUNK ultra-petits sur mobile faible
const CHUNK_SIZE = IS_LOW_MEMORY ? 8 * 1024 : 16 * 1024;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

console.log(`📱 Mode: ${IS_MOBILE ? 'Mobile' : 'Desktop'} | RAM: ${DEVICE_RAM}Go | Chunk: ${CHUNK_SIZE/1024}Ko`);

// ✅ ÉCRITURE DIRECTE SUR DISQUE (comme Telegram)
let fileStream = null;
let writer = null;
let receivedSize = 0;

// --- Éléments DOM ---
const stepSelect = document.getElementById('step-select');
const stepWaiting = document.getElementById('step-waiting');
const stepTransfer = document.getElementById('step-transfer');
const stepDone = document.getElementById('step-done');
const errorBox = document.getElementById('errorBox');
const btnModeFile = document.getElementById('btnModeFile');
const btnModeFolder = document.getElementById('btnModeFolder');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const filePreview = document.getElementById('filePreview');
const fileInfo = document.getElementById('fileInfo');
const btnStartSend = document.getElementById('btnStartSend');
const waitingMsg = document.getElementById('waitingMsg');
const linkOutput = document.getElementById('linkOutput');
const btnCopyLink = document.getElementById('btnCopyLink');
const btnCancelSend = document.getElementById('btnCancelSend');
const transferTitle = document.getElementById('transferTitle');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const speedText = document.getElementById('speedText');
const btnCancelTransfer = document.getElementById('btnCancelTransfer');
const btnRestart = document.getElementById('btnRestart');
const downloadLink = document.getElementById('downloadLink');
const emailInput = document.getElementById('emailInput');
const btnSendEmail = document.getElementById('btnSendEmail');

// =========================================================
//  Utilitaires
// =========================================================
function showStep(id) {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
}

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    console.error('❌', msg);
    setTimeout(() => {
        if (errorBox.textContent === msg) errorBox.classList.add('hidden');
    }, 8000);
}

function clearError() {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 o';
    if (!bytes || isNaN(bytes)) return '? o';
    const k = 1024;
    const sizes = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function formatSpeed(bps) {
    if (!bps || isNaN(bps)) return '';
    return `${formatBytes(bps)}/s`;
}

function cleanup() {
    pendingIceCandidates = [];
    isRemoteDescriptionSet = false;
    if (writer) { try { writer.close(); } catch(e){} writer = null; }
    fileStream = null;
    if (dataChannel) { try { dataChannel.close(); } catch(e){} dataChannel = null; }
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    receivedSize = 0;
    expectedSize = 0;
    expectedName = '';
    transferStartTime = 0;
    if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {});
        }
    } catch (err) {}
}

async function getIceServers() {
    if (iceServersConfig) return iceServersConfig;
    try {
        const res = await fetch('/api/ice-config');
        const data = await res.json();
        iceServersConfig = data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
        return iceServersConfig;
    } catch (e) {
        iceServersConfig = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
        return iceServersConfig;
    }
}

async function createPeerConnection() {
    const iceServers = await getIceServers();
    try { return new RTCPeerConnection({ iceServers }); }
    catch (e) {
        return new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        });
    }
}

// =========================================================
//  Data Channel - EXPÉDITEUR
// =========================================================
function setupDataChannelSender() {
    if (!dataChannel) return;
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.onopen = () => {
        transferTitle.textContent = 'Envoi en cours…';
        startFileTransfer();
    };
    dataChannel.onclose = () => {};
    dataChannel.onerror = (err) => showError('❌ Erreur canal');
    dataChannel.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.msgType === 'complete') {
                showStep('step-done');
                transferTitle.textContent = 'Transfert réussi !';
                if (wakeLock) { wakeLock.release(); wakeLock = null; }
            } else if (msg.msgType === 'error') {
                showError('❌ ' + msg.message);
            }
        } catch (e) {}
    };
}

// =========================================================
//  Data Channel - DESTINATAIRE (🎯 VERSION TELEGRAM)
//  Écrit directement sur le disque SANS stocker en mémoire
// =========================================================
function setupDataChannelReceiver() {
    pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        
        channel.onopen = async () => {
            transferTitle.textContent = 'Réception en cours…';
            transferStartTime = Date.now();
            await requestWakeLock();
        };
        channel.onclose = () => {
            if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
        };
        channel.onerror = () => {};
        
        let metadataReceived = false;
        let downloadStarted = false;
        
        channel.onmessage = async (event) => {
            if (transferAborted) return;
            
            // Métadonnées
            if (!metadataReceived) {
                try {
                    const strData = typeof event.data === 'string' 
                        ? event.data 
                        : new TextDecoder().decode(event.data);
                    const metadata = JSON.parse(strData);
                    
                    if (metadata.msgType === 'metadata') {
                        expectedName = metadata.name || 'fichier';
                        expectedSize = metadata.size || 0;
                        metadataReceived = true;
                        receivedSize = 0;
                        
                        // ✅ DÉMARRER LE TÉLÉCHARGEMENT DIRECT (StreamSaver)
                        try {
                            if (window.streamSaver) {
                                fileStream = streamSaver.createWriteStream(expectedName, {
                                    size: expectedSize,
                                    writableStrategy: new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
                                    readableStrategy: new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 })
                                });
                                writer = fileStream.getWriter();
                                downloadStarted = true;
                                console.log('💾 Écriture directe sur disque démarrée (mode Telegram)');
                            }
                        } catch (e) {
                            console.warn('⚠️ StreamSaver non disponible, fallback mémoire');
                        }
                        return;
                    }
                } catch (e) {}
            }
            
            // ✅ ÉCRIRE DIRECTEMENT SUR LE DISQUE
            const chunk = event.data;
            const chunkSize = chunk.byteLength || chunk.length || 0;
            
            if (downloadStarted && writer) {
                try {
                    // Écrire le chunk directement sur le disque
                    await writer.write(chunk);
                    receivedSize += chunkSize;
                } catch (e) {
                    console.error('❌ Erreur écriture disque:', e);
                    showError('❌ Erreur écriture disque');
                    return;
                }
            } else {
                // Fallback : garder en mémoire
                if (!window._fallbackChunks) window._fallbackChunks = [];
                window._fallbackChunks.push(chunk);
                receivedSize += chunkSize;
            }
            
            // Progression
            if (expectedSize > 0) {
                const percent = Math.min(100, Math.round((receivedSize / expectedSize) * 100));
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + ' %';
                
                const elapsed = (Date.now() - transferStartTime) / 1000;
                if (elapsed > 0) speedText.textContent = formatSpeed(receivedSize / elapsed);
            }
            
            // ACK périodique
            if (Math.floor(receivedSize / (1024 * 1024)) !== Math.floor((receivedSize - chunkSize) / (1024 * 1024))) {
                channel.send(JSON.stringify({ msgType: 'progress', received: receivedSize }));
            }
            
            // ✅ FIN DU TRANSFERT - FERMER LE FICHIER
            if (expectedSize > 0 && receivedSize >= expectedSize) {
                console.log('✅ Tous les chunks reçus - fermeture fichier');
                
                try {
                    if (writer) {
                        await writer.close();
                        writer = null;
                        fileStream = null;
                    }
                    
                    channel.send(JSON.stringify({ msgType: 'complete' }));
                    try { channel.close(); } catch(e) {}
                    dataChannel = null;
                    
                    showStep('step-done');
                    transferTitle.textContent = '✅ Transfert terminé !';
                    downloadLink.classList.add('hidden'); // Pas besoin avec StreamSaver
                    
                    if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
                } catch (e) {
                    showError('❌ Erreur finalisation: ' + e.message);
                }
            }
        };
    };
}

// =========================================================
//  Envoi fichier (expéditeur)
// =========================================================
async function startFileTransfer() {
    if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
        showError('❌ Canal non prêt');
        return;
    }
    transferStartTime = Date.now();
    let offset = 0;
    
    try {
        dataChannel.send(JSON.stringify({
            msgType: 'metadata',
            name: selectedFile.name,
            size: selectedFile.size,
            fileType: selectedFile.type || 'application/octet-stream'
        }));
    } catch (e) {
        showError('❌ Erreur métadonnées');
        return;
    }
    
    await requestWakeLock();
    await new Promise(r => setTimeout(r, 100));
    
    const reader = new FileReader();
    let chunkCount = 0;
    
    function sendNextChunk() {
        if (transferAborted) return;
        if (offset >= selectedFile.size) {
            console.log('✅ Envoi terminé');
            return;
        }
        
        // Backpressure agressif sur mobile faible
        if (dataChannel.bufferedAmount > 512 * 1024) {
            setTimeout(sendNextChunk, 100);
            return;
        }
        
        const end = Math.min(offset + CHUNK_SIZE, selectedFile.size);
        const chunk = selectedFile.slice(offset, end);
        
        reader.onload = () => {
            if (transferAborted) return;
            try {
                dataChannel.send(reader.result);
                offset = end;
                chunkCount++;
                
                const percent = Math.round((offset / selectedFile.size) * 100);
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + ' %';
                
                const elapsed = (Date.now() - transferStartTime) / 1000;
                if (elapsed > 0) speedText.textContent = formatSpeed(offset / elapsed);
                
                // Pause régulière sur mobile faible
                if (IS_LOW_MEMORY && chunkCount % 5 === 0) {
                    setTimeout(sendNextChunk, 20);
                } else {
                    setTimeout(sendNextChunk, 0);
                }
            } catch (e) {
                showError('❌ Erreur envoi');
            }
        };
        reader.onerror = () => showError('❌ Erreur lecture');
        reader.readAsArrayBuffer(chunk);
    }
    
    sendNextChunk();
}

// =========================================================
//  PeerConnection events
// =========================================================
function setupPeerConnectionEvents() {
    pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit('ice-candidate', { roomId, candidate: event.candidate });
    };
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') showError('❌ Connexion ICE échouée');
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') showError('❌ Connexion P2P échouée');
    };
}

async function applyPendingIceCandidates() {
    if (!isRemoteDescriptionSet || pendingIceCandidates.length === 0) return;
    const candidates = [...pendingIceCandidates];
    pendingIceCandidates = [];
    for (const c of candidates) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
}

async function setupPeerConnectionAsSender() {
    pc = await createPeerConnection();
    setupPeerConnectionEvents();
    return pc;
}

async function setupPeerConnectionAsReceiver() {
    pc = await createPeerConnection();
    setupPeerConnectionEvents();
    setupDataChannelReceiver();
    return pc;
}

// =========================================================
//  🎯 UI - MODE TELEGRAM (Fichiers uniquement sur mobile)
// =========================================================

// Bouton FICHIER - toujours disponible
btnModeFile.addEventListener('click', () => {
    clearError();
    fileInput.removeAttribute('webkitdirectory');
    fileInput.removeAttribute('directory');
    fileInput.click();
});

// Bouton DOSSIER - désactivé sur mobile faible RAM
btnModeFolder.addEventListener('click', () => {
    clearError();
    
    if (IS_LOW_MEMORY) {
        showError('📱 Sur mobile, envoyez les fichiers un par un. Les dossiers ne sont pas supportés pour économiser la mémoire.');
        return;
    }
    
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');
    folderInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
        showError(`❌ Fichier trop volumineux (max ${formatBytes(MAX_FILE_SIZE)})`);
        return;
    }
    selectedFile = file;
    showFilePreview(file.name, file.size, file.type);
});

folderInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    showFilePreview('Compression du dossier...', 0);
    
    try {
        if (!window.JSZip) throw new Error('JSZip non chargé');
        const zip = new JSZip();
        for (const f of files) {
            const buf = await f.arrayBuffer();
            zip.file(f.webkitRelativePath || f.name, buf);
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const folderName = files[0].webkitRelativePath?.split('/')[0] || 'dossier';
        selectedFile = new File([blob], `${folderName}.zip`, { type: 'application/zip' });
        showFilePreview(selectedFile.name, selectedFile.size, selectedFile.type);
    } catch (e) {
        showError('❌ Erreur compression');
        filePreview.classList.add('hidden');
    }
});

function getFileIcon(type, name) {
    const ext = name?.split('.').pop().toLowerCase() || '';
    if (type?.startsWith('image/')) return '🖼️';
    if (type?.startsWith('video/')) return '🎬';
    if (type?.startsWith('audio/')) return '🎵';
    if (ext === 'pdf') return '📕';
    if (['zip','rar','7z'].includes(ext)) return '📦';
    return '📄';
}

function showFilePreview(name, size, type) {
    const icon = getFileIcon(type, name);
    fileInfo.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px; justify-content: center;">
            <div style="font-size: 32px;">${icon}</div>
            <div style="text-align: left; flex: 1; min-width: 0;">
                <div style="font-weight: 600; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
                <div style="font-size: 13px; color: #64748b;">${formatBytes(size)}</div>
            </div>
            <div style="color: #22c55e; font-size: 20px;">✓</div>
        </div>
    `;
    filePreview.classList.remove('hidden');
}

// =========================================================
//  EXPÉDITEUR
// =========================================================
btnStartSend.addEventListener('click', async () => {
    if (!selectedFile) return showError('❌ Aucun fichier sélectionné.');
    clearError();
    role = 'sender';
    transferAborted = false;
    showStep('step-waiting');
    waitingMsg.textContent = '📍 Connexion au serveur...';
    
    socket.emit('create-room', async ({ roomId: id, success, error }) => {
        if (!success) {
            showError('❌ ' + (error || 'Erreur création room'));
            showStep('step-select');
            return;
        }
        roomId = id;
        linkOutput.value = `${location.origin}?room=${roomId}`;
        waitingMsg.textContent = '⏳ En attente du destinataire...';
        
        try {
            await setupPeerConnectionAsSender();
            dataChannel = pc.createDataChannel('file', { ordered: true });
            setupDataChannelSender();
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('send-offer', { roomId, offer });
        } catch (e) {
            showError('❌ Erreur WebRTC');
            setTimeout(() => { cleanup(); showStep('step-select'); }, 3000);
        }
    });
});

btnCopyLink.addEventListener('click', async () => {
    const link = linkOutput.value;
    if (!link) return;
    try {
        await navigator.clipboard.writeText(link);
        btnCopyLink.textContent = '✔️ Copié';
    } catch (e) {
        linkOutput.select();
        document.execCommand('copy');
        btnCopyLink.textContent = '✔️ Copié';
    }
    setTimeout(() => btnCopyLink.textContent = '📋 Copier', 2000);
});

btnCancelSend.addEventListener('click', () => {
    transferAborted = true;
    if (roomId) socket.emit('cancel-transfer', { roomId });
    cleanup();
    showStep('step-select');
});

btnCancelTransfer.addEventListener('click', () => {
    transferAborted = true;
    if (roomId) socket.emit('cancel-transfer', { roomId });
    cleanup();
    showStep('step-select');
});

// =========================================================
//  Email
// =========================================================
btnSendEmail.addEventListener('click', async () => {
    const to = emailInput.value.trim();
    const link = linkOutput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return showError('❌ Email invalide.');
    if (!link) return showError('❌ Aucun lien.');
    
    btnSendEmail.disabled = true;
    btnSendEmail.textContent = 'Envoi...';
    
    try {
        const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, link, fileName: selectedFile?.name })
        });
        const data = await res.json();
        if (data.success) {
            btnSendEmail.textContent = '✅ Envoyé';
            emailInput.value = '';
        } else {
            showError('❌ ' + (data.error || 'Échec'));
            btnSendEmail.textContent = 'Réessayer';
        }
    } catch (e) {
        showError('❌ Erreur réseau');
        btnSendEmail.textContent = 'Réessayer';
    } finally {
        setTimeout(() => {
            btnSendEmail.disabled = false;
            if (!btnSendEmail.textContent.includes('✅')) btnSendEmail.textContent = '✉️ Envoyer';
        }, 3000);
    }
});

// =========================================================
//  DESTINATAIRE
// =========================================================
async function joinAsReceiver() {
    const roomFromUrl = new URLSearchParams(location.search).get('room');
    if (!roomFromUrl) return;
    role = 'receiver';
    roomId = roomFromUrl;
    showStep('step-transfer');
    transferTitle.textContent = 'Connexion au pair...';
    
    try {
        await setupPeerConnectionAsReceiver();
        socket.emit('join-room', { roomId }, ({ success, error }) => {
            if (!success) {
                showError('❌ ' + (error || 'Lien invalide'));
                showStep('step-select');
                return;
            }
            transferTitle.textContent = 'En attente de l\'expéditeur...';
        });
    } catch (e) {
        showError('❌ Erreur');
    }
}

// =========================================================
//  Socket.IO
// =========================================================
function setupSocketListeners() {
    socket.on('connect', () => {
        const room = new URLSearchParams(location.search).get('room');
        if (room && !role) joinAsReceiver();
    });
    socket.on('connect_error', () => showError('❌ Serveur injoignable'));
    socket.on('disconnect', () => {
        if (!transferAborted && role) showError('⚠️ Connexion serveur perdue');
    });
    
    socket.on('offer-received', async ({ offer }) => {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            isRemoteDescriptionSet = true;
            await applyPendingIceCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('send-answer', { roomId, answer });
        } catch (e) {
            showError('❌ Erreur offre');
        }
    });
    
    socket.on('answer-received', async ({ answer }) => {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            isRemoteDescriptionSet = true;
            await applyPendingIceCandidates();
            showStep('step-transfer');
            transferTitle.textContent = 'Connexion en cours...';
        } catch (e) {
            showError('❌ Erreur réponse');
        }
    });
    
    socket.on('ice-candidate', async (candidate) => {
        if (!pc) return;
        if (!isRemoteDescriptionSet) { pendingIceCandidates.push(candidate); return; }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    });
    
    socket.on('receiver-joined', () => {
        waitingMsg.textContent = '✅ Destinataire connecté...';
    });
    
    socket.on('peer-disconnected', () => {
        if (!transferAborted) {
            showError('❌ Pair déconnecté');
            cleanup();
            showStep('step-select');
        }
    });
    
    socket.on('peer-cancelled', () => {
        showError('❌ L\'expéditeur a annulé.');
        cleanup();
        showStep('step-select');
    });
}

setInterval(() => { if (socket?.connected) socket.emit('ping-keepalive'); }, 30000);

// =========================================================
//  Restart
// =========================================================
btnRestart.addEventListener('click', () => {
    cleanup();
    selectedFile = null;
    fileInput.value = '';
    folderInput.value = '';
    filePreview.classList.add('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = '0 %';
    speedText.textContent = '';
    emailInput.value = '';
    history.replaceState({}, document.title, '/');
    showStep('step-select');
});

// =========================================================
//  Anti-rechargement
// =========================================================
window.addEventListener('beforeunload', (e) => {
    if (role && !transferAborted && expectedSize > 0 && receivedSize < expectedSize) {
        e.preventDefault();
        e.returnValue = 'Un transfert est en cours. Quitter ?';
        return e.returnValue;
    }
});

// =========================================================
//  Initialisation
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!window.RTCPeerConnection) {
        showError('❌ WebRTC non supporté.');
        return;
    }
    
    socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    setupSocketListeners();
});