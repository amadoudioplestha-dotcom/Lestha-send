'use strict';
/**
 * Profils d'expéditeur et statistiques publiques.
 *
 *  - Profil (adresse vérifiée uniquement) : nom affiché, couleur, site web et logo.
 *    Il habille la page de téléchargement de ses envois et sa boîte de dépôt @nom.
 *    Le logo est une petite image PNG, JPEG ou WebP (jamais de SVG, qui peut contenir du script),
 *    contrôlée octet par octet et servie avec des en-têtes stricts.
 *  - Statistiques : compteurs cumulés (envois, fichiers, volume) affichés sur la page d'accueil.
 */
const express = require('express');
const { sha256, rateLimiter, clientIp } = require('./util');

/* ------------------------------------------------------------------ */
/*  Petit magasin clé → JSON dans le stockage, avec cache borné         */
/* ------------------------------------------------------------------ */
function kv(storage, prefix, max = 5000) {
  const cache = new Map();
  const file = (k) => `${prefix}${k}.json`;
  const remember = (k, v) => { cache.delete(k); cache.set(k, v); if (cache.size > max) cache.delete(cache.keys().next().value); };
  return {
    async get(k) {
      if (cache.has(k)) return cache.get(k);
      const b = await storage.getBuffer(file(k)).catch(() => null);
      let v = null;
      try { v = b ? JSON.parse(b.toString('utf8')) : null; } catch (e) { v = null; }
      remember(k, v);
      return v;
    },
    async set(k, v) { remember(k, v); await storage.putBuffer(file(k), Buffer.from(JSON.stringify(v)), 'application/json'); },
    async del(k) { remember(k, null); await storage.deleteKey(file(k)).catch(() => {}); }
  };
}

/* ------------------------------------------------------------------ */
/*  Statistiques publiques                                              */
/* ------------------------------------------------------------------ */
function createStats(storage, db) {
  const KEY = 'system/stats.json';
  let s = null, timer = null;
  const ready = (async () => {
    const b = await storage.getBuffer(KEY).catch(() => null);
    try { s = b ? JSON.parse(b.toString('utf8')) : null; } catch (e) { s = null; }
    if (!s) {
      // Première fois : on part des envois déjà présents dans le stockage
      s = { since: Date.now(), transfers: 0, files: 0, bytes: 0, direct: 0 };
      try {
        for (const id of await db.listIds()) {
          const t = await db.get(id).catch(() => null);
          if (t && t.status === 'ready' && !t.selftest) { s.transfers++; s.files += t.files.length; s.bytes += t.totalSize || 0; }
          db.release(id);
        }
      } catch (e) { /* stockage indisponible : compteurs à zéro */ }
      await storage.putBuffer(KEY, Buffer.from(JSON.stringify(s)), 'application/json').catch(() => {});
    }
  })();
  const flush = () => { timer = null; storage.putBuffer(KEY, Buffer.from(JSON.stringify(s)), 'application/json').catch(e => console.error('stats', e.message)); };
  return {
    ready,
    add(fields) {
      if (!s) return;
      for (const [k, v] of Object.entries(fields)) s[k] = (s[k] || 0) + (Number(v) || 0);
      if (!timer) timer = setTimeout(flush, 10000);
    },
    get: () => s,
    flush: async () => { if (timer) { clearTimeout(timer); flush(); } }
  };
}

/* ------------------------------------------------------------------ */
/*  Profils                                                             */
/* ------------------------------------------------------------------ */
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const LOGO_MAX = 300 * 1024;
function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG') return { type: 'image/png', ext: 'png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}
function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const x = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (!/^https?:$/.test(x.protocol) || !x.hostname.includes('.')) return null;
    return x.href.slice(0, 200);
  } catch (e) { return null; }
}

