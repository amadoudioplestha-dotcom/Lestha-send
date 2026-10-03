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
const { originGuard, capMailer, turnstile, mountVerify, isEmail } = require('./lib/guard');
const { mountCloud } = require('./lib/cloud');
const { mountP2P } = require('./lib/p2p');
const { createSecurity } = require('./lib/security');
const { mountAdmin } = require('./lib/admin');
const { mountRequests } = require('./lib/requests');
const { mountNearby } = require('./lib/nearby');
const { mountLive } = require('./lib/live');
const { mountClassroom } = require('./lib/classroom');
const { mountProfiles, createStats } = require('./lib/profiles');
const { createIce } = require('./lib/turn');
const { createInsights } = require('./lib/insights');
const { createCodes } = require('./lib/codes');
const { mountMeet } = require('./lib/meet');
const { createSettings } = require('./lib/settings');
const VERSION = require('./package.json').version;

const env = process.env;
const PORT = env.PORT || 3000;
const IS_RENDER = env.RENDER === 'true' || !!env.RENDER_SERVICE_ID;
// Sur Render, l'adresse publique est connue automatiquement si PUBLIC_URL n'est pas renseignée
if (!env.PUBLIC_URL && env.RENDER_EXTERNAL_URL) env.PUBLIC_URL = env.RENDER_EXTERNAL_URL;

/** Vérifie que le stockage répond vraiment (écriture → lecture → suppression) */
async function storageSelfTest(storage) {
  const key = 'system/healthcheck-' + crypto.randomBytes(4).toString('hex');
  const payload = Buffer.from('ok-' + Date.now());
  const t0 = Date.now();
  await storage.putBuffer(key, payload, 'text/plain');
  const back = await storage.getBuffer(key);
  await storage.deleteKey(key);
  if (!back || !back.equals(payload)) throw new Error('Lecture incohérente');
  return Date.now() - t0;
}

