'use strict';
/**
 * Compteur de bande passante sortante du serveur (3.27).
 *
 * Render (offre gratuite) compte tout ce que le serveur envoie : pages, API, réunions en temps réel,
 * et aussi ce qu'il envoie lui-même au stockage R2 (aperçus, qualités vidéo). Au-delà de 5 Go par mois,
 * le service est suspendu (ou facturé avec une carte). Ce compteur mesure le même chose, par catégorie,
 * pour voir venir le problème :
 *   - total exact : octets écrits sur chaque connexion (HTTP + WebSocket) ;
 *   - par catégorie : chaque réponse HTTP est rangée selon son adresse ;
 *   - envois vers R2 faits par le serveur.
 * Alertes par e-mail (ADMIN_EMAIL) à 50 %, 80 % et 100 % de BW_LIMIT_GB (5 par défaut), une fois par mois.
 * Rien de personnel n'est enregistré : seulement des totaux par jour et par catégorie.
 */
const PREFIX = 'system/bandwidth/';
const CATS = {
  zip: 'ZIP faits par le serveur',
  fichiers: 'Fichiers servis par le serveur',
  apercus: 'Aperçus et miniatures',
  reunions: 'Réunions (documents, pages)',
  site: 'Pages et code du site',
  api: 'Échanges de l\'application',
  tempsreel: 'Temps réel (réunions, Direct, chat) et en-têtes',
  r2: 'Envois du serveur vers le stockage'
};
const THRESHOLDS = [50, 80, 100];

const monthKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 7);
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

