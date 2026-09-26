'use strict';
/**
 * « Demande de fichiers » : un lien de dépôt pour que d'autres vous envoient leurs fichiers
 * (rendus d'apprenants, rushes, pièces d'un dossier…).
 * Chaque dépôt devient un transfert Cloud classique qui APPARTIENT au créateur de la demande :
 * le déposant reçoit seulement une clé d'envoi, jamais la clé de gestion.
 */
const express = require('express');
const { randomId, randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter, clientIp, deviceFromUA, browserFromUA } = require('./util');
const { createDb } = require('./db');

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3;

function mountRequests(app, { env, storage, db, mailer, signer, io, ctx, cloud }) {
  const rdb = createDb(storage, 'requests/');
  const r = express.Router();
  const fail = (res, s, error, extra) => res.status(s).json(Object.assign({ error }, extra || {}));
  const createLimit = rateLimiter({ windowMs: HOUR, max: 30 });
  const depositLimit = rateLimiter({ windowMs: HOUR, max: 40 });
  const pinLimit = rateLimiter({ windowMs: 15 * 60e3, max: 8 });
  const base = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  const salt = env.APP_SECRET || 'transferx';
  const visitor = (req) => sha256(String(req.query.v || req.body?.v || clientIp(req)) + salt).slice(0, 16);

  const stateOf = (q) => (Date.now() > q.expiresAt ? 'expired' : q.closed ? 'closed' : 'open');
  function pushEvent(q, ev) {
    ev.t = Date.now();
    q.events.push(ev);
    if (q.events.length > 1000) q.events.shift();
    if (io) io.to('owner:' + q.id).emit('request-event', { id: q.id, event: ev, deposits: q.deposits.filter(d => d.status === 'ready').length });
  }

  async function loadOwner(req, res, next) {
    try {
      const q = await rdb.get(req.params.id);
      if (!q) return fail(res, 404, 'Demande introuvable ou expirée.');
      const key = req.get('x-owner-key') || req.query.key;
      if (!key || !safeEqual(sha256(key), q.ownerHash)) return fail(res, 403, 'Clé de gestion invalide.');
      req.q = q; next();
    } catch (e) { next(e); }
  }
  const hasAccess = (req, q) => {
    if (!q.pin) return true;
    const tok = signer.verify(req.get('x-access-token') || req.query.tk);
    return !!(tok && tok.rid === q.id && tok.pv === q.pinVersion);
  };

  async function ownerView(q, req) {
    const deposits = await Promise.all(q.deposits.slice().reverse().map(async d => {
      const t = await db.get(d.id).catch(() => null);
      return Object.assign({}, d, {
        state: t ? cloud.publicState(t) : 'deleted', link: `${base(req)}/t/${d.id}`,
        downloads: t ? t.stats.downloads + t.stats.zipDownloads : 0, expiresAt: t ? t.expiresAt : null,
        files: t ? t.files.map(f => ({ id: f.id, name: f.name, path: f.path, size: f.size, type: f.type, done: !!f.done })) : []
      });
    }));
    return {
      id: q.id, kind: 'request', title: q.title, message: q.message, ownerName: q.ownerName, ownerEmail: q.ownerEmail,
      notify: !!q.notify, createdAt: q.createdAt, expiresAt: q.expiresAt, state: stateOf(q), closed: !!q.closed,
      pinEnabled: !!q.pin, maxBytes: q.maxBytes, depositTtl: q.depositTtl, link: `${base(req)}/d/${q.id}`,
      stats: { views: q.stats.views, visitors: q.stats.visitors.length }, events: q.events.slice(-300), deposits
    };
  }

  /* ---------- création ---------- */
  r.post('/requests', async (req, res, next) => {
    try {
      const admin = ctx.isAdmin && ctx.isAdmin(req);
      if (ctx.cloudEnabled === false) return fail(res, 503, 'Mode Cloud indisponible : le stockage R2 n\'est pas configuré.');
      if (!admin && ctx.security && ctx.security.isBlockedIp(clientIp(req))) return fail(res, 403, 'Action bloquée depuis cette connexion.');
      if (!admin && env.UPLOAD_CODE && !safeEqual(String(req.get('x-upload-code') || ''), env.UPLOAD_CODE)) return fail(res, 401, 'Code d\'accès requis.', { needCode: true });
      if (!admin && !createLimit(clientIp(req))) return fail(res, 429, 'Trop de demandes créées. Réessayez plus tard.');
      const b = req.body || {};
      const pin = b.pin ? String(b.pin) : null;
      if (pin && !/^\d{4,8}$/.test(pin)) return fail(res, 400, 'PIN : 4 à 8 chiffres.');
      const maxTtl = cloud.MAX_TTL;
      const ownerKey = randomKey(24);
      const q = {
        id: randomId(10), ownerHash: sha256(ownerKey), createdAt: Date.now(),
        expiresAt: Date.now() + Math.min(Math.max(Number(b.ttl) || 7 * DAY, HOUR), maxTtl),
        title: String(b.title || '').trim().slice(0, 140) || 'Déposez vos fichiers',
        message: String(b.message || '').slice(0, 1500), ownerName: String(b.ownerName || '').slice(0, 80),
        ownerEmail: isEmail(b.ownerEmail) ? String(b.ownerEmail).slice(0, 200) : '', notify: !!b.notify,
        pin: pin ? hashPin(pin) : null, pinVersion: 1,
        maxBytes: Math.min(Math.max(Number(b.maxBytes) || 10 * GB, 10 * 1024 * 1024), (Number(env.MAX_TRANSFER_GB) || 250) * GB),
        depositTtl: Math.min(Math.max(Number(b.depositTtl) || 30 * DAY, DAY), maxTtl),
        closed: false, deposits: [], events: [], stats: { views: 0, visitors: [] }
      };
      await rdb.save(q, 0);
      if (io) io.to('admin').emit('admin-event', { id: q.id, title: q.title, event: { t: Date.now(), type: 'request_created' } });
      res.json({ id: q.id, ownerKey, link: `${base(req)}/d/${q.id}`, manageLink: `${base(req)}/r/${q.id}#${ownerKey}`, expiresAt: q.expiresAt });
    } catch (e) { next(e); }
  });

  /* ---------- gestion ---------- */
  r.get('/requests/:id', loadOwner, async (req, res, next) => { try { res.json(await ownerView(req.q, req)); } catch (e) { next(e); } });

  r.patch('/requests/:id', loadOwner, async (req, res, next) => {
    try {
      const q = req.q, b = req.body || {};
      if ('closed' in b) { q.closed = !!b.closed; pushEvent(q, { type: q.closed ? 'closed' : 'opened' }); }
      if (b.extendMs) q.expiresAt = Math.min(Math.max(q.expiresAt, Date.now()) + Math.min(Number(b.extendMs) || 0, cloud.MAX_TTL), Date.now() + cloud.MAX_TTL);
      if ('title' in b) q.title = String(b.title || '').slice(0, 140) || q.title;
      if ('message' in b) q.message = String(b.message || '').slice(0, 1500);
      if ('notify' in b) q.notify = !!b.notify;
      if ('ownerEmail' in b) q.ownerEmail = isEmail(b.ownerEmail) ? String(b.ownerEmail) : '';
      if ('maxBytes' in b && Number(b.maxBytes) > 0) q.maxBytes = Math.min(Number(b.maxBytes), (Number(env.MAX_TRANSFER_GB) || 250) * GB);
      if ('pin' in b) {
        if (!b.pin) q.pin = null;
        else if (/^\d{4,8}$/.test(String(b.pin))) q.pin = hashPin(String(b.pin));
        else return fail(res, 400, 'PIN : 4 à 8 chiffres.');
        q.pinVersion++;
      }
      await rdb.save(q, 0);
      res.json(await ownerView(q, req));
    } catch (e) { next(e); }
  });

  r.delete('/requests/:id', loadOwner, async (req, res, next) => {
    try {
      const q = req.q;
      for (const d of q.deposits) { const t = await db.get(d.id).catch(() => null); if (t) await cloud.deleteTransfer(t, 'owner'); }
      await rdb.remove(q.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/owner/requests-summary', async (req, res, next) => {
    try {
      const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 200);
      res.json({
        items: await Promise.all(items.map(async ({ id, key }) => {
          const q = await rdb.get(id).catch(() => null);
          if (!q || !key || !safeEqual(sha256(key), q.ownerHash)) return { id, gone: true };
          const ready = q.deposits.filter(d => d.status === 'ready');
          return {
            id: q.id, kind: 'request', title: q.title, createdAt: q.createdAt, expiresAt: q.expiresAt, state: stateOf(q),
            deposits: ready.length, totalSize: ready.reduce((s, d) => s + (d.size || 0), 0), fileCount: ready.reduce((s, d) => s + (d.files || 0), 0),
            pinEnabled: !!q.pin, stats: { views: q.stats.views, uniqueVisitors: q.stats.visitors.length, downloads: 0 },
            events: q.events.slice(-200).map(e => ({ t: e.t, type: e.type === 'deposit' ? 'download' : e.type === 'view' ? 'view' : e.type, n: e.n }))
          };
        }))
      });
    } catch (e) { next(e); }
  });

  /* ---------- côté déposant ---------- */
  r.get('/public/d/:id', async (req, res, next) => {
    try {
      const q = await rdb.get(req.params.id);
      if (!q) return fail(res, 404, 'Ce lien de dépôt n\'existe pas ou a expiré.');
      const state = stateOf(q);
      if (state === 'open' && req.query.v) {
        const vid = visitor(req);
        if (!q.stats.visitors.includes(vid)) {
          q.stats.visitors.push(vid); if (q.stats.visitors.length > 3000) q.stats.visitors.shift();
          q.stats.views++;
          pushEvent(q, { type: 'view', d: deviceFromUA(req.headers['user-agent']), b: browserFromUA(req.headers['user-agent']) });
          rdb.save(q);
        }
      }
      res.json({
        id: q.id, state, title: q.title, ownerName: q.ownerName, expiresAt: q.expiresAt, maxBytes: q.maxBytes,
        pinRequired: !!q.pin, locked: !hasAccess(req, q), message: hasAccess(req, q) ? q.message : ''
      });
    } catch (e) { next(e); }
  });

  r.post('/public/d/:id/unlock', async (req, res, next) => {
    try {
      const q = await rdb.get(req.params.id);
      if (!q) return fail(res, 404, 'Lien introuvable.');
      if (!pinLimit(clientIp(req) + ':' + q.id)) return fail(res, 429, 'Trop de tentatives. Patientez 15 minutes.');
      if (!checkPin(String(req.body.pin || ''), q.pin)) { pushEvent(q, { type: 'pin_fail' }); rdb.save(q); return fail(res, 403, 'Code incorrect.'); }
      res.json({ token: signer.sign({ rid: q.id, pv: q.pinVersion, exp: Date.now() + 12 * HOUR }) });
    } catch (e) { next(e); }
  });

  r.post('/public/d/:id/deposit', async (req, res, next) => {
    try {
      const q = await rdb.get(req.params.id);
      if (!q) return fail(res, 404, 'Lien introuvable.');
      const st = stateOf(q);
      if (st === 'expired') return fail(res, 410, 'Ce lien de dépôt a expiré.');
      if (st === 'closed') return fail(res, 403, 'Les dépôts sont fermés pour ce lien.');
      if (!hasAccess(req, q)) return fail(res, 401, 'Code requis.');
      if (ctx.cloudEnabled === false) return fail(res, 503, 'Stockage indisponible.');
      if (ctx.security && ctx.security.isBlockedIp(clientIp(req))) return fail(res, 403, 'Dépôt bloqué depuis cette connexion.');
      if (!depositLimit(clientIp(req))) return fail(res, 429, 'Trop de dépôts depuis cette connexion. Réessayez plus tard.');
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) return fail(res, 400, 'Indiquez votre nom.');
      const out = await cloud.createTransfer(req, {
        files: b.files, title: `Dépôt de ${name}`, senderName: name, message: String(b.message || '').slice(0, 1500), maxBytes: q.maxBytes
      }, { ownerHash: q.ownerHash, uploadKey: true, requestId: q.id, ttl: q.depositTtl });
      if (out.error) return fail(res, out.status || 400, out.error);
      const t = out.t;
      q.deposits.push({ id: t.id, name, message: String(b.message || '').slice(0, 1500), at: Date.now(), size: t.totalSize, files: t.files.length, status: 'uploading' });
      if (q.deposits.length > 2000) q.deposits.shift();
      await rdb.save(q, 0);
      res.json({ transferId: t.id, uploadKey: out.uploadKey, files: t.files.map(f => ({ id: f.id, partSize: f.partSize, partCount: f.partCount, done: f.done })) });
    } catch (e) { next(e); }
  });

  /* ---------- un dépôt vient d'être finalisé ---------- */
  ctx.onDeposit = async (t, req) => {
    try {
      const q = await rdb.get(t.requestId);
      if (!q) return;
      const d = q.deposits.find(x => x.id === t.id);
      if (d) { d.status = 'ready'; d.size = t.totalSize; d.files = t.files.length; d.readyAt = Date.now(); }
      const ua = req.headers['user-agent'] || '';
      pushEvent(q, { type: 'deposit', n: t.senderName, f: t.files.length + ' fichier(s)', size: t.totalSize, tid: t.id, d: deviceFromUA(ua), b: browserFromUA(ua) });
      await rdb.save(q, 0);
      if (io) io.to('admin').emit('admin-event', { id: t.id, title: q.title, event: { t: Date.now(), type: 'deposit', n: t.files.length, size: t.totalSize } });
      if (q.notify && q.ownerEmail && mailer.enabled) {
        const link = `${base(req)}/r/${q.id}`;
        mailer.send({
          to: q.ownerEmail, subject: `📥 Nouveau dépôt de ${t.senderName} — ${q.title}`,
          text: `${t.senderName} a déposé ${t.files.length} fichier(s) dans « ${q.title} ».\nVoir les dépôts : ${link}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#0b1220;color:#e2e8f0;border-radius:16px"><h2 style="margin:0 0 12px">Nouveau dépôt 📥</h2><p><b>${t.senderName.replace(/</g, '&lt;')}</b> a déposé <b>${t.files.length} fichier(s)</b> dans « ${q.title.replace(/</g, '&lt;')} ».</p><p style="margin:20px 0"><a href="${link}" style="background:linear-gradient(90deg,#00b4d8,#06d6a0);color:#04121f;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Voir les dépôts</a></p></div>`
        }).catch(e => console.error('notify deposit', e.message));
      }
    } catch (e) { console.error('onDeposit', e.message); }
  };

  /* ---------- temps réel + nettoyage ---------- */
  if (io) io.on('connection', (socket) => {
    socket.on('watch-requests', async (items, cb) => {
      const ok = [];
      for (const { id, key } of (Array.isArray(items) ? items.slice(0, 100) : [])) {
        const q = await rdb.get(id).catch(() => null);
        if (q && key && safeEqual(sha256(key), q.ownerHash)) { socket.join('owner:' + id); ok.push(id); }
      }
      if (typeof cb === 'function') cb({ ok });
    });
  });

  async function cleanup() {
    try {
      for (const id of await rdb.listIds()) {
        const q = await rdb.get(id);
        if (q && Date.now() > q.expiresAt + q.depositTtl + DAY) await rdb.remove(id);   // les dépôts ont leur propre expiration
      }
    } catch (e) { console.error('requests cleanup', e.message); }
  }
  setTimeout(cleanup, 30000).unref();
  setInterval(cleanup, 60 * 60e3).unref();

  app.use('/api', r);
  return { rdb };
}

module.exports = { mountRequests };
