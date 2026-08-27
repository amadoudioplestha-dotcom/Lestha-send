try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) {}
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size, webrtc: true }));
app.get('/api/ice-config', (_, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (process.env.TURN_URL) iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  res.json({ iceServers });
});
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function expired(room) { return !room || Date.now() >= room.expiresAt; }
function safeCallback(cb, value) { if (typeof cb === 'function') cb(value); }
app.post('/api/send-email', async (req, res) => {
  const { to, link, fileName } = req.body || {};
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !link) return res.status(400).json({ error: 'Email ou lien invalide.' });
  if (!nodemailer || !process.env.SMTP_HOST) return res.status(503).json({ error: 'Service email non configuré (SMTP_HOST).' });
  try {
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
    await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject: `Fichier à récupérer : ${fileName || 'transfert'}`, text: `Récupérez le fichier ici : ${link}` });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Échec de l’envoi email.' }); }
});
setInterval(() => { for (const [id, room] of rooms) if (expired(room)) { if (room.receiverSocketId) io.to(room.receiverSocketId).emit('link-expired'); rooms.delete(id); } }, 60_000);
io.on('connection', socket => {
  socket.on('create-room', ({ expiresIn, pin } = {}, cb) => {
    const seconds = Math.min(Math.max(Number(expiresIn) || 3600, 3600), 7 * 86400);
    const roomId = crypto.randomBytes(12).toString('hex');
    rooms.set(roomId, { senderSocketId: socket.id, receiverSocketId: null, offer: null, iceCandidates: [], expiresAt: Date.now() + seconds * 1000, pinHash: pin ? hash(pin) : null });
    socket.join(roomId); socket.roomId = roomId; socket.role = 'sender';
    safeCallback(cb, { success: true, roomId, expiresAt: rooms.get(roomId).expiresAt });
  });
  socket.on('send-offer', ({ roomId, offer } = {}) => { const r = rooms.get(roomId); if (r && r.senderSocketId === socket.id && !expired(r)) { r.offer = offer; if (r.receiverSocketId) io.to(r.receiverSocketId).emit('offer-received', { offer }); } });
  socket.on('join-room', ({ roomId, pin } = {}, cb) => {
    const r = rooms.get(roomId);
    if (expired(r)) { rooms.delete(roomId); return safeCallback(cb, { success: false, error: 'Lien expiré.' }); }
    if (r.receiverSocketId) return safeCallback(cb, { success: false, error: 'Room déjà occupée.' });
    if (r.pinHash && hash(pin || '') !== r.pinHash) return safeCallback(cb, { success: false, error: 'Code PIN incorrect.' });
    r.receiverSocketId = socket.id; socket.join(roomId); socket.roomId = roomId; socket.role = 'receiver'; safeCallback(cb, { success: true, expiresAt: r.expiresAt });
    io.to(r.senderSocketId).emit('receiver-joined'); if (r.offer) socket.emit('offer-received', { offer: r.offer });
  });
  socket.on('send-answer', ({ roomId, answer } = {}) => { const r = rooms.get(roomId); if (r?.receiverSocketId === socket.id) io.to(r.senderSocketId).emit('answer-received', { answer }); });
  socket.on('ice-candidate', ({ roomId, candidate } = {}) => { const r = rooms.get(roomId); if (!r) return; const target = socket.id === r.senderSocketId ? r.receiverSocketId : r.senderSocketId; if (target) io.to(target).emit('ice-candidate', candidate); else r.iceCandidates.push({ from: socket.id, candidate }); });
  socket.on('get-ice-candidates', ({ roomId } = {}, cb) => { const r = rooms.get(roomId); if (!r) return safeCallback(cb, { candidates: [] }); const other = socket.id === r.senderSocketId ? r.receiverSocketId : r.senderSocketId; const candidates = r.iceCandidates.filter(x => x.from === other).map(x => x.candidate); safeCallback(cb, { candidates }); });
  socket.on('cancel-transfer', ({ roomId } = {}) => { const r = rooms.get(roomId); if (r?.senderSocketId === socket.id) { if (r.receiverSocketId) io.to(r.receiverSocketId).emit('peer-cancelled'); rooms.delete(roomId); } });
  socket.on('disconnect', () => { const r = rooms.get(socket.roomId); if (!r) return; const other = socket.id === r.senderSocketId ? r.receiverSocketId : r.senderSocketId; if (other) io.to(other).emit('peer-disconnected'); if (socket.id === r.senderSocketId) rooms.delete(socket.roomId); else r.receiverSocketId = null; });
});
server.listen(PORT, () => console.log(`TransferX écoute sur le port ${PORT}`));
