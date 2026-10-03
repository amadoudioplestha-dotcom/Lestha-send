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
      if (!direct.has(c) && !meets.has(c)) { direct.set(c, roomId); return c; }
    }
    return null;
  }
  function dropRoom(roomId) { for (const [c, r] of direct) if (r === roomId) direct.delete(c); }

  /** Code pour une réunion (en mémoire, libéré à la fin de la réunion) */
  function forMeet(id) {
    for (let i = 0; i < 50; i++) {
      const c = draw();
      if (!direct.has(c) && !meets.has(c)) { meets.set(c, id); return c; }
    }
    return null;
  }
  function dropMeet(id) { for (const [c, r] of meets) if (r === id) meets.delete(c); }
  const useMeet = (fn) => { meetAlive = fn; };

  /** Code pour un lien Cloud */
  async function forTransfer(id, expiresAt) {
    const exp = Math.min(Number(expiresAt) || now() + CLOUD_TTL, now() + CLOUD_TTL);
    for (let i = 0; i < 12; i++) {
      const c = draw();
      if (direct.has(c) || meets.has(c) || await cloudRecord(c)) continue;
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
    if (meet) { if (meetAlive(meet)) return { kind: 'meet', id: meet }; meets.delete(code); }
    const r = await cloudRecord(code);
    if (r) return { kind: 'cloud', id: r.id };
    return null;
  }

  return { forRoom, dropRoom, forMeet, dropMeet, useMeet, forTransfer, resolve, noteFail, locked, CODE_RE, _direct: direct };
}

module.exports = { createCodes, CODE_RE };
