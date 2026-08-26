// =========================================================
//  Variables globales
// =========================================================
let socket;
let pc;
let dataChannel;
let role = null;
let roomId = '';
let selectedFile = null;
let selectedFiles = [];
let transferAborted = false;
let iceServersConfig = null;
let receivedChunks = [];
let receivedSize = 0;
let expectedSize = 0;
let expectedName = '';
let transferStartTime = 0;
let pendingIceCandidates = [];
let isRemoteDescriptionSet = false;
let wakeLock = null;

// ✅ DÉTECTION RAM ET CHUNK ADAPTATIF
const DEVICE_RAM = navigator.deviceMemory || 4; // en Go
const IS_LOW_MEMORY = DEVICE_RAM <= 2;
const IS_MEDIUM_MEMORY = DEVICE_RAM <= 4;

const CHUNK_SIZE = IS_LOW_MEMORY 
    ? 4 * 1024         // 4 Ko pour téléphones très faibles
    : IS_MEDIUM_MEMORY 
        ? 8 * 1024     // 8 Ko moyen
        : 16 * 1024;   // 16 Ko appareils puissants

const BUFFER_LIMIT = IS_LOW_MEMORY 
    ? 512 * 1024       // 512 Ko buffer max
    : 1024 * 1024 * 2; // 2 Mo buffer max

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 Go
const MAX_FOLDER_SIZE = IS_LOW_MEMORY 
    ? 50 * 1024 * 1024   // 50 Mo sur téléphones faibles
    : 200 * 1024 * 1024; // 200 Mo sur autres

console.log(`💾 RAM: ${DEVICE_RAM}Go | Chunk: ${CHUNK_SIZE/1024}Ko | Buffer: ${BUFFER_LIMIT/1024}Ko`);

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
    }, 10000);
}

function clearError() {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 o';
    if (!bytes || isNaN(bytes) || bytes < 0) return '? o';
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
    console.log('🧹 Nettoyage...');
    pendingIceCandidates = [];
    isRemoteDescriptionSet = false;
    if (dataChannel) { try { dataChannel.close(); } catch(e){} dataChannel = null; }
    if (pc) { try { pc.close(); } catch(e){} pc = null; }
    receivedChunks = [];
    receivedSize = 0;
    expectedSize = 0;
    expectedName = '';
    transferStartTime = 0;
    releaseWakeLock();
}

// =========================================================
//  Wake Lock
// =========================================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('🔒 Wake Lock activé');
            wakeLock.addEventListener('release', () => console.log('🔓 Wake Lock libéré'));
        }
    } catch (err) {
        console.warn('⚠️ Wake Lock:', err.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(()=>{});
        wakeLock = null;
    }
}

// =========================================================
//  Config ICE
// =========================================================
async function getIceServers() {
    if (iceServersConfig) return iceServersConfig;
    try {
        const res = await fetch('/api/ice-config');
        const data = await res.json();
        iceServersConfig = data.iceServers || [
            { urls: 'stun:stun.l.google.com:19302' }
        ];
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
    try {
        return new RTCPeerConnection({ iceServers });
    } catch (e) {
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
        console.log('📡 DC ouvert (expéditeur)');
        transferTitle.textContent = 'Envoi en cours…';
        startFileTransfer();
    };
    
    dataChannel.onclose = () => console.log('📡 DC fermé (expéditeur)');
    
    dataChannel.onerror = (err) => {
        console.error('❌ Erreur DC:', err);
        showError('❌ Erreur canal');
    };
    
    dataChannel.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.msgType === 'complete') {
                showStep('step-done');
                transferTitle.textContent = 'Transfert réussi !';
                releaseWakeLock();
            } else if (msg.msgType === 'error') {
                showError('❌ ' + msg.message);
            }
        } catch (e) {}
    };
}

