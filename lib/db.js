'use strict';
/**
 * Métadonnées des transferts — persistées DANS le stockage (R2 ou disque),
 * sous forme de JSON : meta/<id>.json. Le serveur reste donc sans état :
 * un redémarrage (Render, mise en veille, redéploiement) ne casse aucun lien.
 */
function createDb(storage) {
  const cache = new Map();       // id -> transfer
  const timers = new Map();      // id -> timeout d'écriture différée
  const key = (id) => `meta/${id}.json`;

  async function get(id) {
    if (!/^[A-Za-z0-9]{6,32}$/.test(String(id))) return null;
    if (cache.has(id)) return cache.get(id);
    const buf = await storage.getBuffer(key(id));
    if (!buf) return null;
    try {
      const t = JSON.parse(buf.toString('utf8'));
      cache.set(id, t);
      return t;
    } catch (e) { return null; }
  }

  async function writeNow(t) {
    clearTimeout(timers.get(t.id)); timers.delete(t.id);
    t.updatedAt = Date.now();
    await storage.putBuffer(key(t.id), Buffer.from(JSON.stringify(t)), 'application/json');
  }

  /** Écriture différée (regroupe les rafales d'événements : vues, téléchargements…) */
  function save(t, delay = 1500) {
    cache.set(t.id, t);
    if (delay === 0) return writeNow(t);
    if (timers.has(t.id)) return Promise.resolve();
    timers.set(t.id, setTimeout(() => { writeNow(t).catch(e => console.error('db.save', e.message)); }, delay));
    return Promise.resolve();
  }

  async function remove(id) {
    clearTimeout(timers.get(id)); timers.delete(id);
    cache.delete(id);
    try { await storage.deleteKey(key(id)); } catch (e) { /* ignore */ }
  }

  async function listIds() {
    const keys = await storage.listKeys('meta/');
    return keys.map(k => (k.match(/^meta\/([A-Za-z0-9]+)\.json$/) || [])[1]).filter(Boolean);
  }

  async function flushAll() {
    const pending = [...timers.keys()].map(id => cache.get(id)).filter(Boolean);
    await Promise.all(pending.map(writeNow));
  }

  return { get, save, remove, listIds, flushAll, cache };
}

module.exports = { createDb };
