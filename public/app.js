// =========================================================
//  TRANSFERX - Streaming optimisé, design clair
//  Mobile & Desktop, fichiers illimités
// =========================================================

let socket, pc, dc, role, roomId, selectedFile, transferAborted = false;
let iceServersConfig = null;
let expectedSize = 0, expectedName = '', receivedSize = 0;
let transferStartTime = 0, pendingIceCandidates = [], isRemoteDescriptionSet = false;
let fileStream = null, writer = null;
let debugChunks = 0;

// Détection
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Chunk: petit pour mobile, plus grand pour desktop
const CHUNK_SIZE = IS_MOBILE ? 16384 : 65536;

console.log(`📱 ${IS_MOBILE ? 'Mobile' : 'Desktop'} | ${IS_IOS ? 'iOS' : 'Other'} | Chunk: ${CHUNK_SIZE/1024}KB`);

// =========================================================
//  UTILITAIRES
// =========================================================

const $ = id => document.getElementById(id);

function showStep(id) {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    $(id)?.classList.add('active');
    window.scrollTo(0, 0);
}

function showError(msg, boxId = 'errorBox') {
    const box = $(boxId);
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
    console.error('❌', msg);
    setTimeout(() => {
        if (box.textContent === msg) box.classList.add('hidden');
    }, 8000);
}

function clearError() {
    document.querySelectorAll('.error-box').forEach(b => {
        b.classList.add('hidden');
        b.textContent = '';
    });
}

