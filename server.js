require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// =========================================================
//  Middlewares
// =========================================================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// =========================================================
//  Configuration TURN/STUN (envoyée au client)
// =========================================================

/**
 * Valide et corrige une URL TURN/STUN
 * - Ajoute le port par défaut si manquant
 * - Corrige le schéma si nécessaire
 * - Rejette les URLs malformées
 */
function validateIceServer(url, username, credential) {
    if (!url || typeof url !== 'string') return null;
    
    url = url.trim();
    if (!url) return null;
    
    // Vérifier le schéma
    const schemeMatch = url.match(/^(stun|turn|turns):/i);
    let scheme, hostPortPart;
    
    if (schemeMatch) {
        scheme = schemeMatch[1].toLowerCase();
        hostPortPart = url.slice(schemeMatch[0].length);
    } else {
        // Deviner le schéma
        if (url.includes('google.com') || url.includes('stun.')) {
            scheme = 'stun';
        } else {
            scheme = 'turn';
        }
        hostPortPart = url;
    }
    
    // Parser host et port
    const hostPortMatch = hostPortPart.match(/^([^:]+)(?::(\d+))?$/);
    if (!hostPortMatch) {
        console.warn(`⚠️ URL ICE invalide (format host:port incorrect): ${url}`);
        return null;
    }
    
    const [, host, portStr] = hostPortMatch;
    const hostClean = host.trim();
    
    if (!hostClean || hostClean.includes('/') || hostClean.includes('?')) {
        console.warn(`⚠️ Host ICE invalide: ${hostClean}`);
        return null;
    }
    
    // Port par défaut selon le schéma
    const defaultPort = scheme === 'stun' ? 19302 : 3478;
    const port = portStr ? parseInt(portStr, 10) : defaultPort;
    
    // Vérifier que le port est valide
    if (isNaN(port) || port < 1 || port > 65535) {
        console.warn(`⚠️ Port ICE invalide: ${portStr}, utilisation port défaut ${defaultPort}`);
        // On continue avec le port par défaut au lieu de rejeter
    }
    
    const finalPort = (isNaN(port) || port < 1 || port > 65535) ? defaultPort : port;
    const cleanUrl = `${scheme}:${hostClean}:${finalPort}`;
    
    const server = { urls: cleanUrl };
    
    // Ajouter credentials seulement pour TURN/TURNS
    if (scheme !== 'stun' && username && credential) {
        const user = String(username).trim();
        const pass = String(credential).trim();
        if (user && pass) {
            server.username = user;
            server.credential = pass;
        }
    }
    
    console.log(`✅ Serveur ICE validé: ${cleanUrl}`);
    return server;
}

app.get('/api/ice-config', (req, res) => {
    // STUN publics toujours disponibles
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    // Ajouter TURN server seulement s'il est configuré et valide
    if (process.env.TURN_URL) {
        const turnServer = validateIceServer(
            process.env.TURN_URL,
            process.env.TURN_USERNAME,
            process.env.TURN_CREDENTIAL
        );
        
        if (turnServer) {
            iceServers.push(turnServer);
        } else {
            console.log('⚠️ TURN_URL présent mais invalide, ignoré');
        }
    }

    // Log pour debug
    console.log('📤 Envoi config ICE:', iceServers.map(s => s.urls));
    res.json({ iceServers });
});

// =========================================================
//  Envoi d'e-mail (Nodemailer)
// =========================================================

/**
 * Vérifie que Gmail est correctement configuré
 */
function checkEmailConfig() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    
    if (!user || !pass) {
        return { ok: false, error: 'Gmail non configuré. Vérifiez GMAIL_USER et GMAIL_APP_PASSWORD dans le .env' };
    }
    
    // Test basique du format email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(user)) {
        return { ok: false, error: 'GMAIL_USER n\'est pas une adresse email valide' };
    }
    
    return { ok: true, user, pass };
}

// Créer le transporter à la demande (pas au démarrage, pour gérer les changements de config)
function createTransporter() {
    const config = checkEmailConfig();
    if (!config.ok) return null;
    
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: config.user,
            pass: config.pass
        }
    });
}

/**
 * Échappe le HTML pour éviter les injections XSS
 */
function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#039;');
}

