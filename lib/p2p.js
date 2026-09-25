'use strict';
/**
 * Signalisation WebRTC du mode "Direct P2P" (zéro stockage).
 * Nouveautés :
 *  - la room SURVIT à la déconnexion de l'expéditeur (changement d'appli, veille, réseau) ;
 *    il la récupère avec sa clé expéditeur ("reclaim-room") et les transferts reprennent
 *  - récupération possible même après un redémarrage du serveur
 *  - relance de négociation à la demande du destinataire (ICE échouée)
 */
const { randomKey, sha256, safeEqual, hashPin, checkPin, rateLimiter } = require('./util');

function mountP2P(io) {
  const rooms = new Map();
  const joinLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });

  function generateRoomId() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = 'TX-';
      for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
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
      }
    }
  }, 60000).unref();

  io.on('connection', (socket) => {
    const ip = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;

    socket.on('create-room', (payload, callback) => {
      if (typeof payload === 'function') { callback = payload; payload = {}; }
      payload = payload || {};
      const ttl = Math.min(Math.max(parseInt(payload.ttl, 10) || 3600000, 60000), 7 * 86400000);
      const pin = payload.pin && /^\d{4,8}$/.test(String(payload.pin)) ? String(payload.pin) : null;
      if (socket.roomId && rooms.has(socket.roomId) && socket.role === 'sender') {
        const old = rooms.get(socket.roomId);
        old.receivers.forEach(id => io.to(id).emit('peer-disconnected'));
        rooms.delete(socket.roomId);
      }
      const roomId = generateRoomId();
      const senderKey = randomKey(18);
      const room = newRoom({ roomId, senderSocketId: socket.id, senderKeyHash: sha256(senderKey), ttl, pin, destroyOnDownload: payload.destroyOnDownload === true, info: sanitizeInfo(payload.info) });
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'sender';
      if (typeof callback === 'function') callback({ roomId, senderKey, success: true, expiresAt: room.expiresAt });
    });

    /** L'expéditeur revient (nouvelle connexion socket, page rechargée, serveur redémarré…) */
    socket.on('reclaim-room', (payload, callback) => {
      const { roomId, senderKey, expiresAt, pin, destroyOnDownload, info } = payload || {};
      if (!roomId || !senderKey || !/^TX-[A-Z0-9]{6}$/.test(roomId)) return callback && callback({ success: false, error: 'Données invalides' });
      let room = rooms.get(roomId);
      if (!room) {
        if (!expiresAt || Date.now() > expiresAt) return callback && callback({ success: false, error: 'Lien expiré' });
        room = newRoom({ roomId, senderSocketId: null, senderKeyHash: sha256(senderKey), expiresAt: Math.min(expiresAt, Date.now() + 7 * 86400000), pin, destroyOnDownload, info: sanitizeInfo(info) });
      }
      if (!safeEqual(sha256(senderKey), room.senderKeyHash)) return callback && callback({ success: false, error: 'Clé expéditeur invalide' });
      room.senderSocketId = socket.id; room.senderOnline = true; room.lastSenderSeen = Date.now();
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'sender';
      room.receivers.forEach(id => io.to(id).emit('sender-online'));
      if (typeof callback === 'function') callback({ success: true, receivers: [...room.receivers], expiresAt: room.expiresAt, downloadCount: room.downloadCount });
    });

    socket.on('send-offer', ({ roomId, offer, receiverId }) => {
      const room = rooms.get(roomId);
      if (!room || room.senderSocketId !== socket.id || !receiverId) return;
      io.to(receiverId).emit('offer-received', { offer });
    });

    socket.on('join-room', ({ roomId, pin } = {}, callback) => {
      const room = rooms.get(roomId);
      if (!room) return callback && callback({ success: false, error: 'Lien invalide ou expiré. Si l\'expéditeur rouvre TransferX, le lien redeviendra actif.', retry: true });
      if (Date.now() > room.expiresAt) { rooms.delete(roomId); return callback && callback({ success: false, error: 'Ce lien a expiré.' }); }
      if (room.pin) {
        if (!pin) return callback && callback({ success: false, pinRequired: true });
        if (!joinLimit(ip + roomId)) return callback && callback({ success: false, pinRequired: true, error: 'Trop de tentatives, patientez.' });
        if (!checkPin(pin, room.pin)) return callback && callback({ success: false, pinRequired: true, error: 'Code PIN incorrect.' });
      }
      room.receivers.add(socket.id);
      socket.join(roomId);
      socket.roomId = roomId; socket.role = 'receiver';
      if (typeof callback === 'function') callback({ success: true, senderOnline: room.senderOnline, info: room.info });
      if (room.senderOnline) io.to(room.senderSocketId).emit('receiver-joined', { receiverId: socket.id, totalReceivers: room.receivers.size });
    });

    /** Le destinataire demande une nouvelle négociation (connexion WebRTC perdue) */
    socket.on('request-restart', ({ roomId } = {}) => {
      const room = rooms.get(roomId);
      if (!room || !room.receivers.has(socket.id) || !room.senderOnline) return;
      io.to(room.senderSocketId).emit('receiver-joined', { receiverId: socket.id, totalReceivers: room.receivers.size, restart: true });
    });

    socket.on('send-answer', ({ roomId, answer }) => {
      const room = rooms.get(roomId);
      if (!room || !room.senderOnline) return;
      io.to(room.senderSocketId).emit('answer-received', { answer, receiverId: socket.id });
    });

    socket.on('ice-candidate', ({ roomId, candidate, targetId }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (targetId) return io.to(targetId).emit('ice-candidate', { candidate, from: socket.id });
      if (socket.id !== room.senderSocketId && room.senderOnline) return io.to(room.senderSocketId).emit('ice-candidate', { candidate, from: socket.id });
      if (!room.iceCandidates.has(socket.id)) room.iceCandidates.set(socket.id, []);
      const list = room.iceCandidates.get(socket.id);
      list.push(candidate); if (list.length > 50) list.shift();
    });

    socket.on('get-ice-candidates', ({ roomId } = {}, callback) => {
      const room = rooms.get(roomId);
      if (!room) return callback && callback({ candidates: [] });
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
      if (room.senderOnline) io.to(room.senderSocketId).emit('download-notification', { receiverId: socket.id, totalDownloads: room.downloadCount, timestamp: Date.now() });
      if (room.destroyOnDownload) {
        room.receivers.forEach(id => { if (id !== socket.id) io.to(id).emit('peer-disconnected', { reason: 'destroyed' }); });
        if (room.senderOnline) io.to(room.senderSocketId).emit('transfer-destroyed');
        rooms.delete(roomId);
      }
    });

    socket.on('cancel-transfer', ({ roomId } = {}) => {
      const room = rooms.get(roomId);
      if (!room || room.senderSocketId !== socket.id) return;
      room.receivers.forEach(id => io.to(id).emit('peer-cancelled'));
      rooms.delete(roomId);
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