function mountProfiles(app, { env, storage, ctx, db }) {
  const store = kv(storage, 'profiles/');
  const pidOf = (email) => sha256('profile:' + String(email).toLowerCase()).slice(0, 32);
  const fail = (res, s, error, extra) => res.status(s).json(Object.assign({ error }, extra || {}));
  const editLimit = rateLimiter({ windowMs: 3600e3, max: 40 });
  const r = express.Router();

  const publicOf = (pid, p) => p ? {
    pid, displayName: p.displayName || '', color: p.color || '', website: p.website || '',
    logo: p.logo ? `/api/public/brand/${pid}/logo?v=${p.logo.v}` : null
  } : null;

  async function needEmail(req, res) {
    const email = ctx.verifiedEmail && ctx.verifiedEmail(req);
    if (!email) { fail(res, 401, 'Confirmez votre adresse e-mail pour personnaliser votre page. C\'est gratuit.', { needVerify: true }); return null; }
    return email;
  }

  r.get('/profile', async (req, res, next) => {
    try {
      const email = await needEmail(req, res); if (!email) return;
      const pid = pidOf(email);
      res.json(Object.assign({ email }, publicOf(pid, await store.get(pid)) || { pid, displayName: '', color: '', website: '', logo: null }));
    } catch (e) { next(e); }
  });

  r.put('/profile', async (req, res, next) => {
    try {
      const email = await needEmail(req, res); if (!email) return;
      if (!editLimit(clientIp(req))) return fail(res, 429, 'Trop de modifications. Réessayez dans une heure.');
      const b = req.body || {};
      const website = cleanUrl(b.website);
      if (website === null) return fail(res, 400, 'Adresse de site web invalide.');
      const color = String(b.color || '');
      if (color && !COLOR_RE.test(color)) return fail(res, 400, 'Couleur invalide.');
      const pid = pidOf(email);
      const p = Object.assign({}, await store.get(pid), {
        displayName: String(b.displayName || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60),
        color: color.toLowerCase(), website, updatedAt: Date.now()
      });
      await store.set(pid, p);
      res.json(Object.assign({ email }, publicOf(pid, p)));
    } catch (e) { next(e); }
  });

  r.post('/profile/logo', async (req, res, next) => {
    try {
      const email = await needEmail(req, res); if (!email) return;
      if (!editLimit(clientIp(req))) return fail(res, 429, 'Trop de modifications. Réessayez dans une heure.');
      const data = String((req.body && req.body.data) || '').replace(/^data:[^,]*,/, '');
      const buf = Buffer.from(data, 'base64');
      if (!buf.length) return fail(res, 400, 'Image manquante.');
      if (buf.length > LOGO_MAX) return fail(res, 413, 'Image trop lourde (300 Ko maximum).');
      const kind = sniffImage(buf);
      if (!kind) return fail(res, 415, 'Format non accepté : utilisez une image PNG, JPEG ou WebP.');
      const pid = pidOf(email);
      const p = Object.assign({}, await store.get(pid));
      if (p.logo && p.logo.ext !== kind.ext) await storage.deleteKey(`brand/${pid}.${p.logo.ext}`).catch(() => {});
      await storage.putBuffer(`brand/${pid}.${kind.ext}`, buf, kind.type);
      p.logo = { ext: kind.ext, type: kind.type, v: Date.now().toString(36) };
      p.updatedAt = Date.now();
      await store.set(pid, p);
      res.json(Object.assign({ email }, publicOf(pid, p)));
    } catch (e) { next(e); }
  });

  r.delete('/profile/logo', async (req, res, next) => {
    try {
      const email = await needEmail(req, res); if (!email) return;
      const pid = pidOf(email);
      const p = Object.assign({}, await store.get(pid));
      if (p.logo) await storage.deleteKey(`brand/${pid}.${p.logo.ext}`).catch(() => {});
      p.logo = null;
      await store.set(pid, p);
      res.json(Object.assign({ email }, publicOf(pid, p)));
    } catch (e) { next(e); }
  });

  r.get('/public/brand/:pid/logo', async (req, res, next) => {
    try {
      const pid = String(req.params.pid);
      if (!/^[0-9a-f]{32}$/.test(pid)) return res.status(404).end();
      const p = await store.get(pid);
      if (!p || !p.logo) return res.status(404).end();
      const buf = await storage.getBuffer(`brand/${pid}.${p.logo.ext}`).catch(() => null);
      if (!buf) return res.status(404).end();
      res.set({
        'Content-Type': p.logo.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin'
      });
      res.end(buf);
    } catch (e) { next(e); }
  });

  /* ---------- Statistiques publiques (compteurs de la page d'accueil) ---------- */
  const STATS_MIN = env.STATS_MIN_TRANSFERS != null && env.STATS_MIN_TRANSFERS !== '' ? Math.max(0, Number(env.STATS_MIN_TRANSFERS) || 0) : 20;
  r.get('/public/stats', (req, res) => {
    const s = ctx.stats && ctx.stats.get();
    res.set('Cache-Control', 'public, max-age=60');
    // Rien n'est affiché tant que les chiffres sont trop petits pour être parlants
    if (!s || s.transfers < STATS_MIN) return res.json({ show: false });
    res.json({ show: true, transfers: s.transfers, files: s.files, bytes: s.bytes, direct: s.direct || 0, since: s.since });
  });

  app.use('/api', r);

  /** Habillage public d'un expéditeur vérifié (null si aucun) */
  async function brandFor(pid) {
    if (!pid || !/^[0-9a-f]{32}$/.test(pid)) return null;
    const p = await store.get(pid).catch(() => null);
    if (!p || !(p.displayName || p.logo || p.color || p.website)) return null;
    return publicOf(pid, p);
  }
  return { pidOf, brandFor };
}

module.exports = { kv, createStats, mountProfiles, sniffImage, cleanUrl };
