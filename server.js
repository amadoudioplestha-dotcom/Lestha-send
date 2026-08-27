require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

let sgMail = null;
try {
    sgMail = require('@sendgrid/mail');
    console.log('✅ @sendgrid/mail chargé');
} catch (e) {
    console.warn('⚠️ @sendgrid/mail non disponible');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.all('/cdn-cgi/*', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        email: {
            sendgrid_configured: !!(sgMail && process.env.SENDGRID_API_KEY),
            from_email: process.env.SENDGRID_FROM_EMAIL || 'Non configuré'
        },
        webrtc: true
    });
});

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
    if (!to || !link) return res.status(400).json({ error: 'Champs manquants (to, link).' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Email invalide.' });
    if (!sgMail || !process.env.SENDGRID_API_KEY) {
        return res.status(503).json({ error: 'Service email non configuré.' });
    }
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'amadoudioplestha@gmail.com';
    try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
            to: to.trim(),
            from: { email: fromEmail, name: 'TransferX' },
            subject: `📦 Vous avez reçu un fichier : ${escapeHtml(fileName) || 'sans nom'}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #1f2937;">📦 Fichier prêt à être récupéré</h2>
                    <p style="color: #374151;">Un fichier <strong>${escapeHtml(fileName) || 'sans nom'}</strong> vous a été envoyé de manière sécurisée via TransferX.</p>
                    <p style="margin: 24px 0; text-align: center;">
                        <a href="${escapeHtml(link)}" style="background: #2563eb; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold; font-size: 16px;">⬇️ Récupérer le fichier</a>
                    </p>
                    <p style="color: #6b7280; font-size: 13px; border-top: 1px solid #e5e7eb; padding-top: 12px;">
                        ⚠️ Ce lien fonctionne uniquement pendant que l'expéditeur reste connecté.<br>
                        🔒 Transfert P2P direct et chiffré — aucun fichier stocké sur un serveur.
                    </p>
                </div>`
        });
        console.log(`✅ Email envoyé à ${to} via SendGrid`);
        return res.json({ success: true, provider: 'sendgrid' });
    } catch (error) {
        console.error('❌ Erreur SendGrid:', error.response?.body || error.message);
        return res.status(500).json({
            error: 'Échec envoi: ' + (error.response?.body?.errors?.[0]?.message || error.message)
        });
    }
});

// ========================================
//  SIGNALISATION WEBRTC — SESSION PERSISTANTE
// ========================================
const rooms = new Map();

function generateRoomId() {
    return crypto.randomBytes(8).toString('hex');
}

function hashPin(pin) {
    return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// Nettoyage : expiration réelle + max 7 jours
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if ((room.expiresAt && now > room.expiresAt) || now - room.createdAt > 7 * 86400000) {
            console.log(`🧹 Room expirée nettoyée: ${roomId}`);
            room.receivers.forEach(id => io.to(id).emit('peer-disconnected'));
            rooms.delete(roomId);
        }
    }
}, 60000);

