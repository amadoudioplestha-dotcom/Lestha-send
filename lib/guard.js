'use strict';
/**
 * Protections transverses de Lestha Send :
 *  - originGuard     : refuse les requêtes qui ne passent pas par Cloudflare (ORIGIN_SECRET),
 *                      ce qui rend l'adresse IP du visiteur fiable pour toutes les limites ;
 *  - dailyCounter    : compteurs par jour (envois gratuits, e-mails…) ;
 *  - capMailer       : plafond global d'e-mails par jour, pour qu'un abus ne grille jamais le compte d'envoi ;
 *  - turnstile       : anti-robot Cloudflare Turnstile, optionnel (TURNSTILE_SECRET) ;
 *  - mountVerify     : vérification d'une adresse e-mail par code à 6 chiffres → jeton « expéditeur vérifié ».
 */
const crypto = require('crypto');
const express = require('express');
const { safeEqual, sha256, rateLimiter, clientIp } = require('./util');

const DAY = 86400e3;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '')) && String(s).length <= 200;
const normEmail = (s) => String(s || '').trim().toLowerCase();

/* ------------------------------------------------------------------ */
/*  Origine : seules les requêtes passées par Cloudflare sont servies   */
/* ------------------------------------------------------------------ */
function originGuard(env) {
  const secret = String(env.ORIGIN_SECRET || '');
  const enabled = secret.length >= 16;
  const ok = (h) => !enabled || safeEqual(String(h || ''), secret);
  return {
    enabled,
    http(req, res, next) {
      // Render vérifie /health directement sur le serveur, sans passer par Cloudflare
      if (req.path === '/health' || ok(req.get('x-origin-secret'))) return next();
      res.status(403).set('Cache-Control', 'no-store').type('text/plain').send('Accès direct refusé. Utilisez l\'adresse officielle du service.');
    },
    socket(socket, next) {
      if (ok(socket.handshake.headers['x-origin-secret'])) return next();
      next(new Error('Accès direct refusé'));
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Compteur journalier en mémoire (remis à zéro chaque jour UTC)       */
/* ------------------------------------------------------------------ */
function dailyCounter() {
  let day = Math.floor(Date.now() / DAY);
  let map = new Map();
  const roll = () => { const d = Math.floor(Date.now() / DAY); if (d !== day) { day = d; map = new Map(); } };
  return {
    get(key) { roll(); return map.get(key) || 0; },
    add(key, n = 1) { roll(); const v = (map.get(key) || 0) + n; map.set(key, v); return v; },
    /** Ajoute n si le total reste ≤ max ; renvoie false sinon (rien n'est compté) */
    take(key, max, n = 1) { roll(); const v = map.get(key) || 0; if (v + n > max) return false; map.set(key, v + n); return true; }
  };
}

/* ------------------------------------------------------------------ */
/*  Plafond global d'e-mails par jour                                   */
/* ------------------------------------------------------------------ */
function capMailer(mailer, env) {
  const cap = Math.max(1, Number(env.EMAIL_DAILY_CAP) || 300);
  const count = dailyCounter();
  const send = mailer.send.bind(mailer);
  mailer.dailyCap = cap;
  mailer.sentToday = () => count.get('all');
  mailer.send = async (msg) => {
    if (!count.take('all', cap)) {
      console.warn('✉️  Plafond quotidien d\'e-mails atteint (' + cap + ') : envoi refusé');
      throw Object.assign(new Error('Le service a atteint sa limite d\'e-mails pour aujourd\'hui. Partagez le lien directement.'), { status: 429, quota: true });
    }
    return send(msg);
  };
  return mailer;
}

/* ------------------------------------------------------------------ */
/*  Cloudflare Turnstile (optionnel)                                    */
/* ------------------------------------------------------------------ */
function turnstile(env) {
  const secret = String(env.TURNSTILE_SECRET || '');
  const siteKey = String(env.TURNSTILE_SITE_KEY || '');
  const enabled = !!(secret && siteKey);
  return {
    enabled, siteKey: enabled ? siteKey : null,
    async check(req) {
      if (!enabled) return true;
      const token = String(req.get('x-turnstile') || (req.body && req.body.turnstile) || '');
      if (!token || token.length > 2048) return false;
      try {
        const body = new URLSearchParams({ secret, response: token, remoteip: clientIp(req) });
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        return !!j.success;
      } catch (e) {
        console.error('turnstile', e.message);
        return false;
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Vérification de l'adresse e-mail de l'expéditeur                    */
/* ------------------------------------------------------------------ */
function mountVerify(app, { mailer, signer, captcha }) {
  const codes = new Map();                                   // email -> { hash, exp, tries }
  const ipLimit = rateLimiter({ windowMs: 3600e3, max: 6 });
  const mailLimit = rateLimiter({ windowMs: 3600e3, max: 3 });
  const confirmLimit = rateLimiter({ windowMs: 15 * 60e3, max: 20 });
  const fail = (res, s, error, extra) => res.status(s).json(Object.assign({ error }, extra || {}));
  const codeHash = (email, code) => sha256('verify:' + email + ':' + code);
  setInterval(() => { const now = Date.now(); for (const [k, v] of codes) if (v.exp < now) codes.delete(k); }, 60e3).unref();

  const r = express.Router();

  r.post('/verify/start', async (req, res, next) => {
    try {
      const email = normEmail(req.body && req.body.email);
      if (!isEmail(email)) return fail(res, 400, 'Adresse e-mail invalide.');
      if (!mailer.enabled) return fail(res, 503, 'L\'envoi d\'e-mails n\'est pas configuré sur ce serveur.');
      if (!(await captcha.check(req))) return fail(res, 403, 'Vérification anti-robot échouée. Rechargez la page.', { needCaptcha: true });
      if (!ipLimit(clientIp(req)) || !mailLimit(email)) return fail(res, 429, 'Trop de demandes de code. Réessayez dans une heure.');
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      codes.set(email, { hash: codeHash(email, code), exp: Date.now() + 10 * 60e3, tries: 0 });
      await mailer.send({
        to: email,
        subject: `${code} est votre code Lestha Send`,
        text: `Votre code de confirmation Lestha Send : ${code}\nIl est valable 10 minutes.\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
        html: mailer.layout ? mailer.layout('Votre code de confirmation', `<p style="color:#334155;font-size:15px;line-height:1.6;margin:0 0 10px;">Saisissez ce code dans Lestha Send pour confirmer votre adresse :</p><p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:8px 0 18px;color:#0b1b2e;text-align:center;background:#f1f7fb;border-radius:12px;padding:14px 0;">${code}</p><p style="color:#64748b;font-size:13px;line-height:1.6;margin:0;">Il est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message.</p>`) : `<p>Votre code Lestha Send : <b>${code}</b></p>`
      });
      res.json({ ok: true, expiresIn: 600 });
    } catch (e) {
      if (e.quota) return fail(res, 429, e.message);
      next(e);
    }
  });

  r.post('/verify/confirm', (req, res) => {
    const email = normEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!confirmLimit(clientIp(req))) return fail(res, 429, 'Trop de tentatives. Patientez 15 minutes.');
    const c = codes.get(email);
    if (!c || c.exp < Date.now()) return fail(res, 400, 'Code expiré. Demandez-en un nouveau.');
    if (++c.tries > 5) { codes.delete(email); return fail(res, 429, 'Trop d\'essais. Demandez un nouveau code.'); }
    if (!safeEqual(codeHash(email, code), c.hash)) return fail(res, 403, 'Code incorrect.');
    codes.delete(email);
    res.json({ ok: true, email, token: signer.sign({ ve: email, exp: Date.now() + 30 * DAY }) });
  });

  app.use('/api', r);

  /** Adresse vérifiée portée par la requête (en-tête X-Sender-Token), ou null */
  return function verifiedEmail(req) {
    const tok = signer.verify(req.get('x-sender-token') || '');
    return tok && tok.ve && isEmail(tok.ve) ? tok.ve : null;
  };
}

module.exports = { originGuard, dailyCounter, capMailer, turnstile, mountVerify, isEmail, normEmail };
