// =========================================================
//  Variables globales
// =========================================================
let socket;
let pc;
let dataChannel;
let role = null;
let roomId = '';
let selectedFile = null;
let selectedFiles = []; // Pour les dossiers
let transferAborted = false;
let iceServersConfig = null;
let receivedChunks = [];
let receivedSize = 0;
let expectedSize = 0;
let expectedName = '';
let transferStartTime = 0;
let pendingIceCandidates = []; // Buffer pour les candidats arrivés avant setRemoteDescription
let isRemoteDescriptionSet = false;

const CHUNK_SIZE = 16 * 1024;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB limite de sécurité

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
//  Fonctions utilitaires
// =========================================================

function showStep(id) {
    document.querySelectorAll('.step').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    console.error('❌ Erreur UI:', msg);
    
    // Auto-hide après 10 secondes
    setTimeout(() => {
        if (errorBox.textContent === msg) {
            errorBox.classList.add('hidden');
        }
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

function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || isNaN(bytesPerSecond)) return '';
    return `${formatBytes(bytesPerSecond)}/s`;
}

function cleanup() {
    console.log('🧹 Nettoyage connexion...');
    
    pendingIceCandidates = [];
    isRemoteDescriptionSet = false;
    
    if (dataChannel) {
        try {
            dataChannel.close();
        } catch (e) {
            console.warn('Erreur fermeture dataChannel:', e.message);
        }
        dataChannel = null;
    }
    
    if (pc) {
        try {
            pc.close();
        } catch (e) {
            console.warn('Erreur fermeture RTCPeerConnection:', e.message);
        }
        pc = null;
    }
    
    receivedChunks = [];
    receivedSize = 0;
    expectedSize = 0;
    expectedName = '';
    transferStartTime = 0;
}

// =========================================================
//  Récupération config TURN/STUN depuis le serveur
// =========================================================
async function getIceServers() {
    if (iceServersConfig) return iceServersConfig;
    
    try {
        const res = await fetch('/api/ice-config');
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        
        const data = await res.json();
        console.log('📥 Réponse brute ICE config:', JSON.stringify(data));
        
        // Valider chaque serveur reçu
        const validServers = [];
        
        for (const server of (data.iceServers || [])) {
            if (!server || !server.urls) {
                console.warn('⚠️ Serveur ICE invalide (pas d\'URLs):', server);
                continue;
            }
            
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            const validUrls = [];
            
            for (const url of urls) {
                if (!url || typeof url !== 'string') continue;
                
                // Vérification manuelle du format
                const match = url.match(/^(stun|turn|turns):([^:]+):(\d+)$/);
                if (!match) {
                    console.warn('⚠️ URL ICE rejetée (format invalide):', url);
                    continue;
                }
                
                const [, scheme, host, port] = match;
                const portNum = parseInt(port, 10);
                
                if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
                    console.warn('⚠️ URL ICE rejetée (port invalide):', url);
                    continue;
                }
                
                validUrls.push(url);
            }
            
            if (validUrls.length > 0) {
                const cleanServer = { urls: validUrls.length === 1 ? validUrls[0] : validUrls };
                
                // Ajouter credentials si présents et c'est un TURN
                const isTurn = validUrls.some(u => u.startsWith('turn:') || u.startsWith('turns:'));
                if (isTurn && server.username && server.credential) {
                    cleanServer.username = String(server.username).trim();
                    cleanServer.credential = String(server.credential).trim();
                }
                
                validServers.push(cleanServer);
                console.log('✅ Serveur ICE validé:', cleanServer);
            }
        }
        
        // S'assurer qu'on a au moins les STUN par défaut
        if (validServers.length === 0) {
            throw new Error('Aucun serveur ICE valide reçu du serveur');
        }
        
        iceServersConfig = validServers;
        console.log('✅ Config ICE finale:', iceServersConfig);
        return iceServersConfig;
        
    } catch (e) {
        console.warn('⚠️ Fallback STUN uniquement:', e.message);
        iceServersConfig = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
        return iceServersConfig;
    }
}

