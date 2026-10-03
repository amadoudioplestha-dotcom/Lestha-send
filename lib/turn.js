'use strict';
/**
 * Serveurs ICE (STUN/TURN) pour le mode Direct.
 *
 *  - STUN : Google ×2 + Cloudflare (connexion directe quand les réseaux le permettent)
 *  - TURN Cloudflare (recommandé) : CF_TURN_KEY_ID + CF_TURN_API_TOKEN
 *      → identifiants éphémères générés par l'API Cloudflare, renouvelés automatiquement.
 *        C'est ce relais qui sauve les transferts entre réseaux mobiles (CGNAT), Wi-Fi
 *        d'entreprise ou d'université filtrés, et quand l'adresse IP change en cours de route.
 *  - TURN personnalisé (facultatif) : TURN_URL (+ TURN_USERNAME / TURN_CREDENTIAL)
 *
 * Les identifiants TURN sont limités dans le temps (CF_TURN_TTL, 6 h par défaut) et
 * régénérés toutes les 20 minutes : une copie qui fuiterait devient vite inutilisable.
 */
const STUN = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

function validateIceServer(url, username, credential) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim();
  const m = url.match(/^(stun|turn|turns):/i);
  const scheme = m ? m[1].toLowerCase() : (url.includes('stun.') ? 'stun' : 'turn');
  const rest = m ? url.slice(m[0].length) : url;
  const hm = rest.match(/^([^:?]+)(?::(\d+))?(\?.*)?$/);
  if (!hm) return null;
  const port = parseInt(hm[2] || (scheme === 'stun' ? 19302 : 3478), 10);
  const obj = { urls: `${scheme}:${hm[1].trim()}:${port}${hm[3] || ''}` };
  if (scheme !== 'stun' && username && credential) { obj.username = String(username).trim(); obj.credential = String(credential).trim(); }
  return obj;
}

function createIce(env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const keyId = (env.CF_TURN_KEY_ID || '').trim();
  const token = (env.CF_TURN_API_TOKEN || '').trim();
  const ttl = Math.min(48 * 3600, Math.max(1800, Number(env.CF_TURN_TTL) || 6 * 3600));
  const REFRESH = 20 * 60e3;
  const custom = [];
  (env.TURN_URL || '').split(',').filter(Boolean).forEach(u => {
    const s = validateIceServer(u, env.TURN_USERNAME, env.TURN_CREDENTIAL);
    if (s) custom.push(s);
  });
  let cache = null, cacheAt = 0, inflight = null, lastError = null, okCount = 0, failCount = 0;

  async function fetchCloudflare() {
    const r = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
    });
    if (!r.ok) throw new Error('Cloudflare TURN : HTTP ' + r.status);
    const j = await r.json();
    let list = j.iceServers;
    if (!Array.isArray(list)) list = list ? [list] : [];
    // Les navigateurs bloquent le port 53 : on retire ces adresses pour éviter des délais inutiles
    const out = [];
    for (const s of list) {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
      const turnUrls = urls.filter(u => /^turns?:/i.test(u));
      if (turnUrls.length && s.username && s.credential) out.push({ urls: turnUrls, username: s.username, credential: s.credential });
    }
    if (!out.length) throw new Error('Cloudflare TURN : réponse sans serveur TURN');
    return out;
  }

  async function turnServers() {
    if (!keyId || !token) return [];
    if (cache && now() - cacheAt < REFRESH) return cache;
    if (!inflight) {
      inflight = fetchCloudflare()
        .then(list => { cache = list; cacheAt = now(); lastError = null; okCount++; return list; })
        .catch(e => { lastError = e.message; failCount++; console.warn('⚠️', e.message); return cache || []; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  return {
    provider: keyId && token ? 'cloudflare' : custom.length ? 'custom' : null,
    async getIceServers() {
      const turn = await turnServers();
      return { iceServers: STUN.concat(turn, custom), relay: turn.length + custom.length > 0, ttl: turn.length ? Math.round(REFRESH / 1000) : 3600 };
    },
    status: () => ({ provider: keyId && token ? 'cloudflare' : custom.length ? 'custom' : null, lastError, okCount, failCount, cachedAt: cacheAt || null })
  };
}

module.exports = { createIce, validateIceServer };