app.post('/api/send-email', async (req, res) => {
    const { to, link, fileName } = req.body;

    // Validation des entrées
    if (!to || !link) {
        return res.status(400).json({ error: 'Champs manquants (to, link requis).' });
    }

    // Validation email destinataire
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
        return res.status(400).json({ error: 'Adresse e-mail destinataire invalide.' });
    }

    // Vérifier que Gmail est configuré
    const config = checkEmailConfig();
    if (!config.ok) {
        return res.status(503).json({ error: config.error });
    }

    const transporter = createTransporter();
    if (!transporter) {
        return res.status(503).json({ error: 'Impossible de créer le transporteur email' });
    }

    try {
        // Vérifier le lien (doit être une URL valide)
        let url;
        try {
            url = new URL(link);
        } catch (e) {
            return res.status(400).json({ error: 'Lien invalide.' });
        }

        await transporter.sendMail({
            from: `"Transfert Sécurisé" <${config.user}>`,
            to: to.trim(),
            subject: 'Vous avez reçu un fichier sécurisé',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #1f2937;">📦 Fichier prêt à être récupéré</h2>
                    <p style="color: #374151;">Un fichier <strong>${escapeHtml(fileName) || 'sans nom'}</strong> vous a été envoyé de manière sécurisée (transfert direct, chiffré, sans stockage sur serveur).</p>
                    <p style="margin: 24px 0; text-align: center;">
                        <a href="${escapeHtml(link)}" style="background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                            ⬇️ Récupérer le fichier
                        </a>
                    </p>
                    <p style="color: #6b7280; font-size: 13px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
                        <strong>⚠️ Important :</strong> Ce lien fonctionne uniquement pendant que l'expéditeur reste connecté.
                        Si le lien ne fonctionne plus, demandez à l'expéditeur de le renvoyer.
                    </p>
                </div>
            `
        });
        
        console.log(`✅ Email envoyé à ${to}`);
        res.json({ success: true, message: 'Email envoyé avec succès' });
        
    } catch (error) {
        console.error('❌ Erreur envoi email :', error.message);
        res.status(500).json({ error: 'Échec de l\'envoi de l\'e-mail: ' + error.message });
    }
});

// =========================================================
//  Signalisation WebRTC (rooms en mémoire, jamais persisté)
// =========================================================
const rooms = new Map(); // roomId -> { senderSocketId, receiverSocketId, offer, answer, iceCandidates, createdAt }

function generateRoomId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Nettoyer les rooms abandonnées (> 1 heure)
 */
function cleanupOldRooms() {
    const now = Date.now();
    const MAX_AGE = 60 * 60 * 1000; // 1 heure
    
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > MAX_AGE) {
            console.log(`🧹 Room expirée nettoyée: ${roomId}`);
            rooms.delete(roomId);
        }
    }
}

// Nettoyage périodique
setInterval(cleanupOldRooms, 5 * 60 * 1000); // Toutes les 5 minutes

io.on('connection', (socket) => {
    console.log('✅ Connexion socket:', socket.id);

    // --- Expéditeur crée une room ---
    socket.on('create-room', (callback) => {
        // Nettoyer l'ancienne room si existante
        if (socket.roomId && rooms.has(socket.roomId)) {
            const oldRoom = rooms.get(socket.roomId);
            // Notifier l'autre pair si connecté
            const otherId = oldRoom.senderSocketId === socket.id ? oldRoom.receiverSocketId : oldRoom.senderSocketId;
            if (otherId) {
                io.to(otherId).emit('peer-disconnected');
            }
            rooms.delete(socket.roomId);
        }

        const roomId = generateRoomId();
        rooms.set(roomId, { 
            senderSocketId: socket.id, 
            receiverSocketId: null, 
            offer: null,
            answer: null,
            iceCandidates: [], // Buffer pour les candidats arrivés avant la connexion
            createdAt: Date.now()
        });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'sender';
        
        console.log(`📍 Room créée : ${roomId}`);
        
        if (typeof callback === 'function') {
            callback({ roomId, success: true });
        }
    });

    // --- Expéditeur envoie son offre SDP ---
    socket.on('send-offer', ({ roomId, offer }) => {
        const room = rooms.get(roomId);
        if (!room) {
            console.warn('⚠️ Room non trouvée pour offre :', roomId);
            socket.emit('error', { message: 'Room non trouvée' });
            return;
        }
        
        // Vérifier que c'est bien l'expéditeur
        if (room.senderSocketId !== socket.id) {
            console.warn('⚠️ Tentative d\'envoi d\'offre par non-expéditeur');
            socket.emit('error', { message: 'Non autorisé' });
            return;
        }

        room.offer = offer;
        console.log(`📨 Offre SDP stockée pour room : ${roomId}`);
        
        // Si le destinataire est déjà là, lui envoyer l'offre
        if (room.receiverSocketId) {
            io.to(room.receiverSocketId).emit('offer-received', { offer });
            console.log(`📤 Offre relayée au destinataire: ${room.receiverSocketId}`);
        }
    });

    // --- Destinataire rejoint une room ---
    socket.on('join-room', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            console.warn('⚠️ Tentative de rejoindre room inexistante:', roomId);
            if (typeof callback === 'function') {
                callback({ success: false, error: 'Lien de transfert invalide ou expiré.' });
            }
            return;
        }
        
        // Vérifier que la room n'a pas déjà un destinataire
        if (room.receiverSocketId) {
            console.warn('⚠️ Room déjà occupée:', roomId);
            if (typeof callback === 'function') {
                callback({ success: false, error: 'Ce transfert est déjà en cours avec un autre destinataire.' });
            }
            return;
        }

        room.receiverSocketId = socket.id;
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'receiver';
        
        console.log(`👤 Destinataire rejoint : ${roomId}`);
        
        if (typeof callback === 'function') {
            callback({ success: true });
        }

        // Notifier l'expéditeur
        io.to(room.senderSocketId).emit('receiver-joined');

        // Si l'offre existe déjà, l'envoyer au destinataire
        if (room.offer) {
            socket.emit('offer-received', { offer: room.offer });
            console.log(`📤 Offre SDP envoyée au nouveau destinataire`);
        }
    });

    // --- Destinataire envoie sa réponse SDP ---
    socket.on('send-answer', ({ roomId, answer }) => {
        const room = rooms.get(roomId);
        if (!room) {
            console.warn('⚠️ Room non trouvée pour answer:', roomId);
            return;
        }
        
        // Vérifier que c'est bien le destinataire
        if (room.receiverSocketId !== socket.id) {
            console.warn('⚠️ Tentative d\'envoi de answer par non-destinataire');
            return;
        }

        room.answer = answer;
        io.to(room.senderSocketId).emit('answer-received', { answer });
        console.log(`📬 Réponse SDP relayée à l'expéditeur pour : ${roomId}`);
    });

    // --- Échange des candidats ICE ---
    socket.on('ice-candidate', ({ roomId, candidate }) => {
        const room = rooms.get(roomId);
        if (!room) {
            console.warn('⚠️ Room non trouvée pour ICE candidate:', roomId);
            return;
        }
        
        const target = socket.id === room.senderSocketId ? room.receiverSocketId : room.senderSocketId;
        
        if (target) {
            io.to(target).emit('ice-candidate', candidate);
        } else {
            // Buffer le candidat si l'autre pair n'est pas encore là
            room.iceCandidates.push({
                from: socket.id,
                candidate,
                timestamp: Date.now()
            });
            console.log(`⏳ Candidat ICE mis en buffer pour room ${roomId}`);
        }
    });

    // --- Récupérer les candidats ICE en buffer ---
    socket.on('get-ice-candidates', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) {
            if (typeof callback === 'function') callback({ candidates: [] });
            return;
        }
        
        const myRole = socket.id === room.senderSocketId ? 'sender' : 'receiver';
        const otherRole = myRole === 'sender' ? 'receiver' : 'sender';
        
        // Renvoyer les candidats de l'autre pair
        const candidates = room.iceCandidates
            .filter(c => {
                const fromRole = c.from === room.senderSocketId ? 'sender' : 'receiver';
                return fromRole === otherRole;
            })
            .map(c => c.candidate);
        
        if (typeof callback === 'function') {
            callback({ candidates });
        }
        
        // Nettoyer les candidats envoyés
        room.iceCandidates = room.iceCandidates.filter(c => {
            const fromRole = c.from === room.senderSocketId ? 'sender' : 'receiver';
            return fromRole !== otherRole;
        });
    });

    // --- Annulation manuelle ---
    socket.on('cancel-transfer', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        // Vérifier que l'emetteur est bien l'expéditeur
        if (room.senderSocketId !== socket.id) return;

        const target = room.receiverSocketId;
        if (target) {
            io.to(target).emit('peer-cancelled');
        }
        rooms.delete(roomId);
        console.log(`❌ Transfert annulé par expéditeur : ${roomId}`);
    });

    // --- Destinataire quitte / refuse ---
    socket.on('leave-room', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const wasReceiver = room.receiverSocketId === socket.id;
        
        if (wasReceiver) {
            room.receiverSocketId = null;
            io.to(room.senderSocketId).emit('receiver-left');
            console.log(`👤 Destinataire a quitté : ${roomId}`);
        }
    });

    // --- Déconnexion ---
    socket.on('disconnect', (reason) => {
        console.log(`❌ Déconnexion : ${socket.id} (${reason})`);
        
        const roomId = socket.roomId;
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (!room) return;

        // Déterminer qui s'est déconnecté et notifier l'autre
        const isSender = socket.id === room.senderSocketId;
        const otherId = isSender ? room.receiverSocketId : room.senderSocketId;
        
        if (otherId) {
            io.to(otherId).emit('peer-disconnected');
        }

        // Nettoyer la room si l'expéditeur part, ou libérer le slot destinataire
        if (isSender) {
            rooms.delete(roomId);
            console.log(`🗑️ Room supprimée (expéditeur parti) : ${roomId}`);
        } else {
            room.receiverSocketId = null;
            console.log(`🔄 Room libérée (destinataire parti) : ${roomId}`);
        }
    });

    // --- Ping/pong pour garder la connexion active ---
    socket.on('ping-keepalive', () => {
        socket.emit('pong-keepalive');
    });
});

// =========================================================
//  Démarrage du serveur
// =========================================================
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
    console.log(`📧 Configuration email: ${checkEmailConfig().ok ? 'OK' : 'NON CONFIGURÉE'}`);
    console.log(`🔄 TURN server: ${process.env.TURN_URL ? 'configuré (' + process.env.TURN_URL + ')' : 'non configuré (STUN uniquement)'}`);
});