// =========================================================
//  Création RTCPeerConnection robuste
// =========================================================
async function createPeerConnection() {
    const iceServers = await getIceServers();
    
    console.log('🔧 Tentative création RTCPeerConnection avec:', JSON.stringify(iceServers));
    
    // Essayer avec la config complète
    try {
        const config = { iceServers };
        const connection = new RTCPeerConnection(config);
        console.log('✅ RTCPeerConnection créé avec config serveur');
        return connection;
    } catch (e) {
        console.error('❌ Échec RTCPeerConnection config complète:', e.message);
    }
    
    // Fallback: STUN uniquement
    try {
        const fallbackConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };
        const connection = new RTCPeerConnection(fallbackConfig);
        console.log('⚠️ RTCPeerConnection créé avec fallback STUN uniquement');
        showError('⚠️ Connexion avec relais TURN impossible, utilisation STUN uniquement (peut échouer derrière certains pare-feu)');
        return connection;
    } catch (e2) {
        console.error('❌ Échec total RTCPeerConnection:', e2.message);
        throw new Error('Votre navigateur ne supporte pas WebRTC ou la connexion est bloquée');
    }
}

// =========================================================
//  Configuration du data channel (expéditeur)
// =========================================================
function setupDataChannelSender() {
    if (!dataChannel) {
        console.error('❌ dataChannel est null dans setupDataChannelSender');
        return;
    }
    
    dataChannel.binaryType = 'arraybuffer';
    
    dataChannel.onopen = () => {
        console.log('📡 DataChannel ouvert (expéditeur)');
        transferTitle.textContent = 'Envoi en cours…';
        startFileTransfer();
    };
    
    dataChannel.onclose = () => {
        console.log('📡 DataChannel fermé (expéditeur)');
    };
    
    dataChannel.onerror = (err) => {
        console.error('❌ Erreur DataChannel:', err);
        showError('❌ Erreur de canal de données: ' + (err.message || 'inconnue'));
    };
    
    // Confirmations du récepteur
    dataChannel.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            console.log('📥 Message reçu:', msg.type);
            
            if (msg.type === 'progress') {
                // Mise à jour si besoin
            } else if (msg.type === 'complete') {
                console.log('✅ Destinataire confirme réception complète');
                showStep('step-done');
                transferTitle.textContent = 'Transfert réussi !';
                downloadLink.classList.add('hidden');
            } else if (msg.type === 'error') {
                showError('❌ Erreur côté destinataire: ' + msg.message);
            }
        } catch (e) {
            // Pas un JSON, ignorer
        }
    };
}

