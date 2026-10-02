'use strict';
/**
 * Métadonnées des transferts — persistées DANS le stockage (R2 ou disque),
 * sous forme de JSON : meta/<id>.json. Le serveur reste donc sans état :
 * un redémarrage (Render, mise en veille, redéploiement) ne casse aucun lien.
 */
function createDb(storage, prefix = 'meta/', { maxCache = 2000 } = {}) {
  const cache = new Map();       // id -> transfer (ordre d'insertion = du plus ancien au plus récent)
  const timers = new Map();      // id -> timeout d'écriture différée
  const key = (id) => `${prefix}${id}.json`;

  const loading = new Map();      // id -> Promise (évite deux copies d'un même transfert lors de requêtes simultanées)
  async function get(id) {
    if (!/^[A-Za-z0-9]{6,32}$/.test(String(id))) return null;
    if (cache.has(id)) { const t = cache.get(id); cache.delete(id); cache.set(id, t); return t; }   // garde l'ordre « récemment utilisé »
    if (loading.has(id)) return loading.get(id);
    const p = (async () => {
      const buf = await storage.getBuffer(key(id));
      if (!buf) return null;
      try {
        const t = JSON.parse(buf.toString('utf8'));
        if (!cache.has(id)) { cache.set(id, t); trim(); }
        return cache.get(id);
      } catch (e) { return null; }
    })();
    loading.set(id, p);
    try { return await p; } finally { loading.delete(id); }
  }

  /* Une fiche n'est oubliée que si elle est inactive depuis 30 minutes et n'attend aucune écriture :
     deux copies d'un même transfert en cours d'envoi pourraient sinon s'écraser l'une l'autre. */
  const IDLE = 30 * 60e3;
  const idle = (id) => { const t = cache.get(id); return !timers.has(id) && t && Date.now() - (t.updatedAt || t.createdAt || 0) > IDLE; };
  /** Cache borné : on oublie d'abord les fiches les moins récemment utilisées */
  function trim() {
    if (cache.size <= maxCache) return;
    for (const id of [...cache.keys()]) {
      if (cache.size <= maxCache) break;
      if (idle(id)) cache.delete(id);
    }
  }
  /** Libère une fiche inactive du cache (lectures en masse : nettoyage, console admin) */
  function release(id) { if (idle(id)) cache.delete(id); }

  async function writeNow(t) {
    clearTimeout(timers.get(t.id)); timers.delete(t.id);
    t.updatedAt = Date.now();
    await storage.putBuffer(key(t.id), Buffer.from(JSON.stringify(t)), 'application/json');
  }

  /** Écriture différée (regroupe les rafales d'événements : vues, téléchargements…) */
  function save(t, delay = 1500) {
    if (!cache.has(t.id)) { cache.set(t.id, t); trim(); } else cache.set(t.id, t);
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
    const keys = await storage.listKeys(prefix);
    const re = new RegExp('^' + prefix.replace('/', '\\/') + '([A-Za-z0-9]+)\\.json$');
    return keys.map(k => (k.match(re) || [])[1]).filter(Boolean);
  }

  async function flushAll() {
    const pending = [...timers.keys()].map(id => cache.get(id)).filter(Boolean);
    await Promise.all(pending.map(writeNow));
  }

  return { get, save, remove, listIds, flushAll, release, cache };
}

module.exports = { createDb };
