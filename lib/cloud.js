'use strict';
/**
 * Transferts "Cloud" : les fichiers sont déposés sur R2 (ou disque) → le lien reste
 * valide même quand l'expéditeur ferme l'application. Upload multipart parallèle et
 * reprenable, téléchargement direct avec reprise (HTTP Range), ZIP en streaming.
 */
const express = require('express');
const archiver = require('archiver');
const { randomId, randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter, clientIp, deviceFromUA, browserFromUA, cleanName, PIN_RE, PIN_RULE } = require('./util');
const { dailyCounter, isEmail } = require('./guard');
const { contentDisposition } = require('./storage');
const { fileDelivery } = require('./file-response');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function partSizeFor(size) {
  const base = 8 * MB;                         // 8 Mo : reprise fine sur réseaux mobiles lents
  if (size <= base * 9000) return base;        // jusqu'à ~70 Go avec des morceaux de 8 Mo
  return Math.ceil(size / 9000 / MB) * MB;     // au-delà : morceaux plus gros (limite S3 = 10 000)
}

function mountCloud(app, { storage, db, mailer, signer, io, env, ctx = {} }) {
  const security = ctx.security;
  const isAdmin = (req) => !!(ctx.isAdmin && ctx.isAdmin(req));   // résolu à l'appel (défini par le module admin)
  const cloudEnabled = () => ctx.cloudEnabled !== false;
  const router = express.Router();
  const MAX_TRANSFER = (Number(env.MAX_TRANSFER_GB) || 250) * GB;
  const MAX_FILES = Number(env.MAX_FILES) || 10000;
  const MAX_TTL = (Number(env.MAX_TTL_DAYS) || 30) * DAY;
  const GRACE_AFTER_LIMIT = 6 * HOUR;          // reprise possible après la limite de téléchargements
  const createLimit = rateLimiter({ windowMs: HOUR, max: Number(env.MAX_TRANSFERS_PER_HOUR) || 60 });
  const pinLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const mailLimit = rateLimiter({ windowMs: HOUR, max: 40 });
  const reportLimit = rateLimiter({ windowMs: HOUR, max: 10 });
  const fileLocks = new Map();
  const daily = dailyCounter();
  const QUOTA = env.STORAGE_QUOTA_GB ? Number(env.STORAGE_QUOTA_GB) * GB : 0;
  const REPORT_THRESHOLD = Math.max(1, Number(env.REPORT_THRESHOLD) || 3);
  const PIN_LOCK_FAILS = 20;                    // échecs de PIN par heure et par lien, toutes adresses confondues
  let storedBytes = 0;                          // volume hébergé (recalculé à chaque nettoyage)

  /* ---------------- offres : libre, adresse vérifiée, complète ---------------- */
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const TIERS = {
    free: {
      name: 'free', maxBytes: Math.min(num(env.FREE_MAX_GB, 2) * GB, MAX_TRANSFER), maxTtl: Math.min(num(env.FREE_MAX_DAYS, 3) * DAY, MAX_TTL),
      perDay: num(env.FREE_DAILY_TRANSFERS, 10), emails: 0, uploadWindow: DAY, requests: false
    },
    verified: {
      name: 'verified', maxBytes: Math.min(num(env.VERIFIED_MAX_GB, 10) * GB, MAX_TRANSFER), maxTtl: Math.min(num(env.VERIFIED_MAX_DAYS, 7) * DAY, MAX_TTL),
      perDay: num(env.VERIFIED_DAILY_TRANSFERS, 20), emails: num(env.EMAIL_MAX_RECIPIENTS, 3), uploadWindow: DAY, requests: true
    },
    full: { name: 'full', maxBytes: MAX_TRANSFER, maxTtl: MAX_TTL, perDay: Infinity, emails: 20, uploadWindow: 7 * DAY, requests: true }
  };
  /** Offre applicable à la requête : admin et détenteurs du code d'établissement = complète */
  function tierOf(req) {
    const email = ctx.verifiedEmail ? ctx.verifiedEmail(req) : null;
    if (isAdmin(req)) return Object.assign({}, TIERS.full, { admin: true, email });
    if (env.UPLOAD_CODE && safeEqual(String(req.get('x-upload-code') || ''), env.UPLOAD_CODE)) return Object.assign({}, TIERS.full, { email });
    if (email) return Object.assign({}, TIERS.verified, { email });
    return Object.assign({}, TIERS.free);
  }
  /** Compte un envoi dans le quota du jour ; false si le quota est atteint */
  const dailyKey = (req, tier) => (tier.email ? 'em:' + tier.email : 'ip:' + clientIp(req));
  function takeDaily(req, tier) {
    if (tier.perDay === Infinity) return true;
    return daily.take(dailyKey(req, tier), tier.perDay);
  }
  /** Rend l'envoi au quota du jour quand la création échoue (PIN invalide, stockage plein…) */
  function refundDaily(req, tier) { if (tier.perDay !== Infinity) daily.add(dailyKey(req, tier), -1); }

  const baseUrl = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const shareLink = (req, t) => `${baseUrl(req)}/t/${t.id}`;
  const manageLink = (req, t, key) => `${baseUrl(req)}/m/${t.id}${key ? '#' + key : ''}`;
  const fail = (res, status, error, extra) => res.status(status).json(Object.assign({ error }, extra || {}));

  /* ---------------- helpers ---------------- */
  function isExpired(t) { return Date.now() > t.expiresAt; }
  function limitReached(t) { return !!(t.maxDownloads && t.stats.recipients.length >= t.maxDownloads); }

  function publicState(t) {
    if (t.deleted) return 'deleted';
    if (isExpired(t)) return 'expired';
    if (t.disabled) return 'disabled';
    if (t.status === 'uploading') return 'uploading';
    if (limitReached(t)) return 'limit';
    return 'ready';
  }

  /** Fichier vu de l'extérieur (+ informations de version pour la revue vidéo) */
  function fileView(f) {
    const o = { id: f.id, name: f.name, path: f.path, size: f.size, type: f.type };
    if (f.versionOf) { o.versionOf = f.versionOf; o.v = f.v; o.addedAt = f.addedAt; }
    return o;
  }
  const COLORS = new Set(['#f43f5e', '#fbbf24', '#22d3ee', '#a3e635', '#ffffff', '#a78bfa']);
  /** Annotations dessinées sur l'image : coordonnées 0..1, taille bornée */
  function cleanDraw(d) {
    if (!Array.isArray(d)) return null;
    const out = [];
    for (const sh of d.slice(0, 30)) {
      if (!sh || !['pen', 'arrow', 'rect', 'circle'].includes(sh.t) || !Array.isArray(sh.p)) continue;
      const p = sh.p.slice(0, 600).map(n => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 1000) / 1000);
      if (p.length < 4 || p.length % 2) continue;
      out.push({ t: sh.t, c: COLORS.has(sh.c) ? sh.c : '#f43f5e', p });
    }
    return out.length ? out : null;
  }
  function reviewsOf(t) {
    const out = {};
    Object.entries(t.reviews || {}).forEach(([fid, m]) => { out[fid] = Object.values(m).sort((a, b) => b.at - a.at).slice(0, 50); });
    return out;
  }

  function ownerView(t, req) {
    return {
      id: t.id, title: t.title, message: t.message, senderName: t.senderName, senderEmail: t.senderEmail,
      notifyOnDownload: !!t.notifyOnDownload, createdAt: t.createdAt, finalizedAt: t.finalizedAt || null,
      expiresAt: t.expiresAt, status: t.status, state: publicState(t), disabled: !!t.disabled,
      pinEnabled: !!t.pin, maxDownloads: t.maxDownloads || null, totalSize: t.totalSize, fileCount: t.files.length,
      files: t.files.map(f => Object.assign(fileView(f), { done: !!f.done, partSize: f.partSize, partCount: f.partCount, downloads: t.stats.perFile[f.id] || 0 })),
      stats: {
        views: t.stats.views, uniqueVisitors: t.stats.visitors.length, downloads: t.stats.downloads,
        zipDownloads: t.stats.zipDownloads, recipients: t.stats.recipients.length, bytesOut: t.stats.bytesOut,
        failedPins: t.stats.failedPins || 0, lastActivity: t.stats.lastActivity || null
      },
      events: t.stats.events.slice(-300),
      emails: (t.emails || []).slice(-50),
      playback: t.playback || 'off', allowComments: !!t.allowComments, watermark: t.watermark || '', requestId: t.requestId || null,
      comments: (t.comments || []).slice(-500), reviews: reviewsOf(t),
      watch: Object.fromEntries(t.files.filter(f => t.stats.watch && t.stats.watch[f.id]).map(f => {
        const vals = Object.values(t.stats.watch[f.id]);
        return [f.id, { viewers: vals.length, avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length), completes: vals.filter(v => v >= 90).length }];
      })),
      link: shareLink(req, t)
    };
  }

  function summaryView(t, req) {
    return {
      id: t.id, title: t.title, createdAt: t.createdAt, expiresAt: t.expiresAt, state: publicState(t), status: t.status,
      totalSize: t.totalSize, fileCount: t.files.length, pinEnabled: !!t.pin, maxDownloads: t.maxDownloads || null,
      uploaded: t.files.filter(f => f.done).reduce((s, f) => s + f.size, 0),
      firstFile: t.files[0] ? t.files[0].name : '',
      stats: statsOf(t),
      events: t.stats.events.slice(-200).map(e => ({ t: e.t, type: e.type, f: e.f || undefined, d: e.d || undefined, b: e.b || undefined })),
      link: shareLink(req, t)
    };
  }

  function pushEvent(t, ev) {
    ev.t = Date.now();
    t.stats.events.push(ev);
    if (t.stats.events.length > 2000) t.stats.events.splice(0, t.stats.events.length - 2000);
    t.stats.lastActivity = ev.t;
    if (io) {
      io.to('owner:' + t.id).emit('transfer-event', { id: t.id, event: ev, stats: statsOf(t), state: publicState(t) });
      io.to('admin').emit('admin-event', { id: t.id, title: titleOf(t), event: ev });
    }
  }
  function titleOf(t) { return t.title || (t.files.length === 1 ? t.files[0].name : (t.files[0] && t.files[0].path ? t.files[0].path.split('/')[0] : t.files.length + ' fichiers')); }

  /** Suppression complète (fichiers + métadonnées) — utilisée par le propriétaire, l'admin et le nettoyage */
  async function deleteTransfer(t, by = 'owner') {
    for (const f of t.files) if (f.uploadId) await storage.abortMultipart(f.key, f.uploadId);
    await storage.deletePrefix(`files/${t.id}/`);
    await db.remove(t.id);
    if (io) {
      io.to('owner:' + t.id).emit('transfer-deleted', { id: t.id });
      io.to('admin').emit('admin-event', { id: t.id, title: titleOf(t), event: { t: Date.now(), type: 'deleted', by } });
    }
  }

  function statsOf(t) {
    return { views: t.stats.views, uniqueVisitors: t.stats.visitors.length, downloads: t.stats.downloads, zipDownloads: t.stats.zipDownloads, recipients: t.stats.recipients.length, bytesOut: t.stats.bytesOut, failedPins: t.stats.failedPins || 0, lastActivity: t.stats.lastActivity || null };
  }

  const t_salt = env.APP_SECRET || 'transferx';
  function visitorOf(req) {
    const v = String(req.query.v || req.body?.v || '').slice(0, 64);
    return sha256((v || clientIp(req) + (req.headers['user-agent'] || '')) + t_salt).slice(0, 16);
  }
  async function loadOwner(req, res, next) {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Transfert introuvable ou expiré.');
      const key = req.get('x-owner-key') || req.query.key;
      if (!key || !safeEqual(sha256(key), t.ownerHash)) return fail(res, 403, 'Clé de gestion invalide.');
      req.t = t; req.ownerKey = key;
      next();
    } catch (e) { next(e); }
  }

  /** Clé de gestion OU clé de dépôt (le déposant peut envoyer ses fichiers, pas gérer le transfert) */
  async function loadUploader(req, res, next) {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Transfert introuvable ou expiré.');
      const key = req.get('x-owner-key') || req.query.key;
      const h = key ? sha256(key) : '';
      if (!key || !(safeEqual(h, t.ownerHash) || (t.uploadHash && safeEqual(h, t.uploadHash)))) return fail(res, 403, 'Clé invalide.');
      req.t = t; req.ownerKey = safeEqual(h, t.ownerHash) ? key : null;
      next();
    } catch (e) { next(e); }
  }

  function hasAccess(req, t) {
    if (!t.pin) return true;
    const tok = signer.verify(req.query.tk || req.get('x-access-token'));
    return !!(tok && tok.id === t.id && tok.pv === t.pinVersion);
  }

  async function withFileLock(key, fn) {
    while (fileLocks.has(key)) await fileLocks.get(key);
    const p = (async () => fn())();
    fileLocks.set(key, p.catch(() => {}));
    try { return await p; } finally { fileLocks.delete(key); }
  }

  /* ---------------- config ---------------- */
  router.get('/config', (req, res) => {
    const tier = tierOf(req);
    res.set('Cache-Control', 'no-store');
    res.json({
      modules: ctx.settings ? ctx.settings.modules() : undefined,
      driver: storage.name, direct: !!storage.direct, maxTransferBytes: tier.maxBytes, maxFiles: MAX_FILES,
      maxTtl: tier.maxTtl, email: mailer.enabled, p2p: true, uploadCodeRequired: !!env.UPLOAD_CODE && tier.name !== 'full', admin: !!tier.admin, cloudEnabled: cloudEnabled(),
      quotaBytes: QUOTA || null,
      appName: mailer.appName || 'Lestha Send', contactEmail: env.CONTACT_EMAIL || null,
      founderLinkedin: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/[A-Za-z0-9_\/%.-]+$/.test(String(env.FOUNDER_LINKEDIN || '')) ? env.FOUNDER_LINKEDIN : null,
      tier: tier.name, verifiedEmail: tier.email || null, emailRecipients: tier.emails, canRequest: tier.requests,
      limits: {
        free: { maxBytes: TIERS.free.maxBytes, maxTtl: TIERS.free.maxTtl },
        verified: { maxBytes: TIERS.verified.maxBytes, maxTtl: TIERS.verified.maxTtl, emails: TIERS.verified.emails }
      },
      turnstileSiteKey: ctx.captcha ? ctx.captcha.siteKey : null
    });
  });

  /* ---------------- création ---------------- */
  router.post('/transfers', async (req, res, next) => {
    try {
      const admin = isAdmin(req);
      if (!cloudEnabled()) return fail(res, 503, 'Mode Cloud indisponible : le stockage R2 n\'est pas configuré sur ce serveur. Utilisez le mode Direct P2P.', { cloudDisabled: true });
      if (!admin && security && security.isBlockedIp(clientIp(req))) return fail(res, 403, 'L\'envoi est bloqué depuis cette connexion. Contactez l\'administrateur.');
      if (!admin && env.UPLOAD_CODE && !safeEqual(String(req.get('x-upload-code') || ''), env.UPLOAD_CODE)) return fail(res, 401, 'Code d\'accès à l\'envoi requis.', { needCode: true });
      if (!admin && !createLimit(clientIp(req))) return fail(res, 429, 'Trop de transferts créés. Réessayez dans une heure.');
      const tier = tierOf(req);
      if (tier.name !== 'full' && ctx.captcha && !(await ctx.captcha.check(req))) return fail(res, 403, 'Vérification anti-robot échouée. Rechargez la page et réessayez.', { needCaptcha: true });
      const pre = precheck(req.body || {}, tier);
      if (pre) return fail(res, pre.status || 400, pre.error, pre.extra);
      if (!takeDaily(req, tier)) return fail(res, 429, tier.email
        ? `Limite de ${tier.perDay} envois Cloud par jour atteinte. Le mode Direct reste illimité.`
        : `Limite de ${tier.perDay} envois Cloud par jour atteinte depuis cette connexion. Confirmez votre e-mail pour en faire plus, ou utilisez le mode Direct, illimité.`, { needVerify: !tier.email });
      const r = await createTransfer(req, req.body || {}, { admin, tier });
      if (r.error) { refundDaily(req, tier); return fail(res, r.status || 400, r.error); }
      const { t, ownerKey } = r;
      res.json({
        id: t.id, ownerKey, link: shareLink(req, t), manageLink: manageLink(req, t, ownerKey),
        files: t.files.map(f => ({ id: f.id, partSize: f.partSize, partCount: f.partCount, done: f.done }))
      });
    } catch (e) { next(e); }
  });

  /** Contrôle de taille avant de compter l'envoi dans le quota du jour */
  function precheck(b, tier) {
    const files = Array.isArray(b.files) ? b.files : [];
    const total = files.reduce((s, f) => s + Math.max(0, Math.floor(Number(f && f.size) || 0)), 0);
    if (files.length && total > tier.maxBytes) {
      return {
        status: 413, extra: { needVerify: tier.name === 'free', maxBytes: tier.maxBytes },
        error: tier.name === 'free'
          ? `Sans compte, un envoi Cloud est limité à ${require('./email').bytes(tier.maxBytes)}. Confirmez votre e-mail pour aller jusqu'à ${require('./email').bytes(TIERS.verified.maxBytes)}, ou utilisez le mode Direct, sans limite.`
          : `Envoi trop volumineux (max ${require('./email').bytes(tier.maxBytes)}). Le mode Direct n'a pas cette limite.`
      };
    }
    return null;
  }

  /** Création d'un transfert (utilisée par l'envoi classique et par les dépôts « demande de fichiers ») */
  async function createTransfer(req, b, { admin = false, ownerHash = null, uploadKey = false, requestId = null, ttl: forcedTtl = null, tier = null } = {}) {
      tier = tier || TIERS.full;
      const files = Array.isArray(b.files) ? b.files : [];
      if (!files.length) return { error: 'Aucun fichier.' };
      if (files.length > MAX_FILES) return { error: `Maximum ${MAX_FILES} fichiers par transfert.` };
      let total = 0;
      const id = randomId(10);
      const list = files.map((f, i) => {
        const size = Math.max(0, Math.floor(Number(f.size) || 0));
        total += size;
        const partSize = partSizeFor(size);
        const fid = 'f' + i.toString(36) + randomId(4);
        return {
          id: fid, name: cleanName(String(f.name || '').split('/').pop()), path: f.path ? cleanName(f.path) : null,
          size, type: String(f.type || 'application/octet-stream').slice(0, 120), lastModified: Number(f.lastModified) || 0,
          key: `files/${id}/${fid}`, uploadId: null, partSize, partCount: Math.max(1, Math.ceil(size / partSize)), done: false
        };
      });
      if (total === 0) return { error: 'Les fichiers sont vides.' };
      if (total > Math.min(MAX_TRANSFER, tier.maxBytes)) return { error: `Transfert trop volumineux (max ${require('./email').bytes(Math.min(MAX_TRANSFER, tier.maxBytes))}).`, status: 413 };
      if (b.maxBytes && total > b.maxBytes) return { error: `Dépôt trop volumineux (max ${require('./email').bytes(b.maxBytes)}).`, status: 413 };
      if (!admin && QUOTA && storedBytes + total > QUOTA) {
        console.warn('💾 Quota de stockage atteint :', storedBytes, '/', QUOTA);
        return { error: 'Le stockage Cloud du service est plein pour le moment. Utilisez le mode Direct, qui ne stocke rien.', status: 507 };
      }
      const ttl = Math.min(forcedTtl || Math.max(Number(b.ttl) || 7 * DAY, HOUR), tier.maxTtl, MAX_TTL);
      const pin = b.pin ? String(b.pin) : null;
      if (pin && !PIN_RE.test(pin)) return { error: PIN_RULE };
      // Alertes de téléchargement : uniquement vers l'adresse vérifiée de l'expéditeur
      // (ou celle saisie par un établissement disposant du code d'accès)
      const notifyTo = tier.email || (tier.name === 'full' && isEmail(b.senderEmail) ? String(b.senderEmail).slice(0, 200) : '');
      const ownerKey = ownerHash ? null : randomKey(24);
      const upKey = uploadKey ? randomKey(24) : null;
      const now = Date.now();
      const t = {
        id, v: 3, ownerHash: ownerHash || sha256(ownerKey), uploadHash: upKey ? sha256(upKey) : null, requestId, createdAt: now, status: 'uploading', ttl,
        expiresAt: now + (tier.uploadWindow || 7 * DAY), // fenêtre d'upload ; recalculée à la finalisation
        tier: tier.name, maxBytes: Math.min(MAX_TRANSFER, tier.maxBytes), maxTtl: tier.maxTtl, maxEmails: tier.emails,
        title: String(b.title || '').slice(0, 140), message: String(b.message || '').slice(0, 1500),
        senderName: String(b.senderName || '').slice(0, 80),
        senderEmail: notifyTo,
        senderVerified: !!tier.email,
        brandPid: tier.email && ctx.profiles ? ctx.profiles.pidOf(tier.email) : null,
        notifyOnDownload: !!b.notifyOnDownload && !!notifyTo,
        pin: pin ? hashPin(pin) : null, pinVersion: 1,
        maxDownloads: b.destroyOnDownload ? 1 : (Number(b.maxDownloads) > 0 ? Math.floor(Number(b.maxDownloads)) : null),
        disabled: false, files: list, totalSize: total,
        stats: { views: 0, downloads: 0, zipDownloads: 0, bytesOut: 0, visitors: [], recipients: [], perFile: {}, events: [], failedPins: 0 },
        emails: [],
        playback: ['on', 'only'].includes(b.playback) ? b.playback : 'off',
        allowComments: !!b.allowComments, watermark: String(b.watermark || '').slice(0, 60), comments: [],
        creator: security ? { ipHash: security.ipHash(clientIp(req)), ipMasked: security.maskIp(clientIp(req)), device: deviceFromUA(req.headers['user-agent']), browser: browserFromUA(req.headers['user-agent']) } : null,
        selftest: admin && b.title === '__selftest__'
      };
      // Fichiers vides : créés immédiatement
      for (const f of list) if (f.size === 0) { await storage.putBuffer(f.key, Buffer.alloc(0), f.type); f.done = true; }
      await db.save(t, 0);
      storedBytes += total;
      if (io) io.to('admin').emit('admin-event', { id, title: titleOf(t), event: { t: now, type: requestId ? 'deposit_started' : 'created', size: total, n: list.length, d: t.creator && t.creator.device, b: t.creator && t.creator.browser } });
      return { t, ownerKey, uploadKey: upKey };
  }

  /* ---------------- upload : URLs des morceaux ---------------- */
  router.post('/transfers/:id/files/:fid/urls', loadUploader, async (req, res, next) => {
    try {
      const t = req.t;
      const f = t.files.find(x => x.id === req.params.fid);
      if (!f) return fail(res, 404, 'Fichier inconnu.');
      if (f.done) return res.json({ done: true, urls: {} });
      const parts = (Array.isArray(req.body.parts) ? req.body.parts : []).map(Number)
        .filter(n => Number.isInteger(n) && n >= 1 && n <= f.partCount).slice(0, 64);
      await withFileLock(f.key, async () => {
        if (!f.uploadId) { f.uploadId = await storage.createMultipart(f.key, f.type); await db.save(t, 0); }
      });
      const urls = {};
      for (const n of parts) {
        const offset = (n - 1) * f.partSize;
        const size = Math.min(f.partSize, f.size - offset);
        if (storage.direct) {
          urls[n] = await storage.presignPart(f.key, f.uploadId, n, size, 3 * 3600);
        } else {
          const tk = signer.sign({ k: f.key, u: f.uploadId, p: n, o: offset, s: size, exp: Date.now() + 6 * HOUR });
          urls[n] = `${baseUrl(req)}/api/local/part?tk=${encodeURIComponent(tk)}`;
        }
      }
      res.json({ urls });
    } catch (e) { next(e); }
  });

  /* ---------------- upload : morceaux déjà reçus (reprise) ---------------- */
  router.get('/transfers/:id/files/:fid/parts', loadUploader, async (req, res, next) => {
    try {
      const f = req.t.files.find(x => x.id === req.params.fid);
      if (!f) return fail(res, 404, 'Fichier inconnu.');
      if (f.done) return res.json({ done: true, parts: [] });
      if (!f.uploadId) return res.json({ done: false, parts: [] });
      const parts = await storage.listParts(f.key, f.uploadId);
      res.json({ done: false, parts: parts.map(p => p.PartNumber) });
    } catch (e) { next(e); }
  });

  /* ---------------- upload : finalisation d'un fichier ---------------- */
  router.post('/transfers/:id/files/:fid/complete', loadUploader, async (req, res, next) => {
    try {
      const t = req.t;
      const f = t.files.find(x => x.id === req.params.fid);
      if (!f) return fail(res, 404, 'Fichier inconnu.');
      if (f.done) return res.json({ done: true });
      if (!f.uploadId) return fail(res, 409, 'Upload non démarré.');
      await withFileLock(f.key, async () => {
        if (f.done) return;
        const parts = await storage.listParts(f.key, f.uploadId);
        const missing = [];
        const have = new Set(parts.map(p => p.PartNumber));
        for (let n = 1; n <= f.partCount; n++) if (!have.has(n)) missing.push(n);
        if (missing.length) throw Object.assign(new Error('Morceaux manquants'), { status: 409, missing: missing.slice(0, 200) });
        // Contrôle de taille morceau par morceau (si le stockage l'indique) : on redemande seulement les morceaux abîmés
        const expected = (n) => Math.min(f.partSize, f.size - (n - 1) * f.partSize);
        const sized = parts.filter(p => p.PartNumber <= f.partCount && p.Size != null);
        const bad = sized.filter(p => Number(p.Size) !== expected(p.PartNumber)).map(p => p.PartNumber);
        if (bad.length) throw Object.assign(new Error(`Morceaux incomplets (${bad.length})`), { status: 409, missing: bad.slice(0, 200) });
        try {
          await storage.completeMultipart(f.key, f.uploadId, parts.filter(p => p.PartNumber <= f.partCount), f.size);
        } catch (err) {
          console.error('❌ assemblage', t.id, f.id, err.name, err.message);
          // Déjà assemblé par une requête précédente dont la réponse s'est perdue ?
          const h = await storage.head(f.key).catch(() => null);
          if (!h || Number(h.size ?? h.ContentLength ?? -1) !== f.size) throw Object.assign(new Error('Assemblage refusé par le stockage : ' + (err.message || err.name)), { status: 502 });
        }
        f.done = true; f.uploadId = null;
        await db.save(t, 0);
      });
      res.json({ done: true });
    } catch (e) {
      if (e.status === 409) return fail(res, 409, e.message, { missing: e.missing });
      if (e.status === 502) return fail(res, 502, e.message);
      next(e);
    }
  });

  /* ---------------- finalisation du transfert ---------------- */
  router.post('/transfers/:id/finalize', loadUploader, async (req, res, next) => {
    try {
      const t = req.t;
      const pending = t.files.filter(f => !f.done).map(f => f.id);
      if (pending.length) return fail(res, 409, 'Certains fichiers ne sont pas encore envoyés.', { pending });
      if (t.status === 'uploading') {
        t.status = 'ready';
        t.finalizedAt = Date.now();
        t.expiresAt = t.finalizedAt + t.ttl;
        pushEvent(t, { type: 'ready' });
        await db.save(t, 0);
        if (t.requestId && ctx.onDeposit) ctx.onDeposit(t, req);
        if (ctx.stats && !t.selftest) ctx.stats.add({ transfers: 1, files: t.files.length, bytes: t.totalSize });
      }
      let emails = req.ownerKey ? (Array.isArray(req.body.emails) ? req.body.emails : []).map(s => String(s).trim()).filter(isEmail) : [];
      const sent = [];
      let emailNote = null;
      if (emails.length && mailer.enabled) {
        const tier = tierOf(req);
        const room = Math.max(0, tier.emails - (t.emails || []).length);
        if (!tier.emails) emailNote = 'needVerify';
        else if (emails.length > room) { emailNote = 'capped'; emails = emails.slice(0, room); }
        for (const to of emails) {
          if (!mailLimit(clientIp(req))) break;
          try { await mailer.send({ to, ...mailer.transferEmail({ t, link: shareLink(req, t), senderName: t.senderName, senderEmail: tier.email }) }); sent.push(to); t.emails.push({ to, at: Date.now() }); }
          catch (e) { console.error('mail', e.response?.body || e.message); if (e.quota) { emailNote = 'dailyCap'; break; } }
        }
        await db.save(t);
      }
      // Code « Recevoir » à 6 chiffres (24 h au plus), créé une seule fois par envoi
      let code = t.shortCode && t.shortCode.expiresAt > Date.now() ? t.shortCode : null;
      if (!code && ctx.codes) {
        try { code = await ctx.codes.forTransfer(t.id, t.expiresAt); if (code) { t.shortCode = code; await db.save(t); } } catch (e) { console.warn('code', e.message); }
      }
      res.json({ ok: true, link: shareLink(req, t), manageLink: req.ownerKey ? manageLink(req, t, req.ownerKey) : null, expiresAt: t.expiresAt, emailed: sent, emailNote, code });
    } catch (e) { next(e); }
  });

  /* ---------------- gestion (tableau de bord) ---------------- */
  router.get('/transfers/:id', loadOwner, (req, res) => res.json(ownerView(req.t, req)));

  router.patch('/transfers/:id', loadOwner, async (req, res, next) => {
    try {
      const t = req.t, b = req.body || {};
      if (b.extendMs) {
        const base = Math.max(t.expiresAt, Date.now());
        const cap = Math.max(t.maxTtl || MAX_TTL, tierOf(req).maxTtl);   // une prolongation reste dans la durée de l'offre
        t.expiresAt = Math.min(base + Math.min(Number(b.extendMs) || 0, cap), Date.now() + cap);
        pushEvent(t, { type: 'extended' });
      }
      if ('pin' in b) {
        if (b.pin === null || b.pin === '') t.pin = null;
        else if (PIN_RE.test(String(b.pin))) t.pin = hashPin(String(b.pin));
        else return fail(res, 400, PIN_RULE);
        t.pinVersion = (t.pinVersion || 1) + 1;         // invalide les accès déjà accordés
        t.pinFailLog = [];
      }
      if ('maxDownloads' in b) {
        t.maxDownloads = Number(b.maxDownloads) > 0 ? Math.floor(Number(b.maxDownloads)) : null;
        if (!limitReached(t)) delete t.purgeAt;           // limite relevée : on annule la purge programmée
        else if (!t.purgeAt) t.purgeAt = Date.now() + GRACE_AFTER_LIMIT;
      }
      if ('disabled' in b) {
        if (!b.disabled && t.disabledBy === 'reports') return fail(res, 403, 'Ce transfert a été désactivé après des signalements. Contactez l\'administrateur.');
        t.disabled = !!b.disabled;
      }
      if ('title' in b) t.title = String(b.title || '').slice(0, 140);
      if ('message' in b) t.message = String(b.message || '').slice(0, 1500);
      if ('notifyOnDownload' in b) t.notifyOnDownload = !!b.notifyOnDownload;
      if ('playback' in b) t.playback = ['on', 'only'].includes(b.playback) ? b.playback : 'off';
      if ('allowComments' in b) t.allowComments = !!b.allowComments;
      if ('watermark' in b) t.watermark = String(b.watermark || '').slice(0, 60);
      if ('senderEmail' in b) {
        const tier = tierOf(req);
        const wanted = String(b.senderEmail || '').trim().toLowerCase();
        if (!wanted) t.senderEmail = '';
        else if (wanted === tier.email || (tier.name === 'full' && isEmail(wanted))) t.senderEmail = wanted.slice(0, 200);
        else return fail(res, 401, 'Confirmez d\'abord cette adresse e-mail.', { needVerify: true });
        if (!t.senderEmail) t.notifyOnDownload = false;
      }
      if ('notifyOnDownload' in b && !t.senderEmail) t.notifyOnDownload = false;
      await db.save(t, 0);
      res.json(ownerView(t, req));
    } catch (e) { next(e); }
  });

  router.patch('/transfers/:id/comments/:cid', loadOwner, async (req, res, next) => {
    try {
      const c = (req.t.comments || []).find(x => x.id === req.params.cid);
      if (!c) return fail(res, 404, 'Commentaire introuvable.');
      c.resolved = !!req.body.resolved; c.resolvedBy = c.resolved ? (req.t.senderName || 'Expéditeur') : null;
      await db.save(req.t, 0);
      res.json({ ok: true, comments: req.t.comments });
    } catch (e) { next(e); }
  });

  /** Nouvelle version d'une vidéo (V2, V3…) sur le MÊME lien */
  router.post('/transfers/:id/versions', loadOwner, async (req, res, next) => {
    try {
      const t = req.t, b = req.body || {};
      if (publicState(t) === 'expired') return fail(res, 410, 'Ce transfert a expiré.');
      const base = t.files.find(x => x.id === b.of);
      if (!base) return fail(res, 404, 'Fichier d\'origine introuvable.');
      const root = base.versionOf || base.id;
      const size = Math.max(0, Math.floor(Number(b.file?.size) || 0));
      if (!size) return fail(res, 400, 'Fichier vide.');
      const cap = Math.min(MAX_TRANSFER, t.maxBytes || MAX_TRANSFER);
      if (t.totalSize + size > cap) return fail(res, 413, `Transfert trop volumineux (max ${require('./email').bytes(cap)}).`);
      if (!isAdmin(req) && QUOTA && storedBytes + size > QUOTA) return fail(res, 507, 'Le stockage Cloud du service est plein pour le moment.');
      const chain = t.files.filter(x => x.id === root || x.versionOf === root);
      const partSize = partSizeFor(size);
      const fid = 'v' + randomId(6);
      const f = {
        id: fid, name: cleanName(String(b.file.name || base.name).split('/').pop()), path: null, size,
        type: String(b.file.type || 'application/octet-stream').slice(0, 120), lastModified: Number(b.file.lastModified) || 0,
        key: `files/${t.id}/${fid}`, uploadId: null, partSize, partCount: Math.max(1, Math.ceil(size / partSize)), done: false,
        versionOf: root, v: Math.max(...chain.map(x => x.v || 1)) + 1, addedAt: Date.now()
      };
      const rootFile = t.files.find(x => x.id === root); if (rootFile && !rootFile.v) rootFile.v = 1;
      t.files.push(f); t.totalSize += size; storedBytes += size;
      pushEvent(t, { type: 'version', f: f.name, p: f.v });
      await db.save(t, 0);
      res.json({ file: { id: f.id, partSize: f.partSize, partCount: f.partCount, done: false, v: f.v } });
    } catch (e) { next(e); }
  });

  router.delete('/transfers/:id/comments/:cid', loadOwner, async (req, res, next) => {
    try {
      const t = req.t;
      t.comments = (t.comments || []).filter(c => c.id !== req.params.cid);
      await db.save(t, 0);
      res.json({ ok: true, comments: t.comments });
    } catch (e) { next(e); }
  });

  router.delete('/transfers/:id', loadOwner, async (req, res, next) => {
    try { await deleteTransfer(req.t, 'owner'); res.json({ ok: true }); } catch (e) { next(e); }
  });

  router.post('/transfers/:id/email', loadOwner, async (req, res, next) => {
    try {
      const t = req.t;
      if (!mailer.enabled) return fail(res, 503, 'Service e-mail non configuré.');
      if (t.status !== 'ready') return fail(res, 409, 'Transfert pas encore prêt.');
      const tier = tierOf(req);
      if (!tier.emails) return fail(res, 401, 'Confirmez d\'abord votre adresse e-mail pour envoyer le lien par e-mail.', { needVerify: true });
      let emails = (Array.isArray(req.body.emails) ? req.body.emails : [req.body.to]).map(s => String(s || '').trim()).filter(isEmail);
      if (!emails.length) return fail(res, 400, 'Adresse e-mail invalide.');
      const room = Math.max(0, Math.max(t.maxEmails || 0, tier.emails) - (t.emails || []).length);
      if (!room) return fail(res, 429, `Ce lien a déjà été envoyé au nombre maximal de destinataires (${Math.max(t.maxEmails || 0, tier.emails)}). Partagez-le directement.`);
      emails = emails.slice(0, room);
      const sent = [];
      for (const to of emails) {
        if (!mailLimit(clientIp(req))) return fail(res, 429, 'Trop d\'e-mails envoyés, réessayez plus tard.', { sent });
        try { await mailer.send({ to, ...mailer.transferEmail({ t, link: shareLink(req, t), senderName: t.senderName, senderEmail: tier.email }) }); }
        catch (e) { if (e.quota) return fail(res, 429, e.message, { sent }); throw e; }
        sent.push(to); t.emails.push({ to, at: Date.now() });
      }
      await db.save(t);
      res.json({ ok: true, sent });
    } catch (e) { next(e); }
  });

  /** Résumé de plusieurs transferts (tableau de bord global) */
  router.post('/owner/summary', async (req, res, next) => {
    try {
      const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 200);
      const out = await Promise.all(items.map(async ({ id, key }) => {
        const t = await db.get(id).catch(() => null);
        if (!t || t.deleted) return { id, gone: true };
        if (!key || !safeEqual(sha256(key), t.ownerHash)) return { id, gone: true };
        return summaryView(t, req);
      }));
      res.json({ items: out });
    } catch (e) { next(e); }
  });

  /* ================= CÔTÉ DESTINATAIRE ================= */
  router.get('/public/t/:id', async (req, res, next) => {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Ce lien n\'existe pas ou a expiré.', { state: 'gone' });
      const state = publicState(t);
      const unlocked = hasAccess(req, t);
      if (state === 'ready' && req.query.v) {
        const vid = visitorOf(req);
        const last = (t.viewSeen || (t.viewSeen = {}))[vid] || 0;
        if (Date.now() - last > 30 * 60 * 1000) {
          t.viewSeen[vid] = Date.now();
          const keys = Object.keys(t.viewSeen); if (keys.length > 3000) delete t.viewSeen[keys[0]];
          t.stats.views++;
          if (!t.stats.visitors.includes(vid)) { t.stats.visitors.push(vid); if (t.stats.visitors.length > 5000) t.stats.visitors.shift(); }
          const ua = req.headers['user-agent'] || '';
          pushEvent(t, { type: 'view', d: deviceFromUA(ua), b: browserFromUA(ua), v: vid.slice(0, 6) });
          db.save(t);
        }
      }
      const base = {
        id: t.id, state, title: t.title, senderName: t.senderName, createdAt: t.createdAt, expiresAt: t.expiresAt,
        totalSize: t.totalSize, fileCount: t.files.length, pinRequired: !!t.pin, locked: !unlocked,
        downloadsLeft: t.maxDownloads ? Math.max(0, t.maxDownloads - t.stats.recipients.length) : null,
        direct: !!storage.direct, playback: t.playback || 'off', allowComments: !!t.allowComments,
        senderVerified: !!t.senderVerified && !!t.senderEmail, reported: t.disabledBy === 'reports'
      };
      // Habillage de l'expéditeur vérifié (nom, logo, couleur), jamais sur un lien signalé
      if (base.senderVerified && !base.reported && t.brandPid && ctx.profiles) base.brand = await ctx.profiles.brandFor(t.brandPid);
      if (unlocked && (state === 'ready' || state === 'limit')) {
        base.message = t.message;
        base.files = t.files.filter(f => f.done).map(fileView);
        base.alreadyRecipient = t.stats.recipients.includes(visitorOf(req));
        if (t.playback === 'only') base.watermark = t.watermark || `${t.senderName || 'Lestha Send'} · ${t.id}`;
        else if (t.watermark) base.watermark = t.watermark;
        if (t.allowComments) { base.comments = (t.comments || []).slice(-500); base.reviews = reviewsOf(t); }
      }
      res.json(base);
    } catch (e) { next(e); }
  });

  router.post('/public/t/:id/unlock', async (req, res, next) => {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Lien introuvable.');
      if (!pinLimit(clientIp(req) + ':' + t.id)) return fail(res, 429, 'Trop de tentatives. Patientez 15 minutes.');
      // Verrou par lien, quelle que soit l'adresse : empêche de deviner un PIN depuis de nombreuses connexions
      t.pinFailLog = (t.pinFailLog || []).filter(ts => Date.now() - ts < HOUR);
      if (t.pin && t.pinFailLog.length >= PIN_LOCK_FAILS) return fail(res, 429, 'Ce lien est verrouillé pendant une heure après trop de codes erronés.');
      if (!checkPin(String(req.body.pin || ''), t.pin)) {
        t.pinFailLog.push(Date.now());
        t.stats.failedPins = (t.stats.failedPins || 0) + 1;
        pushEvent(t, { type: 'pin_fail', d: deviceFromUA(req.headers['user-agent']) });
        db.save(t);
        return fail(res, 403, 'Code PIN incorrect.');
      }
      res.json({ token: signer.sign({ id: t.id, pv: t.pinVersion, exp: Date.now() + 12 * HOUR }) });
    } catch (e) { next(e); }
  });

  /** Signalement d'un envoi abusif : désactivation automatique après plusieurs signalements distincts */
  router.post('/public/t/:id/report', async (req, res, next) => {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Lien introuvable.');
      if (!reportLimit(clientIp(req))) return fail(res, 429, 'Trop de signalements depuis cette connexion.');
      const by = security ? security.ipHash(clientIp(req)) : sha256(clientIp(req)).slice(0, 24);
      const reason = String((req.body && req.body.reason) || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
      t.reports = t.reports || [];
      const fresh = !t.reports.some(r => r.by === by);
      if (fresh) t.reports.push({ by, at: Date.now(), reason });
      if (t.reports.length > 50) t.reports.splice(0, t.reports.length - 50);
      let disabledNow = false;
      // Un expéditeur à l'adresse vérifiée est identifiable : il faut deux fois plus de signalements pour suspendre son lien
      const threshold = t.senderVerified ? REPORT_THRESHOLD * 2 : REPORT_THRESHOLD;
      if (t.reports.length >= threshold && !t.disabled) { t.disabled = true; t.disabledBy = 'reports'; disabledNow = true; }
      if (fresh) pushEvent(t, { type: 'report', n: t.reports.length });
      await db.save(t, 0);
      if (fresh && env.ADMIN_EMAIL && mailer.enabled) {
        mailer.send({
          to: env.ADMIN_EMAIL, subject: `Signalement ${disabledNow ? '(lien désactivé) ' : ''}— ${titleOf(t)}`,
          text: `Le transfert ${t.id} (« ${titleOf(t)} ») a reçu un signalement (${t.reports.length} au total).${disabledNow ? '\nIl a été désactivé automatiquement.' : ''}\nMotif : ${reason || 'non précisé'}\nLien : ${shareLink(req, t)}`,
          html: mailer.simple ? mailer.simple({ title: disabledNow ? 'Lien suspendu après signalements' : 'Nouveau signalement', paragraphs: [`Le transfert <strong>${mailer.esc(titleOf(t))}</strong> (${t.id}) a reçu un signalement, ${t.reports.length} au total.`, `Motif : ${mailer.esc(reason || 'non précisé')}`].concat(disabledNow ? ['Il a été <strong>désactivé automatiquement</strong>. Vous pouvez le réactiver depuis la console si le signalement est infondé.'] : []), action: { href: shareLink(req, t), label: 'Voir le lien' } }) : undefined
        }).catch(e => console.error('report mail', e.message));
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  async function guardDownload(req, res) {
    const t = await db.get(req.params.id);
    if (!t || t.deleted) { fail(res, 404, 'Ce lien n\'existe plus.'); return null; }
    const state = publicState(t);
    if (state === 'expired') { fail(res, 410, 'Ce transfert a expiré.'); return null; }
    if (state === 'disabled') { fail(res, 403, t.disabledBy === 'reports' ? 'Ce transfert a été suspendu après des signalements.' : 'Ce transfert a été désactivé par l\'expéditeur.'); return null; }
    if (state === 'uploading') { fail(res, 409, 'Transfert en cours d\'envoi.'); return null; }
    if (!hasAccess(req, t)) { fail(res, 401, 'Code PIN requis.'); return null; }
    const vid = visitorOf(req);
    if (state === 'limit' && !t.stats.recipients.includes(vid)) { fail(res, 410, 'Limite de téléchargements atteinte.'); return null; }
    return { t, vid };
  }

  function countDownload(req, t, vid, type, file) {
    const firstEver = t.stats.downloads + t.stats.zipDownloads === 0;
    if (type === 'zip') t.stats.zipDownloads++; else t.stats.downloads++;
    if (file) t.stats.perFile[file.id] = (t.stats.perFile[file.id] || 0) + 1;
    t.stats.bytesOut += file ? file.size : t.totalSize;
    if (!t.stats.recipients.includes(vid)) {
      t.stats.recipients.push(vid);
      if (t.maxDownloads && t.stats.recipients.length >= t.maxDownloads) t.purgeAt = Date.now() + GRACE_AFTER_LIMIT;
    }
    const ua = req.headers['user-agent'] || '';
    pushEvent(t, { type, f: file ? (file.path || file.name) : null, d: deviceFromUA(ua), b: browserFromUA(ua), v: vid.slice(0, 6) });
    db.save(t);
    if (firstEver && t.notifyOnDownload && t.senderEmail && mailer.enabled) {
      mailer.send({ to: t.senderEmail, ...mailer.downloadNotice({ t, manageLink: manageLink(req, t), fileName: file ? file.name : null, device: deviceFromUA(ua) }) })
        .catch(e => console.error('notify', e.message));
    }
  }

  /** Téléchargement d'un fichier : redirection vers R2 (reprise native) ou flux local avec Range */
  router.get('/public/t/:id/f/:fid', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      const f = t.files.find(x => x.id === req.params.fid);
      if (!f || !f.done) return fail(res, 404, 'Fichier introuvable.');
      const requestedInline = req.query.inline === '1';
      const delivery = fileDelivery(requestedInline, f.type);
      const inline = delivery.inline;
      if (t.playback === 'only' && !inline) return fail(res, 403, 'Ce transfert est en visionnage seul : le bouton de téléchargement est désactivé.');
      const filename = f.name;
      if (!inline && req.method !== 'HEAD') {
        const range = req.headers.range;
        const isResume = range && !/^bytes=0-/.test(range);
        if (!isResume) countDownload(req, t, vid, 'download', f);
      }
      if (storage.direct) {
        const url = await storage.presignGet(f.key, { filename, inline, contentType: delivery.contentType, expiresIn: t.playback === 'only' ? 3 * 3600 : 12 * 3600 });
        res.set('Cache-Control', 'no-store');
        return res.redirect(302, url);
      }
      res.set('Content-Disposition', contentDisposition(filename, inline));
      res.set('Cache-Control', 'private, no-transform');
      res.type(delivery.contentType);
      return res.sendFile(storage.pathFor(f.key), { acceptRanges: true, lastModified: true, dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) { next(e); }
  });

  /** Progression de visionnage (appelée par le lecteur toutes les ~15 s) */
  const commentLimit = rateLimiter({ windowMs: 10 * 60e3, max: 30 });
  router.post('/public/t/:id/watch', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      const f = t.files.find(x => x.id === req.body.fid);
      if (!f) return fail(res, 404, 'Fichier introuvable.');
      const pct = Math.max(0, Math.min(100, Math.round(Number(req.body.pct) || 0)));
      t.stats.watch = t.stats.watch || {};
      const w = t.stats.watch[f.id] = t.stats.watch[f.id] || {};
      const prev = w[vid];
      if (prev === undefined && Object.keys(w).length >= 2000) return res.json({ ok: true });
      w[vid] = Math.max(prev || 0, pct);
      const ua = req.headers['user-agent'] || '';
      const base = { f: f.path || f.name, d: deviceFromUA(ua), b: browserFromUA(ua), v: vid.slice(0, 6) };
      if (prev === undefined) pushEvent(t, Object.assign({ type: 'play' }, base));
      for (const m of [25, 50, 75, 95]) if ((prev || 0) < m && pct >= m) pushEvent(t, Object.assign({ type: 'watch', p: m }, base));
      db.save(t);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /** Commentaires horodatés (validation de montage, retours clients…) */
  router.post('/public/t/:id/comments', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      if (!t.allowComments) return fail(res, 403, 'Les commentaires sont désactivés pour ce transfert.');
      if (!commentLimit(clientIp(req))) return fail(res, 429, 'Trop de commentaires, patientez quelques minutes.');
      const f = t.files.find(x => x.id === req.body.fid);
      const text = String(req.body.text || '').trim().slice(0, 500);
      if (!f || !text) return fail(res, 400, 'Commentaire vide.');
      const c = { id: randomId(8), fid: f.id, time: Math.max(0, Math.min(1e6, Number(req.body.time) || 0)), text, name: String(req.body.name || '').trim().slice(0, 60) || 'Anonyme', at: Date.now(), v: vid.slice(0, 6) };
      const parent = req.body.parent ? (t.comments || []).find(x => x.id === req.body.parent && !x.parent) : null;
      if (req.body.parent && !parent) return fail(res, 404, 'Commentaire d\'origine introuvable.');
      if (parent) { c.parent = parent.id; c.fid = parent.fid; c.time = parent.time; }
      else {
        const end = Number(req.body.end);
        if (isFinite(end) && end > c.time + 0.04) c.end = Math.min(1e6, end);
        const draw = cleanDraw(req.body.draw); if (draw) c.draw = draw;
      }
      t.comments = t.comments || [];
      t.comments.push(c);
      if (t.comments.length > 1000) t.comments.shift();
      pushEvent(t, { type: 'comment', f: f.path || f.name, p: Math.round(c.time), n: c.name, d: deviceFromUA(req.headers['user-agent']) });
      if (io) io.to('owner:' + t.id).emit('transfer-comment', { id: t.id, comment: c });
      db.save(t);
      res.json({ ok: true, comment: c, comments: t.comments.slice(-500) });
    } catch (e) { next(e); }
  });

  /** Relecteur : marquer une remarque comme traitée */
  router.post('/public/t/:id/comments/:cid/resolve', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t } = g;
      if (!t.allowComments) return fail(res, 403, 'Les commentaires sont désactivés.');
      const c = (t.comments || []).find(x => x.id === req.params.cid && !x.parent);
      if (!c) return fail(res, 404, 'Commentaire introuvable.');
      c.resolved = !!req.body.resolved; c.resolvedBy = c.resolved ? (String(req.body.name || '').trim().slice(0, 60) || 'Anonyme') : null;
      if (io) io.to('owner:' + t.id).emit('transfer-comment', { id: t.id, comment: c });
      db.save(t);
      res.json({ ok: true, comments: t.comments.slice(-500) });
    } catch (e) { next(e); }
  });

  /** Décision de validation : approuvé / modifications demandées */
  const reviewLimit = rateLimiter({ windowMs: 10 * 60e3, max: 20 });
  router.post('/public/t/:id/review', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      if (!t.allowComments) return fail(res, 403, 'La revue est désactivée pour ce transfert.');
      if (!reviewLimit(clientIp(req))) return fail(res, 429, 'Trop de demandes, patientez quelques minutes.');
      const f = t.files.find(x => x.id === req.body.fid && x.done);
      const status = ['approved', 'changes', 'pending'].includes(req.body.status) ? req.body.status : null;
      if (!f || !status) return fail(res, 400, 'Décision invalide.');
      const name = String(req.body.name || '').trim().slice(0, 60) || 'Anonyme';
      t.reviews = t.reviews || {};
      const m = t.reviews[f.id] = t.reviews[f.id] || {};
      if (status === 'pending') delete m[vid.slice(0, 8)]; else m[vid.slice(0, 8)] = { name, status, at: Date.now() };
      pushEvent(t, { type: 'review', f: f.path || f.name, n: name, s: status });
      if (io) io.to('owner:' + t.id).emit('transfer-review', { id: t.id, fid: f.id, name, status });
      db.save(t);
      if (status !== 'pending' && t.senderEmail && mailer.enabled) {
        const verdict = status === 'approved' ? '✅ Approuvé' : '✏️ Modifications demandées';
        const open = (t.comments || []).filter(c => c.fid === f.id && !c.parent && !c.resolved).length;
        const html = mailer.simple({ title: verdict, paragraphs: [`<strong>${esc(name)}</strong> a rendu sa décision sur <strong>${esc(f.name)}</strong>${f.v ? ' (V' + f.v + ')' : ''}.`, `${open} remarque(s) non traitée(s).`], action: { href: manageLink(req, t), label: 'Ouvrir le suivi' } });
        mailer.send({ to: t.senderEmail, subject: `${verdict} — ${f.name}`, html, text: `${name} : ${verdict} sur ${f.name}. ${open} remarque(s) non traitée(s).\n${manageLink(req, t)}` })
          .catch(e => console.error('review mail', e.message));
      }
      res.json({ ok: true, reviews: reviewsOf(t) });
    } catch (e) { next(e); }
  });

  /** Rafraîchissement léger de la revue (commentaires + décisions), sans compter de visite */
  router.get('/public/t/:id/review', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t } = g;
      if (!t.allowComments) return res.json({ comments: [], reviews: {} });
      res.json({ comments: (t.comments || []).slice(-500), reviews: reviewsOf(t), files: t.files.filter(f => f.done).map(fileView) });
    } catch (e) { next(e); }
  });

  /** Tout télécharger en ZIP (flux, sans compression, ZIP64 pour > 4 Go) */
  router.get('/public/t/:id/zip', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      if (t.playback === 'only') return fail(res, 403, 'Ce transfert est en visionnage seul.');
      countDownload(req, t, vid, 'zip', null);
      const zipName = (t.title || (t.files.length === 1 ? t.files[0].name : 'lestha-send-' + t.id)).replace(/[\\/:*?"<>|]+/g, '_') + '.zip';
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', contentDisposition(zipName));
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no');
      const archive = archiver('zip', { store: true, forceZip64: t.totalSize > 3.5 * GB });
      archive.on('warning', (e) => console.warn('zip', e.message));
      archive.on('error', (e) => { console.error('zip', e.message); res.destroy(e); });
      res.on('close', () => { if (!res.writableFinished) archive.abort(); });
      archive.pipe(res);
      const used = new Set();
      for (const f of t.files) {
        if (res.destroyed) break;
        if (!f.done) continue;
        let name = (f.versionOf ? `V${f.v} - ` : '') + (f.path || f.name).replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
        while (used.has(name)) name = name.replace(/(\.[^./]+)?$/, (m) => ' (2)' + (m || ''));
        used.add(name);
        const stream = await storage.getStream(f.key);
        await new Promise((resolve, reject) => {
          archive.once('entry', resolve);
          stream.once('error', reject);
          archive.append(stream, { name, date: f.lastModified ? new Date(f.lastModified) : new Date() });
        });
      }
      await archive.finalize();
    } catch (e) { if (!res.headersSent) next(e); else res.destroy(); }
  });

  /* ---------------- driver local : réception d'un morceau ---------------- */
  if (!storage.direct) {
    app.put('/api/local/part', async (req, res) => {
      const tk = signer.verify(req.query.tk);
      if (!tk) return fail(res, 403, 'URL d\'upload expirée ou invalide.');
      try {
        const etag = await storage.writePart(tk.k, tk.u, tk.p, tk.o, tk.s, req);
        res.set('ETag', etag).status(200).end();
      } catch (e) { fail(res, e.status || 500, e.message); }
    });
  }

  /* ---------------- nettoyage automatique ---------------- */
  async function cleanup() {
    const now = Date.now();
    let ids = [];
    try { ids = await db.listIds(); } catch (e) { return console.error('cleanup list', e.message); }
    let used = 0;
    for (const id of ids) {
      try {
        const t = await db.get(id);
        if (!t) continue;
        const dead = now > t.expiresAt + HOUR || (t.purgeAt && now > t.purgeAt) || t.deleted;
        if (!dead) { used += t.totalSize || 0; db.release && db.release(id); continue; }
        await deleteTransfer(t, 'expiration');
        console.log('🧹 Transfert supprimé :', id);
      } catch (e) { console.error('cleanup', id, e.message); }
    }
    storedBytes = used;
  }
  setTimeout(cleanup, 15000).unref();
  setInterval(cleanup, 10 * 60 * 1000).unref();

  /* ---------------- live : le tableau de bord suit ses transferts ---------------- */
  if (io) {
    io.on('connection', (socket) => {
      socket.on('watch-transfers', async (items, cb) => {
        const ok = [];
        for (const { id, key } of (Array.isArray(items) ? items.slice(0, 200) : [])) {
          const t = await db.get(id).catch(() => null);
          if (t && key && safeEqual(sha256(key), t.ownerHash)) { socket.join('owner:' + id); ok.push(id); }
        }
        if (typeof cb === 'function') cb({ ok });
      });
    });
  }

  app.use('/api', router);
  return { cleanup, publicState, statsOf, titleOf, deleteTransfer, limitReached, createTransfer, summaryView, pushEvent, MAX_TTL, tierOf, takeDaily, refundDaily, storedBytes: () => storedBytes };
}

module.exports = { mountCloud, partSizeFor };