// =========================================================
//  Configuration du data channel (destinataire)
// =========================================================
// =========================================================
//  Configuration du data channel (destinataire) - VERSION CORRIGÉE
// =========================================================
function setupDataChannelReceiver() {
    pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        
        console.log('📡 DataChannel reçu (destinataire)');
        
        channel.onopen = () => {
            console.log('📡 DataChannel ouvert (destinataire)');
            transferTitle.textContent = 'Réception en cours…';
            transferStartTime = Date.now();
        };
        
        channel.onclose = () => {
            console.log('📡 DataChannel fermé (destinataire)');
        };
        
        channel.onerror = (err) => {
            console.error('❌ Erreur DataChannel destinataire:', err);
        };
        
        let metadataReceived = false;
        let fileBuffer = [];
        
        channel.onmessage = (event) => {
            if (transferAborted) return;
            
            // Premier message: métadonnées (JSON)
            if (!metadataReceived) {
                try {
                    // Sécurisation : on s'assure que c'est bien du texte avant de parser
                    const strData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
                    const metadata = JSON.parse(strData);
                    
                    // ✅ On cherche maintenant "msgType" au lieu de "type"
                    if (metadata.msgType === 'metadata') {
                        expectedName = metadata.name || 'fichier';
                        expectedSize = metadata.size || 0;
                        metadataReceived = true;
                        receivedChunks = [];
                        receivedSize = 0;
                        
                        console.log(`📥 Métadonnées reçues: ${expectedName} (${formatBytes(expectedSize)})`);
                        
                        if (expectedSize > MAX_FILE_SIZE) {
                            channel.send(JSON.stringify({
                                msgType: 'error', // ✅ Changé ici aussi
                                message: 'Fichier trop volumineux (max 2 Go)'
                            }));
                            throw new Error('Fichier trop volumineux');
                        }
                        
                        return;
                    }
                } catch (e) {
                    if (e.message === 'Fichier trop volumineux') {
                        cleanup();
                        showError('❌ Fichier trop volumineux (limite: 2 Go)');
                        return;
                    }
                    // Pas des métadonnées JSON valides, c'est un chunk binaire, on continue
                }
            }
            
            // Chunks de données
            const chunk = event.data;
            receivedChunks.push(chunk);
            receivedSize += chunk.byteLength || chunk.length || 0;
            
            // Mise à jour progression
            if (expectedSize > 0) {
                const percent = Math.min(100, Math.round((receivedSize / expectedSize) * 100));
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + ' %';
                
                // Vitesse
                const elapsed = (Date.now() - transferStartTime) / 1000;
                if (elapsed > 0) {
                    const speed = receivedSize / elapsed;
                    speedText.textContent = formatSpeed(speed);
                }
            }
            
            // Envoi accusé réception périodique
            if (receivedChunks.length % 100 === 0) {
                channel.send(JSON.stringify({
                    msgType: 'progress', // ✅ Changé ici aussi
                    received: receivedSize
                }));
            }
            
            // Transfert terminé?
            if (expectedSize > 0 && receivedSize >= expectedSize) {
                console.log('✅ Tous les chunks reçus:', receivedSize, '/', expectedSize);
                
                try {
                    // Assembler le fichier
                    const blob = new Blob(receivedChunks);
                    console.log('📦 Blob assemblé:', blob.size, 'bytes');
                    
                    // Vérifier taille finale
                    if (blob.size !== expectedSize) {
                        console.warn(`⚠️ Taille finale différente: ${blob.size} vs ${expectedSize}`);
                    }
                    
                    // Créer le lien de téléchargement
                    const url = URL.createObjectURL(blob);
                    downloadLink.href = url;
                    downloadLink.download = expectedName;
                    downloadLink.classList.remove('hidden');
                    downloadLink.textContent = `⬇️ Télécharger ${expectedName} (${formatBytes(blob.size)})`;
                    
                    // Notification au sender
                    channel.send(JSON.stringify({ msgType: 'complete' })); // ✅ Changé ici aussi
                    
                    showStep('step-done');
                    transferTitle.textContent = '✅ Transfert terminé !';
                    
                    // Nettoyer la connexion mais garder le blob
                    if (dataChannel) {
                        try { dataChannel.close(); } catch (e) {}
                        dataChannel = null;
                    }
                    
                } catch (e) {
                    console.error('❌ Erreur assemblage fichier:', e);
                    channel.send(JSON.stringify({
                        msgType: 'error', // ✅ Changé ici aussi
                        message: 'Erreur assemblage: ' + e.message
                    }));
                    showError('❌ Erreur lors de l\'assemblage du fichier');
                }
            }
        };
    };
}

