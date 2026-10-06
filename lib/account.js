'use strict';
/**
 * Compte enseignant sans mot de passe (3.17)
 * L'adresse e-mail confirmée par un code (lib/guard.js) sert de compte. Le serveur garde, pour chaque
 * adresse, un « coffre » : la liste des transferts, espaces Smart Drop, réunions et directs créés,
 * avec leurs clés de gestion. Sur un nouvel appareil, on confirme son e-mail et tout revient.
 * Le coffre est chiffré (AES-256-GCM) avec une clé tirée du secret de l'application : une fuite du
 * stockage seul ne révèle rien. Les élèves et les déposants n'ont toujours pas besoin de compte.
 */
const crypto = require('crypto');
const { rateLimiter, clientIp } = require('./util');

const MAX = 512 * 1024;                               // taille maximale d'un coffre (JSON)

function mountAccount(app, { storage, secret, verifiedEmail }) {
  const key = crypto.createHash('sha256').update('lestha-vault:' + secret).digest();
  const pathOf = (email) => 'accounts/' + crypto.createHmac('sha256', secret).update('acct:' + email).digest('hex').slice(0, 40) + '.bin';
  const seal = (obj) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]);
  };
  const open = (buf) => {
    if (!buf || buf.length < 30 || buf[0] !== 1) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13)); d.setAuthTag(buf.subarray(13, 29));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(29)), d.final()]).toString('utf8'));
  };
  const limit = rateLimiter({ windowMs: 10 * 60e3, max: 120 });
  const fail = (res, s, error) => res.status(s).json({ error });
  const who = (req, res) => {
    const email = verifiedEmail(req);
    if (!email) { fail(res, 401, 'Connectez-vous avec votre e-mail.'); return null; }
    if (!limit(clientIp(req))) { fail(res, 429, 'Trop de demandes. Réessayez dans quelques minutes.'); return null; }
    return email;
  };
  const load = async (email) => {
    const buf = await storage.getBuffer(pathOf(email)).catch(() => null);
    try { return open(buf); } catch (e) { return null; }
  };

  app.get('/api/account/vault', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const email = who(req, res); if (!email) return;
      const v = await load(email);
      res.json({ email, vault: v ? v.vault : null, updatedAt: v ? v.updatedAt : 0 });
    } catch (e) { next(e); }
  });

  app.put('/api/account/vault', async (req, res, next) => {
    try {
      const email = who(req, res); if (!email) return;
      const vault = req.body && req.body.vault;
      if (!vault || typeof vault !== 'object' || Array.isArray(vault)) return fail(res, 400, 'Coffre invalide.');
      if (Buffer.byteLength(JSON.stringify(vault)) > MAX) return fail(res, 413, 'Coffre trop volumineux.');
      const updatedAt = Date.now();
      await storage.putBuffer(pathOf(email), seal({ email, vault, updatedAt }), 'application/octet-stream');
      res.json({ ok: true, updatedAt });
    } catch (e) { next(e); }
  });

  /* Supprimer le compte : le coffre est effacé (les transferts eux-mêmes expirent comme d'habitude) */
  app.delete('/api/account/vault', async (req, res, next) => {
    try {
      const email = who(req, res); if (!email) return;
      await storage.deleteKey(pathOf(email)).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}

module.exports = { mountAccount };