// =========================================================
//  Data Channel - DESTINATAIRE
// =========================================================
function setupDataChannelReceiver() {
    pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        console.log('📡 DC reçu (destinataire)');
        
        channel.onopen = () => {
            console.log('📡 DC ouvert (destinataire)');
            transferTitle.textContent = 'Réception en cours…';
            transferStartTime = Date.now();
            requestWakeLock();
        };
        
        channel.onclose = () => {
            console.log('📡 DC fermé (destinataire)');
            releaseWakeLock();
        };
        
        channel.onerror = (err) => console.error('❌ Erreur DC:', err);
        
        let metadataReceived = false;
        
        channel.onmessage = (event) => {
            if (transferAborted) return;
            
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
                        receivedChunks = [];
                        console.log(`📥 ${expectedName} (${formatBytes(expectedSize)})`);
                        
                        if (expectedSize > MAX_FILE_SIZE) {
                            channel.send(JSON.stringify({
                                msgType: 'error',
                                message: 'Fichier trop volumineux'
                            }));
                            showError('❌ Fichier trop volumineux');
                            return;
                        }
                        return;
                    }
                } catch (e) {}
            }
            
            const chunk = event.data;
            receivedChunks.push(chunk);
            receivedSize += chunk.byteLength || chunk.length || 0;
            
            if (expectedSize > 0) {
                const percent = Math.min(100, Math.round((receivedSize / expectedSize) * 100));
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + ' %';
                
                const elapsed = (Date.now() - transferStartTime) / 1000;
                if (elapsed > 0) {
                    speedText.textContent = formatSpeed(receivedSize / elapsed);
                }
            }
            
            if (receivedChunks.length % 100 === 0) {
                channel.send(JSON.stringify({ msgType: 'progress', received: receivedSize }));
            }
            
            if (expectedSize > 0 && receivedSize >= expectedSize) {
                console.log('✅ Tous les chunks reçus');
                try {
                    const blob = new Blob(receivedChunks);
                    const url = URL.createObjectURL(blob);
                    downloadLink.href = url;
                    downloadLink.download = expectedName;
                    downloadLink.classList.remove('hidden');
                    downloadLink.textContent = `⬇️ Télécharger ${expectedName} (${formatBytes(blob.size)})`;
                    
                    channel.send(JSON.stringify({ msgType: 'complete' }));
                    try { channel.close(); } catch(e) {}
                    dataChannel = null;
                    
                    showStep('step-done');
                    transferTitle.textContent = '✅ Transfert terminé !';
                    releaseWakeLock();
                } catch (e) {
                    console.error('❌ Erreur assemblage:', e);
                    showError('❌ Erreur assemblage: ' + e.message);
                }
            }
        };
    };
}

// =========================================================
//  ✅ ENVOI FICHIER OPTIMISÉ MÉMOIRE
// =========================================================
function startFileTransfer() {
    if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
        showError('❌ Canal non prêt');
        return;
    }
    
    console.log('🚀 Envoi:', selectedFile.name, selectedFile.size);
    transferStartTime = Date.now();
    let offset = 0;
    let chunkCount = 0;
    
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
    
    requestWakeLock();
    
    const reader = new FileReader();
    
    function sendNextChunk() {
        if (transferAborted) return;
        if (offset >= selectedFile.size) {
            console.log('✅ Envoi terminé');
            return;
        }
        
        // ⚠️ BACKPRESSURE AGRESSIF : pause si buffer saturé
        if (dataChannel.bufferedAmount > BUFFER_LIMIT) {
            setTimeout(sendNextChunk, 50);
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
                if (elapsed > 0) {
                    speedText.textContent = formatSpeed(offset / elapsed);
                }
                
                // ✅ PAUSE FRÉQUENTE pour laisser le GC respirer
                // Sur téléphones faibles : pause tous les 5 chunks
                // Sur autres : pause tous les 20 chunks
                const pauseInterval = IS_LOW_MEMORY ? 5 : 20;
                
                if (chunkCount % pauseInterval === 0) {
                    setTimeout(sendNextChunk, 10); // 10ms pause
                } else {
                    setTimeout(sendNextChunk, 0); // immédiat
                }
            } catch (e) {
                console.error('❌ Erreur chunk:', e);
                showError('❌ Erreur envoi: ' + e.message);
            }
        };
        
        reader.onerror = () => {
            showError('❌ Erreur lecture fichier');
        };
        
        reader.readAsArrayBuffer(chunk);
    }
    
    sendNextChunk();
}

