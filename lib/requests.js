'use strict';
/**
 * « Demande de fichiers » : un lien de dépôt pour que d'autres vous envoient leurs fichiers
 * (rendus d'apprenants, rushes, pièces d'un dossier…).
 * Chaque dépôt devient un transfert Cloud classique qui APPARTIENT au créateur de la demande :
 * le déposant reçoit seulement une clé d'envoi, jamais la clé de gestion.
 */
const express = require('express');
const { randomId, randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter, clientIp, deviceFromUA, browserFromUA, PIN_RE, PIN_RULE } = require('./util');
const { createDb } = require('./db');
const { kv } = require('./profiles');
const SD = require('./smartdrop');
const archiver = require('archiver');

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3;

function mountRequests(app, { env, storage, db, mailer, signer, io, ctx, cloud }) {
  const rdb = createDb(storage, 'requests/');
  const r = express.Router();
  const fail = (res, s, error, extra) => res.status(s).json(Object.assign({ error }, extra || {}));
  const createLimit = rateLimiter({ windowMs: HOUR, max: 30 });
  const handleLimit = rateLimiter({ windowMs: HOUR, max: 60 });
  const DEPOSITS_PER_DAY = Math.max(1, Number(env.HANDLE_DEPOSITS_PER_DAY) || 100);
  const depositLimit = rateLimiter({ windowMs: HOUR, max: 40 });
  const pinLimit = rateLimiter({ windowMs: 15 * 60e3, max: 8 });
  const base = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
  const salt = env.APP_SECRET || 'transferx';
  const visitor = (req) => sha256(String(req.query.v || req.body?.v || clientIp(req)) + salt).slice(0, 16);

  // Smart Drop : jusqu'à 30 jours (DROP_MAX_DAYS) pour les comptes confirmés, même si un envoi classique est limité à 7 jours
  const DROP_MAX = () => Math.min(cloud.MAX_TTL, (Number(env.DROP_MAX_DAYS) || 30) * DAY);
  const dropMaxFor = (tier) => Math.max(tier.maxTtl, tier.requests ? DROP_MAX() : 0);
  const stateOf = (q) => (q.closed ? 'closed' : !q.permanent && Date.now() > q.expiresAt ? 'expired' : q.maxDeposits && (q.seq || 0) >= q.maxDeposits ? 'full' : 'open');
  const count = (f) => { try { if (ctx.insights && ctx.insights.count) ctx.insights.count(f).catch(() => {}); } catch (e) { /* ignore */ } };
  const MB = 1024 * 1024;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  /** Réglages Smart Drop communs à la création et à la modification */
  function smartOptions(q, b, tier) {
    if ('sector' in b) q.sector = SD.SECTORS.some(x => x.id === b.sector) ? b.sector : 'autre';
    if ('fields' in b) q.fields = SD.cleanFields(b.fields);
    if ('accept' in b) q.accept = SD.cleanAccept(b.accept);
    if ('maxFileBytes' in b) q.maxFileBytes = Math.max(0, Math.min(Number(b.maxFileBytes) || 0, q.maxBytes || Infinity));
    if ('maxDeposits' in b) q.maxDeposits = Math.max(0, Math.min(Math.floor(Number(b.maxDeposits) || 0), 100000));
    if ('color' in b) q.color = COLOR_RE.test(String(b.color || '')) ? String(b.color).toLowerCase() : '';
    if ('contact' in b) q.contact = String(b.contact || '').replace(/[<>]/g, '').trim().slice(0, 160);
    if ('receipt' in b) q.receipt = !!b.receipt;
    if ('notifyDepositor' in b) q.notifyDepositor = !!b.notifyDepositor;
  }
  const depositView = (d) => ({ no: d.no || null, email: d.email || '', answers: d.answers || {}, review: d.review || 'received', note: d.note || '', reviewedAt: d.reviewedAt || null });

  /* ---------- Liens personnels permanents : lestha-send.com/@nom ---------- */
  const handles = kv(storage, 'handles/');          // nom -> { name, rid, owner, createdAt }
  const handleOwners = kv(storage, 'handle-owners/'); // empreinte de l'adresse -> { name }
  const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
  const RESERVED = new Set(['admin', 'administrateur', 'api', 'app', 'aide', 'help', 'support', 'contact', 'lestha', 'lesthasend', 'lestha-send', 'transferx', 'send', 'envoyer', 'direct', 'demande', 'dashboard', 'proximite', 'classe', 'live', 'securite', 'faq', 'a-propos', 'apropos', 'conditions', 'confidentialite', 'officiel', 'official', 'security', 'root', 'system', 'noreply', 'no-reply', 'abuse', 'signaler', 'info', 'www', 'mail', 'test', 'demo', 'cloudflare', 'render', 'google', 'facebook', 'whatsapp', 'orange', 'wave', 'free', 'expresso', 'banque', 'bank', 'police', 'gouv', 'etat', 'senegal']);
  const handleOwnerKey = (email) => sha256('handle:' + String(email).toLowerCase()).slice(0, 32);
  const handleLink = (req, name) => `${base(req)}/@${name}`;
  function handleProblem(name) {
    if (!HANDLE_RE.test(name)) return 'Le nom doit faire 3 à 30 caractères : lettres minuscules, chiffres et tirets (pas au début ni à la fin).';
    if (name.includes('--')) return 'Évitez deux tirets à la suite.';
    if (RESERVED.has(name) || /lestha|admin|support|officiel/.test(name)) return 'Ce nom est réservé.';
    return null;
  }
  const brandOf = async (q) => (q.brandPid && ctx.profiles ? ctx.profiles.brandFor(q.brandPid) : null);
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
      }, depositView(d));
    }));
    const reviews = {}; q.deposits.filter(d => d.status === 'ready').forEach(d => { const k = d.review || 'received'; reviews[k] = (reviews[k] || 0) + 1; });
    return {
      id: q.id, kind: 'request', title: q.title, message: q.message, ownerName: q.ownerName, ownerEmail: q.ownerEmail,
      notify: !!q.notify, createdAt: q.createdAt, expiresAt: q.expiresAt, state: stateOf(q), closed: !!q.closed,
      pinEnabled: !!q.pin, maxBytes: q.maxBytes, depositTtl: q.depositTtl, link: q.handle ? handleLink(req, q.handle) : `${base(req)}/d/${q.id}`,
      permanent: !!q.permanent, handle: q.handle || null,
      sector: q.sector || 'autre', fields: SD.fieldsOf(q), accept: q.accept || [], maxFileBytes: q.maxFileBytes || 0, maxDeposits: q.maxDeposits || 0,
      color: q.color || '', contact: q.contact || '', receipt: !!q.receipt, notifyDepositor: !!q.notifyDepositor, smart: !!q.fields, reviews,
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
      // Une demande de fichiers fait stocker des fichiers par des tiers : réservée aux adresses vérifiées
      const tier = cloud.tierOf(req);
      if (!tier.requests) return fail(res, 401, 'Confirmez votre adresse e-mail pour créer une demande de fichiers. C\'est gratuit.', { needVerify: true });
      if (tier.name !== 'full' && ctx.captcha && !(await ctx.captcha.check(req))) return fail(res, 403, 'Vérification anti-robot échouée. Rechargez la page et réessayez.', { needCaptcha: true });
      if (!cloud.takeDaily(req, tier)) return fail(res, 429, `Limite de ${tier.perDay} envois ou demandes par jour atteinte.`);
      const b = req.body || {};
      const pin = b.pin ? String(b.pin) : null;
      if (pin && !PIN_RE.test(pin)) { cloud.refundDaily(req, tier); return fail(res, 400, PIN_RULE); }
      const maxTtl = Math.min(cloud.MAX_TTL, dropMaxFor(tier));
      const ownerKey = randomKey(24);
      // Date limite : durée (ttl) ou date précise (deadline), dans la limite de l'offre
      const until = Number(b.deadline) > Date.now() + HOUR ? Number(b.deadline) - Date.now() : Number(b.ttl) || 7 * DAY;
      const q = {
        id: randomId(10), ownerHash: sha256(ownerKey), createdAt: Date.now(),
        expiresAt: Date.now() + Math.min(Math.max(until, HOUR), maxTtl),
        title: String(b.title || '').trim().slice(0, 140) || 'Déposez vos fichiers',
        message: String(b.message || '').slice(0, 1500), ownerName: String(b.ownerName || '').slice(0, 80),
        ownerEmail: tier.email || (tier.name === 'full' && isEmail(b.ownerEmail) ? String(b.ownerEmail).slice(0, 200) : ''),
        notify: !!b.notify, tierMaxBytes: tier.maxBytes, tierMaxTtl: maxTtl,
        brandPid: tier.email && ctx.profiles ? ctx.profiles.pidOf(tier.email) : null,
        pin: pin ? hashPin(pin) : null, pinVersion: 1,
        maxBytes: Math.min(Math.max(Number(b.maxBytes) || 10 * GB, 10 * 1024 * 1024), (Number(env.MAX_TRANSFER_GB) || 250) * GB, tier.maxBytes),
        depositTtl: Math.min(Math.max(Number(b.depositTtl) || 30 * DAY, DAY), maxTtl),
        closed: false, deposits: [], events: [], stats: { views: 0, visitors: [] }, seq: 0, v: 2
      };
      smartOptions(q, Object.assign({ sector: 'autre', receipt: true }, b), tier);
      if (!q.fields) q.fields = SD.cleanFields(null).length ? SD.cleanFields(SD.TEMPLATES.find(t => t.id === 'simple').fields) : null;
      await rdb.save(q, 0);
      count({ drop_created: 1, ['drop_' + q.sector]: 1 });
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
      if (b.expiresAt && !q.permanent) {
        // Nouvelle date limite précise (avancer ou repousser), dans la limite de l'offre à partir d'aujourd'hui
        const cap = Math.min(cloud.MAX_TTL, Math.max(q.tierMaxTtl || 0, DROP_MAX()));
        const want = Number(b.expiresAt);
        if (!(want > Date.now() + 10 * 60e3)) return fail(res, 400, 'Choisissez une date future.');
        if (want > Date.now() + cap + DAY) return fail(res, 400, `La date limite ne peut pas dépasser ${Math.round(cap / DAY)} jours.`);
        q.expiresAt = Math.min(want, Date.now() + cap);
        pushEvent(q, { type: 'deadline', at: q.expiresAt });
      }
      if (b.extendMs && !q.permanent) { const cap = Math.min(cloud.MAX_TTL, Math.max(q.tierMaxTtl || 0, DROP_MAX())); q.expiresAt = Math.min(Math.max(q.expiresAt, Date.now()) + Math.min(Number(b.extendMs) || 0, cap), Date.now() + cap); }
      if ('title' in b) q.title = String(b.title || '').slice(0, 140) || q.title;
      if ('message' in b) q.message = String(b.message || '').slice(0, 1500);
      if ('notify' in b) q.notify = !!b.notify;
      if ('ownerEmail' in b) {
        const tier = cloud.tierOf(req);
        const wanted = String(b.ownerEmail || '').trim().toLowerCase();
        if (!wanted) q.ownerEmail = '';
        else if (wanted === tier.email || (tier.name === 'full' && isEmail(wanted))) q.ownerEmail = wanted.slice(0, 200);
        else return fail(res, 401, 'Confirmez d\'abord cette adresse e-mail.', { needVerify: true });
      }
      if ('maxBytes' in b && Number(b.maxBytes) > 0) q.maxBytes = Math.min(Number(b.maxBytes), (Number(env.MAX_TRANSFER_GB) || 250) * GB, q.tierMaxBytes || Infinity);
      smartOptions(q, b);
      if ('pin' in b) {
        if (!b.pin) q.pin = null;
        else if (PIN_RE.test(String(b.pin))) q.pin = hashPin(String(b.pin));
        else return fail(res, 400, PIN_RULE);
        q.pinFailLog = [];
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
      if (q.handle) { await handles.del(q.handle); if (q.handleOwner) await handleOwners.del(q.handleOwner); }
      await rdb.remove(q.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---------- Smart Drop : catalogue, statut d'un dépôt, export, tout télécharger ---------- */
  r.get('/smartdrop/catalog', (req, res) => {
    const tier = cloud.tierOf(req);
    res.set('Cache-Control', 'private, no-store');
    res.json(Object.assign(SD.catalog(), { limits: { maxTtl: Math.min(cloud.MAX_TTL, dropMaxFor(tier)), maxBytes: tier.maxBytes, canCreate: !!tier.requests } }));
  });

  /* Console admin : état actuel des espaces (calculé au plus toutes les 2 minutes) */
  let dropCache = null;
  ctx.dropStats = async () => {
    if (dropCache && Date.now() - dropCache.at < 120e3) return dropCache.v;
    const v = { spaces: 0, open: 0, closed: 0, expired: 0, full: 0, handles: 0, smart: 0, deposits: 0, uploading: 0, files: 0, bytes: 0, reviews: {}, sectors: {}, recent: [] };
    for (const rid of await rdb.listIds()) {
      const q = await rdb.get(rid).catch(() => null); if (!q) continue;
      v.spaces++; const st = stateOf(q); v[st] = (v[st] || 0) + 1;
      if (q.permanent) v.handles++; if (q.fields) v.smart++;
      const sec = q.sector || 'autre'; v.sectors[sec] = (v.sectors[sec] || 0) + 1;
      let n = 0;
      for (const d of q.deposits) {
        if (d.status !== 'ready') { v.uploading++; continue; }
        n++; v.deposits++; v.files += d.files || 0; v.bytes += d.size || 0;
        const k = d.review || 'received'; v.reviews[k] = (v.reviews[k] || 0) + 1;
      }
      v.recent.push({ id: q.id, title: q.title, sector: sec, state: st, deposits: n, createdAt: q.createdAt, expiresAt: q.permanent ? null : q.expiresAt });
    }
    v.recent = v.recent.sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
    dropCache = { at: Date.now(), v };
    return v;
  };

  r.patch('/requests/:id/deposits/:tid', loadOwner, async (req, res, next) => {
    try {
      const q = req.q, d = q.deposits.find(x => x.id === req.params.tid);
      if (!d) return fail(res, 404, 'Dépôt introuvable.');
      const b = req.body || {}, before = d.review || 'received';
      if ('review' in b) { if (!SD.STATUS_IDS.includes(b.review)) return fail(res, 400, 'Statut inconnu.'); d.review = b.review; d.reviewedAt = Date.now(); }
      if ('note' in b) d.note = String(b.note || '').replace(/[<>]/g, '').slice(0, 1000);
      if (d.review !== before) {
        pushEvent(q, { type: 'review', n: d.name, no: d.no, s: d.review });
        // Le déposant est prévenu du changement de statut (s'il a laissé son e-mail et si l'option est active)
        if (q.notifyDepositor && d.email && mailer.enabled && ['incomplete', 'validated', 'refused', 'review'].includes(d.review)) {
          const st = SD.STATUSES.find(x => x.id === d.review).label;
          mailer.send({
            to: d.email, subject: `${d.no ? d.no + ' · ' : ''}${q.title} : ${st}`,
            text: `Bonjour ${d.name},\nVotre dépôt ${d.no || ''} pour « ${q.title} » est maintenant : ${st}.${d.note ? '\n\nMessage : ' + d.note : ''}`,
            html: mailer.simple({ title: 'Suivi de votre dépôt', paragraphs: [`Bonjour <strong>${mailer.esc(d.name)}</strong>,`, `Votre dépôt <strong>${mailer.esc(d.no || '')}</strong> pour « ${mailer.esc(q.title)} » est maintenant : <strong>${mailer.esc(st)}</strong>.`].concat(d.note ? [`Message de ${mailer.esc(q.ownerName || 'l\'organisateur')} : ${mailer.esc(d.note)}`] : []), note: 'Message envoyé par Lestha Send pour le compte de ' + mailer.esc(q.ownerName || 'l\'organisateur') + '.' })
          }).catch(e => console.error('notify review', e.message));
        }
      }
      await rdb.save(q, 0);
      res.json(Object.assign({ id: d.id }, depositView(d)));
    } catch (e) { next(e); }
  });

  const fmtCsvDate = (ts) => { const x = new Date(ts); const z = (n) => String(n).padStart(2, '0'); return `${z(x.getDate())}/${z(x.getMonth() + 1)}/${x.getFullYear()} ${z(x.getHours())}:${z(x.getMinutes())}`; };
  // Excel : un numéro « +221 … » reste du texte (espace insécable de largeur nulle), une formule « =… » est neutralisée
  const csvCell = (v) => { let x = String(v == null ? '' : Array.isArray(v) ? v.join(', ') : v); if (/^[+-][\d\s().-]+$/.test(x)) x = '\u200b' + x; else if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; };
  r.get('/requests/:id/export.csv', loadOwner, async (req, res, next) => {
    try {
      const q = req.q, fields = SD.fieldsOf(q).filter(f => !SD.isFileField(f));
      const head = ['N°', 'Date', 'Déposant', ...fields.map(f => f.label), 'Fichiers', 'Taille (Mo)', 'Statut', 'Note', 'Lien'];
      const rows = [head.map(csvCell).join(';')];
      for (const d of q.deposits.filter(x => x.status === 'ready')) {
        const t = await db.get(d.id).catch(() => null);
        const st = (SD.STATUSES.find(x => x.id === (d.review || 'received')) || {}).label;
        rows.push([d.no || '', fmtCsvDate(d.at), d.name, ...fields.map(f => (d.answers || {})[f.id] || ''), t ? t.files.map(f => f.path || f.name).join(' | ') : '(supprimé)', ((d.size || 0) / MB).toFixed(1).replace('.', ','), st, d.note || '', `${base(req)}/t/${d.id}`].map(csvCell).join(';'));
      }
      const name = (q.title || 'depots').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'depots';
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="Depots-${name}.csv"`);
      res.set('Cache-Control', 'no-store');
      res.send('﻿' + rows.join('\r\n'));
    } catch (e) { next(e); }
  });

  /** Tout télécharger : un dossier par dépôt (« CAND-0007 - Awa Ndiaye/CV/… »), flux sans compression */
  r.get('/requests/:id/zip', loadOwner, async (req, res, next) => {
    try {
      const q = req.q, only = SD.STATUS_IDS.includes(req.query.status) ? req.query.status : null;
      const list = q.deposits.filter(d => d.status === 'ready' && (!only || (d.review || 'received') === only));
      if (!list.length) return fail(res, 404, 'Aucun dépôt à télécharger.');
      const name = (q.title || 'depots').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 80) + '.zip';
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.set('Cache-Control', 'no-store'); res.set('X-Accel-Buffering', 'no');
      const total = list.reduce((s, d) => s + (d.size || 0), 0);
      const archive = archiver('zip', { store: true, forceZip64: total > 3.5 * GB });
      archive.on('warning', (e) => console.warn('zip', e.message));
      archive.on('error', (e) => { console.error('zip', e.message); res.destroy(e); });
      res.on('close', () => { if (!res.writableFinished) archive.abort(); });
      archive.pipe(res);
      const used = new Set();
      for (const d of list) {
        if (res.destroyed) break;
        const t = await db.get(d.id).catch(() => null); if (!t) continue;
        const dir = `${d.no ? d.no + ' - ' : ''}${d.name}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 90);
        for (const f of t.files) {
          if (!f.done || res.destroyed) continue;
          let nm = dir + '/' + String(f.path || f.name).replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '');
          while (used.has(nm)) nm = nm.replace(/(\.[^./]+)?$/, (m) => ' (2)' + (m || ''));
          used.add(nm);
          const stream = await storage.getStream(f.key);
          await new Promise((resolve, reject) => { archive.once('entry', resolve); stream.once('error', reject); archive.append(stream, { name: nm, date: f.lastModified ? new Date(f.lastModified) : new Date() }); });
        }
      }
      pushEvent(q, { type: 'zip_all', n: list.length }); rdb.save(q);
      await archive.finalize();
    } catch (e) { if (!res.headersSent) next(e); else res.destroy(); }
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

  /* ---------- liens personnels @nom ---------- */
  r.get('/handles/check/:name', async (req, res, next) => {
    try {
      if (!handleLimit(clientIp(req))) return fail(res, 429, 'Trop de vérifications. Patientez un peu.');
      const name = String(req.params.name || '').toLowerCase();
      const problem = handleProblem(name);
      if (problem) return res.json({ available: false, reason: problem });
      res.json({ available: !(await handles.get(name)), reason: (await handles.get(name)) ? 'Ce nom est déjà pris.' : null });
    } catch (e) { next(e); }
  });

  r.get('/handles/mine', async (req, res, next) => {
    try {
      const email = ctx.verifiedEmail && ctx.verifiedEmail(req);
      if (!email) return fail(res, 401, 'Confirmez votre adresse e-mail.', { needVerify: true });
      const own = await handleOwners.get(handleOwnerKey(email));
      if (!own) return res.json({ name: null });
      const h = await handles.get(own.name);
      if (!h) return res.json({ name: null });
      res.json({ name: h.name, id: h.rid, link: handleLink(req, h.name) });
    } catch (e) { next(e); }
  });

  r.post('/handles', async (req, res, next) => {
    try {
      const admin = ctx.isAdmin && ctx.isAdmin(req);
      if (ctx.cloudEnabled === false) return fail(res, 503, 'Mode Cloud indisponible : le stockage R2 n\'est pas configuré.');
      if (!admin && ctx.security && ctx.security.isBlockedIp(clientIp(req))) return fail(res, 403, 'Action bloquée depuis cette connexion.');
      if (!admin && !createLimit(clientIp(req))) return fail(res, 429, 'Trop de demandes. Réessayez plus tard.');
      const tier = cloud.tierOf(req);
      const b = req.body || {};
      const email = tier.email || (tier.name === 'full' && isEmail(b.ownerEmail) ? String(b.ownerEmail).trim().toLowerCase().slice(0, 200) : '');
      if (!tier.requests || !email) return fail(res, 401, 'Confirmez votre adresse e-mail pour réserver votre lien personnel. C\'est gratuit.', { needVerify: true });
      if (tier.name !== 'full' && ctx.captcha && !(await ctx.captcha.check(req))) return fail(res, 403, 'Vérification anti-robot échouée. Rechargez la page et réessayez.', { needCaptcha: true });
      const name = String(b.name || '').trim().toLowerCase();
      const problem = handleProblem(name);
      if (problem) return fail(res, 400, problem);
      const ownKey = handleOwnerKey(email);
      if (await handleOwners.get(ownKey)) return fail(res, 409, 'Vous avez déjà un lien personnel. Retrouvez-le dans « Mon lien personnel ».', { hasHandle: true });
      if (await handles.get(name)) return fail(res, 409, 'Ce nom est déjà pris.');
      const ownerKey = randomKey(24);
      const q = {
        id: randomId(10), ownerHash: sha256(ownerKey), createdAt: Date.now(),
        expiresAt: Date.now() + 100 * 365 * DAY, permanent: true, handle: name, handleOwner: ownKey,
        title: String(b.title || '').trim().slice(0, 140) || 'Déposez-moi vos fichiers',
        message: String(b.message || '').slice(0, 1500), ownerName: String(b.ownerName || '').slice(0, 80),
        ownerEmail: email, notify: b.notify !== false, tierMaxBytes: tier.maxBytes, tierMaxTtl: tier.maxTtl,
        brandPid: ctx.profiles ? ctx.profiles.pidOf(email) : null,
        pin: null, pinVersion: 1,
        maxBytes: Math.min((Number(env.MAX_TRANSFER_GB) || 250) * GB, tier.maxBytes),
        depositTtl: Math.min(cloud.MAX_TTL, tier.maxTtl),
        closed: false, deposits: [], events: [], stats: { views: 0, visitors: [] }
      };
      // Réservation du nom d'abord : deux personnes ne peuvent pas obtenir le même
      await handles.set(name, { name, rid: q.id, owner: ownKey, createdAt: Date.now() });
      await handleOwners.set(ownKey, { name });
      await rdb.save(q, 0);
      if (io) io.to('admin').emit('admin-event', { id: q.id, title: '@' + name, event: { t: Date.now(), type: 'request_created' } });
      res.json({ name, id: q.id, ownerKey, link: handleLink(req, name), manageLink: `${base(req)}/r/${q.id}#${ownerKey}` });
    } catch (e) { next(e); }
  });

  /** Retrouver la gestion de son lien depuis un autre appareil : l'adresse vérifiée fait foi */
  r.post('/handles/recover', async (req, res, next) => {
    try {
      const email = ctx.verifiedEmail && ctx.verifiedEmail(req);
      if (!email) return fail(res, 401, 'Confirmez votre adresse e-mail.', { needVerify: true });
      if (!handleLimit(clientIp(req))) return fail(res, 429, 'Trop de tentatives. Patientez un peu.');
      const own = await handleOwners.get(handleOwnerKey(email));
      const h = own && await handles.get(own.name);
      const q = h && await rdb.get(h.rid);
      if (!q) return fail(res, 404, 'Aucun lien personnel pour cette adresse.');
      const ownerKey = randomKey(24);
      q.ownerHash = sha256(ownerKey);
      // Les dépôts déjà reçus suivent la nouvelle clé de gestion
      for (const d of q.deposits) {
        const t = await db.get(d.id).catch(() => null);
        if (t) { t.ownerHash = q.ownerHash; await db.save(t, 0); }
      }
      await rdb.save(q, 0);
      res.json({ name: q.handle, id: q.id, ownerKey, link: handleLink(req, q.handle) });
    } catch (e) { next(e); }
  });

  r.get('/public/h/:name', async (req, res, next) => {
    try {
      const name = String(req.params.name || '').toLowerCase();
      const h = HANDLE_RE.test(name) ? await handles.get(name) : null;
      if (!h) return fail(res, 404, 'Ce lien personnel n\'existe pas.');
      res.json({ id: h.rid, name: h.name });
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
        pinRequired: !!q.pin, locked: !hasAccess(req, q), message: hasAccess(req, q) ? q.message : '',
        permanent: !!q.permanent, handle: q.handle || null, brand: await brandOf(q),
        fields: hasAccess(req, q) ? SD.fieldsOf(q) : [], smart: !!q.fields, sector: q.sector || 'autre',
        accept: q.accept || [], acceptLabel: SD.acceptLabel(q.accept), acceptExt: (q.accept || []).flatMap(k => SD.ACCEPT[k].ext),
        maxFileBytes: q.maxFileBytes || 0, color: q.color || '', contact: q.contact || '', receipt: !!q.receipt
      });
    } catch (e) { next(e); }
  });

  r.post('/public/d/:id/unlock', async (req, res, next) => {
    try {
      const q = await rdb.get(req.params.id);
      if (!q) return fail(res, 404, 'Lien introuvable.');
      if (!pinLimit(clientIp(req) + ':' + q.id)) return fail(res, 429, 'Trop de tentatives. Patientez 15 minutes.');
      q.pinFailLog = (q.pinFailLog || []).filter(ts => Date.now() - ts < HOUR);
      if (q.pin && q.pinFailLog.length >= 20) return fail(res, 429, 'Ce lien est verrouillé pendant une heure après trop de codes erronés.');
      if (!checkPin(String(req.body.pin || ''), q.pin)) { q.pinFailLog.push(Date.now()); pushEvent(q, { type: 'pin_fail' }); rdb.save(q); return fail(res, 403, 'Code incorrect.'); }
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
      if (st === 'full') return fail(res, 403, 'Ce dépôt a atteint le nombre maximal de réponses.');
      if (!hasAccess(req, q)) return fail(res, 401, 'Code requis.');
      if (ctx.cloudEnabled === false) return fail(res, 503, 'Stockage indisponible.');
      if (ctx.security && ctx.security.isBlockedIp(clientIp(req))) return fail(res, 403, 'Dépôt bloqué depuis cette connexion.');
      if (!depositLimit(clientIp(req))) return fail(res, 429, 'Trop de dépôts depuis cette connexion. Réessayez plus tard.');
      if (ctx.captcha && !(await ctx.captcha.check(req))) return fail(res, 403, 'Vérification anti-robot échouée. Rechargez la page et réessayez.', { needCaptcha: true });
      const b = req.body || {};
      const chk = SD.checkDeposit(q, b);
      if (chk.error) return fail(res, chk.status || 400, chk.error);
      const name = chk.name;
      if (q.permanent) {
        // Une boîte permanente reste ouverte : on borne le nombre de dépôts par jour
        const today = Math.floor(Date.now() / DAY);
        if (!q.day || q.day.d !== today) q.day = { d: today, n: 0 };
        if (q.day.n >= DEPOSITS_PER_DAY) return fail(res, 429, 'Cette boîte de dépôt a reçu beaucoup de fichiers aujourd\'hui. Réessayez demain.');
        q.day.n++;
      }
      q.seq = (q.seq || 0) + 1;
      const no = SD.numberOf(q, q.seq);
      const msg = String(chk.answers.message || chk.answers.commentaire || b.message || '').slice(0, 1500);
      const out = await cloud.createTransfer(req, {
        files: chk.files, title: `${no} — ${name}`, senderName: name, message: msg, maxBytes: q.maxBytes
      }, {
        ownerHash: q.ownerHash, uploadKey: true, requestId: q.id, ttl: q.depositTtl,
        tier: { name: 'deposit', maxBytes: q.maxBytes, maxTtl: q.depositTtl, uploadWindow: DAY, emails: 0 }
      });
      if (out.error) { q.seq--; return fail(res, out.status || 400, out.error); }
      const t = out.t;
      const at = Date.now();
      q.deposits.push({ id: t.id, no, name, email: chk.email, answers: chk.answers, review: 'received', message: msg, at, size: t.totalSize, files: t.files.length, status: 'uploading' });
      if (q.deposits.length > 2000) q.deposits.shift();
      await rdb.save(q, 0);
      res.json({ transferId: t.id, uploadKey: out.uploadKey, receipt: { no, at, name, email: q.receipt && mailer.enabled ? chk.email : '' }, files: t.files.map(f => ({ id: f.id, partSize: f.partSize, partCount: f.partCount, done: f.done })) });
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
      count({ drop_deposits: 1 });
      if (d && q.receipt && d.email && mailer.enabled) {
        const list = t.files.map(f => f.path || f.name);
        const when = new Date(d.at).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
        mailer.send({
          to: d.email, subject: `Accusé de réception ${d.no || ''} — ${q.title}`,
          text: `Bonjour ${d.name},
Nous confirmons la réception de votre dépôt pour « ${q.title} ».
Numéro : ${d.no}
Date : ${when}
Fichiers :
- ${list.join('\n- ')}

Conservez ce numéro pour tout échange.`,
          html: mailer.simple({ title: 'Accusé de réception ✅', paragraphs: [`Bonjour <strong>${mailer.esc(d.name)}</strong>, nous confirmons la réception de votre dépôt pour « ${mailer.esc(q.title)} ».`, `Numéro : <strong>${mailer.esc(d.no || '')}</strong><br>Date : ${mailer.esc(when)}<br>${list.length} fichier(s) : ${list.slice(0, 12).map(x => mailer.esc(x)).join(', ')}${list.length > 12 ? '…' : ''}`, 'Conservez ce numéro pour tout échange.'], note: 'Message envoyé par Lestha Send pour le compte de ' + mailer.esc(q.ownerName || 'l\'organisateur') + '.' })
        }).catch(e => console.error('receipt', e.message));
      }
      if (q.notify && q.ownerEmail && mailer.enabled) {
        const link = `${base(req)}/r/${q.id}`;
        mailer.send({
          to: q.ownerEmail, subject: `📥 ${d && d.no ? d.no + ' · ' : ''}Nouveau dépôt de ${t.senderName} — ${q.title}`,
          text: `${t.senderName} a déposé ${t.files.length} fichier(s) dans « ${q.title} ».\nVoir les dépôts : ${link}`,
          html: mailer.simple({ title: 'Nouveau dépôt 📥', paragraphs: [`<strong>${mailer.esc(t.senderName)}</strong> a déposé <strong>${t.files.length} fichier(s)</strong> dans « ${mailer.esc(q.handle ? '@' + q.handle : q.title)} ».`], action: { href: link, label: 'Voir les dépôts' }, note: 'Vous recevez cet e-mail car les alertes de dépôt sont activées.' })
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
