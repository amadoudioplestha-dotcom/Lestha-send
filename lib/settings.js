'use strict';
/**
 * Réglages du site modifiables depuis la console (sans redéployer).
 * modules : services affichés dans le menu. Un service désactivé disparaît du menu,
 * sa page affiche « indisponible » et ses routes refusent les nouvelles demandes.
 */
const KEY = 'system/settings.json';
const MODULES = {
  nearby: { label: 'À proximité', on: true },
  meet: { label: 'Réunion', on: true },
  live: { label: 'Direct vidéo', on: true },
  classroom: { label: 'Classe BBB (serveur BigBlueButton requis)', on: false }
};

function createSettings(storage) {
  let s = { modules: {} };
  const ready = storage.getBuffer(KEY).then(b => { if (b) { try { s = Object.assign(s, JSON.parse(b.toString('utf8'))); } catch (e) { /* ignore */ } } }).catch(() => {});
  const modules = () => Object.fromEntries(Object.entries(MODULES).map(([k, d]) => [k, typeof s.modules[k] === 'boolean' ? s.modules[k] : d.on]));
  return {
    ready,
    modules,
    on: (k) => modules()[k] !== false,
    list: () => Object.entries(MODULES).map(([k, d]) => ({ key: k, label: d.label, on: modules()[k] })),
    async setModules(patch) {
      for (const [k, v] of Object.entries(patch || {})) if (MODULES[k] && typeof v === 'boolean') s.modules[k] = v;
      await storage.putBuffer(KEY, Buffer.from(JSON.stringify(s)), 'application/json');
      return modules();
    }
  };
}

module.exports = { createSettings, MODULES };
