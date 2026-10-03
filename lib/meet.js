'use strict';
/**
 * Réunions audio et vidéo (mode « Réunion »).
 *
 *  - Créer : un lien /reunion/ID + un code à 6 chiffres, sans compte. L'organisateur garde une clé privée.
 *  - Rejoindre : prénom, micro coupé à l'arrivée ; lever la main ; partage d'écran.
 *  - Organisateur : couper un micro ou tous les micros, baisser une main, retirer quelqu'un,
 *    verrouiller la réunion, la terminer pour tous.
 *
 * Deux moteurs :
 *  - « mesh » (par défaut) : chaque appareil se connecte aux autres (WebRTC + relais TURN).
 *    Idéal jusqu'à 12 personnes en audio, 6 en vidéo.
 *  - « sfu » (si CF_SFU_APP_ID et CF_SFU_APP_TOKEN sont définis) : chacun envoie sa voix une seule fois
 *    au serveur Cloudflare Realtime, qui la redistribue. Jusqu'à MEET_MAX personnes (50 par défaut).
 *    Le secret Cloudflare reste sur le serveur : l'écran passe par /api/meet/:id/sfu.
 *
 * Rien n'est enregistré : ni la voix, ni la vidéo, ni la liste des participants.
 */
const crypto = require('crypto');
const { rateLimiter, clientIp, socketIp, sha256, safeEqual } = require('./util');

const ID_RE = /^[a-z0-9]{10}$/;
const KINDS = ['audio', 'video'];
const TRACKS = ['a', 'c', 's'];                    // micro, caméra, écran
const IDLE_MS = 15 * 60e3;                          // réunion vide : fermée après 15 min
const MAX_MS = 10 * 3600e3;                         // durée maximale d'une réunion
const clip = (s, n) => String(s == null ? '' : s).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const newId = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 10; i++) s += a[crypto.randomInt(a.length)]; return s; };

function createSfu(env, { fetchImpl = globalThis.fetch } = {}) {
  const appId = (env.CF_SFU_APP_ID || '').trim(), token = (env.CF_SFU_APP_TOKEN || '').trim();
  if (!appId || !token) return null;
  const base = `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}`;
  async function call(method, path, body) {
    const r = await fetchImpl(base + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || j.errorCode) {
      const e = new Error('Cloudflare Realtime : ' + ((j && (j.errorDescription || j.errorCode)) || 'HTTP ' + r.status));
      e.status = 502; throw e;
    }
    return j;
  }
  return {
    newSession: () => call('POST', '/sessions/new'),
    tracks: (sid, body) => call('POST', `/sessions/${encodeURIComponent(sid)}/tracks/new`, body),
    renegotiate: (sid, body) => call('PUT', `/sessions/${encodeURIComponent(sid)}/renegotiate`, body),
    close: (sid, body) => call('PUT', `/sessions/${encodeURIComponent(sid)}/tracks/close`, body)
  };
}