function formatBytes(b) {
    if (!b || b < 0) return '0 o';
    const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
    return `${(b / Math.pow(1024, i)).toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}

function formatSpeed(bps) {
    return bps > 0 ? `${formatBytes(bps)}/s` : '';
}

// =========================================================
//  NETTOYAGE
// =========================================================

function cleanup() {
    pendingIceCandidates = [];
    isRemoteDescriptionSet = false;
    debugChunks = 0;
    
    if (writer) {
        writer.close().catch(() => {});
        writer = null;
    }
    fileStream = null;
    
    if (dc) try { dc.close(); } catch(e) {}
    dc = null;
    
    if (pc) {
        try { pc.close(); } catch(e) {}
        pc.onicecandidate = null;
        pc.ondatachannel = null;
        pc = null;
    }
    
    receivedSize = 0;
    expectedSize = 0;
    expectedName = '';
}

// =========================================================
//  ICE SERVERS
// =========================================================

async function getIceServers() {
    if (iceServersConfig) return iceServersConfig;
    try {
        const res = await fetch('/api/ice-config');
        const data = await res.json();
        iceServersConfig = data.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
        return iceServersConfig;
    } catch (e) {
        return iceServersConfig = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
    }
}

async function createPC() {
    const ice = await getIceServers();
    try {
        return new RTCPeerConnection({ iceServers: ice });
    } catch (e) {
        return new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
    }
}

// =========================================================
//  SENDER - Data Channel
// =========================================================

function setupDCSender() {
    if (!dc) return;
    dc.binaryType = 'arraybuffer';
    
    dc.onopen = () => {
        $('transferTitle').textContent = 'Envoi en cours...';
        sendFileStreaming();
    };
    
    dc.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.msgType === 'complete') {
                showStep('step-done');
                $('transferTitle').textContent = 'Transfert réussi !';
            } else if (msg.msgType === 'error') {
                showError('❌ ' + msg.message, 'errorBox3');
            }
        } catch(e) {}
    };
}

// =========================================================
//  ENVOI STREAMING - Clé pour fichiers > 500MB
// =========================================================

async function sendFileStreaming() {
    if (!selectedFile || dc?.readyState !== 'open') {
        showError('❌ Canal non prêt', 'errorBox3');
        return;
    }
    
    transferStartTime = Date.now();
    
    // Métadonnées
    dc.send(JSON.stringify({
        msgType: 'metadata',
        name: selectedFile.name,
        size: selectedFile.size,
        type: selectedFile.type || 'application/octet-stream'
    }));
    
    await new Promise(r => setTimeout(r, 100));
    
    // Streaming avec File.slice (pas de FileReader = pas de mémoire)
    let offset = 0;
    const total = selectedFile.size;
    let lastUpdate = 0;
    let chunkCount = 0;
    
    // Pour iOS/Safari: utiliser FileReader (pas le choix)
    // Pour autres: File.slice + ReadableStream si dispo
    
    const useFileReader = IS_SAFARI || IS_IOS;
    
    async function sendNext() {
        if (transferAborted || offset >= total) {
            if (offset >= total) console.log('✅ Envoi terminé:', chunkCount, 'chunks');
            return;
        }
        
        // Backpressure
        if (dc.bufferedAmount > 1024 * 1024) {
            setTimeout(sendNext, 50);
            return;
        }
        
        const end = Math.min(offset + CHUNK_SIZE, total);
        const chunk = selectedFile.slice(offset, end);
        
        try {
            let buffer;
            
            if (useFileReader) {
                // iOS/Safari: obligatoire mais on lit un seul chunk
                buffer = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsArrayBuffer(chunk);
                });
            } else {
                // Chrome/Android: Blob.arrayBuffer() plus propre
                buffer = await chunk.arrayBuffer();
            }
            
            dc.send(buffer);
            offset = end;
            chunkCount++;
            
            // Progression toutes les 100ms max (évite repaint)
            const now = Date.now();
            if (now - lastUpdate > 100) {
                updateSendProgress(offset, total);
                lastUpdate = now;
            }
            
            // Sur mobile: pause courte tous les 10 chunks évite crash
            const needPause = IS_MOBILE && (chunkCount % 10 === 0);
            setTimeout(sendNext, needPause ? 10 : 0);
            
        } catch (e) {
            showError('❌ Erreur envoi: ' + e.message, 'errorBox3');
        }
    }
    
    sendNext();
}

function updateSendProgress(current, total) {
    const pct = Math.min(100, Math.round((current / total) * 100));
    $('progressFill').style.width = pct + '%';
    $('progressText').textContent = pct + '%';
    
    const elapsed = (Date.now() - transferStartTime) / 1000;
    if (elapsed > 0.5) {
        $('speedText').textContent = formatSpeed(current / elapsed);
    }
}

// =========================================================
//  RECEIVER - Data Channel (STREAMING DISQUE)
// =========================================================

function setupDCReceiver() {
    pc.ondatachannel = (e) => {
        const channel = e.channel;
        channel.binaryType = 'arraybuffer';
        
        let gotMeta = false;
        let gotStream = false;
        let startTime = 0;
        
        channel.onopen = () => {
            $('transferTitle').textContent = 'Réception en cours...';
            startTime = Date.now();
        };
        
        channel.onmessage = async (e) => {
            if (transferAborted) return;
            
            // Métadonnées (premier message)
            if (!gotMeta) {
                try {
                    const txt = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
                    const meta = JSON.parse(txt);
                    
                    if (meta.msgType === 'metadata') {
                        expectedName = meta.name || 'fichier';
                        expectedSize = meta.size || 0;
                        gotMeta = true;
                        receivedSize = 0;
                        
                        // Démarrer StreamSaver
                        try {
                            if (window.streamSaver) {
                                fileStream = streamSaver.createWriteStream(expectedName, {
                                    size: expectedSize
                                });
                                writer = fileStream.getWriter();
                                gotStream = true;
                                console.log('💾 StreamSaver actif');
                            }
                        } catch(err) {
                            console.warn('⚠️ StreamSaver fail:', err);
                        }
                        return;
                    }
                } catch(e) {}
            }
            
            // Données binaires
            const chunk = e.data;
            const len = chunk.byteLength || 0;
            
            if (gotStream && writer) {
                try {
                    await writer.write(new Uint8Array(chunk));
                } catch(err) {
                    console.error('❌ Write error:', err);
                    showError('Erreur écriture disque', 'errorBox3');
                    return;
                }
            } else {
                // Fallback mémoire pour petits fichiers
                if (!window._fallbackChunks) window._fallbackChunks = [];
                window._fallbackChunks.push(new Uint8Array(chunk));
            }
            
            receivedSize += len;
            
            // Progression
            if (expectedSize > 0) {
                const pct = Math.min(100, Math.round((receivedSize / expectedSize) * 100));
                $('progressFill').style.width = pct + '%';
                $('progressText').textContent = pct + '%';
                
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    $('speedText').textContent = formatSpeed(receivedSize / elapsed);
                }
            }
            
            // Fin ?
            if (expectedSize > 0 && receivedSize >= expectedSize) {
                finishReceive(channel);
            }
        };
    };
}

async function finishReceive(channel) {
    console.log('✅ Réception complète:', receivedSize, 'bytes');
    
    try {
        if (writer) {
            await writer.close();
            writer = null;
            fileStream = null;
        } else if (window._fallbackChunks) {
            // Fallback: créer blob et télécharger
            const blob = new Blob(window._fallbackChunks);
            const url = URL.createObjectURL(blob);
            $('downloadLink').href = url;
            $('downloadLink').download = expectedName;
            $('downloadLink').classList.remove('hidden');
            window._fallbackChunks = null;
        }
        
        channel.send(JSON.stringify({ msgType: 'complete' }));
        
        showStep('step-done');
        $('transferTitle').textContent = '✅ Transfert terminé !';
        
    } catch(e) {
        showError('❌ Erreur finalisation: ' + e.message, 'errorBox3');
    }
}

// =========================================================
//  PEER CONNECTION
// =========================================================

function setupPCEvents() {
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('ice-candidate', { roomId, candidate: e.candidate });
        }
    };
    
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
            showError('❌ Connexion ICE échouée', 'errorBox3');
        }
    };
}

async function applyPendingIce() {
    if (!isRemoteDescriptionSet || !pendingIceCandidates.length) return;
    const candidates = [...pendingIceCandidates];
    pendingIceCandidates = [];
    for (const c of candidates) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {}
    }
}

// =========================================================
//  UI - SÉLECTION FICHIER
// =========================================================

$('btnModeFile').addEventListener('click', () => {
    clearError();
    fileInput.removeAttribute('webkitdirectory');
    fileInput.removeAttribute('directory');
    $('fileInput').click();
});

$('btnModeFolder').addEventListener('click', () => {
    clearError();
    $('folderInput').setAttribute('webkitdirectory', '');
    $('folderInput').setAttribute('directory', '');
    $('folderInput').click();
});

$('fileInput').addEventListener('change', handleFileSelect);
$('folderInput').addEventListener('change', handleFolderSelect);

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    selectedFile = file;
    showFilePreview(file.name, file.size, file.type);
}

async function handleFolderSelect(e) {
    const files = [...e.target.files];
    if (!files.length) return;
    
    showFilePreview('Compression...', 0);
    
    try {
        const zip = new JSZip();
        for (const f of files) {
            zip.file(f.webkitRelativePath || f.name, f.slice());
        }
        const blob = await zip.generateAsync({ 
            type: 'blob',
            streamFiles: true,
            compression: 'DEFLATE',
            compressionOptions: { level: 1 }
        });
        const name = (files[0].webkitRelativePath?.split('/')[0] || 'dossier') + '.zip';
        selectedFile = new File([blob], name, { type: 'application/zip' });
        showFilePreview(selectedFile.name, selectedFile.size, 'zip');
    } catch(err) {
        showError('❌ Erreur compression');
        $('filePreview').classList.add('hidden');
    }
}

function getFileIcon(type, name) {
    const ext = name?.split('.').pop().toLowerCase();
    if (type?.startsWith('image/')) return '🖼️';
    if (type?.startsWith('video/')) return '🎬';
    if (type?.startsWith('audio/')) return '🎵';
    if (ext === 'pdf') return '📕';
    if (['zip','rar','7z'].includes(ext)) return '📦';
    return '📄';
}

function showFilePreview(name, size, type) {
    const icon = getFileIcon(type, name);
    const sizeStr = size > 0 ? `<div class="file-preview-size">${formatBytes(size)}</div>` : '';
    
    $('fileInfo').innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;justify-content:center;">
            <div style="font-size:32px;flex-shrink:0;">${icon}</div>
            <div style="text-align:left;flex:1;min-width:0;">
                <div class="file-preview-name">${name}</div>
                ${sizeStr}
            </div>
            <div style="color:#22c55e;font-size:20px;flex-shrink:0;">✓</div>
        </div>
    `;
    $('filePreview').classList.remove('hidden');
}

