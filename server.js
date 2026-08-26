require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');

// ========================================
//  🔐 IDENTIFIANTS GMAIL EN DUR (fallback sécurisé)
// ========================================
// Si les variables d'environnement ne sont pas chargées sur Render,
// ces valeurs seront utilisées automatiquement.
const GMAIL_USER = process.env.GMAIL_USER || 'amadoudioplestha@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || 'vxfnjxwgwzqpescm';

// ========================================
//  INITIALISATION DU SERVEUR
// ========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// Évite les 404 fantômes (Cloudflare RUM, favicon)
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.all('/cdn-cgi/*', (req, res) => res.status(204).end());

// ========================================
//  ROUTE DE SANTÉ (pour vérifier que tout tourne)
// ========================================
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        email: {
            gmail_configured: !!GMAIL_USER && !!GMAIL_APP_PASSWORD,
            gmail_user: GMAIL_USER
        },
        webrtc: true
    });
});

// ========================================
//  CONFIGURATION ICE (STUN/TURN)
// ========================================
function validateIceServer(url, username, credential) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    const schemeMatch = url.match(/^(stun|turn|turns):/i);
    let scheme, hostPortPart;
    if (schemeMatch) {
        scheme = schemeMatch[1].toLowerCase();
        hostPortPart = url.slice(schemeMatch[0].length);
    } else {
        scheme = url.includes('stun.') ? 'stun' : 'turn';
        hostPortPart = url;
    }
    const hostPortMatch = hostPortPart.match(/^([^:]+)(?::(\d+))?$/);
    if (!hostPortMatch) return null;
    const [, host, portStr] = hostPortMatch;
    const defaultPort = scheme === 'stun' ? 19302 : 3478;
    const port = portStr ? parseInt(portStr, 10) : defaultPort;
    const finalPort = (isNaN(port) || port < 1 || port > 65535) ? defaultPort : port;
    const cleanUrl = `${scheme}:${host.trim()}:${finalPort}`;
    const serverObj = { urls: cleanUrl };
    if (scheme !== 'stun' && username && credential) {
        serverObj.username = String(username).trim();
        serverObj.credential = String(credential).trim();
    }
    return serverObj;
}

app.get('/api/ice-config', (req, res) => {
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];
    if (process.env.TURN_URL) {
        const turnServer = validateIceServer(
            process.env.TURN_URL,
            process.env.TURN_USERNAME,
            process.env.TURN_CREDENTIAL
        );
        if (turnServer) iceServers.push(turnServer);
    }
    res.json({ iceServers });
});

// ========================================
//  📧 ENVOI D'EMAIL (Gmail avec identifiants en dur)
// ========================================
function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

