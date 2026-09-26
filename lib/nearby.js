'use strict';
/**
 * Mode « À proximité » : découverte des appareils sur le même réseau (même adresse publique),
 * appareils appairés par code (jeton HMAC, sans base de données), relais de signalisation WebRTC
 * et presse-papiers partagé. Les FICHIERS ne passent jamais par le serveur.
 */
const crypto = require('crypto');

function mountNearby(io, { secret, security }) {
  const codes = new Map(); // code -> { deviceId, name, kind, os, exp }
  const pairToken = (a, b) => crypto.createHmac('sha256', secret).update('pair:' + [a, b].sort().join('|')).digest('base64url').slice(0, 32);
  const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
  const clean = (s, n = 40) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

  setInterval(() => { const now = Date.now(); for (const [c, v] of codes) if (v.exp < now) codes.delete(c); }, 60e3).unref();

  const info = (s) => s.data.near && { deviceId: s.data.near.deviceId, name: s.data.near.name, kind: s.data.near.kind, os: s.data.near.os };

  async function listFor(socket) {
    const me = socket.data.near; if (!me) return [];
    const out = new Map();
    for (const s of await io.in(me.group).fetchSockets()) {
      const n = s.data.near;
      if (n && n.deviceId !== me.deviceId) out.set(n.deviceId, Object.assign(info(s), { via: 'local' }));
    }
    for (const peer of me.paired) {
      if (out.has(peer)) { out.get(peer).paired = true; continue; }
      for (const s of await io.in('dev:' + peer).fetchSockets()) {
        if (s.data.near) { out.set(peer, Object.assign(info(s), { via: 'paired', paired: true })); break; }
      }
    }
    return [...out.values()];
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
    const targets = await io.in('dev:' + to).fetchSockets();
    return targets.some(s => s.data.near && s.data.near.group === me.group);
  }

  io.on('connection', (socket) => {
    const ip = socket.handshake.headers['cf-connecting-ip'] || (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;

    socket.on('near-join', async (p = {}, cb) => {
      if (!okId(p.deviceId)) return cb && cb({ ok: false });
      const prev = socket.data.near;
      if (prev && prev.deviceId !== p.deviceId) socket.leave('dev:' + prev.deviceId);
      const group = 'near:' + (security ? security.ipHash(ip) : crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24));
      const paired = new Set((Array.isArray(p.pairs) ? p.pairs.slice(0, 50) : []).filter(x => x && okId(x.peer) && x.token === pairToken(p.deviceId, x.peer)).map(x => x.peer));
      socket.data.near = { deviceId: p.deviceId, name: clean(p.name) || 'Appareil', kind: ['mobile', 'tablet', 'desktop'].includes(p.kind) ? p.kind : 'desktop', os: clean(p.os, 20), group, paired };
      socket.join(group); socket.join('dev:' + p.deviceId);
      notifyChanged(socket.data.near);
      if (cb) cb({ ok: true, peers: await listFor(socket) });
    });

    socket.on('near-leave', () => {
      const n = socket.data.near; if (!n) return;
      socket.leave(n.group); socket.leave('dev:' + n.deviceId);
      socket.data.near = null;
      notifyChanged(n);
    });

    socket.on('near-list', async (cb) => { if (typeof cb === 'function') cb({ peers: await listFor(socket) }); });

    socket.on('near-rename', (name) => {
      const n = socket.data.near; if (!n) return;
      n.name = clean(name) || n.name;
      notifyChanged(n);
    });

    /* Appairage : A affiche un code, B le saisit → jeton partagé, vérifiable sans stockage */
    socket.on('pair-create', (cb) => {
      const n = socket.data.near; if (!n || typeof cb !== 'function') return;
      let code; do { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (codes.has(code));
      codes.set(code, { deviceId: n.deviceId, name: n.name, kind: n.kind, os: n.os, exp: Date.now() + 5 * 60e3 });
      cb({ code, expiresIn: 300 });
    });
    socket.on('pair-join', async (code, cb) => {
      const n = socket.data.near; if (!n || typeof cb !== 'function') return;
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
      if (!(await allowed(socket, p.to))) return cb && cb({ ok: false, error: 'Appareil injoignable.' });
      const payload = { from: info(socket), offerId: clean(p.offerId, 40), kind: p.kind === 'text' ? 'text' : 'files' };
      if (payload.kind === 'text') payload.text = String(p.text || '').slice(0, 20000);
      else {
        payload.files = (Array.isArray(p.files) ? p.files.slice(0, 2000) : []).map(f => ({ name: clean(f.name, 300), size: Number(f.size) || 0, type: clean(f.type, 100) }));
        payload.total = payload.files.reduce((s, f) => s + f.size, 0);
      }
      io.to('dev:' + p.to).emit('near-incoming', payload);
      if (cb) cb({ ok: true });
    });
    for (const ev of ['near-reply', 'near-signal', 'near-cancel']) {
      socket.on(ev, async (p = {}) => {
        if (!(await allowed(socket, p.to))) return;
        io.to('dev:' + p.to).emit(ev, { from: info(socket), offerId: clean(p.offerId, 40), accept: !!p.accept, data: ev === 'near-signal' ? p.data : undefined, reason: clean(p.reason, 100) });
      });
    }

    socket.on('disconnect', () => { if (socket.data.near) notifyChanged(socket.data.near); });
  });
}

module.exports = { mountNearby };