// =========================================================
//  SENDER FLOW
// =========================================================

$('btnStartSend').addEventListener('click', async () => {
    if (!selectedFile) return showError('❌ Sélectionnez un fichier');
    clearError();
    role = 'sender';
    transferAborted = false;
    showStep('step-waiting');
    $('waitingMsg').textContent = 'Connexion...';
    
    socket.emit('create-room', async ({ roomId: id, success, error }) => {
        if (!success) {
            showError('❌ ' + (error || 'Erreur'), 'errorBox2');
            showStep('step-select');
            return;
        }
        
        roomId = id;
        $('linkOutput').value = `${location.origin}?room=${roomId}`;
        $('waitingMsg').textContent = '⏳ En attente du destinataire...';
        
        try {
            pc = await createPC();
            setupPCEvents();
            dc = pc.createDataChannel('file', { ordered: true });
            setupDCSender();
            
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('send-offer', { roomId, offer });
        } catch(e) {
            showError('❌ Erreur WebRTC', 'errorBox2');
            cleanup();
            setTimeout(() => showStep('step-select'), 3000);
        }
    });
});

$('btnCopyLink').addEventListener('click', async () => {
    const link = $('linkOutput').value;
    if (!link) return;
    
    try {
        await navigator.clipboard.writeText(link);
        $('btnCopyLink').textContent = '✅ Copié';
    } catch(e) {
        $('linkOutput').select();
        document.execCommand('copy');
        $('btnCopyLink').textContent = '✅ Copié';
    }
    setTimeout(() => $('btnCopyLink').textContent = '📋 Copier', 2000);
});

$('btnCancelSend').addEventListener('click', cancelTransfer);
$('btnCancelTransfer').addEventListener('click', cancelTransfer);

