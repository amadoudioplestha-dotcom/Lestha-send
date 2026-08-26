require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// =========================================================
//  EMAIL CONFIG - Gmail OU SendGrid
// =========================================================

function getEmailConfig() {
    // SendGrid prioritaire (cloud-friendly)
    if (process.env.SENDGRID_API_KEY) {
        return { type: 'sendgrid', apiKey: process.env.SENDGRID_API_KEY };
    }
    
    // Gmail fallback
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    
    if (!user || !pass) {
        return { type: null, error: 'Email non configuré. Utilisez SENDGRID_API_KEY ou GMAIL_USER+GMAIL_APP_PASSWORD' };
    }
    
    // Validation format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
        return { type: null, error: 'GMAIL_USER invalide' };
    }
    
    return { type: 'gmail', user, pass };
}

async function sendEmail({ to, from, subject, html }) {
    const config = getEmailConfig();
    
    if (!config.type) {
        throw new Error(config.error);
    }
    
    // SendGrid
    if (config.type === 'sendgrid') {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(config.apiKey);
        
        await sgMail.send({
            to: to.trim(),
            from: from || 'transfer@transferx.app',
            subject,
            html,
        });
        return { provider: 'sendgrid' };
    }
    
    // Gmail
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: config.user,
            pass: config.pass
        },
        // Important pour Render et autres clouds
        tls: {
            rejectUnauthorized: false
        },
        // Timeout court
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000
    });
    
    await transporter.sendMail({
        from: `"TransferX" <${config.user}>`,
        to: to.trim(),
        subject,
        html,
    });
    
    return { provider: 'gmail' };
}

