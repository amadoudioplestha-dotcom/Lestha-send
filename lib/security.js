'use strict';
/**
 * Sécurité partagée : empreinte d'IP (jamais l'IP en clair dans les métadonnées),
 * masquage pour l'affichage admin, et liste de blocage persistée dans le stockage.
 */
const crypto = require('crypto');

function createSecurity({ storage, secret }) {
  const KEY = 'system/blocklist.json';
  const blocked = new Map(); // ipHash -> { ipMasked, reason, at }

  const ipHash = (ip) => crypto.createHmac('sha256', secret).update('ip:' + String(ip || '')).digest('hex').slice(0, 24);

  function maskIp(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { const p = ip.split('.'); return `${p[0]}.${p[1]}.x.x`; }
    if (ip.includes(':')) return ip.split(':').slice(0, 2).join(':') + ':…';
    return ip ? ip.slice(0, 4) + '…' : 'inconnue';
  }

  async function load() {
    try {
      const buf = await storage.getBuffer(KEY);
      if (buf) JSON.parse(buf.toString()).forEach(b => blocked.set(b.ipHash, b));
    } catch (e) { console.warn('blocklist', e.message); }
  }
  async function save() {
    await storage.putBuffer(KEY, Buffer.from(JSON.stringify([...blocked.values()])), 'application/json');
  }

  return {
    ipHash, maskIp, load,
    isBlockedIp: (ip) => blocked.has(ipHash(ip)),
    isBlockedHash: (h) => blocked.has(h),
    list: () => [...blocked.values()].sort((a, b) => b.at - a.at),
    async block(hash, ipMasked, reason) {
      if (!/^[a-f0-9]{24}$/.test(String(hash))) throw Object.assign(new Error('Empreinte invalide'), { status: 400 });
      blocked.set(hash, { ipHash: hash, ipMasked: String(ipMasked || '').slice(0, 60), reason: String(reason || '').slice(0, 200), at: Date.now() });
      await save();
    },
    async unblock(hash) { blocked.delete(hash); await save(); }
  };
}

module.exports = { createSecurity };