async function main() {
  const storage = createStorage(env);
  const db = createDb(storage);
  const mailer = capMailer(createMailer(env), env);
  const origin = originGuard(env);
  const captcha = turnstile(env);

  /* ---------- GARDE-FOU STOCKAGE ----------
   * Le disque d'un service Render est effacé à chaque redémarrage : y stocker des transferts
   * produirait des liens « introuvables ». Sans R2, le mode Cloud est donc désactivé (P2P seul). */
  const warnings = [];
  let cloudEnabled = true;
  if (storage.name === 'local' && IS_RENDER && env.ALLOW_LOCAL_STORAGE !== 'true') {
    cloudEnabled = false;
    warnings.push({ level: 'bad', code: 'no-r2', text: 'Stockage R2 non configuré : le mode Cloud est désactivé pour éviter des liens qui disparaissent au redémarrage de Render.' });
    console.warn('⛔ Stockage R2 absent sur Render → mode Cloud désactivé (P2P seul). Renseignez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
  }
  try {
    const ms = await storageSelfTest(storage);
    console.log(`✅ Stockage opérationnel (${storage.name}, ${ms} ms)`);
  } catch (e) {
    // Mauvaises clés R2, bucket inexistant… : on arrête net, Render garde alors l'ancienne version en ligne
    console.error('❌ Le stockage ne répond pas :', e.name, e.message);
    console.error('   Vérifiez R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID et R2_SECRET_ACCESS_KEY.');
    process.exit(1);
  }
  if (!env.PUBLIC_URL) warnings.push({ level: 'warn', code: 'no-public-url', text: 'PUBLIC_URL non renseignée : les liens envoyés par e-mail utilisent l\'adresse de la requête.' });
  if (!env.APP_SECRET) warnings.push({ level: 'info', code: 'no-secret', text: 'APP_SECRET non renseigné : un secret a été généré et conservé dans le stockage.' });
  if (!origin.enabled) warnings.push({ level: 'bad', code: 'no-origin-secret', text: 'ORIGIN_SECRET absent : le serveur accepte les requêtes qui contournent Cloudflare, et les limites par adresse IP peuvent être contournées.' });
  if (!captcha.enabled) warnings.push({ level: 'info', code: 'no-turnstile', text: 'Turnstile non configuré : pas de vérification anti-robot à la création des envois.' });
  if (!mailer.enabled) warnings.push({ level: 'info', code: 'no-email', text: 'E-mail non configuré : l\'envoi du lien par e-mail et les alertes sont désactivés.' });
  const ice = createIce(env);
  if (!ice.provider) warnings.push({ level: 'warn', code: 'no-turn', text: 'Aucun relais TURN : le mode Direct peut échouer entre réseaux mobiles (4G/5G) ou filtrés. Ajoutez CF_TURN_KEY_ID et CF_TURN_API_TOKEN (Cloudflare, 1 000 Go gratuits par mois).' });

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
  const security = createSecurity({ storage, secret });
  await security.load();
  const ctx = { cloudEnabled, security, warnings, version: VERSION, startedAt: Date.now(), isRender: IS_RENDER, isAdmin: () => false, captcha, originProtected: origin.enabled, ice };

  const app = express();
  // Un seul proxy devant l'application (Render) : on ne croit que l'adresse qu'il ajoute.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6, pingInterval: 20000, pingTimeout: 30000 });
  io.use(origin.socket);
  app.use(origin.http);

  // En-têtes de sécurité légers
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    next();
  });

  app.use(express.json({ limit: '5mb' }));
  ctx.verifiedEmail = mountVerify(app, { mailer, signer, captcha });

  // Fichiers statiques : le service worker et le HTML ne doivent jamais être figés en cache
  const pub = path.join(__dirname, 'public');
  /* index.html est servi par sendIndex (adresse publique insérée dans les balises d'aperçu) */
  let indexHtml = null;
  const renderIndex = () => {
    if (indexHtml && process.env.NODE_ENV === 'production') return indexHtml;
    const base = String(env.PUBLIC_URL || '').replace(/\/$/, '');
    indexHtml = require('fs').readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/__PUBLIC_URL__/g, base);
    return indexHtml;
  };
  const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(renderIndex()); };
  app.get(['/', '/index.html'], sendIndex);

  app.use(express.static(pub, {
    index: false,
    setHeaders(res, file) {
      // HTML / JS / CSS : toujours revalidés (ETag) → jamais de versions mélangées après une mise à jour
      if (/\.(html|webmanifest|json|js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
      else res.set('Cache-Control', 'public, max-age=86400');
    }
  }));

  app.get('/favicon.ico', (req, res) => res.redirect(301, '/icon-192.png'));
  app.all('/cdn-cgi/*', (req, res) => res.status(204).end());

  app.get('/health', (req, res) => res.json({
    status: 'OK', version: VERSION, timestamp: new Date().toISOString(), storage: storage.name, cloud: cloudEnabled,
    email: { enabled: mailer.enabled, provider: mailer.provider }, turn: ice.provider, webrtc: true, origin: origin.enabled
  }));

  /* ---------- ICE (STUN + relais TURN Cloudflare à identifiants éphémères) ---------- */
  const iceLimit = rateLimiter({ windowMs: 10 * 60e3, max: 120 });
  app.get('/api/ice-config', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!iceLimit(clientIp(req))) return res.json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }], relay: false });
    res.json(await ice.getIceServers());
  });

  /* ---------- Retours et usage (anonyme) ---------- */
  ctx.io = io;
  ctx.insights = createInsights({ storage, secret, mailer, env, ctx });
  ctx.insights.mountPublic(app);

  /* ---------- E-mail du mode P2P (lien limité à ce domaine : pas de relais de spam) ---------- */
  const p2pMailLimit = rateLimiter({ windowMs: 3600 * 1000, max: 20 });
  app.post('/api/send-email', async (req, res) => {
    const { to, link, fileName } = req.body || {};
    if (!to || !link) return res.status(400).json({ error: 'Champs manquants (to, link).' });
    if (!isEmail(String(to).trim())) return res.status(400).json({ error: 'Email invalide.' });
    const sender = ctx.verifiedEmail(req);
    if (!sender && !ctx.isAdmin(req)) return res.status(401).json({ error: 'Confirmez d\'abord votre adresse e-mail pour envoyer un lien par e-mail.', needVerify: true });
    const base = (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    let ok = false;
    try { const u = new URL(link); ok = u.origin === new URL(base).origin; } catch (e) { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Lien non autorisé.' });
    if (!p2pMailLimit(clientIp(req))) return res.status(429).json({ error: 'Trop d\'e-mails envoyés.' });
    if (!mailer.enabled) return res.status(503).json({ error: 'Service email non configuré.' });
    try {
      await mailer.send({ to: to.trim(), ...mailer.p2pEmail({ link, fileName, sender }) });
      res.json({ success: true, provider: mailer.provider });
    } catch (e) {
      console.error('❌ Email:', e.response?.body || e.message);
      res.status(e.status || 500).json({ error: e.quota ? e.message : 'Échec envoi : ' + (e.response?.body?.errors?.[0]?.message || e.message) });
    }
  });

  /* ---------- Services activables depuis la console ---------- */
  ctx.settings = createSettings(storage);
  await ctx.settings.ready;
  const moduleGuard = (k) => (req, res, next) => (ctx.settings.on(k) || ctx.isAdmin(req) ? next() : res.status(403).json({ error: 'Ce service est désactivé pour le moment.' }));
  app.use('/api/classrooms', moduleGuard('classroom'));
  app.use('/api/lives', moduleGuard('live'));

  /* ---------- Modes Cloud + P2P ---------- */
  ctx.stats = createStats(storage, db);
  ctx.profiles = mountProfiles(app, { env, storage, ctx, db });
  const cloud = mountCloud(app, { storage, db, mailer, signer, io, env, ctx });
  ctx.codes = createCodes({ storage });
  const p2p = mountP2P(io, { security, storage, stats: ctx.stats, codes: ctx.codes });
  mountRequests(app, { env, storage, db, mailer, signer, io, ctx, cloud });
  mountNearby(io, { secret, security });
  ctx.meet = mountMeet(app, io, { env, codes: ctx.codes, ctx });
  ctx.codes.useMeet(ctx.meet.alive);
  if (ctx.meet.engine === 'mesh') warnings.push({ level: 'info', code: 'meet-mesh', text: 'Réunions : moteur direct (12 personnes en audio, 6 en vidéo). Ajoutez CF_SFU_APP_ID et CF_SFU_APP_TOKEN (Cloudflare Realtime) pour aller jusqu\'à 50.' });
  mountLive(app, { storage, io, env });
  mountClassroom(app, { env, storage, signer });
  mountAdmin(app, { env, db, storage, mailer, signer, io, security, cloud, p2p, ctx, publicDir: pub });

  /* ---------- Routes de l'application (SPA) ---------- */
  app.get(/^\/@[A-Za-z0-9-]{3,30}\/?$/, sendIndex);
  app.get(['/a-propos', '/securite', '/faq', '/conditions', '/confidentialite', '/t/:id', '/m/:id', '/w/:id', '/d/:id', '/r/:id', '/classe', '/classe/:id', '/dashboard', '/proximite', '/recevoir', '/reunion', '/reunion/:id', '/demande', '/send', '/p2p', '/direct', '/live/:id'], sendIndex);

  // Toute autre adresse : l'application affiche « page introuvable », avec un vrai code 404
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io') || /\.[A-Za-z0-9]{1,8}$/.test(req.path)) return next();
    res.status(404); sendIndex(req, res);
  });

  // Erreurs API au format JSON
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('❌', req.method, req.path, err.message);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur serveur. Réessayez.' });
  });

  server.listen(PORT, () => {
    console.log(`🚀 Lestha Send sur le port ${PORT}`);
    console.log(`💾 Stockage : ${storage.name === 's3' ? 'S3 / Cloudflare R2 (' + (env.S3_BUCKET || env.R2_BUCKET) + ')' : 'disque local (' + storage.root + ')'}`);
    console.log(`📧 E-mail : ${mailer.enabled ? mailer.provider : 'non configuré'}`);
    console.log(`🔄 TURN : ${ice.provider === 'cloudflare' ? 'relais Cloudflare (identifiants éphémères)' : ice.provider ? 'serveur personnalisé' : 'STUN uniquement'}`);
  });

  const shutdown = async () => { try { await db.flushAll(); if (ctx.stats) await ctx.stats.flush(); if (ctx.insights) await ctx.insights.flush(); } catch (e) { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('Démarrage impossible :', e); process.exit(1); });