// Debug endpoint
app.get('/api/debug/email', (req, res) => {
    const config = getEmailConfig();
    res.json({
        configured: !!config.type,
        provider: config.type,
        error: config.error || null,
        fromEmail: config.type === 'gmail' ? config.user : 'transfer@transferx.app'
    });
});

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
    try {
        await sendEmail({
            to: req.body.to || process.env.GMAIL_USER,
            subject: 'Test TransferX',
            html: '<p>✅ Configuration email OK</p>'
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =========================================================
//  ENVOI EMAIL PRINCIPAL
// =========================================================

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
    
    // Validation
    if (!to || !link) {
        return res.status(400).json({ error: 'Champs manquants (to, link)' });
    }
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ error: 'Email destinataire invalide' });
    }
    
    let url;
    try { url = new URL(link); } catch(e) {
        return res.status(400).json({ error: 'Lien invalide' });
    }
    
    try {
        const result = await sendEmail({
            to,
            subject: 'Vous avez reçu un fichier sécurisé',
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; background: #f8fafc; padding: 24px; border-radius: 16px;">
                    <h2 style="color: #0066FF; margin-bottom: 16px;">📦 Fichier prêt à être récupéré</h2>
                    <p style="color: #374151; line-height: 1.6;">
                        Un fichier <strong>${escapeHtml(fileName) || 'sans nom'}</strong> vous a été envoyé.
                    </p>
                    <p style="margin: 24px 0; text-align: center;">
                        <a href="${escapeHtml(link)}" style="background: #0066FF; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; font-size: 16px;">
                            ⬇️ Récupérer le fichier
                        </a>
                    </p>
                    <p style="color: #6b7280; font-size: 13px; line-height: 1.5; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                        <strong>⚠️ Important :</strong> Ce lien fonctionne uniquement pendant que l'expéditeur reste connecté.
                    </p>
                </div>
            `
        });
        
        console.log(`✅ Email envoyé via ${result.provider} à ${to}`);
        res.json({ success: true, provider: result.provider });
        
    } catch (error) {
        console.error('❌ Email failed:', error.message);
        
        let userError = 'Échec envoi email';
        if (error.code === 'EAUTH') userError = 'Authentification échouée. Vérifiez GMAIL_APP_PASSWORD ou SENDGRID_API_KEY';
        else if (error.code === 'ECONNECTION') userError = 'Connexion SMTP échouée. Réseau bloqué ?';
        else if (error.response?.body) userError = 'SendGrid: ' + error.response.body.errors?.[0]?.message;
        
        res.status(500).json({ 
            error: userError,
            detail: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// =========================================================
//  ICE CONFIG (votre code original conservé)
// =========================================================

function validateIceServer(url, username, credential) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    if (!url) return null;
    
    const schemeMatch = url.match(/^(stun|turn|turns):/i);
    let scheme, hostPortPart;
    
    if (schemeMatch) {
        scheme = schemeMatch[1].toLowerCase();
        hostPortPart = url.slice(schemeMatch[0].length);
    } else {
        scheme = url.includes('google.com') ? 'stun' : 'turn';
        hostPortPart = url;
    }
    
    const hostPortMatch = hostPortPart.match(/^([^:]+)(?::(\d+))?$/);
    if (!hostPortMatch) {
        console.warn(`⚠️ URL ICE invalide: ${url}`);
        return null;
    }
    
    const [, host, portStr] = hostPortMatch;
    const hostClean = host.trim();
    
    if (!hostClean || hostClean.includes('/') || hostClean.includes('?')) {
        console.warn(`⚠️ Host ICE invalide: ${hostClean}`);
        return null;
    }
    
    const defaultPort = scheme === 'stun' ? 19302 : 3478;
    const port = portStr ? parseInt(portStr, 10) : defaultPort;
    const finalPort = (isNaN(port) || port < 1 || port > 65535) ? defaultPort : port;
    const cleanUrl = `${scheme}:${hostClean}:${finalPort}`;
    
    const server = { urls: cleanUrl };
    
    if (scheme !== 'stun' && username && credential) {
        const user = String(username).trim();
        const pass = String(credential).trim();
        if (user && pass) {
            server.username = user;
            server.credential = pass;
        }
    }
    
    console.log(`✅ ICE server: ${cleanUrl}`);
    return server;
}

app.get('/api/ice-config', (req, res) => {
    const iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];
    
    if (process.env.TURN_URL) {
        const turn = validateIceServer(
            process.env.TURN_URL,
            process.env.TURN_USERNAME,
            process.env.TURN_CREDENTIAL
        );
        if (turn) iceServers.push(turn);
    }
    
    res.json({ iceServers });
});

// =========================================================
//  SIGNALING (votre code original conservé)
// =========================================================

const rooms = new Map();

function generateRoomId() {
    return crypto.randomBytes(8).toString('hex');
}

function cleanupOldRooms() {
    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
        if (now - room.createdAt > 3600000) {
            rooms.delete(id);
        }
    }
}
setInterval(cleanupOldRooms, 300000);

io.on('connection', (socket) => {
    console.log('✅ Socket:', socket.id);
    
    socket.on('create-room', (cb) => {
        if (socket.roomId) rooms.delete(socket.roomId);
        
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
        
        if (typeof cb === 'function') cb({ roomId, success: true });
    });
    
    socket.on('send-offer', ({ roomId, offer }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        
        room.offer = offer;
        if (room.receiverSocketId) {
            io.to(room.receiverSocketId).emit('offer-received', { offer });
        }
    });
    
    socket.on('join-room', ({ roomId }, cb) => {
        const room = rooms.get(roomId);
        
        if (!room) {
            if (typeof cb === 'function') cb({ success: false, error: 'Lien invalide ou expiré' });
            return;
        }
        
        if (room.receiverSocketId) {
            if (typeof cb === 'function') cb({ success: false, error: 'Déjà en cours' });
            return;
        }
        
        room.receiverSocketId = socket.id;
        socket.join(roomId);
        socket.roomId = roomId;
        socket.role = 'receiver';
        
        if (typeof cb === 'function') cb({ success: true });
        
        io.to(room.senderSocketId).emit('receiver-joined');
        
        if (room.offer) {
            socket.emit('offer-received', { offer: room.offer });
        }
    });
    
    socket.on('send-answer', ({ roomId, answer }) => {
        const room = rooms.get(roomId);
        if (!room || room.receiverSocketId !== socket.id) return;
        
        room.answer = answer;
        io.to(room.senderSocketId).emit('answer-received', { answer });
    });
    
    socket.on('ice-candidate', ({ roomId, candidate }) => {
        const room = rooms.get(roomId);
        if (!room) return;
        
        const target = socket.id === room.senderSocketId 
            ? room.receiverSocketId 
            : room.senderSocketId;
        
        if (target) {
            io.to(target).emit('ice-candidate', candidate);
        } else {
            room.iceCandidates.push({ from: socket.id, candidate, timestamp: Date.now() });
        }
    });
    
    socket.on('cancel-transfer', ({ roomId }) => {
        const room = rooms.get(roomId);
        if (!room || room.senderSocketId !== socket.id) return;
        
        if (room.receiverSocketId) {
            io.to(room.receiverSocketId).emit('peer-cancelled');
        }
        rooms.delete(roomId);
    });
    
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        if (!room) return;
        
        const isSender = socket.id === room.senderSocketId;
        const other = isSender ? room.receiverSocketId : room.senderSocketId;
        
        if (other) io.to(other).emit('peer-disconnected');
        
        if (isSender) {
            rooms.delete(roomId);
        } else {
            room.receiverSocketId = null;
        }
    });
    
    socket.on('ping-keepalive', () => socket.emit('pong-keepalive'));
});

// =========================================================
//  DÉMARRAGE
// =========================================================

server.listen(PORT, () => {
    const emailConfig = getEmailConfig();
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`📧 Email: ${emailConfig.type || 'NON CONFIGURÉ'}${emailConfig.error ? ' (' + emailConfig.error + ')' : ''}`);
});