io.on('connection', (socket) => {
    console.log('✅ Connexion socket:', socket.id);

    // ✅ create-room : TTL + PIN + compteur
    socket.on('create-room', (payload, callback) => {
        if (typeof payload === 'function') { callback = payload; payload = {}; }
        payload = payload || {};
        const ttl = Math.min(Math.max(parseInt(payload.ttl, 10) || 3600000, 60000), 7 * 86400000);
        const pin = payload.pin ? String(payload.pin) : null;

        if (socket.roomId && rooms.has(socket.roomId)) {
            const oldRoom = rooms.get(socket.roomId);
            oldRoom.receivers.forEach(id => io.to(id).emit('peer-disconnected'));
            rooms.delete(socket.roomId);
        }

        const roomId = generateRoomId();
        const pinHash = pin ? hashPin(pin) : null;

        rooms.set(roomId, {
            senderSocketId: socket.id,
            receivers: new Set(),
            offers: new Map(),
            answers: new Map(),
            iceCandidates: new Map(),
            createdAt: Date.now(),
            expiresAt: Date.now() + ttl,
            pinHash: pinHash,
            downloadCount: 0
        });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'sender';
        console.log(`📍 Room créée: ${roomId} (TTL: ${Math.round(ttl / 3600000)}h, PIN: ${pinHash ? '✅' : '❌'})`);
        if (typeof callback === 'function') callback({ roomId, success: true, expiresAt: Date.now() + ttl });
    });

    // ✅ Offre SDP vers un destinataire précis
    socket.on('send-offer', ({ roomId, offer, receiverId }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        if (receiverId) {
            room.offers.set(receiverId, offer);
            io.to(receiverId).emit('offer-received', { offer });
        }
    });

    // ✅ join-room : PIN + multi-destinataires (session persistante)
    socket.on('join-room', ({ roomId, pin }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback && callback({ success: false, error: 'Lien invalide ou expiré.' });
        if (Date.now() > room.expiresAt) {
            rooms.delete(roomId);
            return callback && callback({ success: false, error: 'Ce lien a expiré.' });
        }
        if (room.pinHash) {
            if (!pin) return callback && callback({ success: false, pinRequired: true });
            if (hashPin(pin) !== room.pinHash) return callback && callback({ success: false, pinRequired: true, error: 'Code PIN incorrect.' });
        }

        room.receivers.add(socket.id);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'receiver';
        console.log(`👤 Destinataire #${room.receivers.size} rejoint: ${roomId}`);
        if (typeof callback === 'function') callback({ success: true });
        io.to(room.senderSocketId).emit('receiver-joined', { receiverId: socket.id, totalReceivers: room.receivers.size });
    });

    socket.on('send-answer', ({ roomId, answer }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        room.answers.set(socket.id, answer);
        io.to(room.senderSocketId).emit('answer-received', { answer, receiverId: socket.id });
    });

    socket.on('ice-candidate', ({ roomId, candidate, targetId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (targetId) {
            io.to(targetId).emit('ice-candidate', { candidate, from: socket.id });
        } else {
            const target = socket.id === room.senderSocketId ? null : room.senderSocketId;
            if (target) io.to(target).emit('ice-candidate', { candidate, from: socket.id });
            else {
                if (!room.iceCandidates.has(socket.id)) room.iceCandidates.set(socket.id, []);
                room.iceCandidates.get(socket.id).push({ candidate, timestamp: Date.now() });
            }
        }
    });

    socket.on('get-ice-candidates', ({ roomId }, callback) => {
        const room = rooms.get(roomId);
        if (!room) return callback && callback({ candidates: [] });
        const myRole = socket.id === room.senderSocketId ? 'sender' : 'receiver';
        const candidates = [];
        room.iceCandidates.forEach((list, fromId) => {
            const fromRole = fromId === room.senderSocketId ? 'sender' : 'receiver';
            if (fromRole !== myRole) list.forEach(c => candidates.push(c.candidate));
        });
        if (typeof callback === 'function') callback({ candidates });
    });

    // ✅ Nouveau : téléchargement terminé → compteur + notification
    socket.on('download-complete', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        room.downloadCount = (room.downloadCount || 0) + 1;
        io.to(room.senderSocketId).emit('download-notification', {
            receiverId: socket.id,
            totalDownloads: room.downloadCount,
            timestamp: Date.now()
        });
        console.log(`✅ Téléchargement terminé: ${roomId} (total: ${room.downloadCount})`);
    });

    socket.on('cancel-transfer', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        room.receivers.forEach(id => io.to(id).emit('peer-cancelled'));
        rooms.delete(roomId);
    });

    socket.on('leave-room', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        if (room.receivers.has(socket.id)) {
            room.receivers.delete(socket.id);
            io.to(room.senderSocketId).emit('receiver-left', { receiverId: socket.id, totalReceivers: room.receivers.size });
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        if (socket.id === room.senderSocketId) {
            room.receivers.forEach(id => io.to(id).emit('peer-disconnected'));
            rooms.delete(roomId);
        } else {
            if (room.receivers.has(socket.id)) {
                room.receivers.delete(socket.id);
                io.to(room.senderSocketId).emit('receiver-left', { receiverId: socket.id, totalReceivers: room.receivers.size });
            }
        }
    });

    socket.on('ping-keepalive', () => socket.emit('pong-keepalive'));
});

server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📧 SendGrid: ${sgMail && process.env.SENDGRID_API_KEY ? '✅ Configuré' : '❌ Non configuré'}`);
    console.log(`📧 From: ${process.env.SENDGRID_FROM_EMAIL || 'Non configuré'}`);
    console.log(`🔄 TURN: ${process.env.TURN_URL ? '✅ Configuré' : '❌ STUN uniquement'}`);
});