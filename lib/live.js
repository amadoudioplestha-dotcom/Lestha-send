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

function mountLive(app, { storage, io, env, ctx }) {
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
  const isMod = (l, key) => !!(key && l.modHash && safeEqual(sha256(String(key)), l.modHash));

  router.post('/lives', async (req, res, next) => {
    try {
      if (!createLimit(clientIp(req))) return fail(res, 429, 'Trop de directs créés, patientez.');
      const b = req.body || {};
      const kind = ['embed', 'camera', 'hls'].includes(b.kind) ? b.kind : 'embed';
      if (kind === 'camera') return fail(res, 410, 'La classe virtuelle est remplacée par « Réunion » (mode Cours).');
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
      const hostKey = randomKey(18), modKey = randomKey(18);
      l.hostHash = sha256(hostKey); l.modHash = sha256(modKey);
      l.waitingRoom = !!b.waitingRoom;
      await db.save(l, 0);
      res.json({ id: l.id, hostKey, modKey, live: publicView(l) });
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

  /** Liste de présence (tuteur ou modérateur) */
  router.get('/lives/:id/attendance', async (req, res, next) => {
    try {
      const l = await load(req, res); if (!l) return;
      const k = req.get('x-owner-key'); if (!isHost(l, k) && !isMod(l, k)) return fail(res, 403, 'Clé invalide.');
      const now = Date.now();
      res.json({ title: l.title, rows: Object.values(l.attendance || {}).map(r => ({ name: r.n, role: r.r, first: r.first, last: r.in ? now : r.last, minutes: Math.round((r.total + (r.in ? now - r.in : 0)) / 60000), joins: r.joins, online: !!r.in })) });
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

  /* ---------------- temps réel : classe virtuelle (rôles, mains levées, parole, modération, sondages, présence) ---------------- */
  const rooms = new Map();   // id -> état en mémoire
  const R = (id) => { if (!rooms.has(id)) rooms.set(id, { locked: false, speakers: new Set(), hands: new Map(), banned: new Set(), admitted: new Set(), poll: null }); return rooms.get(id); };
  async function viewers(id) { if (!io) return 0; const s = await io.in('live:' + id).fetchSockets(); return s.filter(x => x.data.role === 'learner').length; }
  const chatLimit = new Map();
  if (!io) return {};
  const staff = (s) => s.data.role === 'host' || s.data.role === 'mod';
  const broadcaster = (s) => s.data.role === 'host' || (s.data.live && R(s.data.live).speakers.has(s.id));
  const pollView = (p) => p && { id: p.id, q: p.q, opts: p.opts, counts: p.opts.map((_, i) => [...p.votes.values()].filter(v => v === i).length), total: p.votes.size, open: p.open };

  async function pushState(id) {
    const r = R(id), l = await db.get(id);
    const inRoom = await io.in('live:' + id).fetchSockets();
    const participants = inRoom.map(s => ({ id: s.id, name: s.data.name, role: s.data.role, hand: r.hands.get(s.id) || null, speaker: r.speakers.has(s.id), muted: !!s.data.muted }));
    const base = { participants, locked: r.locked, waitingRoom: !!(l && l.waitingRoom), poll: pollView(r.poll), viewers: participants.filter(p => p.role === 'learner').length };
    io.to('live:' + id).emit('live-state', base);
    const waiting = (await io.in('livewait:' + id).fetchSockets()).map(s => ({ id: s.id, name: s.data.name }));
    io.to('livestaff:' + id).emit('live-waiting', waiting);
    io.to('live:' + id).emit('live-viewers', { id, n: base.viewers });
  }
  async function attend(id, s, on) {
    if (!s.data.v) return;
    const l = await db.get(id); if (!l) return;
    l.attendance = l.attendance || {};
    const now = Date.now();
    const rec = l.attendance[s.data.v] = l.attendance[s.data.v] || { n: s.data.name, r: s.data.role, first: now, last: now, total: 0, joins: 0 };
    rec.n = s.data.name || rec.n;
    if (on && !rec.in) { rec.in = now; rec.joins++; }
    if (!on && rec.in) { rec.total += now - rec.in; rec.in = null; rec.last = now; }
    if (Object.keys(l.attendance).length > 2000) return;
    db.save(l, 5000);
  }
  async function admit(s, id) {
    s.leave('livewait:' + id); s.data.waiting = false;
    s.join('live:' + id); s.data.live = id;
    if (staff(s)) s.join('livestaff:' + id);
    if (s.data.v) R(id).admitted.add(s.data.v);
    const l = await db.get(id);
    if (s.data.role === 'host' && l && l.kind === 'camera') { hosts.set(id, s.id); io.to('live:' + id).emit('live-host', { online: true, peer: s.id }); }
    // chaque diffuseur (tuteur + apprenants qui ont la parole) envoie son flux au nouvel arrivant
    const others = await io.in('live:' + id).fetchSockets();
    others.forEach(o => { if (o.id !== s.id && broadcaster(o)) o.emit('live-viewer', { peer: s.id }); });
    attend(id, s, true);
    s.emit('live-admitted', { role: s.data.role, hostPeer: hosts.get(id) || null });
    pushState(id);
  }
  function leave(s) {
    const id = s.data.live || s.data.waitId; if (!id) return;
    const r = R(id);
    s.leave('live:' + id); s.leave('livewait:' + id); s.leave('livestaff:' + id);
    r.hands.delete(s.id);
    if (r.speakers.delete(s.id)) io.to('live:' + id).emit('live-speaker-off', { peer: s.id });
    if (s.data.role === 'host' && hosts.get(id) === s.id) { hosts.delete(id); io.to('live:' + id).emit('live-host', { online: false }); }
    else io.to('live:' + id).emit('live-viewer-left', { peer: s.id });
    if (s.data.live) attend(id, s, false);
    s.data.live = null; s.data.waitId = null;
    pushState(id);
  }

  io.on('connection', (socket) => {
    socket.on('live-join', async ({ id, key, name, v } = {}, cb) => {
      try {
        const l = await db.get(String(id || '')); if (!l || l.deleted) return cb && cb({ error: 'Direct introuvable.' });
        const r = R(l.id);
        socket.data.role = isHost(l, key) ? 'host' : isMod(l, key) ? 'mod' : 'learner';
        socket.data.name = clean(name, 40) || (socket.data.role === 'host' ? (l.hostName || 'Tuteur') : 'Invité');
        socket.data.v = /^[\w-]{6,64}$/.test(String(v || '')) ? String(v) : null;
        const learner = socket.data.role === 'learner';
        if (learner && socket.data.v && r.banned.has(socket.data.v)) return cb && cb({ error: 'Vous avez été retiré de cette salle par l\'animateur.' });
        if (learner && l.kind === 'camera' && (await viewers(l.id)) >= MAX_CAMERA_VIEWERS) return cb && cb({ error: `Salle pleine (${MAX_CAMERA_VIEWERS} participants max).` });
        if (learner && r.locked && !(socket.data.v && r.admitted.has(socket.data.v))) return cb && cb({ error: 'La salle est verrouillée par l\'animateur.' });
        if (learner && l.kind === 'camera' && l.waitingRoom && !(socket.data.v && r.admitted.has(socket.data.v))) {
          socket.join('livewait:' + l.id); socket.data.waiting = true; socket.data.waitId = l.id;
          cb && cb({ ok: true, waiting: true, role: 'learner' });
          io.to('livestaff:' + l.id).emit('live-knock', { name: socket.data.name });
          return pushState(l.id);
        }
        cb && cb({ ok: true, role: socket.data.role, host: socket.data.role === 'host', viewers: await viewers(l.id), hostOnline: hosts.has(l.id) });
        admit(socket, l.id);
      } catch (e) { cb && cb({ error: 'Erreur' }); }
    });
    socket.on('live-leave', () => leave(socket));
    socket.on('live-peers', async (_, cb) => {
      const id = socket.data.live; if (!id || !broadcaster(socket)) return cb && cb([]);
      cb && cb((await io.in('live:' + id).fetchSockets()).filter(s => s.id !== socket.id).map(s => s.id));
    });
    socket.on('live-signal', ({ to, data } = {}) => {
      const id = socket.data.live; if (!id || typeof to !== 'string') return;
      const target = io.sockets.sockets.get(to);
      if (!target || target.data.live !== id) return;
      if (!broadcaster(socket) && !broadcaster(target)) return;   // au moins un diffuseur dans l'échange
      target.emit('live-signal', { from: socket.id, data });
    });
    socket.on('live-chat', async ({ text } = {}) => {
      const id = socket.data.live; if (!id) return;
      const now = Date.now(), last = chatLimit.get(socket.id) || 0;
      if (now - last < 1200) return; chatLimit.set(socket.id, now);
      const t = clean(text, 300); if (!t) return;
      const l = await db.get(id); if (!l || (l.chat === false && !staff(socket))) return;
      const msg = { id: randomId(6), n: socket.data.name, t, at: now, h: staff(socket) };
      const list = chats.get(id) || (l.messages || []).slice(); list.push(msg); if (list.length > 200) list.shift(); chats.set(id, list);
      l.messages = list; db.save(l, 10000);
      io.to('live:' + id).emit('live-chat', msg);
    });
    socket.on('live-name', ({ name } = {}) => { socket.data.name = clean(name, 40) || socket.data.name; if (socket.data.live) pushState(socket.data.live); });
    socket.on('live-hand', ({ up } = {}) => {
      const id = socket.data.live; if (!id) return;
      const r = R(id); if (up) r.hands.set(socket.id, Date.now()); else r.hands.delete(socket.id);
      if (up) io.to('livestaff:' + id).emit('live-hand-up', { name: socket.data.name });
      pushState(id);
    });
    socket.on('live-react', ({ e } = {}) => {
      const id = socket.data.live; if (!id || !['👍', '👏', '❤️', '😂', '❓', '🐢'].includes(e)) return;
      const now = Date.now(); if (now - (socket.data.lastReact || 0) < 800) return; socket.data.lastReact = now;
      io.to('live:' + id).emit('live-react', { e, n: socket.data.name });
    });
    socket.on('live-giveback', () => {
      const id = socket.data.live; if (!id) return;
      if (R(id).speakers.delete(socket.id)) { io.to('live:' + id).emit('live-speaker-off', { peer: socket.id }); pushState(id); }
    });
    socket.on('live-muted-self', ({ muted } = {}) => { socket.data.muted = !!muted; if (socket.data.live) pushState(socket.data.live); });
    socket.on('live-vote', ({ i } = {}) => {
      const id = socket.data.live; if (!id) return; const p = R(id).poll;
      if (!p || !p.open || !Number.isInteger(i) || i < 0 || i >= p.opts.length) return;
      p.votes.set(socket.data.v || socket.id, i); pushState(id);
    });
    /* ---- actions réservées au tuteur et au modérateur ---- */
    socket.on('live-mod', async ({ action, target, on, q, opts } = {}) => {
      const id = socket.data.live; if (!id || !staff(socket)) return;
      const r = R(id), t = target ? io.sockets.sockets.get(target) : null;
      const inRoom = t && (t.data.live === id || t.data.waitId === id);
      switch (action) {
        case 'floor': if (inRoom && t.data.live === id) { r.speakers.add(t.id); r.hands.delete(t.id); t.emit('live-floor', { on: true }); } break;
        case 'unfloor': if (inRoom && r.speakers.delete(t.id)) { t.emit('live-floor', { on: false }); io.to('live:' + id).emit('live-speaker-off', { peer: t.id }); } break;
        case 'mute': if (inRoom) t.emit('live-muted', { by: socket.data.name }); break;
        case 'muteAll': (await io.in('live:' + id).fetchSockets()).forEach(s => { if (s.id !== socket.id && s.data.role !== 'host') s.emit('live-muted', { by: socket.data.name }); }); break;
        case 'lower': if (target) r.hands.delete(target); break;
        case 'lowerAll': r.hands.clear(); break;
        case 'remove':
          if (inRoom && t.data.role === 'learner') { if (t.data.v) r.banned.add(t.data.v); t.emit('live-kicked'); leave(t); }
          break;
        case 'admit': if (t && t.data.waitId === id && t.data.waiting) admit(t, id); break;
        case 'admitAll': (await io.in('livewait:' + id).fetchSockets()).forEach(s => admit(s, id)); break;
        case 'deny': if (t && t.data.waiting) { t.emit('live-kicked', { denied: true }); leave(t); } break;
        case 'lock': r.locked = !!on; break;
        case 'waitingRoom': { const l = await db.get(id); if (l) { l.waitingRoom = !!on; db.save(l, 0); } if (!on) (await io.in('livewait:' + id).fetchSockets()).forEach(s => admit(s, id)); break; }
        case 'poll': {
          const qq = clean(q, 200), oo = (Array.isArray(opts) ? opts : []).map(o => clean(o, 80)).filter(Boolean).slice(0, 6);
          if (!qq || oo.length < 2) return;
          r.poll = { id: randomId(5), q: qq, opts: oo, votes: new Map(), open: true }; break;
        }
        case 'pollClose': if (r.poll) r.poll.open = false; break;
        case 'pollClear': r.poll = null; break;
        default: return;
      }
      pushState(id);
    });
    socket.on('disconnect', () => { chatLimit.delete(socket.id); leave(socket); });
  });
  return { parseEmbed };
}

module.exports = { mountLive, parseEmbed };
