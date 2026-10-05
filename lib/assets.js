'use strict';
/**
 * Mise à jour garantie de l'interface après chaque déploiement.
 * La page HTML (jamais figée en cache) porte le numéro de version :
 * - les scripts et la feuille de style de la page reçoivent « ?v=VERSION » ;
 * - une « import map » fait de même pour tous les modules importés entre eux (./core.js…).
 * Un navigateur qui gardait d'anciens fichiers en mémoire charge donc forcément les nouveaux.
 * Les navigateurs trop anciens pour les import maps l'ignorent : tout fonctionne comme avant.
 */
const fs = require('fs');
const path = require('path');

function versionAssets(html, { publicDir, version }) {
  const v = encodeURIComponent(String(version || '0'));
  const list = (dir) => { try { return fs.readdirSync(path.join(publicDir, dir)).filter(f => f.endsWith('.js')); } catch (e) { return []; } };
  const imports = {};
  list('js').forEach(f => { imports['/js/' + f] = '/js/' + f + '?v=' + v; });
  const map = '<script type="importmap">' + JSON.stringify({ imports }) + '</script>\n';
  let out = html
    .replace(/(<script\b[^>]*\bsrc=")(\/js\/[\w.-]+\.js)(")/g, `$1$2?v=${v}$3`)
    .replace(/(<link\b[^>]*\bhref=")(\/style\.css)(")/g, `$1$2?v=${v}$3`);
  const i = out.search(/<script\b/i);
  out = i >= 0 ? out.slice(0, i) + map + out.slice(i) : out.replace('</head>', map + '</head>');
  return out;
}

module.exports = { versionAssets };
