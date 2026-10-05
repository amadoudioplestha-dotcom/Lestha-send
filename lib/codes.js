'use strict';
/**
 * Codes de réception à 6 chiffres (bouton « Recevoir »).
 *
 *  - Mode Direct : code gardé en mémoire tant que le lien direct existe. Taper le code ne donne
 *    PAS accès au lien : l'expéditeur doit accepter l'appareil qui le demande.
 *  - Mode Cloud : code enregistré dans le stockage, valable 24 h au plus (jamais au-delà du lien).
 *
 * Protections : essais limités par connexion, plafond global d'échecs (attaque répartie),
 * codes courts dans le temps.
 */
const crypto = require('crypto');

const CODE_RE = /^\d{6}$/;
const CLOUD_TTL = 24 * 3600e3;

function createCodes({ storage, now = Date.now }) {
  const direct = new Map();            // code → roomId
  const meets = new Map();             // code → réunion
  let meetAlive = () => false;
  const key = (c) => 'codes/' + c + '.json';
  let fails = [], lockedUntil = 0;

  const draw = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  /* Codes enregistrés (réunions durables, liens Cloud) : réservés jusqu'à leur expiration, même quand la réunion
     n'est plus en mémoire, pour qu'un lien direct ne reçoive jamais le même code. Les réunions durables sont
     rechargées par lib/meet.js une minute après le démarrage, ce qui remet leurs codes ici. */
  const reserved = new Map();   // code → expiration
  const reserve = (c, exp) => { if (CODE_RE.test(String(c || ''))) reserved.set(c, Math.max(Number(exp) || now() + CLOUD_TTL, reserved.get(c) || 0)); };
  const pruneT = setInterval(() => { const t = now(); for (const [c, e] of reserved) if (e < t) reserved.delete(c); }, 10 * 60e3); if (pruneT.unref) pruneT.unref();
  const isFree = (c) => !direct.has(c) && !meets.has(c) && !(reserved.get(c) > now());

  async function cloudRecord(code) {
    const b = await storage.getBuffer(key(code)).catch(() => null);
    if (!b) return null;
    try { const r = JSON.parse(b.toString('utf8')); return r && r.exp > now() ? r : null; } catch (e) { return null; }
  }

  /** Code pour un lien direct (synchrone : uniquement en mémoire) */
  function forRoom(roomId) {
    for (const [c, r] of direct) if (r === roomId) return c;
    for (let i = 0; i < 50; i++) {
      const c = draw();
      if (isFree(c)) { direct.set(c, roomId); return c; }
    }
    return null;
  }
  function dropRoom(roomId) { for (const [c, r] of direct) if (r === roomId) direct.delete(c); }

  /** Code pour une réunion. Avec exp (lien durable) : aussi enregistré dans le stockage, pour survivre à un redémarrage */
  async function forMeet(id, exp) {
    for (let i = 0; i < 50; i++) {
      const c = draw();
      if (!isFree(c) || await cloudRecord(c)) continue;
      meets.set(c, id);
      if (exp) reserve(c, exp);
      if (exp) await storage.putBuffer(key(c), Buffer.from(JSON.stringify({ meet: id, exp })), 'application/json').catch(() => {});
      return c;
    }
    return null;
  }
  /** Remet en mémoire le code d'une réunion rechargée depuis le stockage */
  function restoreMeet(code, id, exp) { if (CODE_RE.test(String(code || '')) && !direct.has(code)) { meets.set(code, id); if (exp) reserve(code, exp); } }
  /** purge : supprime aussi le code enregistré (lien supprimé ou expiré) */
  function dropMeet(id, purge) {
    for (const [c, r] of meets) if (r === id) { meets.delete(c); if (purge) reserved.delete(c); if (purge && storage.deleteKey) storage.deleteKey(key(c)).catch(() => {}); }
  }
  const useMeet = (fn) => { meetAlive = fn; };

  /** Code pour un lien Cloud */
  async function forTransfer(id, expiresAt) {
    const exp = Math.min(Number(expiresAt) || now() + CLOUD_TTL, now() + CLOUD_TTL);
    for (let i = 0; i < 12; i++) {
      const c = draw();
      if (!isFree(c) || await cloudRecord(c)) continue;
      reserve(c, exp);
      await storage.putBuffer(key(c), Buffer.from(JSON.stringify({ id, exp })), 'application/json');
      return { code: c, expiresAt: exp };
    }
    return null;
  }

  /** Échecs comptés sur tout le service : au-delà de 400 en 10 minutes, la saisie de code se met en pause */
  function noteFail() {
    const t = now();
    fails = fails.filter(x => t - x < 10 * 60e3); fails.push(t);
    if (fails.length > 400) lockedUntil = t + 10 * 60e3;
  }
  const locked = () => now() < lockedUntil;

  /** { kind: 'direct', roomId } | { kind: 'cloud', id } | null */
  async function resolve(code, roomExists) {
    if (!CODE_RE.test(String(code || ''))) return null;
    const roomId = direct.get(code);
    if (roomId) {
      if (roomExists(roomId)) return { kind: 'direct', roomId };
      direct.delete(code);
    }
    const meet = meets.get(code);
    if (meet) { if (await meetAlive(meet)) return { kind: 'meet', id: meet }; meets.delete(code); }
    const r = await cloudRecord(code);
    if (r && r.meet) return (await meetAlive(r.meet)) ? { kind: 'meet', id: r.meet } : null;
    if (r && r.id) return { kind: 'cloud', id: r.id };
    return null;
  }

  return { forRoom, dropRoom, forMeet, restoreMeet, dropMeet, useMeet, forTransfer, resolve, noteFail, locked, CODE_RE, _direct: direct };
}

module.exports = { createCodes, CODE_RE };