function mountMeet(app, io, { env, codes, ctx, fetchImpl } = {}) {
  const sfu = createSfu(env || {}, { fetchImpl });
  const forced = String((env && env.MEET_ENGINE) || 'auto').toLowerCase();
  const engine = forced === 'mesh' || !sfu ? 'mesh' : 'sfu';
  const MAX = Math.max(2, Math.min(200, Number(env && env.MEET_MAX) || 50));
  const limitFor = (m) => (m.engine === 'sfu' ? MAX : m.kind === 'video' ? 6 : 12);
  const meetings = new Map();
  const createLimit = rateLimiter({ windowMs: 3600e3, max: 20 });
  const joinLimit = rateLimiter({ windowMs: 10 * 60e3, max: 60 });
  const sfuLimit = rateLimiter({ windowMs: 60e3, max: 240 });

  const pub = (p) => ({ pid: p.pid, name: p.name, host: p.host, muted: p.muted, cam: p.cam, screen: p.screen, hand: p.hand || 0, tracks: [...p.tracks] });
  const info = (m) => ({ id: m.id, title: m.title, kind: m.kind, engine: m.engine, code: m.code, locked: m.locked, startedAt: m.createdAt, max: limitFor(m), emergency: m.emergency });
  const room = (m) => 'meet:' + m.id;
  const alive = (id) => meetings.has(id);

  function endMeeting(m, reason) {
    io.to(room(m)).emit('meet-ended', { reason });
    for (const p of m.people.values()) {
      const s = io.sockets.sockets.get(p.sid); if (s) { s.leave(room(m)); s.meetId = null; }
    }
    if (codes) codes.dropMeet(m.id);
    meetings.delete(m.id);
  }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const m of meetings.values()) {
      if (now - m.createdAt > MAX_MS) endMeeting(m, 'Durée maximale atteinte.');
      else if (!m.people.size && now - m.emptySince > IDLE_MS) endMeeting(m, 'expired');
    }
  }, 60e3);
  if (sweep.unref) sweep.unref();

  function leave(socket, why) {
    const m = meetings.get(socket.meetId); if (!m) return;
    const p = [...m.people.values()].find(x => x.sid === socket.id); if (!p) return;
    m.people.delete(p.pid);
    socket.leave(room(m)); socket.meetId = null;
    io.to(room(m)).emit('meet-left', { pid: p.pid, why: why || 'left' });
    if (p.session && sfu && p.mids.length) sfu.close(p.session, { tracks: p.mids.map(mid => ({ mid })), force: true }).catch(() => {});
    if (!m.people.size) m.emptySince = Date.now();
  }

  /* ---------- signalisation (socket.io) ---------- */
  io.on('connection', (socket) => {
    const ip = socketIp(socket);

    socket.on('meet-create', ({ title, kind, emergency } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (ctx && ctx.settings && !ctx.settings.on('meet')) return cb({ error: 'Les réunions sont désactivées pour le moment.' });
      if (!createLimit(ip)) return cb({ error: 'Trop de réunions créées depuis cette connexion. Réessayez plus tard.' });
      let id; do { id = newId(); } while (meetings.has(id));
      const hostKey = crypto.randomBytes(18).toString('base64url');
      const m = {
        id, title: clip(title, 80) || (emergency ? 'Réunion urgente' : 'Réunion'), kind: KINDS.includes(kind) ? kind : 'audio',
        engine, hostHash: sha256(hostKey), createdAt: Date.now(), emptySince: Date.now(), locked: false, emergency: !!emergency, people: new Map()
      };
      m.code = codes ? codes.forMeet(id) : null;
      meetings.set(id, m);
      if (ctx && ctx.io) ctx.io.to('admin').emit('admin-event', { id, title: 'Réunion', event: { t: Date.now(), type: 'meet_created', kind: m.kind } });
      cb({ id, hostKey, code: m.code, kind: m.kind });
    });

    socket.on('meet-peek', ({ id } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const m = meetings.get(id);
      if (!m) return cb({ error: 'Cette réunion n\'existe pas ou est terminée.' });
      cb({ meeting: info(m), count: m.people.size });
    });

    socket.on('meet-join', ({ id, name, hostKey } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!joinLimit(ip)) return cb({ error: 'Trop de tentatives. Patientez quelques minutes.' });
      const m = meetings.get(id);
      if (!m || !ID_RE.test(String(id))) return cb({ error: 'Cette réunion n\'existe pas ou est terminée.' });
      const isHost = typeof hostKey === 'string' && hostKey.length > 10 && safeEqual(sha256(hostKey), m.hostHash);
      if (socket.meetId) leave(socket, 'left');
      if (m.locked && !isHost) return cb({ error: 'L\'organisateur a verrouillé cette réunion.' });
      if (m.people.size >= limitFor(m)) return cb({ error: `La réunion est complète (${limitFor(m)} personnes au maximum).` });
      const pid = crypto.randomBytes(6).toString('hex');
      const token = crypto.randomBytes(18).toString('base64url');
      const p = { pid, sid: socket.id, token, name: clip(name, 30) || 'Invité', host: isHost, muted: true, cam: false, screen: false, hand: 0, tracks: new Set(), session: null, mids: [] };
      const others = [...m.people.values()].map(pub);
      m.people.set(pid, p);
      socket.join(room(m)); socket.meetId = m.id;
      socket.to(room(m)).emit('meet-joined', pub(p));
      cb({ ok: true, self: pub(p), token, meeting: info(m), people: others });
    });

    socket.on('meet-state', (s = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const p = [...m.people.values()].find(x => x.sid === socket.id); if (!p) return;
      if ('muted' in s) p.muted = !!s.muted;
      if ('cam' in s) p.cam = !!s.cam && m.kind === 'video';
      if ('screen' in s) p.screen = !!s.screen;
      if ('hand' in s) p.hand = s.hand ? (p.hand || Date.now()) : 0;
      io.to(room(m)).emit('meet-state', pub(p));
    });

    /* Signalisation WebRTC (moteur mesh) : uniquement entre membres de la même réunion */
    socket.on('meet-signal', ({ to, data } = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const from = [...m.people.values()].find(x => x.sid === socket.id);
      const target = m.people.get(to);
      if (!from || !target || !data || typeof data !== 'object') return;
      io.to(target.sid).emit('meet-signal', { from: from.pid, data });
    });

    socket.on('meet-host', ({ action, pid } = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const me = [...m.people.values()].find(x => x.sid === socket.id);
      if (!me || !me.host) return;
      const target = pid ? m.people.get(pid) : null;
      if (action === 'mute' && target) io.to(target.sid).emit('meet-force', { action: 'mute', by: me.name });
      else if (action === 'muteAll') { for (const p of m.people.values()) if (p.pid !== me.pid) io.to(p.sid).emit('meet-force', { action: 'mute', by: me.name }); }
      else if (action === 'lower' && target) { target.hand = 0; io.to(room(m)).emit('meet-state', pub(target)); }
      else if (action === 'remove' && target && !target.host) {
        io.to(target.sid).emit('meet-force', { action: 'remove', by: me.name });
        const s = io.sockets.sockets.get(target.sid); if (s) leave(s, 'removed');
      } else if (action === 'lock' || action === 'unlock') { m.locked = action === 'lock'; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'end') endMeeting(m, 'L\'organisateur a terminé la réunion.');
    });

    socket.on('meet-leave', () => leave(socket, 'left'));
    socket.on('disconnect', () => leave(socket, 'left'));
  });

  /* ---------- relais vers Cloudflare Realtime (moteur sfu) ---------- */
  app.post('/api/meet/:id/sfu', async (req, res) => {
    if (!sfu) return res.status(404).json({ error: 'Serveur de réunion non configuré.' });
    if (!sfuLimit(clientIp(req))) return res.status(429).json({ error: 'Trop de requêtes.' });
    const m = meetings.get(req.params.id);
    const token = String(req.get('x-meet-token') || '');
    const p = m && [...m.people.values()].find(x => x.token.length === token.length && safeEqual(x.token, token));
    if (!p) return res.status(403).json({ error: 'Vous ne faites plus partie de cette réunion.' });
    const b = req.body || {};
    try {
      if (!p.session) p.session = (await sfu.newSession()).sessionId;
      if (b.op === 'push') {
        const tracks = (Array.isArray(b.tracks) ? b.tracks : []).filter(t => TRACKS.includes(t.kind) && typeof t.mid === 'string').slice(0, 3);
        if (!tracks.length || !b.sessionDescription) return res.status(400).json({ error: 'Requête invalide.' });
        const r = await sfu.tracks(p.session, { sessionDescription: b.sessionDescription, tracks: tracks.map(t => ({ location: 'local', mid: t.mid, trackName: p.pid + '-' + t.kind })) });
        tracks.forEach(t => { p.tracks.add(t.kind); p.mids.push(t.mid); });
        io.to(room(m)).emit('meet-state', pub(p));
        return res.json({ sessionDescription: r.sessionDescription, tracks: r.tracks || [] });
      }
      if (b.op === 'pull') {
        const want = (Array.isArray(b.tracks) ? b.tracks : []).slice(0, 30).map(t => {
          const o = m.people.get(t.pid);
          return o && o.session && o.tracks.has(t.kind) && o.pid !== p.pid ? { location: 'remote', sessionId: o.session, trackName: o.pid + '-' + t.kind, _pid: o.pid, _kind: t.kind } : null;
        }).filter(Boolean);
        if (!want.length) return res.json({ tracks: [] });
        const r = await sfu.tracks(p.session, { tracks: want.map(({ _pid, _kind, ...t }) => t) });
        const out = (r.tracks || []).map(t => { const w = want.find(x => x.trackName === t.trackName && x.sessionId === t.sessionId) || {}; return { mid: t.mid, pid: w._pid, kind: w._kind, error: t.errorCode || null }; });
        out.forEach(t => { if (t.mid) p.mids.push(t.mid); });
        return res.json({ sessionDescription: r.sessionDescription || null, requiresImmediateRenegotiation: !!r.requiresImmediateRenegotiation, tracks: out });
      }
      if (b.op === 'renegotiate') {
        if (!b.sessionDescription) return res.status(400).json({ error: 'Requête invalide.' });
        await sfu.renegotiate(p.session, { sessionDescription: b.sessionDescription });
        return res.json({ ok: true });
      }
      if (b.op === 'close') {
        const mids = (Array.isArray(b.mids) ? b.mids : []).filter(x => typeof x === 'string').slice(0, 30);
        if (mids.length) await sfu.close(p.session, { tracks: mids.map(mid => ({ mid })), force: true });
        return res.json({ ok: true });
      }
      res.status(400).json({ error: 'Opération inconnue.' });
    } catch (e) {
      console.warn('meet sfu', e.message);
      res.status(e.status || 500).json({ error: 'Le serveur audio ne répond pas. Réessayez dans un instant.' });
    }
  });

  return {
    engine, alive, meetings,
    stats: () => { let people = 0; meetings.forEach(m => { people += m.people.size; }); return { meetings: meetings.size, people, engine }; }
  };
}

module.exports = { mountMeet, createSfu };