// =========================================================
//  Envoi du fichier (chunk par chunk)
// =========================================================
// =========================================================
//  Envoi du fichier (chunk par chunk) - VERSION CORRIGÉE
// =========================================================
async function startFileTransfer() {
    if (!selectedFile || !dataChannel || dataChannel.readyState !== 'open') {
        showError('❌ Canal non prêt pour l\'envoi');
        return;
    }
    console.log('🚀 Début envoi:', selectedFile.name, selectedFile.size);
    transferStartTime = Date.now();
    let offset = 0;
    let chunkIndex = 0;
    
    // Envoyer métadonnées d'abord
    try {
        dataChannel.send(JSON.stringify({
            msgType: 'metadata', // ✅ CHANGÉ (évite le conflit avec la propriété 'type' du fichier)
            name: selectedFile.name,
            size: selectedFile.size,
            fileType: selectedFile.type || 'application/octet-stream' // ✅ CHANGÉ
        }));
    } catch (e) {
        showError('❌ Erreur envoi métadonnées: ' + e.message);
        return;
    }
    
    // Attendre un peu que les métadonnées soient traitées
    await new Promise(r => setTimeout(r, 50));
    
    const reader = new FileReader();
    
    function sendNextChunk() {
        if (transferAborted) {
            console.log('⛔ Envoi annulé');
            return;
        }
        
        if (offset >= selectedFile.size) {
            console.log('✅ Envoi terminé');
            return;
        }

        // ⚠️ Anti-saturation du buffer WebRTC (Backpressure)
        if (dataChannel.bufferedAmount > 1024 * 1024 * 4) {
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
                chunkIndex++;
                
                const percent = Math.round((offset / selectedFile.size) * 100);
                progressFill.style.width = percent + '%';
                progressText.textContent = percent + ' %';
                
                // Vitesse
                const elapsed = (Date.now() - transferStartTime) / 1000;
                if (elapsed > 0) {
                    const speed = offset / elapsed;
                    speedText.textContent = formatSpeed(speed);
                }
                
                // Prochain chunk (avec setTimeout pour laisser respirer le navigateur)
                setTimeout(sendNextChunk, 0);
            } catch (e) {
                console.error('❌ Erreur envoi chunk:', e);
                showError('❌ Erreur envoi: ' + e.message);
            }
        };
        
        reader.onerror = (e) => {
            console.error('❌ Erreur lecture fichier:', e);
            showError('❌ Erreur lecture du fichier');
        };
        reader.readAsArrayBuffer(chunk);
    }
    
    sendNextChunk();
}

// =========================================================
//  Gestion des offres/réponses ICE
// =========================================================
function setupPeerConnectionEvents() {
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('❄️ ICE candidate généré:', event.candidate.type, event.candidate.protocol);
            socket.emit('ice-candidate', { roomId, candidate: event.candidate });
        } else {
            console.log('❄️ ICE gathering terminé');
        }
    };
    
    pc.onicegatheringstatechange = () => {
        console.log('❄️ ICE gathering state:', pc.iceGatheringState);
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log('❄️ ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
            showError('❌ Connexion ICE échouée. Essayez un autre réseau ou vérifiez votre pare-feu.');
        } else if (pc.iceConnectionState === 'disconnected') {
            console.warn('⚠️ Connexion ICE interrompue, tentative de reconnexion...');
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            console.log('✅ Connexion ICE établie');
        }
    };
    
    pc.onconnectionstatechange = () => {
        console.log('🔌 Connection state:', pc.connectionState);
        if (pc.connectionState === 'failed') {
            showError('❌ La connexion P2P a échoué complètement.');
        } else if (pc.connectionState === 'connected') {
            console.log('✅ Connexion P2P établie');
        }
    };
    
    pc.onsignalingstatechange = () => {
        console.log('📡 Signaling state:', pc.signalingState);
    };
}

// =========================================================
//  Application des candidats ICE en attente
// =========================================================
async function applyPendingIceCandidates() {
    if (!isRemoteDescriptionSet || pendingIceCandidates.length === 0) return;
    
    console.log(`🔄 Application de ${pendingIceCandidates.length} candidats ICE en attente`);
    
    const candidates = [...pendingIceCandidates];
    pendingIceCandidates = [];
    
    for (const candidate of candidates) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('✅ Candidat ICE appliqué (en retard)');
        } catch (e) {
            console.warn('⚠️ Échec application candidat ICE:', e.message);
        }
    }
}

// =========================================================
//  Initialisation expéditeur
// =========================================================
async function setupPeerConnectionAsSender() {
    try {
        pc = await createPeerConnection();
        setupPeerConnectionEvents();
        
        // Le data channel sera créé après
        return pc;
        
    } catch (e) {
        console.error('❌ Échec setup sender:', e);
        throw e;
    }
}

// =========================================================
//  Initialisation destinataire
// =========================================================
async function setupPeerConnectionAsReceiver() {
    try {
        pc = await createPeerConnection();
        setupPeerConnectionEvents();
        setupDataChannelReceiver();
        
        return pc;
        
    } catch (e) {
        console.error('❌ Échec setup receiver:', e);
        throw e;
    }
}

