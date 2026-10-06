'use strict';
/**
 * Console d'administration Lestha Send (accès réservé, discret).
 *  - page servie uniquement à l'adresse ADMIN_PATH (par défaut /admin), non indexée
 *  - connexion par mot de passe (ADMIN_PASSWORD) → jeton signé 12 h, tentatives limitées
 *  - l'admin voit les MÉTADONNÉES (tailles, noms, activité) jamais le contenu des fichiers ni les messages
 */
const fs = require('fs');
const { versionAssets } = require('./assets');
const path = require('path');
const express = require('express');
const { sha256, safeEqual, rateLimiter, clientIp } = require('./util');

const DAY = 86400e3;

function mountAdmin(app, { env, db, storage, mailer, signer, io, security, cloud, p2p, ctx, publicDir }) {
  const PASSWORD = env.ADMIN_PASSWORD || '';
  if (!PASSWORD) {
    console.log('🔒 Console admin désactivée (ADMIN_PASSWORD non défini)');
    return;
  }
  if (PASSWORD.length < 10) ctx.warnings.push({ level: 'warn', code: 'weak-admin', text: 'ADMIN_PASSWORD est court : utilisez au moins 12 caractères.' });
  const ADMIN_PATH = (env.ADMIN_PATH || 'admin').replace(/[^a-zA-Z0-9_-]/g, '') || 'admin';
  const pwTag = sha256('adm:' + PASSWORD).slice(0, 12);          // changer le mot de passe invalide les sessions
  const loginLimit = rateLimiter({ windowMs: 15 * 60e3, max: 6 });

  const verifyToken = (tok) => {
    const t = signer.verify(tok);
    return !!(t && t.adm === 1 && t.pv === pwTag);
  };
  const tokenOf = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-admin-token') || '';
  ctx.isAdmin = (req) => verifyToken(tokenOf(req));

  /* ---------- page admin (le sprite d'icônes est repris de index.html) ---------- */
  let pageCache = null;
  function adminPage() {
    if (pageCache && process.env.NODE_ENV === 'production') return pageCache;
    const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const sprite = (index.match(/<svg width="0" height="0"[\s\S]*?<\/svg>/) || [''])[0];
    const tpl = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.html'), 'utf8');
    pageCache = versionAssets(tpl.replace('{{SPRITE}}', sprite), { publicDir, version: require('../package.json').version });
    return pageCache;
  }
  app.get('/' + ADMIN_PATH, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY' });
    res.type('html').send(adminPage());
  });

  const r = express.Router();
  const fail = (res, s, error) => res.status(s).json({ error });

  r.post('/login', (req, res) => {
    const ip = clientIp(req);
    if (!loginLimit(ip)) return fail(res, 429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    const ok = safeEqual(sha256(String(req.body.password || '')), sha256(PASSWORD));
    setTimeout(() => {
      if (!ok) { console.warn('⚠️ Échec de connexion admin depuis', security.maskIp(ip)); return fail(res, 401, 'Mot de passe incorrect.'); }
      loginLimit.refund(ip);   // une connexion réussie ne compte pas dans la limite d'essais
      res.json({ token: signer.sign({ adm: 1, pv: pwTag, exp: Date.now() + 12 * 3600e3 }) });
    }, 350);
  });

  r.use((req, res, next) => (ctx.isAdmin(req) ? next() : fail(res, 401, 'Session expirée, reconnectez-vous.')));

  /* ---------- chargement de tous les transferts (avec cache court) ---------- */
  let snap = null, snapAt = 0;
  async function all(force) {
    if (!force && snap && Date.now() - snapAt < 15000) return snap;
    const ids = await db.listIds();
    const out = [];
    for (let i = 0; i < ids.length; i += 16) {
      const batch = await Promise.all(ids.slice(i, i + 16).map(id => db.get(id).catch(() => null)));
      batch.forEach(t => { if (t && !t.deleted && !t.selftest) out.push(t); if (t) db.release(t.id); });
    }
    snap = out; snapAt = Date.now();
    return out;
  }
  const dl = (t) => (t.stats.downloads || 0) + (t.stats.zipDownloads || 0);
  const stored = (t) => (t.status === 'ready' ? t.totalSize : t.files.filter(f => f.done).reduce((s, f) => s + f.size, 0));

  function row(t) {
    return {
      id: t.id, title: cloud.titleOf(t), fileCount: t.files.length, totalSize: t.totalSize, state: cloud.publicState(t),
      createdAt: t.createdAt, expiresAt: t.expiresAt, downloads: dl(t), views: t.stats.views, visitors: t.stats.visitors.length,
      pin: !!t.pin, maxDownloads: t.maxDownloads || null, disabled: !!t.disabled, senderName: t.senderName || '',
      emailsSent: (t.emails || []).length, lastActivity: t.stats.lastActivity || null,
      reports: (t.reports || []).length, disabledBy: t.disabledBy || null, tier: t.tier || null, senderVerified: !!t.senderVerified,
      creator: t.creator ? { ipHash: t.creator.ipHash, ipMasked: t.creator.ipMasked, device: t.creator.device, browser: t.creator.browser, blocked: security.isBlockedHash(t.creator.ipHash) } : null
    };
  }

  /* ---------- vue d'ensemble ---------- */
  r.get('/overview', async (req, res, next) => {
    try {
      const list = await all(req.query.fresh === '1');
      const now = Date.now();
      const states = { ready: 0, uploading: 0, expired: 0, disabled: 0, limit: 0 };
      let storedBytes = 0, downloads = 0, views = 0, visitors = 0, bytesOut = 0, emails = 0, failedPins = 0;
      const created = { d1: 0, d7: 0, d30: 0 }, volume = { d7: 0, d30: 0 };
      const days = [];
      const base = new Date(); base.setHours(0, 0, 0, 0);
      for (let i = 29; i >= 0; i--) { const d = new Date(base); d.setDate(base.getDate() - i); days.push({ start: d.getTime(), created: 0, downloads: 0, views: 0, volume: 0 }); }
      const dayOf = (ts) => days.find(d => ts >= d.start && ts < d.start + DAY);
      const devices = {}, browsers = {};
      const creators = new Map();
      const pinFails = [];
      const recent = [];
      for (const t of list) {
        const st = cloud.publicState(t);
        states[st] = (states[st] || 0) + 1;
        if (st !== 'expired') storedBytes += stored(t);
        downloads += dl(t); views += t.stats.views; visitors += t.stats.visitors.length; bytesOut += t.stats.bytesOut || 0;
        emails += (t.emails || []).length; failedPins += t.stats.failedPins || 0;
        const age = now - t.createdAt;
        if (age < DAY) created.d1++;
        if (age < 7 * DAY) { created.d7++; volume.d7 += t.totalSize; }
        if (age < 30 * DAY) { created.d30++; volume.d30 += t.totalSize; }
        const cd = dayOf(t.createdAt); if (cd) { cd.created++; cd.volume += t.totalSize; }
        const title = cloud.titleOf(t);
        t.stats.events.slice(-40).forEach(e => { if (e.type !== 'ready') recent.push(Object.assign({ id: t.id, title }, e)); });
        for (const e of t.stats.events) {
          const d = dayOf(e.t);
          if (e.type === 'view') { if (d) d.views++; if (e.d) devices[e.d] = (devices[e.d] || 0) + 1; if (e.b) browsers[e.b] = (browsers[e.b] || 0) + 1; }
          else if (e.type === 'download' || e.type === 'zip') { if (d) d.downloads++; }
          else if (e.type === 'pin_fail') pinFails.push({ t: e.t, id: t.id, title: cloud.titleOf(t), d: e.d });
        }
        if (t.creator && t.creator.ipHash) {
          const c = creators.get(t.creator.ipHash) || { ipHash: t.creator.ipHash, ipMasked: t.creator.ipMasked, count: 0, volume: 0, lastAt: 0, device: t.creator.device, browser: t.creator.browser };
          c.count++; c.volume += t.totalSize; c.lastAt = Math.max(c.lastAt, t.createdAt);
          creators.set(t.creator.ipHash, c);
        }
      }
      let p2pRooms = 0, p2pOnline = 0, p2pReceivers = 0;
      if (p2p && p2p.rooms) p2p.rooms.forEach(room => { p2pRooms++; if (room.senderOnline) p2pOnline++; p2pReceivers += room.receivers.size; });
      const mem = process.memoryUsage();
      res.json({
        generatedAt: now,
        totals: { transfers: list.length, states, storedBytes, downloads, views, visitors, bytesOut, emails, failedPins, created, volume },
        quotaBytes: env.STORAGE_QUOTA_GB ? Number(env.STORAGE_QUOTA_GB) * 1024 ** 3 : null,
        days: days.map(d => ({ t: d.start, created: d.created, downloads: d.downloads, views: d.views, volume: d.volume })),
        devices, browsers,
        topDownloaded: list.filter(t => dl(t) > 0).sort((a, b) => dl(b) - dl(a)).slice(0, 6).map(row),
        biggest: list.filter(t => cloud.publicState(t) !== 'expired').sort((a, b) => b.totalSize - a.totalSize).slice(0, 6).map(row),
        creators: [...creators.values()].sort((a, b) => b.count - a.count).slice(0, 25).map(c => Object.assign(c, { blocked: security.isBlockedHash(c.ipHash) })),
        pinFails: pinFails.sort((a, b) => b.t - a.t).slice(0, 20),
        recent: recent.sort((a, b) => b.t - a.t).slice(0, 60),
        live: { sockets: io.engine.clientsCount, p2pRooms, p2pOnline, p2pReceivers, meet: ctx.meet ? ctx.meet.stats() : null },
        system: {
          version: ctx.version, node: process.version, uptime: Math.round((now - ctx.startedAt) / 1000),
          memoryMb: Math.round(mem.rss / 1048576), storage: storage.name, bucket: env.S3_BUCKET || env.R2_BUCKET || null,
          cloudEnabled: ctx.cloudEnabled, isRender: ctx.isRender, email: mailer.provider, turn: ctx.ice ? ctx.ice.provider : !!env.TURN_URL, adminEmail: !!env.ADMIN_EMAIL,
          uploadCode: !!env.UPLOAD_CODE, publicUrl: env.PUBLIC_URL || null, appSecret: !!env.APP_SECRET, adminPath: '/' + ADMIN_PATH,
          originProtected: !!ctx.originProtected, turnstile: !!(ctx.captcha && ctx.captcha.enabled),
          emailsToday: mailer.sentToday ? mailer.sentToday() : null, emailDailyCap: mailer.dailyCap || null,
          storedBytesLive: cloud.storedBytes ? cloud.storedBytes() : null,
          warnings: ctx.warnings
        }
      });
    } catch (e) { next(e); }
  });

  /* ---------- transferts ---------- */
  r.get('/transfers', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').toLowerCase().trim();
      const state = String(req.query.state || '');
      const sort = String(req.query.sort || 'created');
      let list = (await all(req.query.fresh === '1')).map(row);
      if (state) list = list.filter(x => x.state === state);
      if (q) list = list.filter(x => (x.title + ' ' + x.id + ' ' + x.senderName + ' ' + (x.creator ? x.creator.ipMasked : '')).toLowerCase().includes(q));
      const key = { created: 'createdAt', size: 'totalSize', downloads: 'downloads', views: 'views', expires: 'expiresAt', activity: 'lastActivity' }[sort] || 'createdAt';
      list.sort((a, b) => (b[key] || 0) - (a[key] || 0));
      const total = list.length;
      const offset = Math.max(0, Number(req.query.offset) || 0), limit = Math.min(200, Number(req.query.limit) || 50);
      res.json({ total, items: list.slice(offset, offset + limit) });
    } catch (e) { next(e); }
  });

  async function loadT(req, res) {
    const t = await db.get(req.params.id);
    if (!t || t.deleted) { fail(res, 404, 'Transfert introuvable.'); return null; }
    return t;
  }
  const maskEmail = (e) => String(e).replace(/^(.)[^@]*(@.*)$/, '$1***$2');

  r.get('/transfers/:id', async (req, res, next) => {
    try {
      const t = await loadT(req, res); if (!t) return;
      const base = (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      res.json(Object.assign(row(t), {
        link: `${base}/t/${t.id}`, finalizedAt: t.finalizedAt || null, recipients: t.stats.recipients.length, bytesOut: t.stats.bytesOut,
        failedPins: t.stats.failedPins || 0, zipDownloads: t.stats.zipDownloads,
        files: t.files.map(f => ({ name: f.name, path: f.path, size: f.size, type: f.type, done: !!f.done, downloads: t.stats.perFile[f.id] || 0 })),
        emails: (t.emails || []).slice(-20).map(e => ({ to: maskEmail(e.to), at: e.at })),
        events: t.stats.events.slice(-200),
        reportsDetail: (t.reports || []).slice(-20).map(r => ({ at: r.at, reason: r.reason }))
      }));
    } catch (e) { next(e); }
  });

  r.patch('/transfers/:id', async (req, res, next) => {
    try {
      const t = await loadT(req, res); if (!t) return;
      const b = req.body || {};
      if ('disabled' in b) { t.disabled = !!b.disabled; if (!t.disabled) { t.disabledBy = null; t.reports = []; } }
      if (b.extendMs) t.expiresAt = Math.min(Math.max(t.expiresAt, Date.now()) + Math.min(Number(b.extendMs) || 0, cloud.MAX_TTL), Date.now() + cloud.MAX_TTL);
      await db.save(t, 0);
      snap = null;
      res.json(row(t));
    } catch (e) { next(e); }
  });

  r.delete('/transfers/:id', async (req, res, next) => {
    try {
      const t = await loadT(req, res); if (!t) return;
      await cloud.deleteTransfer(t, 'admin');
      snap = null;
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- blocage ---------- */
  r.get('/blocks', (req, res) => res.json({ items: security.list() }));

  /* ---------- inscrits (comptes enseignants par e-mail) ---------- */
  r.get('/accounts', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const items = ctx.accounts ? await ctx.accounts.list() : [];
      const now = Date.now();
      res.json({ items, total: items.length, active7: items.filter(x => now - x.last < 7 * DAY).length, active30: items.filter(x => now - x.last < 30 * DAY).length, new7: items.filter(x => now - x.first < 7 * DAY).length });
    } catch (e) { next(e); }
  });
  r.post('/blocks', async (req, res, next) => {
    try { await security.block(req.body.ipHash, req.body.ipMasked, req.body.reason); snap = null; res.json({ ok: true, items: security.list() }); }
    catch (e) { e.status ? fail(res, e.status, e.message) : next(e); }
  });
  r.delete('/blocks/:hash', async (req, res, next) => {
    try { await security.unblock(req.params.hash); snap = null; res.json({ ok: true, items: security.list() }); } catch (e) { next(e); }
  });

  /* ---------- diagnostics ---------- */
  r.post('/selftest', async (req, res) => {
    const steps = [];
    const step = async (name, fn) => {
      const t0 = Date.now();
      try { const detail = await fn(); steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail || '' }); }
      catch (e) { steps.push({ name, ok: false, ms: Date.now() - t0, detail: e.message }); }
    };
    const key = 'system/admin-test-' + Date.now();
    await step('Écriture dans le stockage', () => storage.putBuffer(key, Buffer.from('test'), 'text/plain'));
    await step('Lecture depuis le stockage', async () => { const b = await storage.getBuffer(key); if (!b || b.toString() !== 'test') throw new Error('contenu inattendu'); });
    await step('Suppression', () => storage.deleteKey(key));
    await step('Métadonnées des transferts', async () => `${(await db.listIds()).length} transfert(s) enregistré(s)`);
    res.json({ steps });
  });

  r.post('/test-email', async (req, res) => {
    const to = String(req.body.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail(res, 400, 'Adresse invalide.');
    if (!mailer.enabled) return fail(res, 503, 'E-mail non configuré (SENDGRID_API_KEY / SMTP).');
    try {
      await mailer.send({ to, subject: 'Lestha Send — e-mail de test', text: 'Si vous lisez ceci, l\'envoi d\'e-mails de Lestha Send fonctionne.', html: mailer.simple ? mailer.simple({ title: 'E-mail de test ✅', paragraphs: ['Si vous lisez ceci, l\'envoi d\'e-mails de <strong>Lestha Send</strong> fonctionne.'] }) : '<p>Test Lestha Send ✅</p>' });
      res.json({ ok: true });
    } catch (e) { fail(res, 500, 'Échec : ' + (e.response?.body?.errors?.[0]?.message || e.message)); }
  });

  /* ---------- services affichés ---------- */
  r.get('/settings', (req, res) => res.json({ modules: ctx.settings ? ctx.settings.list() : [] }));
  r.put('/settings', async (req, res, next) => {
    try { if (!ctx.settings) return fail(res, 503, 'Réglages indisponibles.'); await ctx.settings.setModules((req.body || {}).modules); res.json({ modules: ctx.settings.list() }); }
    catch (e) { next(e); }
  });

  if (ctx.insights) ctx.insights.mountAdmin(r);
  app.use('/api/admin', r);

  /* ---------- flux en direct ---------- */
  io.on('connection', (socket) => {
    socket.on('admin-watch', (token, cb) => {
      const ok = verifyToken(token);
      if (ok) socket.join('admin');
      if (typeof cb === 'function') cb({ ok });
    });
  });

  console.log(`🛡️  Console admin active sur /${ADMIN_PATH}`);
}

module.exports = { mountAdmin };
