require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const { createStorage } = require('./lib/storage');
const { createDb } = require('./lib/db');
const { createMailer } = require('./lib/email');
const { makeSigner, rateLimiter, clientIp } = require('./lib/util');
const { mountCloud } = require('./lib/cloud');
const { mountP2P } = require('./lib/p2p');

const env = process.env;
const PORT = env.PORT || 3000;

async function main() {
  const storage = createStorage(env);
  const db = createDb(storage);
  const mailer = createMailer(env);

  // Secret HMAC stable (jetons PIN, URLs d'upload locales) : APP_SECRET ou généré et stocké une fois
  let secret = env.APP_SECRET;
  if (!secret) {
    const buf = await storage.getBuffer('system/secret').catch(() => null);
    if (buf && buf.length >= 32) secret = buf.toString();
    else {
      secret = crypto.randomBytes(32).toString('hex');
      await storage.putBuffer('system/secret', Buffer.from(secret), 'text/plain');
    }
  }
  const signer = makeSigner(secret);

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6, pingInterval: 20000, pingTimeout: 30000 });

  // En-têtes de sécurité légers
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(self), microphone=()');
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  // Fichiers statiques : le service worker et le HTML ne doivent jamais être figés en cache
  const pub = path.join(__dirname, 'public');
  app.use(express.static(pub, {
    setHeaders(res, file) {
      // HTML / JS / CSS : toujours revalidés (ETag) → jamais de versions mélangées après une mise à jour
      if (/\.(html|webmanifest|json|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
      else res.set('Cache-Control', 'public, max-age=86400');
    }
  }));

  app.get('/favicon.ico', (req, res) => res.redirect(301, '/icon-192.png'));
  app.all('/cdn-cgi/*', (req, res) => res.status(204).end());

  app.get('/health', (req, res) => res.json({
    status: 'OK', timestamp: new Date().toISOString(), storage: storage.name,
    email: { enabled: mailer.enabled, provider: mailer.provider }, turn: !!env.TURN_URL, webrtc: true
  }));

  /* ---------- ICE (STUN/TURN) ---------- */
  function validateIceServer(url, username, credential) {
    if (!url || typeof url !== 'string') return null;
    url = url.trim();
    const m = url.match(/^(stun|turn|turns):/i);
    const scheme = m ? m[1].toLowerCase() : (url.includes('stun.') ? 'stun' : 'turn');
    const rest = m ? url.slice(m[0].length) : url;
    const hm = rest.match(/^([^:?]+)(?::(\d+))?(\?.*)?$/);
    if (!hm) return null;
    const port = parseInt(hm[2] || (scheme === 'stun' ? 19302 : 3478), 10);
    const obj = { urls: `${scheme}:${hm[1].trim()}:${port}${hm[3] || ''}` };
    if (scheme !== 'stun' && username && credential) { obj.username = String(username).trim(); obj.credential = String(credential).trim(); }
    return obj;
  }
  app.get('/api/ice-config', (req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
    (env.TURN_URL || '').split(',').filter(Boolean).forEach(u => {
      const s = validateIceServer(u, env.TURN_USERNAME, env.TURN_CREDENTIAL);
      if (s) iceServers.push(s);
    });
    res.json({ iceServers });
  });

  /* ---------- E-mail du mode P2P (lien limité à ce domaine : pas de relais de spam) ---------- */
  const p2pMailLimit = rateLimiter({ windowMs: 3600 * 1000, max: 20 });
  app.post('/api/send-email', async (req, res) => {
    const { to, link, fileName } = req.body || {};
    if (!to || !link) return res.status(400).json({ error: 'Champs manquants (to, link).' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Email invalide.' });
    const base = (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    let ok = false;
    try { const u = new URL(link); ok = u.origin === new URL(base).origin; } catch (e) { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Lien non autorisé.' });
    if (!p2pMailLimit(clientIp(req))) return res.status(429).json({ error: 'Trop d\'e-mails envoyés.' });
    if (!mailer.enabled) return res.status(503).json({ error: 'Service email non configuré.' });
    try {
      await mailer.send({ to: to.trim(), ...mailer.p2pEmail({ link, fileName }) });
      res.json({ success: true, provider: mailer.provider });
    } catch (e) {
      console.error('❌ Email:', e.response?.body || e.message);
      res.status(500).json({ error: 'Échec envoi : ' + (e.response?.body?.errors?.[0]?.message || e.message) });
    }
  });

  /* ---------- Modes Cloud + P2P ---------- */
  mountCloud(app, { storage, db, mailer, signer, io, env });
  mountP2P(io);

  /* ---------- Routes de l'application (SPA) ---------- */
  const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'index.html')); };
  app.get(['/t/:id', '/m/:id', '/dashboard', '/send', '/p2p'], sendIndex);

  // Erreurs API au format JSON
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('❌', req.method, req.path, err.message);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur serveur. Réessayez.' });
  });

  server.listen(PORT, () => {
    console.log(`🚀 TransferX sur le port ${PORT}`);
    console.log(`💾 Stockage : ${storage.name === 's3' ? 'S3 / Cloudflare R2 (' + (env.S3_BUCKET || env.R2_BUCKET) + ')' : 'disque local (' + storage.root + ')'}`);
    console.log(`📧 E-mail : ${mailer.enabled ? mailer.provider : 'non configuré'}`);
    console.log(`🔄 TURN : ${env.TURN_URL ? 'configuré' : 'STUN uniquement'}`);
  });

  const shutdown = async () => { try { await db.flushAll(); } catch (e) { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('Démarrage impossible :', e); process.exit(1); });
