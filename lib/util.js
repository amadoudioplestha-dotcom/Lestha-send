'use strict';
const crypto = require('crypto');

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomId(len = 10) {
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    const v = bytes[i];
    if (v < 248) out += B62[v % 62]; // évite le biais modulo
  }
  while (out.length < len) out += B62[crypto.randomInt(62)];
  return out;
}

const randomKey = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}
function checkPin(pin, rec) {
  if (!rec) return true;
  if (!pin) return false;
  return safeEqual(hashPin(pin, rec.salt).hash, rec.hash);
}

/** Jetons signés HMAC (accès PIN, URLs locales) */
function makeSigner(secret) {
  const mac = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  return {
    sign(obj) {
      const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return body + '.' + mac(body);
    },
    verify(token) {
      if (!token || typeof token !== 'string' || !token.includes('.')) return null;
      const [body, sig] = token.split('.');
      if (!safeEqual(mac(body), sig)) return null;
      try {
        const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (obj.exp && Date.now() > obj.exp) return null;
        return obj;
      } catch (e) { return null; }
    },
    mac
  };
}

/** Limiteur de débit en mémoire */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    return h.count <= max;
  };
}

function clientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '').toString();
}

function deviceFromUA(ua = '') {
  if (/iPad|Tablet/i.test(ua)) return 'tablette';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'ordinateur';
}
function browserFromUA(ua = '') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  if (/curl|wget|aria2/i.test(ua)) return 'Gestionnaire de téléchargement';
  return 'Autre';
}

function cleanName(name, fallback = 'fichier') {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\]/g, '/').trim();
  return (n || fallback).slice(0, 400);
}

module.exports = { randomId, randomKey, sha256, safeEqual, hashPin, checkPin, makeSigner, rateLimiter, clientIp, deviceFromUA, browserFromUA, cleanName };