app.post('/api/send-email', async (req, res) => {
    const { to, link, fileName } = req.body;

    if (!to || !link) {
        return res.status(400).json({ error: 'Champs manquants (to, link).' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ error: 'Email invalide.' });
    }

    // Vérifier que Gmail est configuré
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
        return res.status(503).json({ error: 'Service email non configuré.' });
    }

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
            <h2 style="color: #1f2937;">📦 Fichier prêt à être récupéré</h2>
            <p style="color: #374151;">Un fichier <strong>${escapeHtml(fileName) || 'sans nom'}</strong> vous a été envoyé de manière sécurisée via TransferX.</p>
            <p style="margin: 24px 0; text-align: center;">
                <a href="${escapeHtml(link)}" style="background: #2563eb; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">
                    ⬇️ Récupérer le fichier
                </a>
            </p>
            <p style="color: #6b7280; font-size: 13px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
                ⚠️ Ce lien fonctionne uniquement pendant que l'expéditeur reste connecté.<br>
                🔒 Transfert P2P direct et chiffré — aucun fichier stocké sur un serveur.
            </p>
        </div>
    `;

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: GMAIL_USER,
                pass: GMAIL_APP_PASSWORD
            }
        });

        await transporter.sendMail({
            from: `"TransferX" <${GMAIL_USER}>`,
            to: to,
            subject: `📦 Vous avez reçu un fichier : ${escapeHtml(fileName) || 'sans nom'}`,
            html: htmlContent
        });

        console.log(`✅ Email envoyé via Gmail à ${to}`);
        return res.json({ success: true, provider: 'gmail' });
    } catch (error) {
        console.error('❌ Erreur Gmail:', error.message);
        return res.status(500).json({ 
            error: 'Échec envoi: ' + error.message 
        });
    }
});

// ========================================
//  SIGNALISATION WEBRTC (Rooms en mémoire)
// ========================================
const rooms = new Map();
function generateRoomId() {
    return crypto.randomBytes(8).toString('hex');
}

// Nettoyage périodique des rooms expirées (> 1 heure)
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.createdAt > 3600000) {
            console.log(`🧹 Room expirée nettoyée: ${roomId}`);
            rooms.delete(roomId);
        }
    }
}, 300000);

io.on('connection', (socket) => {
    console.log('✅ Connexion socket:', socket.id);

    // --- Créer une room (expéditeur) ---
    socket.on('create-room', (callback) => {
        if (socket.roomId && rooms.has(socket.roomId)) {
            const oldRoom = rooms.get(socket.roomId);
            const otherId = oldRoom.senderSocketId === socket.id ? oldRoom.receiverSocketId : oldRoom.senderSocketId;
            if (otherId) io.to(otherId).emit('peer-disconnected');
            rooms.delete(socket.roomId);
        }
        const roomId = generateRoomId();
        rooms.set(roomId, {
            senderSocketId: socket.id,
            receiverSocketId: null,
            offer: null,
            answer: null,
            iceCandidates: [],
            createdAt: Date.now()
        });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'sender';
        if (typeof callback === 'function') callback({ roomId, success: true });
    });

    // --- Expéditeur envoie son offre SDP ---
    socket.on('send-offer', ({ roomId, offer }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        room.offer = offer;
        if (room.receiverSocketId) {
            io.to(room.receiverSocketId).emit('offer-received', { offer });
        }
    });

    // --- Destinataire rejoint ---
    socket.on('join-room', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback && callback({ success: false, error: 'Lien invalide ou expiré.' });
        if (room.receiverSocketId) return callback && callback({ success: false, error: 'Room déjà occupée.' });
        
        room.receiverSocketId = socket.id;
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'receiver';
        if (typeof callback === 'function') callback({ success: true });
        
        io.to(room.senderSocketId).emit('receiver-joined');
        if (room.offer) socket.emit('offer-received', { offer: room.offer });
    });

    // --- Destinataire envoie sa réponse SDP ---
    socket.on('send-answer', ({ roomId, answer }) => {
        const room = rooms.get(roomId);
        if (!room || room.receiverSocketId !== socket.id) return;
        room.answer = answer;
        io.to(room.senderSocketId).emit('answer-received', { answer });
    });

    // --- Échange candidats ICE ---
    socket.on('ice-candidate', ({ roomId, candidate }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        const target = socket.id === room.senderSocketId ? room.receiverSocketId : room.senderSocketId;
        if (target) {
            io.to(target).emit('ice-candidate', candidate);
        } else {
            room.iceCandidates.push({ from: socket.id, candidate, timestamp: Date.now() });
        }
    });

    // --- Récupérer candidats en buffer ---
    socket.on('get-ice-candidates', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback && callback({ candidates: [] });
        const myRole = socket.id === room.senderSocketId ? 'sender' : 'receiver';
        const otherRole = myRole === 'sender' ? 'receiver' : 'sender';
        const candidates = room.iceCandidates
            .filter(c => (c.from === room.senderSocketId ? 'sender' : 'receiver') === otherRole)
            .map(c => c.candidate);
        if (typeof callback === 'function') callback({ candidates });
    });

    // --- Annulation ---
    socket.on('cancel-transfer', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        if (room.receiverSocketId) io.to(room.receiverSocketId).emit('peer-cancelled');
        rooms.delete(roomId);
    });

    // --- Destinataire quitte ---
    socket.on('leave-room', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.receiverSocketId === socket.id) {
            room.receiverSocketId = null;
            io.to(room.senderSocketId).emit('receiver-left');
        }
    });

    // --- Déconnexion ---
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const isSender = socket.id === room.senderSocketId;
        const otherId = isSender ? room.receiverSocketId : room.senderSocketId;
        if (otherId) io.to(otherId).emit('peer-disconnected');
        if (isSender) rooms.delete(roomId);
        else room.receiverSocketId = null;
    });

    // --- Keepalive ---
    socket.on('ping-keepalive', () => socket.emit('pong-keepalive'));
});

// ========================================
//  🚀 DÉMARRAGE
// ========================================
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📧 Gmail: ${GMAIL_USER ? '✅ Configuré' : '❌ Non configuré'}`);
    console.log(`🔄 TURN: ${process.env.TURN_URL ? '✅ Configuré' : '❌ STUN uniquement'}`);
});