// =========================================================
//  Événements UI - Sélection de fichiers
// =========================================================
btnModeFile.addEventListener('click', () => {
    clearError();
    fileInput.click();
    fileInput.removeAttribute('webkitdirectory');
    fileInput.removeAttribute('directory');
});

btnModeFolder.addEventListener('click', () => {
    clearError();
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');
    folderInput.click();
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (file.size > MAX_FILE_SIZE) {
        showError(`❌ Fichier trop volumineux (max ${formatBytes(MAX_FILE_SIZE)})`);
        fileInput.value = '';
        return;
    }
    
    selectedFile = file;
    selectedFiles = [file];
    showFilePreview(file.name, file.size);
});

folderInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalSize > MAX_FILE_SIZE) {
        showError(`❌ Dossier trop volumineux (max ${formatBytes(MAX_FILE_SIZE)})`);
        folderInput.value = '';
        return;
    }
    
    // Compression ZIP
    showFilePreview('Compression du dossier...', totalSize);
    
    try {
        const JSZip = window.JSZip;
        if (!JSZip) {
            throw new Error('Bibliothèque JSZip non chargée');
        }
        
        const zip = new JSZip();
        
        for (const file of files) {
            const arrayBuffer = await file.arrayBuffer();
            // Garder la structure relative
            const path = file.webkitRelativePath || file.name;
            zip.file(path, arrayBuffer);
        }
        
        const blob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
            if (metadata.percent) {
                fileInfo.textContent = `Compression... ${Math.round(metadata.percent)} %`;
            }
        });
        
        const folderName = files[0].webkitRelativePath?.split('/')[0] || 'dossier';
        selectedFile = new File([blob], `${folderName}.zip`, { type: 'application/zip' });
        selectedFiles = files;
        
        showFilePreview(selectedFile.name, selectedFile.size);
        
    } catch (e) {
        console.error('Erreur compression:', e);
        showError('❌ Erreur compression: ' + e.message);
        filePreview.classList.add('hidden');
        folderInput.value = '';
    }
});

function showFilePreview(name, size) {
    fileInfo.textContent = `📎 ${name} — ${formatBytes(size)}`;
    filePreview.classList.remove('hidden');
}

// =========================================================
//  EXPÉDITEUR : démarrage du transfert
// =========================================================
btnStartSend.addEventListener('click', async () => {
    if (!selectedFile) {
        return showError('❌ Aucun fichier sélectionné.');
    }
    
    clearError();
    role = 'sender';
    transferAborted = false;
    showStep('step-waiting');
    waitingMsg.textContent = '📍 Connexion au serveur de signalisation...';

    socket.emit('create-room', async ({ roomId: id, success, error }) => {
        if (!success) {
            showError('❌ ' + (error || 'Erreur création room'));
            showStep('step-select');
            return;
        }
        
        roomId = id;
        const link = `${location.origin}?room=${roomId}`;
        linkOutput.value = link;
        waitingMsg.textContent = '⏳ En attente du destinataire...';
        
        try {
            await setupPeerConnectionAsSender();
            
            // Créer le data channel AVANT l'offre
            dataChannel = pc.createDataChannel('file', {
                ordered: true // Fiabilité pour le transfert de fichiers
            });
            setupDataChannelSender();
            
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('send-offer', { roomId, offer });
            
            console.log('✅ Offre SDP créée et envoyée');
            
        } catch (e) {
            console.error('❌ Erreur création offre:', e);
            showError('❌ Erreur WebRTC: ' + (e.message || 'Impossible de créer la connexion'));
            // Retour à l'étape sélection
            setTimeout(() => {
                cleanup();
                showStep('step-select');
            }, 3000);
        }
    });
});

