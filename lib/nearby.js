'use strict';
/**
 * Mode « À proximité » : découverte des appareils sur le même réseau (même adresse publique),
 * appareils appairés par code (jeton HMAC, sans base de données), relais de signalisation WebRTC
 * et presse-papiers partagé. Les FICHIERS ne passent jamais par le serveur.
 */
const crypto = require('crypto');
const { validateDirectFiles } = require('./direct-transfer');
const { socketIp, rateLimiter } = require('./util');

/* Sur les données mobiles, des milliers d'abonnés partagent la même adresse publique :
   au-delà de ce nombre d'appareils sur « le même réseau », on considère qu'il s'agit d'un
   réseau partagé et l'on ne montre plus que les appareils associés par code. */
const CROWD = 12;

function mountNearby(io, { secret, security }) {
  const sendLimit = rateLimiter({ windowMs: 60e3, max: 8 });
  /** Repère court et stable de l'appareil (3 caractères) : permet de reconnaître ses propres appareils sans révéler leur nom */
  const tagOf = (deviceId) => crypto.createHmac('sha256', secret).update('tag:' + deviceId).digest('base64').replace(/[^A-Z2-9]/g, '').slice(0, 3).padEnd(3, 'X');
  const OS_LABEL = { Android: 'Android', iPhone: 'iPhone', iPad: 'iPad', Mac: 'Mac', Windows: 'PC Windows', Linux: 'PC Linux', Chromebook: 'Chromebook' };
  const neutralName = (n) => `${OS_LABEL[n.os] || 'Appareil'} · ${n.tag || tagOf(String(n.deviceId || ''))}`;
  const codes = new Map(); // code -> { deviceId, name, kind, os, exp }
  const pairToken = (a, b) => crypto.createHmac('sha256', secret).update('pair:' + [a, b].sort().join('|')).digest('base64url').slice(0, 32);
  const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
  const clean = (s, n = 40) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

  setInterval(() => { const now = Date.now(); for (const [c, v] of codes) if (v.exp < now) codes.delete(c); }, 60e3).unref();

  /** Ce qu'un autre appareil voit : le vrai nom seulement s'il est associé, sinon un nom neutre */
  const info = (s, viewer) => {
    const n = s.data.near; if (!n) return null;
    const trusted = !!(viewer && viewer.paired && viewer.paired.has(n.deviceId));
    return { deviceId: n.deviceId, name: trusted ? n.name : neutralName(n), kind: n.kind, os: n.os, tag: n.tag || tagOf(String(n.deviceId || '')) };
  };
  async function groupSize(group) { return (await io.in(group).fetchSockets()).filter(s => s.data.near).length; }

  async function listFor(socket) {
    const me = socket.data.near; if (!me) return { peers: [], crowded: false };
    const out = new Map();
    const local = (await io.in(me.group).fetchSockets()).filter(s => s.data.near && s.data.near.deviceId !== me.deviceId);
    const crowded = local.length + 1 > CROWD;
    for (const s of local) {
      const n = s.data.near;
      if (crowded && !me.paired.has(n.deviceId)) continue;
      out.set(n.deviceId, Object.assign(info(s, me), { via: 'local', paired: me.paired.has(n.deviceId) }));
    }
    for (const peer of me.paired) {
      if (out.has(peer)) continue;
      for (const s of await io.in('dev:' + peer).fetchSockets()) {
        if (s.data.near) { out.set(peer, Object.assign(info(s, me), { via: 'paired', paired: true })); break; }
      }
    }
    return { peers: [...out.values()], crowded };
  }
  function notifyChanged(near) {
    if (!near) return;
    io.to(near.group).emit('near-changed');
    near.paired.forEach(p => io.to('dev:' + p).emit('near-changed'));
  }
  async function allowed(socket, to) {
    const me = socket.data.near;
    if (!me || !okId(to) || to === me.deviceId) return false;
    if (me.paired.has(to)) return true;
    // Appareil non associé : seulement sur un vrai réseau local, pas sur un réseau partagé par des inconnus
    if (await groupSize(me.group) > CROWD) return false;
    const targets = await io.in('dev:' + to).fetchSockets();
    return targets.some(s => s.data.near && s.data.near.group === me.group);
  }

  io.on('connection', (socket) => {
    const ip = socketIp(socket);

    socket.on('near-join', async (p = {}, cb) => {
      if (!okId(p.deviceId)) return cb && cb({ ok: false });
      const prev = socket.data.near;
      if (prev && prev.deviceId !== p.deviceId) socket.leave('dev:' + prev.deviceId);
      const group = 'near:' + (security ? security.ipHash(ip) : crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24));
      const paired = new Set((Array.isArray(p.pairs) ? p.pairs.slice(0, 50) : []).filter(x => x && okId(x.peer) && x.token === pairToken(p.deviceId, x.peer)).map(x => x.peer));
      socket.data.near = { deviceId: p.deviceId, tag: tagOf(p.deviceId), name: clean(p.name) || 'Appareil', kind: ['mobile', 'tablet', 'desktop'].includes(p.kind) ? p.kind : 'desktop', os: clean(p.os, 20), group, paired };
      socket.join(group); socket.join('dev:' + p.deviceId);
      notifyChanged(socket.data.near);
      if (cb) { const l = await listFor(socket); cb({ ok: true, peers: l.peers, crowded: l.crowded, tag: socket.data.near.tag }); }
    });

    socket.on('near-leave', () => {
      const n = socket.data.near; if (!n) return;
      socket.leave(n.group); socket.leave('dev:' + n.deviceId);
      socket.data.near = null;
      notifyChanged(n);
    });

    socket.on('near-list', async (cb) => { if (typeof cb === 'function') { const l = await listFor(socket); cb({ peers: l.peers, crowded: l.crowded }); } });

    socket.on('near-rename', (name) => {
      const n = socket.data.near; if (!n) return;
      n.name = clean(name) || n.name;
      notifyChanged(n);
    });

    /* Appairage : A affiche un code, B le saisit → jeton partagé, vérifiable sans stockage */
    socket.on('pair-create', (cb) => {
      const n = socket.data.near; if (!n || typeof cb !== 'function') return;
      let code; do { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (codes.has(code));
      for (const [c, v] of codes) if (v.deviceId === n.deviceId) codes.delete(c);   // un seul code actif par appareil
      codes.set(code, { deviceId: n.deviceId, name: n.name, kind: n.kind, os: n.os, exp: Date.now() + 5 * 60e3, tries: 0 });
      cb({ code, expiresIn: 300 });
    });
    socket.on('pair-join', async (code, cb) => {
      const n = socket.data.near; if (!n || typeof cb !== 'function') return;
      if (!sendLimit('pair:' + ip)) return cb({ ok: false, error: 'Trop d\'essais. Patientez une minute.' });
      const c = codes.get(String(code || '').replace(/\D/g, ''));
      if (!c || c.exp < Date.now()) return cb({ ok: false, error: 'Code invalide ou expiré.' });
      if (c.deviceId === n.deviceId) return cb({ ok: false, error: 'C\'est le code de cet appareil.' });
      codes.delete(String(code).replace(/\D/g, ''));
      const token = pairToken(n.deviceId, c.deviceId);
      io.to('dev:' + c.deviceId).emit('pair-done', { peer: { deviceId: n.deviceId, name: n.name, kind: n.kind, os: n.os }, token });
      cb({ ok: true, token, peer: { deviceId: c.deviceId, name: c.name, kind: c.kind, os: c.os } });
    });

    /* Proposition d'envoi (fichiers ou texte) */
    socket.on('near-send', async (p = {}, cb) => {
      if (!sendLimit('send:' + socket.id)) return cb && cb({ ok: false, error: 'Trop d\'envois d\'un coup. Patientez une minute.' });
      if (!(await allowed(socket, p.to))) return cb && cb({ ok: false, error: 'Appareil injoignable.' });
      const target = (await io.in('dev:' + p.to).fetchSockets()).find(s => s.data.near);
      const payload = { from: info(socket, target && target.data.near), offerId: clean(p.offerId, 40), kind: p.kind === 'text' ? 'text' : 'files' };
      if (payload.kind === 'text') payload.text = String(p.text || '').slice(0, 20000);
      else {
        const validation = validateDirectFiles(p.files);
        if (!validation.ok) return cb && cb({ ok: false, error: validation.error });
        payload.files = p.files.map(f => ({ name: clean(f.name, 300) || 'fichier', size: f.size, type: clean(f.type, 100) }));
        payload.total = validation.total;
      }
      io.to('dev:' + p.to).emit('near-incoming', payload);
      if (cb) cb({ ok: true });
    });
    for (const ev of ['near-reply', 'near-signal', 'near-cancel']) {
      socket.on(ev, async (p = {}) => {
        if (!(await allowed(socket, p.to))) return;
        io.to('dev:' + p.to).emit(ev, { from: info(socket, { paired: socket.data.near.paired.has(p.to) ? new Set([socket.data.near.deviceId]) : new Set() }), offerId: clean(p.offerId, 40), accept: !!p.accept, data: ev === 'near-signal' ? p.data : undefined, reason: clean(p.reason, 100) });
      });
    }

    socket.on('disconnect', () => { if (socket.data.near) notifyChanged(socket.data.near); });
  });
}

module.exports = { mountNearby };
