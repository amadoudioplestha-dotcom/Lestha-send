'use strict';
/**
 * « Direct » : salles de diffusion en direct.
 *  - embed  : lecteur OFFICIEL d'une plateforme (YouTube, Facebook, Vimeo, Twitch, Instagram, TikTok) — rien n'est recopié
 *  - camera : diffusion caméra / écran / micro depuis le navigateur de l'hôte (WebRTC, petits groupes)
 *  - hls    : flux .m3u8 en https (OBS, régie, serveur de streaming)
 * Discussion en direct + compteur de spectateurs par socket.io. Métadonnées dans le stockage (lives/<id>.json).
 */
const express = require('express');
const { randomId, randomKey, sha256, safeEqual, rateLimiter, clientIp } = require('./util');
const { createDb } = require('./db');

const MAX_CAMERA_VIEWERS = 25;
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

/** Transforme un lien de plateforme en lecteur intégrable officiel */
function parseEmbed(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^(www|m|mobile)\./, '');
  const p = u.pathname;
  let m;
  if (h === 'youtu.be' && (m = p.match(/^\/([\w-]{6,})/))) return { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0&playsinline=1` };
  if (h === 'youtube.com' || h === 'music.youtube.com') {
    if (u.searchParams.get('v')) return { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.searchParams.get('v'))}?autoplay=1&rel=0&playsinline=1` };
    if ((m = p.match(/^\/(?:live|shorts|embed)\/([\w-]{6,})/))) return { provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0&playsinline=1` };
    if ((m = p.match(/^\/channel\/(UC[\w-]+)/))) return { provider: 'youtube', src: `https://www.youtube.com/embed/live_stream?channel=${m[1]}&autoplay=1` };
  }
  if (h === 'facebook.com' || h === 'fb.watch' || h === 'web.facebook.com') return { provider: 'facebook', src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(u.href)}&show_text=false&autoplay=true` };
  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    if ((m = p.match(/^\/event\/(\d+)/))) return { provider: 'vimeo', src: `https://vimeo.com/event/${m[1]}/embed` };
    if ((m = p.match(/(?:^|\/)(\d{5,})/))) return { provider: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}?autoplay=1` };
  }
  if (h === 'twitch.tv') {
    if ((m = p.match(/^\/videos\/(\d+)/))) return { provider: 'twitch', twitch: { video: m[1] } };
    if ((m = p.match(/^\/([A-Za-z0-9_]{3,})\/?$/))) return { provider: 'twitch', twitch: { channel: m[1] } };
  }
  if (h === 'instagram.com' && (m = p.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/))) return { provider: 'instagram', src: `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/embed`, vertical: true };
  if (h === 'tiktok.com' && (m = p.match(/\/video\/(\d+)/))) return { provider: 'tiktok', src: `https://www.tiktok.com/embed/v2/${m[1]}`, vertical: true };
  return null;
}