btnCopyLink.addEventListener('click', async () => {
    const link = linkOutput.value;
    if (!link) return;
    
    try {
        await navigator.clipboard.writeText(link);
        btnCopyLink.textContent = '✔️ Copié';
        setTimeout(() => (btnCopyLink.textContent = '📋 Copier'), 2000);
    } catch (e) {
        console.warn('Copie presse-papiers échouée:', e);
        // Fallback: sélectionner le texte
        linkOutput.select();
        linkOutput.setSelectionRange(0, 99999);
        
        try {
            document.execCommand('copy');
            btnCopyLink.textContent = '✔️ Copié';
        } catch (e2) {
            btnCopyLink.textContent = '❌ Erreur';
            // Dernier recours: afficher le lien
            prompt('Copiez ce lien:', link);
        }
        
        setTimeout(() => (btnCopyLink.textContent = '📋 Copier'), 2000);
    }
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
//  Envoi du lien par e-mail
// =========================================================
btnSendEmail.addEventListener('click', async () => {
    const to = emailInput.value.trim();
    const link = linkOutput.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return showError('❌ Adresse e-mail invalide.');
    }
    if (!link) {
        return showError('❌ Aucun lien disponible.');
    }

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
            showError('❌ ' + (data.error || 'Échec envoi'));
            btnSendEmail.textContent = 'Réessayer';
        }
    } catch (e) {
        showError('❌ Erreur réseau: ' + e.message);
        btnSendEmail.textContent = 'Réessayer';
    } finally {
        setTimeout(() => {
            btnSendEmail.disabled = false;
            if (!btnSendEmail.textContent.includes('✅')) {
                btnSendEmail.textContent = 'Envoyer';
            }
        }, 3000);
    }
});

// =========================================================
//  DESTINATAIRE : rejoindre un transfert
// =========================================================
async function joinAsReceiver() {
    const params = new URLSearchParams(location.search);
    const roomFromUrl = params.get('room');
    
    if (!roomFromUrl) return; // Pas de room, mode normal
    
    // C'est un lien de réception
    role = 'receiver';
    roomId = roomFromUrl;
    
    console.log('🔗 Tentative rejoindre room:', roomId);
    
    showStep('step-transfer');
    transferTitle.textContent = 'Connexion au pair...';
    progressText.textContent = 'Initialisation...';
    
    try {
        await setupPeerConnectionAsReceiver();
        
        socket.emit('join-room', { roomId }, async ({ success, error }) => {
            if (!success) {
                showError('❌ ' + (error || 'Lien invalide'));
                showStep('step-select');
                return;
            }
            
            console.log('✅ Rejoint room avec succès, attente offre...');
            transferTitle.textContent = 'En attente de l\'expéditeur...';
        });
        
    } catch (e) {
        console.error('❌ Erreur initialisation receiver:', e);
        showError('❌ Impossible d\'initialiser: ' + e.message);
    }
}