// =========================================================
//  PeerConnection events
// =========================================================
function setupPeerConnectionEvents() {
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { roomId, candidate: event.candidate });
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log('❄️ ICE:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
            showError('❌ Connexion ICE échouée');
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log('🔌 State:', pc.connectionState);
        if (pc.connectionState === 'failed') {
            showError('❌ Connexion P2P échouée');
        }
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
//  UI - Sélection fichiers
// =========================================================
btnModeFile.addEventListener('click', () => {
    clearError();
    fileInput.removeAttribute('webkitdirectory');
    fileInput.click();
});

btnModeFolder.addEventListener('click', () => {
    clearError();
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (file.size > MAX_FILE_SIZE) {
        showError(`❌ Fichier trop volumineux (max ${formatBytes(MAX_FILE_SIZE)})`);
        return;
    }
    
    // ✅ ALERTE pour téléphones faibles
    if (IS_LOW_MEMORY && file.size > 100 * 1024 * 1024) {
        if (!confirm(`⚠️ Votre téléphone a peu de mémoire (${DEVICE_RAM} Go).\n\nUn fichier de ${formatBytes(file.size)} peut causer des problèmes.\n\nContinuer quand même ?`)) {
            fileInput.value = '';
            return;
        }
    }
    
    selectedFile = file;
    showFilePreview(file.name, file.size);
});

folderInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    
    if (totalSize > MAX_FOLDER_SIZE) {
        showError(`❌ Dossier trop volumineux (max ${formatBytes(MAX_FOLDER_SIZE)} sur cet appareil)`);
        return;
    }
    
    showFilePreview('Compression du dossier...', totalSize);
    
    try {
        if (!window.JSZip) throw new Error('JSZip non chargé');
        const zip = new JSZip();
        
        // ✅ Compression progressive (fichier par fichier)
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const buf = await f.arrayBuffer();
            zip.file(f.webkitRelativePath || f.name, buf);
            
            // Pause tous les 5 fichiers pour laisser respirer
            if (i % 5 === 0) {
                fileInfo.textContent = `Compression... ${Math.round((i/files.length)*50)}% (${i+1}/${files.length})`;
                await new Promise(r => setTimeout(r, 10));
            }
        }
        
        fileInfo.textContent = `Finalisation ZIP...`;
        
        const blob = await zip.generateAsync({ type: 'blob' });
        const folderName = files[0].webkitRelativePath?.split('/')[0] || 'dossier';
        selectedFile = new File([blob], `${folderName}.zip`, { type: 'application/zip' });
        showFilePreview(selectedFile.name, selectedFile.size);
    } catch (e) {
        console.error('Erreur compression:', e);
        showError('❌ Erreur compression: ' + e.message);
        filePreview.classList.add('hidden');
    }
});

function showFilePreview(name, size) {
    fileInfo.textContent = `📎 ${name} — ${formatBytes(size)}`;
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
            showError('❌ Erreur WebRTC: ' + e.message);
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
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return showError('❌ Email invalide.');
    }
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
            if (!btnSendEmail.textContent.includes('✅')) {
                btnSendEmail.textContent = '✉️ Envoyer';
            }
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
        showError('❌ Erreur: ' + e.message);
    }
}

// =========================================================
//  Socket.IO
// =========================================================
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('✅ Signalisation OK');
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
        if (!isRemoteDescriptionSet) {
            pendingIceCandidates.push(candidate);
            return;
        }
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

setInterval(() => {
    if (socket?.connected) socket.emit('ping-keepalive');
}, 30000);

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
//  Protection anti-rechargement
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
    console.log('🚀 TransferX v4.0 (Optimisé mémoire)');
    
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