'use strict';
/**
 * Transferts "Cloud" : les fichiers sont déposés sur R2 (ou disque) → le lien reste
 * valide même quand l'expéditeur ferme l'application. Upload multipart parallèle et
 * reprenable, téléchargement direct avec reprise (HTTP Range), ZIP en streaming.
 */
const express = require('express');
const archiver = require('archiver');
const { randomId, randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter, clientIp, deviceFromUA, browserFromUA, cleanName } = require('./util');
const { contentDisposition } = require('./storage');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function partSizeFor(size) {
  const base = 8 * MB;                         // 8 Mo : reprise fine sur réseaux mobiles lents
  if (size <= base * 9000) return base;        // jusqu'à ~70 Go avec des morceaux de 8 Mo
  return Math.ceil(size / 9000 / MB) * MB;     // au-delà : morceaux plus gros (limite S3 = 10 000)
}

function mountCloud(app, { storage, db, mailer, signer, io, env }) {
  const router = express.Router();
  const MAX_TRANSFER = (Number(env.MAX_TRANSFER_GB) || 250) * GB;
  const MAX_FILES = Number(env.MAX_FILES) || 10000;
  const MAX_TTL = (Number(env.MAX_TTL_DAYS) || 30) * DAY;
  const GRACE_AFTER_LIMIT = 6 * HOUR;          // reprise possible après la limite de téléchargements
  const createLimit = rateLimiter({ windowMs: HOUR, max: Number(env.MAX_TRANSFERS_PER_HOUR) || 60 });
  const pinLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
  const mailLimit = rateLimiter({ windowMs: HOUR, max: 40 });
  const fileLocks = new Map();

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

  function ownerView(t, req) {
    return {
      id: t.id, title: t.title, message: t.message, senderName: t.senderName, senderEmail: t.senderEmail,
      notifyOnDownload: !!t.notifyOnDownload, createdAt: t.createdAt, finalizedAt: t.finalizedAt || null,
      expiresAt: t.expiresAt, status: t.status, state: publicState(t), disabled: !!t.disabled,
      pinEnabled: !!t.pin, maxDownloads: t.maxDownloads || null, totalSize: t.totalSize, fileCount: t.files.length,
      files: t.files.map(f => ({ id: f.id, name: f.name, path: f.path, size: f.size, type: f.type, done: !!f.done, partSize: f.partSize, partCount: f.partCount, downloads: t.stats.perFile[f.id] || 0 })),
      stats: {
        views: t.stats.views, uniqueVisitors: t.stats.visitors.length, downloads: t.stats.downloads,
        zipDownloads: t.stats.zipDownloads, recipients: t.stats.recipients.length, bytesOut: t.stats.bytesOut,
        failedPins: t.stats.failedPins || 0, lastActivity: t.stats.lastActivity || null
      },
      events: t.stats.events.slice(-300),
      emails: (t.emails || []).slice(-50),
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
    if (io) io.to('owner:' + t.id).emit('transfer-event', { id: t.id, event: ev, stats: statsOf(t), state: publicState(t) });
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
    res.json({
      driver: storage.name, direct: !!storage.direct, maxTransferBytes: MAX_TRANSFER, maxFiles: MAX_FILES,
      maxTtl: MAX_TTL, email: mailer.enabled, p2p: true, uploadCodeRequired: !!env.UPLOAD_CODE,
      quotaBytes: env.STORAGE_QUOTA_GB ? Number(env.STORAGE_QUOTA_GB) * GB : null
    });
  });

  /* ---------------- création ---------------- */
  router.post('/transfers', async (req, res, next) => {
    try {
      if (env.UPLOAD_CODE && !safeEqual(String(req.get('x-upload-code') || ''), env.UPLOAD_CODE)) return fail(res, 401, 'Code d\'accès à l\'envoi requis.', { needCode: true });
      if (!createLimit(clientIp(req))) return fail(res, 429, 'Trop de transferts créés. Réessayez dans une heure.');
      const b = req.body || {};
      const files = Array.isArray(b.files) ? b.files : [];
      if (!files.length) return fail(res, 400, 'Aucun fichier.');
      if (files.length > MAX_FILES) return fail(res, 400, `Maximum ${MAX_FILES} fichiers par transfert.`);
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
      if (total > MAX_TRANSFER) return fail(res, 400, `Transfert trop volumineux (max ${Math.round(MAX_TRANSFER / GB)} Go).`);
      const ttl = Math.min(Math.max(Number(b.ttl) || 7 * DAY, HOUR), MAX_TTL);
      const pin = b.pin ? String(b.pin) : null;
      if (pin && !/^\d{4,8}$/.test(pin)) return fail(res, 400, 'PIN : 4 à 8 chiffres.');
      const ownerKey = randomKey(24);
      const now = Date.now();
      const t = {
        id, v: 2, ownerHash: sha256(ownerKey), createdAt: now, status: 'uploading', ttl,
        expiresAt: now + 7 * DAY,                       // fenêtre d'upload ; recalculée à la finalisation
        title: String(b.title || '').slice(0, 140), message: String(b.message || '').slice(0, 1500),
        senderName: String(b.senderName || '').slice(0, 80),
        senderEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.senderEmail || '') ? String(b.senderEmail).slice(0, 200) : '',
        notifyOnDownload: !!b.notifyOnDownload,
        pin: pin ? hashPin(pin) : null, pinVersion: 1,
        maxDownloads: b.destroyOnDownload ? 1 : (Number(b.maxDownloads) > 0 ? Math.floor(Number(b.maxDownloads)) : null),
        disabled: false, files: list, totalSize: total,
        stats: { views: 0, downloads: 0, zipDownloads: 0, bytesOut: 0, visitors: [], recipients: [], perFile: {}, events: [], failedPins: 0 },
        emails: []
      };
      // Fichiers vides : créés immédiatement
      for (const f of list) if (f.size === 0) { await storage.putBuffer(f.key, Buffer.alloc(0), f.type); f.done = true; }
      await db.save(t, 0);
      res.json({
        id, ownerKey, link: shareLink(req, t), manageLink: manageLink(req, t, ownerKey),
        files: list.map(f => ({ id: f.id, partSize: f.partSize, partCount: f.partCount, done: f.done }))
      });
    } catch (e) { next(e); }
  });

  /* ---------------- upload : URLs des morceaux ---------------- */
  router.post('/transfers/:id/files/:fid/urls', loadOwner, async (req, res, next) => {
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
  router.get('/transfers/:id/files/:fid/parts', loadOwner, async (req, res, next) => {
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
  router.post('/transfers/:id/files/:fid/complete', loadOwner, async (req, res, next) => {
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
        const sum = parts.filter(p => p.PartNumber <= f.partCount).reduce((s, p) => s + Number(p.Size || 0), 0);
        if (sum !== f.size) throw Object.assign(new Error(`Taille incohérente (${sum} / ${f.size})`), { status: 409, missing: [] });
        await storage.completeMultipart(f.key, f.uploadId, parts.filter(p => p.PartNumber <= f.partCount), f.size);
        f.done = true; f.uploadId = null;
        await db.save(t, 0);
      });
      res.json({ done: true });
    } catch (e) {
      if (e.status === 409) return fail(res, 409, e.message, { missing: e.missing });
      next(e);
    }
  });

  /* ---------------- finalisation du transfert ---------------- */
  router.post('/transfers/:id/finalize', loadOwner, async (req, res, next) => {
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
      }
      const emails = (Array.isArray(req.body.emails) ? req.body.emails : []).map(s => String(s).trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)).slice(0, 20);
      const sent = [];
      if (emails.length && mailer.enabled) {
        for (const to of emails) {
          if (!mailLimit(clientIp(req))) break;
          try { await mailer.send({ to, ...mailer.transferEmail({ t, link: shareLink(req, t), senderName: t.senderName }) }); sent.push(to); t.emails.push({ to, at: Date.now() }); }
          catch (e) { console.error('mail', e.response?.body || e.message); }
        }
        await db.save(t);
      }
      res.json({ ok: true, link: shareLink(req, t), manageLink: manageLink(req, t, req.ownerKey), expiresAt: t.expiresAt, emailed: sent });
    } catch (e) { next(e); }
  });

  /* ---------------- gestion (tableau de bord) ---------------- */
  router.get('/transfers/:id', loadOwner, (req, res) => res.json(ownerView(req.t, req)));

  router.patch('/transfers/:id', loadOwner, async (req, res, next) => {
    try {
      const t = req.t, b = req.body || {};
      if (b.extendMs) {
        const base = Math.max(t.expiresAt, Date.now());
        t.expiresAt = Math.min(base + Math.min(Number(b.extendMs) || 0, MAX_TTL), Date.now() + MAX_TTL);
        pushEvent(t, { type: 'extended' });
      }
      if ('pin' in b) {
        if (b.pin === null || b.pin === '') t.pin = null;
        else if (/^\d{4,8}$/.test(String(b.pin))) t.pin = hashPin(String(b.pin));
        else return fail(res, 400, 'PIN : 4 à 8 chiffres.');
        t.pinVersion = (t.pinVersion || 1) + 1;         // invalide les accès déjà accordés
      }
      if ('maxDownloads' in b) {
        t.maxDownloads = Number(b.maxDownloads) > 0 ? Math.floor(Number(b.maxDownloads)) : null;
        if (!limitReached(t)) delete t.purgeAt;           // limite relevée : on annule la purge programmée
        else if (!t.purgeAt) t.purgeAt = Date.now() + GRACE_AFTER_LIMIT;
      }
      if ('disabled' in b) t.disabled = !!b.disabled;
      if ('title' in b) t.title = String(b.title || '').slice(0, 140);
      if ('message' in b) t.message = String(b.message || '').slice(0, 1500);
      if ('notifyOnDownload' in b) t.notifyOnDownload = !!b.notifyOnDownload;
      if ('senderEmail' in b) t.senderEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.senderEmail || '') ? String(b.senderEmail) : '';
      await db.save(t, 0);
      res.json(ownerView(t, req));
    } catch (e) { next(e); }
  });

  router.delete('/transfers/:id', loadOwner, async (req, res, next) => {
    try {
      const t = req.t;
      for (const f of t.files) if (f.uploadId) await storage.abortMultipart(f.key, f.uploadId);
      await storage.deletePrefix(`files/${t.id}/`);
      await db.remove(t.id);
      if (io) io.to('owner:' + t.id).emit('transfer-deleted', { id: t.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.post('/transfers/:id/email', loadOwner, async (req, res, next) => {
    try {
      const t = req.t;
      if (!mailer.enabled) return fail(res, 503, 'Service e-mail non configuré.');
      if (t.status !== 'ready') return fail(res, 409, 'Transfert pas encore prêt.');
      const emails = (Array.isArray(req.body.emails) ? req.body.emails : [req.body.to]).map(s => String(s || '').trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)).slice(0, 20);
      if (!emails.length) return fail(res, 400, 'Adresse e-mail invalide.');
      const sent = [];
      for (const to of emails) {
        if (!mailLimit(clientIp(req))) return fail(res, 429, 'Trop d\'e-mails envoyés, réessayez plus tard.', { sent });
        await mailer.send({ to, ...mailer.transferEmail({ t, link: shareLink(req, t), senderName: t.senderName }) });
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
        direct: !!storage.direct
      };
      if (unlocked && (state === 'ready' || state === 'limit')) {
        base.message = t.message;
        base.files = t.files.map(f => ({ id: f.id, name: f.name, path: f.path, size: f.size, type: f.type }));
        base.alreadyRecipient = t.stats.recipients.includes(visitorOf(req));
      }
      res.json(base);
    } catch (e) { next(e); }
  });

  router.post('/public/t/:id/unlock', async (req, res, next) => {
    try {
      const t = await db.get(req.params.id);
      if (!t || t.deleted) return fail(res, 404, 'Lien introuvable.');
      if (!pinLimit(clientIp(req) + ':' + t.id)) return fail(res, 429, 'Trop de tentatives. Patientez 15 minutes.');
      if (!checkPin(String(req.body.pin || ''), t.pin)) {
        t.stats.failedPins = (t.stats.failedPins || 0) + 1;
        pushEvent(t, { type: 'pin_fail', d: deviceFromUA(req.headers['user-agent']) });
        db.save(t);
        return fail(res, 403, 'Code PIN incorrect.');
      }
      res.json({ token: signer.sign({ id: t.id, pv: t.pinVersion, exp: Date.now() + 12 * HOUR }) });
    } catch (e) { next(e); }
  });

  async function guardDownload(req, res) {
    const t = await db.get(req.params.id);
    if (!t || t.deleted) { fail(res, 404, 'Ce lien n\'existe plus.'); return null; }
    const state = publicState(t);
    if (state === 'expired') { fail(res, 410, 'Ce transfert a expiré.'); return null; }
    if (state === 'disabled') { fail(res, 403, 'Ce transfert a été désactivé par l\'expéditeur.'); return null; }
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
      const inline = req.query.inline === '1';
      const filename = f.name;
      if (!inline && req.method !== 'HEAD') {
        const range = req.headers.range;
        const isResume = range && !/^bytes=0-/.test(range);
        if (!isResume) countDownload(req, t, vid, 'download', f);
      }
      if (storage.direct) {
        const url = await storage.presignGet(f.key, { filename, inline, contentType: f.type, expiresIn: 12 * 3600 });
        res.set('Cache-Control', 'no-store');
        return res.redirect(302, url);
      }
      res.set('Content-Disposition', contentDisposition(filename, inline));
      res.set('Cache-Control', 'private, no-transform');
      res.type(f.type || 'application/octet-stream');
      return res.sendFile(storage.pathFor(f.key), { acceptRanges: true, lastModified: true, dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    } catch (e) { next(e); }
  });

  /** Tout télécharger en ZIP (flux, sans compression, ZIP64 pour > 4 Go) */
  router.get('/public/t/:id/zip', async (req, res, next) => {
    try {
      const g = await guardDownload(req, res); if (!g) return;
      const { t, vid } = g;
      countDownload(req, t, vid, 'zip', null);
      const zipName = (t.title || (t.files.length === 1 ? t.files[0].name : 'transferx-' + t.id)).replace(/[\\/:*?"<>|]+/g, '_') + '.zip';
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
        let name = (f.path || f.name).replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
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
    for (const id of ids) {
      try {
        const t = await db.get(id);
        if (!t) continue;
        const dead = now > t.expiresAt + HOUR || (t.purgeAt && now > t.purgeAt) || t.deleted;
        if (!dead) continue;
        for (const f of t.files) if (f.uploadId) await storage.abortMultipart(f.key, f.uploadId);
        await storage.deletePrefix(`files/${id}/`);
        await db.remove(id);
        console.log('🧹 Transfert supprimé :', id);
      } catch (e) { console.error('cleanup', id, e.message); }
    }
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
  return { cleanup };
}

module.exports = { mountCloud, partSizeFor };