/** Catégorie d'une réponse HTTP d'après son adresse */
function categoryOf(path) {
  const p = String(path || '');
  if (/\/zip(\/|$)/.test(p)) return 'zip';
  if (/^\/api\/public\/t\/[^/]+\/(f|file)\//.test(p) || /^\/f\//.test(p) || /^\/api\/local\//.test(p)) return 'fichiers';
  if (/^\/(pv|th)\//.test(p) || /^\/api\/public\/t\/[^/]+\/(pg|pv|th|doc)\//.test(p)) return 'apercus';
  if (/^\/api\/meet/.test(p)) return 'reunions';
  if (p.startsWith('/socket.io')) return 'tempsreel';
  if (p.startsWith('/api/')) return 'api';
  return 'site';
}

function createBandwidth({ storage, mailer, env, now = Date.now }) {
  const limit = (Number(env.BW_LIMIT_GB) || 5) * 1e9;
  let month = null;           // { m, total, cat: {}, days: {}, alerts: [] }
  let dirty = false, timer = null;
  const live = new Set();     // connexions ouvertes : leurs octets sont relevés à la demande
  const flushLive = () => { for (const f of live) f(); };

  async function load(m) {
    const b = await storage.getBuffer(PREFIX + m + '.json').catch(() => null);
    let d = null;
    try { d = b ? JSON.parse(b.toString('utf8')) : null; } catch (e) { d = null; }
    return d && d.m === m ? d : { m, total: 0, cat: {}, days: {}, alerts: [] };
  }
  const ready = load(monthKey(now())).then(d => { month = d; }).catch(() => { month = { m: monthKey(now()), total: 0, cat: {}, days: {}, alerts: [] }; });
  const pending = { total: 0, cat: {} };   // compté avant la lecture du mois en cours

  function add(cat, n, inTotal) {
    if (!(n > 0)) return;
    if (!month) { if (inTotal) pending.total += n; if (cat) pending.cat[cat] = (pending.cat[cat] || 0) + n; return; }
    const m = monthKey(now());
    if (month.m !== m) { save(); month = { m, total: 0, cat: {}, days: {}, alerts: [] }; }
    if (pending.total || Object.keys(pending.cat).length) {
      month.total += pending.total; for (const [k, v] of Object.entries(pending.cat)) month.cat[k] = (month.cat[k] || 0) + v;
      pending.total = 0; pending.cat = {};
    }
    if (cat) month.cat[cat] = (month.cat[cat] || 0) + n;
    if (inTotal) { month.total += n; const d = dayKey(now()); month.days[d] = (month.days[d] || 0) + n; }
    dirty = true;
    if (!timer) { timer = setTimeout(() => { timer = null; save(); check(); }, 60e3); if (timer.unref) timer.unref(); }
  }

  async function save() {
    if (!dirty || !month) return;
    dirty = false;
    try { await storage.putBuffer(PREFIX + month.m + '.json', Buffer.from(JSON.stringify(month)), 'application/json'); }
    catch (e) { dirty = true; console.error('bande passante', e.message); }
  }

  /** Alerte par e-mail quand un seuil est franchi (une fois par seuil et par mois) */
  async function check() {
    if (!month) return;
    flushLive();
    const pct = month.total / limit * 100;
    const hit = THRESHOLDS.filter(t => pct >= t && !month.alerts.includes(t));
    if (!hit.length) return;
    const t = Math.max(...hit);
    month.alerts.push(...hit); dirty = true; await save();
    console.warn(`⚠️ Bande passante : ${t} % de la limite du mois (${(month.total / 1e9).toFixed(2)} Go)`);
    if (!env.ADMIN_EMAIL || !mailer || !mailer.enabled) return;
    const s = summary();
    const top = s.categories.slice(0, 3).map(c => `${c.label} : ${(c.bytes / 1e9).toFixed(2)} Go`);
    const paragraphs = [
      `Le serveur a envoyé <b>${(s.total / 1e9).toFixed(2)} Go</b> ce mois-ci, soit <b>${Math.round(s.percent)} %</b> de la limite de ${(limit / 1e9).toFixed(0)} Go de Render.`,
      s.projected ? `À ce rythme, la fin du mois serait vers ${(s.projected / 1e9).toFixed(1)} Go.` : '',
      top.length ? 'Ce qui consomme le plus : ' + top.join(' · ') + '.' : '',
      'Le détail est dans la console, rubrique Système.'
    ].filter(Boolean);
    try {
      const html = mailer.simple ? mailer.simple({ title: `Bande passante : ${t} % utilisés`, paragraphs }) : paragraphs.map(p => `<p>${p}</p>`).join('');
      await mailer.send({ to: env.ADMIN_EMAIL, subject: `Lestha Send — bande passante à ${t} %`, html, text: paragraphs.join('\n\n').replace(/<[^>]+>/g, '') });
    } catch (e) { console.error('alerte bande passante', e.message); }
  }

  function summary() {
    flushLive();
    const m = month || { m: monthKey(now()), total: 0, cat: {}, days: {} };
    const d = new Date(now());
    const dayOfMonth = d.getUTCDate() + d.getUTCHours() / 24;
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const total = m.total + pending.total;
    // Ce que les réponses HTTP n'expliquent pas : WebSocket (réunions, Direct, chat) et en-têtes
    const cat = Object.assign({}, m.cat);
    const known = Object.entries(cat).reduce((s, [k, v]) => s + (k === 'tempsreel' ? 0 : v), 0);
    cat.tempsreel = Math.max(0, total - known);
    return {
      month: m.m, total, limit, percent: total / limit * 100,
      projected: dayOfMonth >= 2 ? Math.round(total / dayOfMonth * daysInMonth) : null,
      categories: Object.entries(cat).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, label: CATS[k] || k, bytes: v })).sort((a, b) => b.bytes - a.bytes),
      days: Object.entries(m.days).sort().slice(-31).map(([day, bytes]) => ({ day, bytes }))
    };
  }

  /** Branche le compteur : connexions du serveur HTTP, réponses Express, envois vers le stockage */
  function attach(server, app) {
    // Total exact : tout ce qui est écrit sur les connexions (HTTP, WebSocket)
    server.on('connection', (sock) => {
      let last = 0;
      const flushSock = () => { const w = sock.bytesWritten || 0; if (w > last) { add(null, w - last, true); last = w; } };
      live.add(flushSock);
      sock.on('close', () => { live.delete(flushSock); flushSock(); });
    });
    const iv = setInterval(flushLive, 15e3); if (iv.unref) iv.unref();
    // Détail par catégorie : corps des réponses HTTP
    app.use((req, res, next) => {
      let n = 0;
      const w = res.write, e = res.end;
      const size = (c, enc) => c ? (Buffer.isBuffer(c) || c instanceof Uint8Array ? c.length : Buffer.byteLength(String(c), typeof enc === 'string' ? enc : 'utf8')) : 0;
      res.write = function (c, enc, cb) { n += size(c, enc); return w.call(this, c, enc, cb); };
      res.end = function (c, enc, cb) { if (typeof c !== 'function') n += size(c, enc); return e.call(this, c, enc, cb); };
      res.on('close', () => add(categoryOf(req.originalUrl.split('?')[0]), n, false));
      next();
    });
    // Envois du serveur vers R2 (aperçus faits par le serveur, qualités vidéo, données)
    if (storage.direct) {
      const pb = storage.putBuffer, pf = storage.putFile;
      storage.putBuffer = async function (key, body, ct) { const r = await pb.call(this, key, body, ct); if (!String(key).startsWith(PREFIX)) add('r2', body ? body.length || 0 : 0, true); return r; };
      if (pf) storage.putFile = async function (key, file, ct) {
        const r = await pf.call(this, key, file, ct);
        try { add('r2', require('fs').statSync(file).size, true); } catch (x) { /* ignore */ }
        return r;
      };
    }
  }

  return { ready, attach, summary, flush: save, check, _add: add };
}

module.exports = { createBandwidth, categoryOf, CATS };