function cancelTransfer() {
    transferAborted = true;
    if (roomId) socket.emit('cancel-transfer', { roomId });
    cleanup();
    resetUI();
    showStep('step-select');
}

function resetUI() {
    selectedFile = null;
    $('fileInput').value = '';
    $('folderInput').value = '';
    $('filePreview').classList.add('hidden');
    $('progressFill').style.width = '0%';
    $('progressText').textContent = '0%';
    $('speedText').textContent = '';
    $('emailInput').value = '';
    $('downloadLink').classList.add('hidden');
}

// =========================================================
//  EMAIL
// =========================================================

$('btnSendEmail').addEventListener('click', async () => {
    const to = $('emailInput').value.trim();
    const link = $('linkOutput').value;
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return showError('❌ Email invalide', 'errorBox2');
    }
    if (!link) return showError('❌ Aucun lien', 'errorBox2');
    
    const btn = $('btnSendEmail');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Envoi...';
    
    try {
        const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                to, 
                link, 
                fileName: selectedFile?.name 
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            btn.textContent = '✅ Envoyé';
            $('emailInput').value = '';
        } else {
            showError('❌ ' + (data.error || 'Échec'), 'errorBox2');
            btn.textContent = '❌ Réessayer';
        }
    } catch(e) {
        showError('❌ Réseau: ' + e.message, 'errorBox2');
        btn.textContent = '❌ Réessayer';
    }
    
    setTimeout(() => {
        btn.disabled = false;
        if (!btn.textContent.includes('✅')) btn.textContent = original;
    }, 3000);
});

// =========================================================
//  RECEIVER FLOW
// =========================================================

async function joinAsReceiver() {
    const room = new URLSearchParams(location.search).get('room');
    if (!room) return;
    
    role = 'receiver';
    roomId = room;
    transferAborted = false;
    showStep('step-transfer');
    $('transferTitle').textContent = 'Connexion au pair...';
    
    try {
        pc = await createPC();
        setupPCEvents();
        setupDCReceiver();
        
        socket.emit('join-room', { roomId }, ({ success, error }) => {
            if (!success) {
                showError('❌ ' + (error || 'Lien invalide'), 'errorBox3');
                showStep('step-select');
            }
        });
    } catch(e) {
        showError('❌ Erreur connexion', 'errorBox3');
    }
}

// =========================================================
//  SOCKET.IO
// =========================================================

function initSocket() {
    socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
    });
    
    socket.on('connect', () => {
        const room = new URLSearchParams(location.search).get('room');
        if (room && !role) joinAsReceiver();
    });
    
    socket.on('connect_error', () => {
        showError('❌ Serveur injoignable');
    });
    
    socket.on('disconnect', () => {
        if (!transferAborted && role) {
            showError('⚠️ Connexion perdue');
        }
    });
    
    socket.on('offer-received', async ({ offer }) => {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            isRemoteDescriptionSet = true;
            await applyPendingIce();
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('send-answer', { roomId, answer });
        } catch(e) {
            showError('❌ Erreur offre', 'errorBox3');
        }
    });
    
    socket.on('answer-received', async ({ answer }) => {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            isRemoteDescriptionSet = true;
            await applyPendingIce();
            showStep('step-transfer');
        } catch(e) {
            showError('❌ Erreur réponse', 'errorBox3');
        }
    });
    
    socket.on('ice-candidate', async (candidate) => {
        if (!pc) return;
        if (!isRemoteDescriptionSet) {
            pendingIceCandidates.push(candidate);
            return;
        }
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {}
    });
    
    socket.on('receiver-joined', () => {
        $('waitingMsg').textContent = '✅ Destinataire connecté !';
    });
    
    socket.on('peer-disconnected', () => {
        if (!transferAborted) {
            showError('❌ Pair déconnecté');
            cleanup();
            showStep('step-select');
        }
    });
    
    socket.on('peer-cancelled', () => {
        showError('❌ Expéditeur annulé');
        cleanup();
        showStep('step-select');
    });
}

// Keepalive
setInterval(() => {
    if (socket?.connected) socket.emit('ping-keepalive');
}, 30000);

// =========================================================
//  RESTART
// =========================================================

$('btnRestart').addEventListener('click', () => {
    cleanup();
    resetUI();
    history.replaceState({}, document.title, '/');
    showStep('step-select');
});

// =========================================================
//  ANTI-RELOAD
// =========================================================

window.addEventListener('beforeunload', (e) => {
    if (role && !transferAborted && expectedSize > 0 && receivedSize < expectedSize) {
        e.preventDefault();
        e.returnValue = 'Transfert en cours. Quitter ?';
        return e.returnValue;
    }
});

// =========================================================
//  INIT
// =========================================================

document.addEventListener('DOMContentLoaded', () => {
    if (!window.RTCPeerConnection) {
        showError('❌ WebRTC non supporté');
        return;
    }
    initSocket();
});