function mountLive(app, { storage, io, env }) {
  const db = createDb(storage, 'lives/');
  const router = express.Router();
  const fail = (res, s, error) => res.status(s).json({ error });
  const createLimit = rateLimiter({ windowMs: 60 * 60e3, max: 20 });
  const chats = new Map();      // id -> [messages] (mémoire + sauvegarde différée)
  const hosts = new Map();      // id -> socket.id de l'hôte (mode caméra)

  function publicView(l) {
    return {
      id: l.id, title: l.title, description: l.description, hostName: l.hostName, kind: l.kind,
      provider: l.provider || null, src: l.src || null, twitch: l.twitch || null, vertical: !!l.vertical, hls: l.hls || null,
      startsAt: l.startsAt || null, status: l.status, chat: l.chat !== false, createdAt: l.createdAt,
      hostOnline: hosts.has(l.id), maxViewers: l.kind === 'camera' ? MAX_CAMERA_VIEWERS : null
    };
  }
  const load = async (req, res) => {
    const l = await db.get(req.params.id);
    if (!l || l.deleted) { fail(res, 404, 'Direct introuvable.'); return null; }
    return l;
  };
  const isHost = (l, key) => !!(key && safeEqual(sha256(String(key)), l.hostHash));

  router.post('/lives', async (req, res, next) => {
    try {
      if (!createLimit(clientIp(req))) return fail(res, 429, 'Trop de directs créés, patientez.');
      const b = req.body || {};
      const kind = ['embed', 'camera', 'hls'].includes(b.kind) ? b.kind : 'embed';
      const l = { id: randomId(8), title: clean(b.title, 120) || 'Direct', description: clean(b.description, 1000), hostName: clean(b.hostName, 60), kind, status: 'scheduled', chat: b.chat !== false, createdAt: Date.now(), messages: [] };
      if (kind === 'embed') {
        const e = parseEmbed(b.url);
        if (!e) return fail(res, 400, 'Lien non reconnu. Collez un lien YouTube, Facebook, Vimeo, Twitch, Instagram ou TikTok.');
        Object.assign(l, e, { url: String(b.url).slice(0, 500), status: 'live' });
      }
      if (kind === 'hls') {
        let u; try { u = new URL(String(b.url || '')); } catch (e) { /* ignore */ }
        if (!u || u.protocol !== 'https:' || !/\.m3u8($|\?)/i.test(u.pathname + u.search)) return fail(res, 400, 'Le flux doit être un lien https se terminant par .m3u8.');
        l.hls = u.href; l.status = 'live';
      }
      const st = Number(b.startsAt); if (st && st > Date.now() - 3600e3) l.startsAt = st;
      const hostKey = randomKey(18);
      l.hostHash = sha256(hostKey);
      await db.save(l, 0);
      res.json({ id: l.id, hostKey, live: publicView(l) });
    } catch (e) { next(e); }
  });

  router.get('/public/live/:id', async (req, res, next) => {
    try {
      const l = await load(req, res); if (!l) return;
      res.json(Object.assign(publicView(l), { messages: (chats.get(l.id) || l.messages || []).slice(-80), viewers: await viewers(l.id) }));
    } catch (e) { next(e); }
  });

  router.patch('/lives/:id', async (req, res, next) => {
    try {
      const l = await load(req, res); if (!l) return;
      if (!isHost(l, req.get('x-owner-key'))) return fail(res, 403, 'Clé invalide.');
      const b = req.body || {};
      if (['scheduled', 'live', 'ended'].includes(b.status)) l.status = b.status;
      if ('title' in b) l.title = clean(b.title, 120) || l.title;
      if ('description' in b) l.description = clean(b.description, 1000);
      if ('chat' in b) l.chat = !!b.chat;
      await db.save(l, 0);
      if (io) io.to('live:' + l.id).emit('live-update', publicView(l));
      res.json(publicView(l));
    } catch (e) { next(e); }
  });

  router.delete('/lives/:id', async (req, res, next) => {
    try {
      const l = await load(req, res); if (!l) return;
      if (!isHost(l, req.get('x-owner-key'))) return fail(res, 403, 'Clé invalide.');
      if (io) io.to('live:' + l.id).emit('live-update', Object.assign(publicView(l), { status: 'ended', deleted: true }));
      chats.delete(l.id); await db.remove(l.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.use('/api', router);

  /* ---------------- temps réel : spectateurs, discussion, signalisation caméra ---------------- */
  async function viewers(id) { if (!io) return 0; const s = await io.in('live:' + id).fetchSockets(); return s.filter(x => !x.data.liveHost).length; }
  const bump = async (id) => { if (io) io.to('live:' + id).emit('live-viewers', { id, n: await viewers(id) }); };
  const chatLimit = new Map();
  if (!io) return {};

  io.on('connection', (socket) => {
    socket.on('live-join', async ({ id, key, name } = {}, cb) => {
      try {
        const l = await db.get(String(id || '')); if (!l || l.deleted) return cb && cb({ error: 'Direct introuvable.' });
        const host = isHost(l, key);
        if (!host && l.kind === 'camera' && (await viewers(l.id)) >= MAX_CAMERA_VIEWERS) return cb && cb({ error: `Salle pleine (${MAX_CAMERA_VIEWERS} spectateurs max en diffusion directe).` });
        socket.join('live:' + l.id);
        socket.data.live = l.id; socket.data.liveHost = host; socket.data.liveName = clean(name, 40) || 'Invité';
        if (host && l.kind === 'camera') {
          hosts.set(l.id, socket.id);
          io.to('live:' + l.id).emit('live-host', { online: true });
        } else if (!host && hosts.has(l.id)) io.to(hosts.get(l.id)).emit('live-viewer', { peer: socket.id });
        cb && cb({ ok: true, host, viewers: await viewers(l.id), hostOnline: hosts.has(l.id) });
        bump(l.id);
      } catch (e) { cb && cb({ error: 'Erreur' }); }
    });
    // L'hôte redemande la liste des spectateurs (démarrage de la caméra après leur arrivée)
    socket.on('live-peers', async (_, cb) => {
      const id = socket.data.live; if (!id || !socket.data.liveHost) return cb && cb([]);
      const list = (await io.in('live:' + id).fetchSockets()).filter(s => !s.data.liveHost).map(s => s.id);
      cb && cb(list);
    });
    socket.on('live-signal', ({ to, data } = {}) => {
      const id = socket.data.live; if (!id || typeof to !== 'string') return;
      const target = io.sockets.sockets.get(to);
      if (!target || target.data.live !== id) return;
      if (!socket.data.liveHost && !target.data.liveHost) return;   // seulement hôte <-> spectateur
      target.emit('live-signal', { from: socket.id, data });
    });
    socket.on('live-chat', async ({ text } = {}) => {
      const id = socket.data.live; if (!id) return;
      const now = Date.now(), last = chatLimit.get(socket.id) || 0;
      if (now - last < 1200) return; chatLimit.set(socket.id, now);
      const t = clean(text, 300); if (!t) return;
      const l = await db.get(id); if (!l || l.chat === false) return;
      const msg = { id: randomId(6), n: socket.data.liveName, t, at: now, h: !!socket.data.liveHost };
      const list = chats.get(id) || (l.messages || []).slice(); list.push(msg); if (list.length > 200) list.shift(); chats.set(id, list);
      l.messages = list; db.save(l, 10000);
      io.to('live:' + id).emit('live-chat', msg);
    });
    socket.on('live-leave', () => {
      const id = socket.data.live; if (!id) return;
      socket.leave('live:' + id);
      if (socket.data.liveHost && hosts.get(id) === socket.id) { hosts.delete(id); io.to('live:' + id).emit('live-host', { online: false }); }
      else if (hosts.has(id)) io.to(hosts.get(id)).emit('live-viewer-left', { peer: socket.id });
      socket.data.live = null; socket.data.liveHost = false; bump(id);
    });
    socket.on('live-name', ({ name } = {}) => { socket.data.liveName = clean(name, 40) || socket.data.liveName; });
    socket.on('disconnect', () => {
      chatLimit.delete(socket.id);
      const id = socket.data.live; if (!id) return;
      if (socket.data.liveHost && hosts.get(id) === socket.id) { hosts.delete(id); io.to('live:' + id).emit('live-host', { online: false }); }
      else if (hosts.has(id)) io.to(hosts.get(id)).emit('live-viewer-left', { peer: socket.id });
      bump(id);
    });
  });
  return { parseEmbed };
}

module.exports = { mountLive, parseEmbed };
