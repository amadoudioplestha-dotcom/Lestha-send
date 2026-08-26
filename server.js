require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

// =========================================================
//  CHARGEMENT CONDITIONNEL DES MODULES EMAIL
// =========================================================

let sgMail = null;
let nodemailer = null;

// SendGrid - chargement sécurisé avec try/catch
try {
    sgMail = require('@sendgrid/mail');
    console.log('✅ Module @sendgrid/mail chargé');
} catch (e) {
    console.warn('⚠️ @sendgrid/mail non installé - npm install @sendgrid/mail');
}

// Nodemailer - chargement sécurisé
try {
    nodemailer = require('nodemailer');
    console.log('✅ Module nodemailer chargé');
} catch (e) {
    console.warn('⚠️ nodemailer non installé');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// =========================================================
//  CONFIGURATION EMAIL
// =========================================================

function getEmailConfig() {
    const sendgridKey = process.env.SENDGRID_API_KEY;
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS;
    
    // Priorité SendGrid
    if (sendgridKey && sgMail) {
        sgMail.setApiKey(sendgridKey);
        console.log('📧 Config: SendGrid activé');
        return { type: 'SENDGRID', keyPreview: sendgridKey.slice(0, 8) + '...' };
    }
    
    // Fallback Gmail (local uniquement)
    if (gmailUser && gmailPass && nodemailer && !process.env.RENDER) {
        console.log('📧 Config: Gmail (local)');
        return {
            type: 'GMAIL',
            transporter: nodemailer.createTransport({
                service: 'gmail',
                auth: { user: gmailUser, pass: gmailPass }
            })
        };
    }
    
    console.warn('⚠️ Aucun service email configuré - les transferts P2P fonctionnent sans email');
    return { type: null, error: 'Ajoutez SENDGRID_API_KEY dans les variables d\'env Render' };
}

const emailConfig = getEmailConfig();

// =========================================================
//  ROUTE DEBUG
// =========================================================

app.get('/api/debug/email', (req, res) => {
    res.json({
        provider: emailConfig.type,
        configOK: !!emailConfig.type,
        isRender: !!process.env.RENDER,
        modules: {
            sendgridLoaded: !!sgMail,
            nodemailerLoaded: !!nodemailer
        },
        envVars: {
            hasSendGrid: !!process.env.SENDGRID_API_KEY,
            sendGridLength: process.env.SENDGRID_API_KEY ? process.env.SENDGRID_API_KEY.length : 0,
            hasGmail: !!process.env.GMAIL_USER,
            emailFrom: process.env.EMAIL_FROM || process.env.GMAIL_USER || 'non défini'
        }
    });
});

// =========================================================
//  FONCTION ENVOI EMAIL UNIFIÉE
// =========================================================

async function sendEmail({ to, subject, html, text }) {
    const fromEmail = process.env.EMAIL_FROM || process.env.GMAIL_USER || 'noreply@filetransfer.app';
    
    // === SENDGRID ===
    if (emailConfig.type === 'SENDGRID' && sgMail) {
        const msg = {
            to,
            from: { email: fromEmail, name: 'FileTransfer' },
            subject,
            html,
            text: text || subject,
            trackingSettings: { clickTracking: { enable: false } }
        };
        
        const [response] = await sgMail.send(msg);
        console.log('✅ SendGrid OK - Status:', response.statusCode);
        return { provider: 'SENDGRID', statusCode: response.statusCode };
    }
    
    // === GMAIL ===
    if (emailConfig.type === 'GMAIL' && emailConfig.transporter) {
        const info = await emailConfig.transporter.sendMail({
            from: `"FileTransfer" <${fromEmail}>`,
            to,
            subject,
            html,
            text: text || subject
        });
        console.log('✅ Gmail OK - MessageId:', info.messageId);
        return { provider: 'GMAIL', messageId: info.messageId };
    }
    
    throw new Error('Aucun provider email disponible');
}

// =========================================================
//  ROUTE ENVOI EMAIL (UNIQUE)
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
    console.log('📧 Requête email reçue:', { to: req.body?.to, hasLink: !!req.body?.link });
    
    try {
        const { to, link, fileName } = req.body;
        
        // Validation
        if (!to || !link) {
            return res.status(400).json({ error: 'Email destinataire et lien requis' });
        }
        
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
            return res.status(400).json({ error: 'Email destinataire invalide' });
        }
        
        try { new URL(link); } catch(e) {
            return res.status(400).json({ error: 'Lien invalide' });
        }

        const displayName = fileName || 'fichier';
        
        const htmlContent = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:40px auto;padding:20px;">
    <div style="background:#f0f7ff;border-radius:16px;padding:32px;text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">📎</div>
        <h2 style="color:#0066FF;margin:0 0 16px;">Fichier partagé avec vous</h2>
        <p style="color:#444;font-size:16px;line-height:1.6;">
            <strong style="color:#0066FF;">${escapeHtml(displayName)}</strong> vous a été envoyé.
        </p>
        <a href="${escapeHtml(link)}" style="display:inline-block;margin:20px 0;padding:14px 32px;background:#0066FF;color:#fff;text-decoration:none;border-radius:12px;font-weight:600;">
            📥 Télécharger
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">
            Ce lien est sécurisé et expire après utilisation.<br>
            <span style="font-family:monospace;background:#e0ecff;padding:4px 8px;border-radius:6px;">${escapeHtml(link)}</span>
        </p>
    </div>
</body>
</html>`;

        const result = await sendEmail({
            to,
            subject: `📎 ${escapeHtml(displayName)} - Fichier partagé`,
            html: htmlContent,
            text: `Fichier partagé: ${displayName}\nLien: ${link}`
        });

        res.json({ success: true, ...result });

    } catch (err) {
        console.error('❌ ERREUR EMAIL:', err.message);
        if (err.response?.body?.errors) {
            console.error('SendGrid errors:', JSON.stringify(err.response.body.errors, null, 2));
        }
        
        let statusCode = 500;
        let userError = 'Échec envoi email';
        
        if (err.message.includes('Aucun provider')) {
            statusCode = 503;
            userError = 'Service email non configuré. Ajoutez SENDGRID_API_KEY sur Render.';
        } else if (err.code === 'EAUTH') {
            userError = 'Authentification échouée. Vérifiez votre clé API.';
        } else if (err.code === 'ECONNECTION') {
            userError = 'Connexion échouée. Réseau bloqué ?';
        }
        
        res.status(statusCode).json({ 
            error: userError,
            provider: emailConfig.type,
            detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
            sendgridDetail: err.response?.body?.errors?.[0]?.message || null
        });
    }
});

// =========================================================
//  ICE CONFIG (conservé)
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
//  SIGNALING (conservé)
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
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📧 Email: ${emailConfig.type || 'NON CONFIGURÉ'}${emailConfig.error ? ' (' + emailConfig.error + ')' : ''}`);
    console.log(`   Modules: SendGrid=${!!sgMail}, Nodemailer=${!!nodemailer}`);
});