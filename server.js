require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

// ========================================
//  DIAGNOSTIC DES MODULES DISPONIBLES
// ========================================

let sgMail = null;
let nodemailer = null;

try {
    sgMail = require('@sendgrid/mail');
    console.log('✅ @sendgrid/mail CHARGÉ');
} catch (e) {
    console.warn('⚠️ @sendgrid/mail NON DISPONIBLE');
}

try {
    nodemailer = require('nodemailer');
    console.log('✅ nodemailer CHARGÉ');
} catch (e) {
    console.warn('⚠️ nodemailer NON DISPONIBLE');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ========================================
//  ROUTE DEBUG (toujours accessible)
// ========================================

app.get('/api/debug/email', (req, res) => {
    const sendgridKey = process.env.SENDGRID_API_KEY;
    
    let provider = null;
    let configOK = false;
    
    if (sendgridKey && sgMail) {
        try {
            sgMail.setApiKey(sendgridKey);
            provider = 'SENDGRID';
            configOK = true;
        } catch (e) {
            provider = 'SENDGRID_ERROR';
        }
    } else if (nodemailer && process.env.GMAIL_USER) {
        provider = 'GMAIL';
        configOK = true;
    }
    
    res.json({
        provider,
        configOK,
        isRender: !!process.env.RENDER,
        modules: {
            sendgrid: !!sgMail,
            nodemailer: !!nodemailer,
            express: !!express,
            socketio: !!io
        },
        env: {
            nodeVersion: process.version,
            hasSendGridKey: !!sendgridKey,
            sendGridLength: sendgridKey ? sendgridKey.length : 0
        }
    });
});

// ========================================
//  PAGE D'ACCUEIL (test)
// ========================================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        modules: {
            sendgrid: !!sgMail,
            nodemailer: !!nodemailer
        }
    });
});

// ========================================
//  DÉMARRAGE (garanti sans crash)
// ========================================

server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📧 SendGrid: ${sgMail ? '✅' : '❌'}`);
    console.log(`📧 Nodemailer: ${nodemailer ? '✅' : '❌'}`);
    console.log(`🔧 Module @sendgrid/mail: ${sgMail ? 'OK' : 'MANQUANT'}`);
});