// =========================================================
//  Gestion des signaux Socket.IO
// =========================================================
function setupSocketListeners() {
    // Connexion établie
    socket.on('connect', () => {
        console.log('✅ Signalisation OK -', socket.id);
        
        // Si URL avec room, tenter de rejoindre
        const params = new URLSearchParams(location.search);
        if (params.get('room') && !role) {
            joinAsReceiver();
        }
    });

    socket.on('connect_error', (err) => {
        console.error('❌ Erreur connexion socket:', err.message);
        showError('❌ Impossible de joindre le serveur de signalisation.');
    });

    socket.on('disconnect', (reason) => {
        console.log('❌ Déconnecté:', reason);
        if (!transferAborted && role) {
            showError('❌ Connexion au serveur perdue. Le transfert peut continuer si la connexion P2P est établie.');
        }
    });

    // --- RECEIVER: Offre reçue ---
    socket.on('offer-received', async ({ offer }) => {
        console.log('📥 Offre SDP reçue');
        
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            isRemoteDescriptionSet = true;
            
            // Appliquer les candidats ICE en attente
            await applyPendingIceCandidates();
            
            // Récupérer les candidats bufférisés sur le serveur aussi
            socket.emit('get-ice-candidates', { roomId }, async ({ candidates }) => {
                for (const candidate of (candidates || [])) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (e) {
                        console.warn('⚠️ Candidat serveur échoué:', e.message);
                    }
                }
            });
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('send-answer', { roomId, answer });
            
            console.log('✅ Answer envoyée');
            
        } catch (e) {
            console.error('❌ Erreur traitement offre:', e);
            showError('❌ Erreur connexion: ' + e.message);
        }
    });

    // --- SENDER: Réponse reçue ---
    socket.on('answer-received', async ({ answer }) => {
        console.log('📥 Answer SDP reçue');
        
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            isRemoteDescriptionSet = true;
            
            await applyPendingIceCandidates();
            
            console.log('✅ Connexion P2P en cours d\'établissement...');
            
            // Passer à l'étape transfert
            showStep('step-transfer');
            transferTitle.textContent = 'Préparation...';
            
        } catch (e) {
            console.error('❌ Erreur traitement answer:', e);
            showError('❌ Erreur connexion: ' + e.message);
        }
    });

    // --- Candidat ICE reçu ---
    socket.on('ice-candidate', async (candidate) => {
        console.log('❄️ Candidat ICE reçu:', candidate?.type, candidate?.protocol);
        
        if (!pc) {
            console.warn('⏳ RTCPeerConnection pas encore créé, candidat ignoré');
            return;
        }
        
        // Si remote description pas encore définie, bufferiser
        if (!isRemoteDescriptionSet || pc.remoteDescription === null) {
            console.log('⏳ Candidat ICE mis en buffer');
            pendingIceCandidates.push(candidate);
            return;
        }
        
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('✅ Candidat ICE appliqué');
        } catch (e) {
            console.warn('⚠️ Échec ajout candidat ICE:', e.message, candidate);
        }
    });

    // --- Destinataire rejoint ---
    socket.on('receiver-joined', () => {
        console.log('👤 Destinataire connecté');
        waitingMsg.textContent = '✅ Destinataire connecté, établissement de la connexion sécurisée...';
    });

    // --- Destinataire quitte ---
    socket.on('receiver-left', () => {
        console.log('👤 Destinataire déconnecté');
        if (!transferAborted) {
            showError('⚠️ Le destinataire s\'est déconnecté. En attente d\'un nouveau...');
        }
    });

    // --- Pair annule ---
    socket.on('peer-cancelled', () => {
        console.log('❌ Pair a annulé');
        transferAborted = true;
        showError('❌ L\'expéditeur a annulé le transfert.');
        cleanup();
        showStep('step-select');
    });

    // --- Pair déconnecté ---
    socket.on('peer-disconnected', () => {
        console.log('❌ Pair déconnecté');
        if (!transferAborted) {
            showError('❌ Connexion avec le pair perdue.');
            cleanup();
            showStep('step-select');
        }
    });

    // --- Erreur serveur ---
    socket.on('error', ({ message }) => {
        showError('❌ Erreur serveur: ' + message);
    });

    // --- Ping/pong keepalive ---
    socket.on('pong-keepalive', () => {
        // Connexion OK
    });
}

// Keepalive périodique
setInterval(() => {
    if (socket && socket.connected) {
        socket.emit('ping-keepalive');
    }
}, 30000);

// =========================================================
//  Nouveau transfert
// =========================================================
btnRestart.addEventListener('click', () => {
    cleanup();
    selectedFile = null;
    selectedFiles = [];
    fileInput.value = '';
    folderInput.value = '';
    filePreview.classList.add('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = '0 %';
    speedText.textContent = '';
    emailInput.value = '';
    
    // Nettoyer l'URL
    if (history.replaceState) {
        history.replaceState({}, document.title, '/');
    }
    
    showStep('step-select');
});

// =========================================================
//  Initialisation
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Application démarrée v2.0');
    
    // Vérifier support WebRTC
    if (!window.RTCPeerConnection) {
        showError('❌ Votre navigateur ne supporte pas WebRTC. Utilisez Chrome, Firefox, Safari ou Edge récent.');
        return;
    }
    
    // Vérifier support FileReader
    if (!window.FileReader) {
        showError('❌ Votre navigateur ne supporte pas la lecture de fichiers.');
        return;
    }
    
    socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });

    setupSocketListeners();
});