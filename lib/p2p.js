'use strict';
/**
 * Signalisation WebRTC du mode "Direct P2P" (zéro stockage).
 * Nouveautés :
 *  - la room SURVIT à la déconnexion de l'expéditeur (changement d'appli, veille, réseau) ;
 *    il la récupère avec sa clé expéditeur ("reclaim-room") et les transferts reprennent
 *  - récupération possible même après un redémarrage du serveur
 *  - relance de négociation à la demande du destinataire (ICE échouée)
 */
const crypto = require('crypto');
const { randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter, socketIp, deviceFromUA, browserFromUA, PIN_RE, PIN_RULE } = require('./util');

/** Identifiants de salle : 8 caractères tirés au hasard cryptographique (les anciens à 6 restent reconnus) */
const ROOM_RE = /^TX-[A-Z0-9]{6,8}$/;

function mountP2P(io, { security, storage, stats, codes } = {}) {
  const codeLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 15 });       // codes à 6 chiffres essayés par adresse
  const pendingReq = new Map();                                              // demandes « Recevoir » en attente d'accord
  const roomAlive = (id) => { const r = rooms.get(id); return !!r && Date.now() <= r.expiresAt; };
  const rooms = new Map();
  const joinLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });     // essais de PIN par adresse et par salle
  const lookupLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 60 });   // tentatives d'accès par adresse (toutes salles)
  const reclaimLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
  const roomKey = (id) => `p2p/${id}.json`;

  /* La clé de l'expéditeur est conservée dans le stockage : après un redémarrage du serveur,
     seul le véritable expéditeur peut reprendre son lien. */
  function persist(room) {
    if (!storage) return;
    storage.putBuffer(roomKey(room.id), Buffer.from(JSON.stringify({ k: room.senderKeyHash, exp: room.expiresAt })), 'application/json')
      .catch(e => console.warn('p2p persist', e.message));
  }
  function forget(id) { if (storage) storage.deleteKey(roomKey(id)).catch(() => {}); }
  async function saved(id) {
    if (!storage) return null;
    try { const b = await storage.getBuffer(roomKey(id)); return b ? JSON.parse(b.toString()) : null; } catch (e) { return null; }
  }

  function generateRoomId() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = 'TX-';
      for (let i = 0; i < 8; i++) code += chars.charAt(crypto.randomInt(chars.length));
    } while (rooms.has(code));
    return code;
  }

  function newRoom({ roomId, senderSocketId, senderKeyHash, ttl, pin, destroyOnDownload, info, expiresAt }) {
    const room = {
      id: roomId, senderSocketId, senderKeyHash, senderOnline: !!senderSocketId,
      receivers: new Set(), iceCandidates: new Map(),
      createdAt: Date.now(), expiresAt: expiresAt || Date.now() + ttl,
      pin: pin ? hashPin(pin) : null, downloadCount: 0, destroyOnDownload: !!destroyOnDownload,
      info: info || null, lastSenderSeen: Date.now()
    };
    rooms.set(roomId, room);
    return room;
  }

  function sanitizeInfo(info) {
    if (!info || !Array.isArray(info.files)) return null;
    return { files: info.files.slice(0, 500).map(f => ({ name: String(f.name || '').slice(0, 300), size: Number(f.size) || 0 })) };
  }

  setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      if (now > room.expiresAt || now - room.createdAt > 7 * 86400000) {
        room.receivers.forEach(id => io.to(id).emit('peer-disconnected', { reason: 'expired' }));
        rooms.delete(roomId);
        forget(roomId);
      }
    }
  }, 60000).unref();

  io.on('connection', (socket) => {
    const ip = socketIp(socket);

    socket.on('create-room', (payload, callback) => {
      if (typeof payload === 'function') { callback = payload; payload = {}; }
      payload = payload || {};
      if (security && security.isBlockedIp(ip)) return callback && callback({ success: false, error: 'Envoi bloqué depuis cette connexion.' });
      const ttl = Math.min(Math.max(parseInt(payload.ttl, 10) || 3600000, 60000), 7 * 86400000);
      if (payload.pin && !PIN_RE.test(String(payload.pin))) return callback && callback({ success: false, error: PIN_RULE });
      const pin = payload.pin ? String(payload.pin) : null;
      if (socket.roomId && rooms.has(socket.roomId) && socket.role === 'sender') {
        const old = rooms.get(socket.roomId);
        old.receivers.forEach(id => io.to(id).emit('peer-disconnected'));
        rooms.delete(socket.roomId);
        forget(socket.roomId);
      }
      const roomId = generateRoomId();
      const senderKey = randomKey(18);
      const room = newRoom({ roomId, senderSocketId: socket.id, senderKeyHash: sha256(senderKey), ttl, pin, destroyOnDownload: payload.destroyOnDownload === true, info: sanitizeInfo(payload.info) });
      if (security) room.creator = { ipHash: security.ipHash(ip), ipMasked: security.maskIp(ip) };
      persist(room);
      if (stats) stats.add({ direct: 1 });
      io.to('admin').emit('admin-event', { id: roomId, title: 'Lien direct P2P', event: { t: Date.now(), type: 'p2p_created', n: room.info ? room.info.files.length : 0, size: room.info ? room.info.files.reduce((s, f) => s + f.size, 0) : 0 } });
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'sender';
      if (typeof callback === 'function') callback({ roomId, senderKey, success: true, expiresAt: room.expiresAt, code: codes ? codes.forRoom(roomId) : null });
    });

    /** L'expéditeur revient (nouvelle connexion socket, page rechargée, serveur redémarré…) */
    socket.on('reclaim-room', async (payload, callback) => {
      const { roomId, senderKey, pin, destroyOnDownload, info } = payload || {};
      if (!roomId || typeof senderKey !== 'string' || !ROOM_RE.test(roomId)) return callback && callback({ success: false, error: 'Données invalides' });
      if (!reclaimLimit(ip)) return callback && callback({ success: false, error: 'Trop de tentatives, patientez.' });
      let room = rooms.get(roomId);
      if (!room) {
        // Serveur redémarré : la salle n'est rendue qu'à celui qui présente la clé enregistrée à sa création
        const rec = await saved(roomId);
        if (!rec || Date.now() > rec.exp) return callback && callback({ success: false, error: 'Lien expiré' });
        if (!safeEqual(sha256(senderKey), rec.k)) return callback && callback({ success: false, error: 'Clé expéditeur invalide' });
        if (rooms.has(roomId)) room = rooms.get(roomId);
        else room = newRoom({ roomId, senderSocketId: null, senderKeyHash: rec.k, expiresAt: rec.exp, pin: pin && /^\d{4,8}$/.test(String(pin)) ? String(pin) : null, destroyOnDownload, info: sanitizeInfo(info) });
      }
      if (!safeEqual(sha256(senderKey), room.senderKeyHash)) return callback && callback({ success: false, error: 'Clé expéditeur invalide' });
      room.senderSocketId = socket.id; room.senderOnline = true; room.lastSenderSeen = Date.now();
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'sender';
      room.receivers.forEach(id => io.to(id).emit('sender-online'));
      if (typeof callback === 'function') callback({ success: true, receivers: [...room.receivers], expiresAt: room.expiresAt, downloadCount: room.downloadCount, code: codes ? codes.forRoom(roomId) : null });
    });

    /* ---------- Bouton « Recevoir » : code à 6 chiffres ---------- */
    socket.on('code-lookup', async ({ code, name } = {}, cb) => {
      if (typeof cb !== 'function' || !codes) return;
      if (codes.locked()) return cb({ error: 'Trop d\'essais sur le service. Réessayez dans quelques minutes.' });
      if (!codeLimit(ip)) return cb({ error: 'Trop d\'essais depuis cette connexion. Patientez quelques minutes.' });
      const r = await codes.resolve(String(code || '').replace(/\D/g, ''), roomAlive).catch(() => null);
      if (!r) { codes.noteFail(); return cb({ error: 'Code inconnu ou expiré. Vérifiez les 6 chiffres.' }); }
      if (r.kind === 'cloud') return cb({ kind: 'cloud', path: '/t/' + r.id });
      const room = rooms.get(r.roomId);
      if (!room.senderOnline || !room.senderSocketId) return cb({ error: 'L\'expéditeur n\'est pas connecté pour l\'instant. Demandez-lui de rouvrir Lestha Send.' });
      if ([...pendingReq.values()].filter(p => p.roomId === r.roomId).length >= 3) return cb({ error: 'D\'autres demandes attendent déjà l\'accord de l\'expéditeur. Réessayez dans un instant.' });
      // L'accès n'est donné qu'après l'accord explicite de l'expéditeur : le code seul ne suffit pas
      const reqId = randomKey(8);
      const ua = socket.handshake.headers['user-agent'] || '';
      const who = { reqId, name: String(name || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 30), device: deviceFromUA(ua), browser: browserFromUA(ua) };
      const timer = setTimeout(() => {
        if (!pendingReq.delete(reqId)) return;
        io.to(room.senderSocketId).emit('join-request-cancel', { reqId });
        cb({ error: 'L\'expéditeur n\'a pas répondu à temps. Réessayez.' });
      }, 90000);
      pendingReq.set(reqId, { roomId: r.roomId, cb, timer, receiver: socket.id });
      io.to(room.senderSocketId).emit('join-request', who);
    });
    socket.on('join-answer', ({ reqId, ok } = {}) => {
      const p = pendingReq.get(reqId); if (!p) return;
      const room = rooms.get(p.roomId);
      if (!room || room.senderSocketId !== socket.id) return;
      pendingReq.delete(reqId); clearTimeout(p.timer);
      p.cb(ok === true ? { kind: 'direct', path: '/?room=' + p.roomId } : { error: 'L\'expéditeur a refusé la demande.' });
    });

    socket.on('send-offer', ({ roomId, offer, receiverId }) => {
      const room = rooms.get(roomId);
      if (!room || room.senderSocketId !== socket.id || !receiverId) return;
      io.to(receiverId).emit('offer-received', { offer });
    });

    socket.on('join-room', ({ roomId, pin } = {}, callback) => {
      if (!lookupLimit(ip)) return callback && callback({ success: false, error: 'Trop de tentatives depuis cette connexion. Patientez quelques minutes.' });
      const room = rooms.get(roomId);
      if (!room) return callback && callback({ success: false, error: 'Lien invalide ou expiré. Si l\'expéditeur rouvre Lestha Send, le lien redeviendra actif.', retry: true });
      if (Date.now() > room.expiresAt) { rooms.delete(roomId); return callback && callback({ success: false, error: 'Ce lien a expiré.' }); }
      if (room.pin) {
        if (!pin) return callback && callback({ success: false, pinRequired: true });
        if (!joinLimit(ip + roomId)) return callback && callback({ success: false, pinRequired: true, error: 'Trop de tentatives, patientez.' });
        room.pinFailLog = (room.pinFailLog || []).filter(ts => Date.now() - ts < 3600e3);
        if (room.pinFailLog.length >= 20) return callback && callback({ success: false, pinRequired: true, error: 'Ce lien est verrouillé pendant une heure après trop de codes erronés.' });
        if (!checkPin(String(pin), room.pin)) { room.pinFailLog.push(Date.now()); return callback && callback({ success: false, pinRequired: true, error: 'Code PIN incorrect.' }); }
      }
      room.receivers.add(socket.id);
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'receiver';
      if (typeof callback === 'function') callback({ success: true, senderOnline: room.senderOnline, info: room.info });
      if (room.senderOnline) io.to(room.senderSocketId).emit('receiver-joined', { receiverId: socket.id, totalReceivers: room.receivers.size });
    });

    /** Le destinataire demande une nouvelle négociation (connexion WebRTC perdue) */
    socket.on('request-restart', ({ roomId, relay } = {}) => {
      const room = rooms.get(roomId);
      if (!room || !room.receivers.has(socket.id) || !room.senderOnline) return;
      io.to(room.senderSocketId).emit('receiver-joined', { receiverId: socket.id, totalReceivers: room.receivers.size, restart: true, relay: relay === true });
    });

    socket.on('send-answer', ({ roomId, answer } = {}) => {
      const room = rooms.get(roomId);
      if (!room || !room.senderOnline || !room.receivers.has(socket.id)) return;
      io.to(room.senderSocketId).emit('answer-received', { answer, receiverId: socket.id });
    });

    socket.on('ice-candidate', ({ roomId, candidate, targetId } = {}) => {
      const room = rooms.get(roomId);
      if (!room) return;
      const member = (id) => id === room.senderSocketId || room.receivers.has(id);
      if (!member(socket.id)) return;                          // seuls les membres de la salle échangent leurs candidats
      if (targetId) return member(targetId) && io.to(targetId).emit('ice-candidate', { candidate, from: socket.id });
      if (socket.id !== room.senderSocketId && room.senderOnline) return io.to(room.senderSocketId).emit('ice-candidate', { candidate, from: socket.id });
      if (!room.iceCandidates.has(socket.id)) room.iceCandidates.set(socket.id, []);
      const list = room.iceCandidates.get(socket.id);
      list.push(candidate); if (list.length > 50) list.shift();
    });

    socket.on('get-ice-candidates', ({ roomId } = {}, callback) => {
      const room = rooms.get(roomId);
      if (!room || !(socket.id === room.senderSocketId || room.receivers.has(socket.id))) return callback && callback({ candidates: [] });
      const myRole = socket.id === room.senderSocketId ? 'sender' : 'receiver';
      const candidates = [];
      room.iceCandidates.forEach((list, fromId) => {
        const fromRole = fromId === room.senderSocketId ? 'sender' : 'receiver';
        if (fromRole !== myRole) list.forEach(c => candidates.push(c));
      });
      if (typeof callback === 'function') callback({ candidates });
    });

    socket.on('download-complete', ({ roomId } = {}) => {
      const room = rooms.get(roomId);
      if (!room || !room.receivers.has(socket.id)) return;
      room.downloadCount++;
      io.to('admin').emit('admin-event', { id: roomId, title: 'Lien direct P2P', event: { t: Date.now(), type: 'p2p_download' } });
      if (room.senderOnline) io.to(room.senderSocketId).emit('download-notification', { receiverId: socket.id, totalDownloads: room.downloadCount, timestamp: Date.now() });
      if (room.destroyOnDownload) {
        room.receivers.forEach(id => { if (id !== socket.id) io.to(id).emit('peer-disconnected', { reason: 'destroyed' }); });
        if (room.senderOnline) io.to(room.senderSocketId).emit('transfer-destroyed');
        rooms.delete(roomId);
        forget(roomId);
      }
    });

    socket.on('cancel-transfer', ({ roomId } = {}) => {
      const room = rooms.get(roomId);
      if (!room || room.senderSocketId !== socket.id) return;
      room.receivers.forEach(id => io.to(id).emit('peer-cancelled'));
      rooms.delete(roomId);
      forget(roomId);
    });

    socket.on('leave-room', ({ roomId } = {}) => {
      const room = rooms.get(roomId);
      if (!room || !room.receivers.has(socket.id)) return;
      room.receivers.delete(socket.id);
      if (room.senderOnline) io.to(room.senderSocketId).emit('receiver-left', { receiverId: socket.id, totalReceivers: room.receivers.size });
    });

    socket.on('disconnect', () => {
      const room = socket.roomId && rooms.get(socket.roomId);
      if (!room) return;
      if (socket.id === room.senderSocketId) {
        // ✅ On NE détruit PLUS la room : l'expéditeur peut revenir
        room.senderOnline = false; room.senderSocketId = null; room.lastSenderSeen = Date.now();
        room.receivers.forEach(id => io.to(id).emit('sender-offline'));
      } else if (room.receivers.delete(socket.id) && room.senderOnline) {
        io.to(room.senderSocketId).emit('receiver-left', { receiverId: socket.id, totalReceivers: room.receivers.size });
      }
    });

    socket.on('ping-keepalive', () => socket.emit('pong-keepalive'));
  });

  return { rooms };
}

module.exports = { mountP2P };
