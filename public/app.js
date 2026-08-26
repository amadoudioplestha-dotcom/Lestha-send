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

// ✅ CHUNK adaptatif discret
const DEVICE_RAM = navigator.deviceMemory || 4;
const CHUNK_SIZE = DEVICE_RAM <= 2 ? 8 * 1024 : DEVICE_RAM <= 4 ? 16 * 1024 : 32 * 1024;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

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
//  🛡️ SAUVEGARDE D'ÉTAT ANTI-RELOAD (style WhatsApp)
// =========================================================
// Sur Android faible RAM, le sélecteur de fichiers peut tuer la page.
// On sauvegarde tout dans sessionStorage pour pouvoir restaurer.
function saveSelectionState(file) {
    try {
        const state = {
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            lastModified: file.lastModified,
            timestamp: Date.now(),
            // On ne peut PAS sérialiser le File lui-même, mais on peut
            // le garder en mémoire via une variable globale qui survit
            // si la page ne recharge pas vraiment
        };
        sessionStorage.setItem('pendingFile', JSON.stringify(state));
    } catch (e) {}
}

function clearSelectionState() {
    try { sessionStorage.removeItem('pendingFile'); } catch (e) {}
}

// Variable qui garde le File en mémoire pendant la sélection
let _pendingFileObject = null;

function setPendingFile(file) {
    _pendingFileObject = file;
    saveSelectionState(file);
}

// =========================================================
//  📱 OUVERTURE INTELLIGENTE DU SÉLECTEUR (WhatsApp-style)
// =========================================================
// Stratégie :
// 1. Essayer showOpenFilePicker() (moderne, pas de reload)
// 2. Sinon, utiliser <input type="file"> avec protection
async function openFilePicker(isFolder = false) {
    // Sauvegarder l'état AVANT d'ouvrir le sélecteur
    try {
        sessionStorage.setItem('pageState', JSON.stringify({
            step: 'select',
            timestamp: Date.now()
        }));
    } catch (e) {}
    
    // Méthode moderne (Chrome desktop, pas Android/iOS)
    if (!isFolder && window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                multiple: false
            });
            const file = await fileHandle.getFile();
            return file;
        } catch (e) {
            if (e.name === 'AbortError') return null;
            // Fallback vers input classique
        }
    }
    
    // Méthode classique : input avec attributs Android-friendly
    return new Promise((resolve) => {
        const input = isFolder ? folderInput : fileInput;
        
        // Handler unique
        const handler = (e) => {
            input.removeEventListener('change', handler);
            input.removeEventListener('cancel', cancelHandler);
            const file = e.target.files?.[0];
            resolve(file || null);
        };
        
        const cancelHandler = () => {
            input.removeEventListener('change', handler);
            input.removeEventListener('cancel', cancelHandler);
            resolve(null);
        };
        
        input.addEventListener('change', handler);
        input.addEventListener('cancel', cancelHandler);
        
        // Déclencher l'ouverture
        input.click();
    });
}

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

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {});
        }
    } catch (err) {}
}

function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
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
        
        channel.onopen = () => {
            transferTitle.textContent = 'Réception en cours…';
            transferStartTime = Date.now();
            requestWakeLock();
        };
        channel.onclose = () => releaseWakeLock();
        channel.onerror = () => {};
        
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
                if (elapsed > 0) speedText.textContent = formatSpeed(receivedSize / elapsed);
            }
            
            if (receivedChunks.length % 100 === 0) {
                channel.send(JSON.stringify({ msgType: 'progress', received: receivedSize }));
            }
            
            if (expectedSize > 0 && receivedSize >= expectedSize) {
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
                    showError('❌ Erreur assemblage');
                }
            }
        };
    };
}

// =========================================================
//  Envoi fichier (expéditeur)
// =========================================================
function startFileTransfer() {
    if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
        showError('❌ Canal non prêt');
        return;
    }
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
        if (offset >= selectedFile.size) return;
        
        // Backpressure
        if (dataChannel.bufferedAmount > 1024 * 1024) {
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
                if (elapsed > 0) speedText.textContent = formatSpeed(offset / elapsed);
                
                // Pause régulière pour éviter la surcharge
                if (chunkCount % 10 === 0) {
                    setTimeout(sendNextChunk, 5);
                } else {
                    setTimeout(sendNextChunk, 0);
                }
            } catch (e) {
                showError('❌ Erreur envoi');
            }
        };
        reader.onerror = () => showError('❌ Erreur lecture fichier');
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
//  📱 UI - Sélection fichiers (WhatsApp-style)
// =========================================================

// Fonction d'aperçu d'un fichier avec icône adaptée
function getFileIcon(type, name) {
    if (!type && name) {
        const ext = name.split('.').pop().toLowerCase();
        if (['jpg','jpeg','png','gif','webp','heic'].includes(ext)) return '🖼️';
        if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '🎬';
        if (['mp3','wav','ogg','m4a','flac'].includes(ext)) return '🎵';
        if (['pdf'].includes(ext)) return '📕';
        if (['doc','docx','txt','rtf','odt'].includes(ext)) return '📄';
        if (['xls','xlsx','csv'].includes(ext)) return '📊';
        if (['ppt','pptx'].includes(ext)) return '📽️';
        if (['zip','rar','7z','tar','gz'].includes(ext)) return '📦';
    }
    if (type) {
        if (type.startsWith('image/')) return '🖼️';
        if (type.startsWith('video/')) return '🎬';
        if (type.startsWith('audio/')) return '🎵';
        if (type.includes('pdf')) return '📕';
        if (type.includes('zip') || type.includes('rar')) return '📦';
        if (type.includes('word') || type.includes('document')) return '📄';
        if (type.includes('sheet') || type.includes('excel')) return '📊';
        if (type.includes('presentation')) return '📽️';
    }
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

// Bouton FICHIER
btnModeFile.addEventListener('click', async () => {
    clearError();
    
    // Ouvrir le sélecteur avec notre fonction intelligente
    const file = await openFilePicker(false);
    
    if (!file) return; // annulé
    
    if (file.size > MAX_FILE_SIZE) {
        showError(`❌ Fichier trop volumineux (max ${formatBytes(MAX_FILE_SIZE)})`);
        return;
    }
    
    // Sauvegarder la référence
    setPendingFile(file);
    selectedFile = file;
    showFilePreview(file.name, file.size, file.type);
});

// Bouton DOSSIER
btnModeFolder.addEventListener('click', async () => {
    clearError();
    
    // Ouvrir le sélecteur dossier
    const file = await openFilePicker(true);
    
    if (!file) return;
    
    // Pour les dossiers, on va charger JSZip à la demande (lazy loading)
    showFilePreview('Préparation du dossier...', 0);
    
    try {
        // Charger JSZip seulement maintenant (économie de RAM)
        if (!window.JSZip) {
            fileInfo.innerHTML = '<div style="color: #64748b;">Chargement compression...</div>';
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }
        
        // Le folderInput renvoie plusieurs fichiers dans files[]
        const files = Array.from(folderInput.files);
        if (files.length === 0) {
            showError('❌ Aucun fichier dans le dossier');
            return;
        }
        
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        fileInfo.innerHTML = `<div style="color: #64748b;">Compression de ${files.length} fichiers...</div>`;
        
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
        showError('❌ Erreur compression: ' + e.message);
        filePreview.classList.add('hidden');
    }
});

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
//  Anti-rechargement pendant transfert
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