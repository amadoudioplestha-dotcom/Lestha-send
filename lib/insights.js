'use strict';
/**
 * Retours et usage — mesure d'audience ANONYME et avis des utilisateurs.
 *
 * Ce qui est compté (agrégé par jour, jamais par personne) :
 *   visites, provenance (TikTok, WhatsApp, LinkedIn…), pays (en-tête Cloudflare),
 *   type d'appareil, parcours (fichiers choisis → envoi terminé → lien ouvert → téléchargé),
 *   usage de chaque mode, problèmes affichés à l'écran, qualité du mode Direct
 *   (connexion directe ou relais, vitesse, reconnexions).
 *
 * Ce qui n'est JAMAIS enregistré : adresse IP, nom ou contenu des fichiers, messages,
 * adresse e-mail (sauf si la personne la laisse volontairement dans un avis pour être recontactée).
 * La fidélité repose sur un identifiant aléatoire du navigateur, haché avec le secret du serveur :
 * il ne permet pas de retrouver une personne. « Ne pas me suivre » (DNT / GPC) est respecté par l'écran.
 */
const crypto = require('crypto');
const express = require('express');
const { rateLimiter, clientIp } = require('./util');

const DAY = 86400e3;
const PREFIX = 'system/insights/';
const MODES = ['cloud', 'direct', 'nearby', 'live', 'classe', 'review', 'request', 'meet'];
const STEPS = ['pick', 'sent', 'open', 'got'];
const HEARD = ['tiktok', 'whatsapp', 'linkedin', 'facebook', 'instagram', 'google', 'ami', 'ecole', 'autre'];
const USES = ['etudes', 'enseignement', 'travail', 'perso', 'creation', 'autre'];
const KINDS = ['avis', 'idee', 'probleme'];

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const dayNum = (ts = Date.now()) => Math.floor(ts / DAY);
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const inc = (o, k, v = 1) => { if (!k) return; o[k] = (o[k] || 0) + v; };

/** Provenance : on ne garde qu'un nom de réseau ou de site, jamais l'adresse complète */
function normSource(raw) {
  let s = String(raw || '').toLowerCase().trim();
  if (!s) return 'direct';
  try { if (/^https?:\/\//.test(s)) s = new URL(s).hostname; } catch (e) { /* ignore */ }
  s = s.replace(/^www\.|^m\.|^l\.|^lm\./, '');
  const map = [
    [/tiktok/, 'tiktok'], [/whatsapp|^wa\.me/, 'whatsapp'], [/linkedin|lnkd\.in/, 'linkedin'], [/facebook|^fb(\.|$)|fb\.com/, 'facebook'],
    [/instagram|^ig$/, 'instagram'], [/google/, 'google'], [/bing/, 'bing'], [/^t\.co$|twitter|^x(\.com)?$/, 'x'], [/youtube|youtu\.be/, 'youtube'],
    [/telegram|^t\.me$/, 'telegram'], [/snapchat/, 'snapchat'], [/chatgpt|openai/, 'chatgpt'], [/lestha/, 'interne'], [/^mail|gmail|outlook|email/, 'e-mail']
  ];
  for (const [re, name] of map) if (re.test(s)) return name;
  return s.replace(/[^a-z0-9._-]/g, '').slice(0, 30) || 'autre';
}
function normCountry(c) {
  c = String(c || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : '??';
}
function deviceOf(ua) {
  ua = String(ua || '');
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablette';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'mobile';
  return 'ordinateur';
}
/** Message d'erreur affiché : on retire tout ce qui pourrait être personnel (noms entre guillemets, nombres, adresses) */
function normError(msg) {
  return clip(msg, 300)
    .replace(/[«"“][^»"”]*[»"”]/g, '«…»')
    .replace(/\S+@\S+/g, '…@…')
    .replace(/https?:\/\/\S+/g, '…')
    .replace(/\b[\w-]+\.[a-z0-9]{2,5}\b/gi, '…')
    .replace(/\d+([.,]\d+)?/g, '#')
    .slice(0, 90);
}

function emptyDay(day) {
  return {
    day, visits: 0, visitors: 0, newV: 0, retV: 0, seen: [],
    src: {}, cc: {}, dev: {}, pages: {},
    funnel: { pick: 0, sent: 0, open: 0, got: 0 }, modes: {}, opens: {},
    errs: {}, p2p: { ok: 0, fail: 0, direct: 0, relay: 0, bytes: 0, ms: 0, restarts: 0, best: 0 },
    fb: { n: 0, mood: {} }, heard: {}, use: {}, bytes: {}
  };
}

function createInsights({ storage, secret, mailer, env, ctx, now = Date.now }) {
  const hashAid = (aid) => crypto.createHmac('sha256', secret).update('aid:' + aid).digest('hex').slice(0, 12);
  const days = new Map();          // jour → document (les jours passés ne changent plus)
  let people = null, feedback = null, ideas = null, meta = null;
  const dirty = new Set();
  let timer = null;

  async function readJson(key, fallback) {
    const b = await storage.getBuffer(PREFIX + key).catch(() => null);
    if (!b) return fallback;
    try { return JSON.parse(b.toString('utf8')); } catch (e) { return fallback; }
  }
  const writeJson = (key, v) => storage.putBuffer(PREFIX + key, Buffer.from(JSON.stringify(v)), 'application/json');

  const ready = (async () => {
    people = await readJson('people.json', {});
    feedback = await readJson('feedback.json', []);
    ideas = await readJson('ideas.json', []);
    meta = await readJson('meta.json', {});
    const today = dayKey(now());
    days.set(today, await readJson('d/' + today + '.json', emptyDay(today)));
  })().catch(e => { console.error('insights', e.message); people = people || {}; feedback = feedback || []; ideas = ideas || []; meta = meta || {}; });

  function touch(key) { dirty.add(key); if (!timer) timer = setTimeout(flush, 30000); }
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const keys = [...dirty]; dirty.clear();
    for (const k of keys) {
      try {
        if (k === 'people') await writeJson('people.json', prunePeople());
        else if (k === 'feedback') await writeJson('feedback.json', feedback);
        else if (k === 'ideas') await writeJson('ideas.json', ideas);
        else if (k === 'meta') await writeJson('meta.json', meta);
        else if (k.startsWith('d/')) { const d = days.get(k.slice(2)); if (d) await writeJson(k + '.json', d); }
      } catch (e) { dirty.add(k); console.error('insights flush', k, e.message); }
    }
  }
  function prunePeople() {
    const min = dayNum(now()) - 180;
    const ids = Object.keys(people);
    for (const id of ids) if (people[id][1] < min) delete people[id];
    const left = Object.keys(people);
    if (left.length > 40000) left.sort((a, b) => people[a][1] - people[b][1]).slice(0, left.length - 40000).forEach(id => delete people[id]);
    return people;
  }

  async function day(key) {
    if (days.has(key)) return days.get(key);
    const d = await readJson('d/' + key + '.json', null);
    if (d) days.set(key, d);
    if (days.size > 120) { const old = [...days.keys()].sort()[0]; if (!dirty.has('d/' + old)) days.delete(old); }
    return d;
  }
  async function today() {
    const k = dayKey(now());
    let d = days.get(k);
    if (!d) { d = (await readJson('d/' + k + '.json', null)) || emptyDay(k); days.set(k, d); }
    return d;
  }

  /** Visiteur anonyme : nouveau, revenu, fidèle */
  function person(d, aid) {
    if (!aid) return null;
    const h = hashAid(aid), n = dayNum(now());
    let p = people[h];
    if (!p) { p = people[h] = [n, n, 1, 0]; d.newV++; }
    else if (p[1] !== n) { p[1] = n; p[2]++; d.retV++; }
    const short = h.slice(0, 8);
    if (!d.seen.includes(short)) { if (d.seen.length < 30000) d.seen.push(short); d.visitors++; }
    touch('people');
    return p;
  }

  /** Événement envoyé par l'écran */
  async function record(ev, req) {
    await ready;
    const d = await today();
    const e = String(ev.e || '');
    const aid = /^[a-z0-9]{16,40}$/i.test(ev.aid || '') ? ev.aid : null;
    const m = MODES.includes(ev.m) ? ev.m : null;
    const p = person(d, aid);
    if (e === 'visit') {
      d.visits++;
      inc(d.src, normSource(ev.src));
      inc(d.cc, normCountry(req.get('cf-ipcountry')));
      inc(d.dev, deviceOf(req.get('user-agent')));
    } else if (e === 'page') {
      if (/^[a-z-]{2,20}$/.test(ev.p || '')) inc(d.pages, ev.p);
    } else if (STEPS.includes(e)) {
      d.funnel[e]++;
      if (e === 'sent') { inc(d.modes, m || 'cloud'); if (p) p[3]++; const b = Number(ev.b); if (b > 0 && b < 1e13) inc(d.bytes, m || 'cloud', b); }
      if (e === 'open') inc(d.opens, m || 'cloud');
    } else if (e === 'use') {
      if (m) inc(d.modes, m);
    } else if (e === 'err') {
      const k = normError(ev.msg);
      if (k && Object.keys(d.errs).length < 300) inc(d.errs, k); else if (k && d.errs[k]) d.errs[k]++;
    } else if (e === 'p2p') {
      const x = d.p2p;
      if (ev.ok) {
        x.ok++;
        if (ev.relay) x.relay++; else x.direct++;
        const b = Math.max(0, Math.min(Number(ev.b) || 0, 1e13)), ms = Math.max(0, Math.min(Number(ev.ms) || 0, 7 * DAY));
        x.bytes += b; x.ms += ms;
        if (ms > 2000 && b / (ms / 1000) > x.best) x.best = Math.round(b / (ms / 1000));
      } else x.fail++;
      x.restarts += Math.max(0, Math.min(Number(ev.r) || 0, 50));
    } else return false;
    touch('d/' + d.day);
    return true;
  }

  /* ---------------- Avis ---------------- */
  async function addFeedback(b, req) {
    await ready;
    const kind = KINDS.includes(b.kind) ? b.kind : 'avis';
    const mood = Math.max(0, Math.min(5, parseInt(b.mood, 10) || 0));
    const text = clip(b.text, 1500);
    const email = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(b.email || '').trim()) ? String(b.email).trim().toLowerCase() : '';
    const heard = HEARD.includes(b.heard) ? b.heard : '';
    const use = USES.includes(b.use) ? b.use : '';
    if (!mood && !text && !heard && !use) { const err = new Error('Écrivez quelques mots ou choisissez une note.'); err.status = 400; throw err; }
    const d = await today();
    d.fb.n++; if (mood) inc(d.fb.mood, String(mood)); if (heard) inc(d.heard, heard); if (use) inc(d.use, use);
    touch('d/' + d.day);
    const item = {
      id: crypto.randomBytes(6).toString('hex'), at: now(), kind, mood, text, email, heard, use,
      m: MODES.includes(b.m) ? b.m : '', page: clip(b.page, 30).replace(/[^a-z0-9/-]/gi, ''),
      cc: normCountry(req.get('cf-ipcountry')), dev: deviceOf(req.get('user-agent')), status: 'new', note: ''
    };
    if (text || email) {
      feedback.unshift(item);
      if (feedback.length > 2000) feedback.length = 2000;
      touch('feedback');
      if (ctx && ctx.io) ctx.io.to('admin').emit('admin-feedback', { kind, mood, at: item.at });
    }
    return item;
  }

  /* ---------------- Idées (vote) ---------------- */
  const publicIdea = (i, h) => ({ id: i.id, title: i.title, desc: i.desc, status: i.status, votes: i.voters.length, voted: !!h && i.voters.includes(h) });
  async function listIdeas(aid) {
    await ready;
    const h = /^[a-z0-9]{16,40}$/i.test(aid || '') ? hashAid(aid).slice(0, 10) : null;
    return ideas.filter(i => i.status !== 'hidden').sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.voters.length - a.voters.length).map(i => publicIdea(i, h));
  }
  async function vote(id, aid) {
    await ready;
    if (!/^[a-z0-9]{16,40}$/i.test(aid || '')) { const e = new Error('Identifiant manquant.'); e.status = 400; throw e; }
    const i = ideas.find(x => x.id === id && x.status !== 'hidden');
    if (!i) { const e = new Error('Idée introuvable.'); e.status = 404; throw e; }
    const h = hashAid(aid).slice(0, 10);
    const k = i.voters.indexOf(h);
    if (k >= 0) i.voters.splice(k, 1); else i.voters.push(h);
    touch('ideas');
    return publicIdea(i, h);
  }

  /* ---------------- Rapport ---------------- */
  async function report(nDays = 30) {
    await ready;
    nDays = Math.max(1, Math.min(180, Number(nDays) || 30));
    const end = now();
    const series = [];
    const T = { visits: 0, visitors: 0, newV: 0, retV: 0, src: {}, cc: {}, dev: {}, pages: {}, funnel: { pick: 0, sent: 0, open: 0, got: 0 }, modes: {}, opens: {}, errs: {}, bytes: {},
      p2p: { ok: 0, fail: 0, direct: 0, relay: 0, bytes: 0, ms: 0, restarts: 0, best: 0 }, fb: { n: 0, mood: {} }, heard: {}, use: {} };
    const merge = (dst, src) => { for (const [k, v] of Object.entries(src || {})) dst[k] = (dst[k] || 0) + v; };
    for (let i = nDays - 1; i >= 0; i--) {
      const k = dayKey(end - i * DAY);
      const d = await day(k);
      series.push({ day: k, visits: d ? d.visits : 0, visitors: d ? d.visitors : 0, sent: d ? d.funnel.sent : 0, got: d ? d.funnel.got : 0 });
      if (!d) continue;
      T.visits += d.visits; T.visitors += d.visitors; T.newV += d.newV; T.retV += d.retV;
      ['src', 'cc', 'dev', 'pages', 'modes', 'opens', 'errs', 'heard', 'use', 'bytes'].forEach(f => merge(T[f], d[f]));
      merge(T.funnel, d.funnel);
      const p = d.p2p || {};
      ['ok', 'fail', 'direct', 'relay', 'bytes', 'ms', 'restarts'].forEach(f => { T.p2p[f] += p[f] || 0; });
      T.p2p.best = Math.max(T.p2p.best, p.best || 0);
      T.fb.n += d.fb.n; merge(T.fb.mood, d.fb.mood);
    }
    // Fidélité (identifiants anonymes)
    const from = dayNum(end) - nDays + 1;
    const L = { active: 0, fresh: 0, back: 0, loyal: 0, senders: 0, repeat: 0, freshReturned: 0 };
    for (const p of Object.values(people)) {
      if (p[1] < from) continue;
      L.active++;
      if (p[0] >= from) { L.fresh++; if (p[2] >= 2) L.freshReturned++; } else L.back++;
      if (p[2] >= 3) L.loyal++;
      if (p[3] > 0) L.senders++;
      if (p[3] >= 2) L.repeat++;
    }
    const moodN = Object.values(T.fb.mood).reduce((s, v) => s + v, 0);
    const moodAvg = moodN ? Object.entries(T.fb.mood).reduce((s, [k, v]) => s + Number(k) * v, 0) / moodN : null;
    const errs = Object.entries(T.errs).sort((a, b) => b[1] - a[1]).slice(0, 15);
    return {
      days: nDays, generatedAt: end, series, totals: T, loyalty: L, moodAvg, moodN, errors: errs,
      p2pAvgSpeed: T.p2p.ms > 0 ? Math.round(T.p2p.bytes / (T.p2p.ms / 1000)) : 0,
      p2pSuccess: T.p2p.ok + T.p2p.fail ? T.p2p.ok / (T.p2p.ok + T.p2p.fail) : null,
      relayShare: T.p2p.ok ? T.p2p.relay / T.p2p.ok : null,
      feedbackNew: feedback.filter(f => f.status === 'new').length,
      ice: ctx && ctx.ice ? ctx.ice.status() : null
    };
  }

  /* ---------------- Bilan de la semaine (lundi matin, par e-mail) ---------------- */
  const pct = (a, b) => (b ? Math.round(a / b * 100) + ' %' : '—');
  const top = (o, n = 5) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  const MODE_LABEL = { meet: 'Réunion', cloud: 'Cloud', direct: 'Direct', nearby: 'À proximité', live: 'Direct vidéo', classe: 'Classe', review: 'Relecture', request: 'Demande de fichiers' };
  async function weeklyHtml() {
    const r = await report(7);
    const T = r.totals;
    const fmtB = (b) => { const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; };
    const recent = feedback.filter(f => f.at > now() - 7 * DAY).slice(0, 8);
    const ideasTop = ideas.filter(i => i.status !== 'hidden' && i.status !== 'done').sort((a, b) => b.voters.length - a.voters.length).slice(0, 3);
    const e = mailer.esc || ((s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
    const paragraphs = [
      `<strong>${T.visits}</strong> visites · <strong>${r.loyalty.active}</strong> visiteurs (dont ${r.loyalty.fresh} nouveaux, ${r.loyalty.back} revenus) · <strong>${T.funnel.sent}</strong> envois · <strong>${T.funnel.got}</strong> téléchargements.`,
      `Parcours : fichiers choisis ${T.funnel.pick} → envois terminés ${T.funnel.sent} (${pct(T.funnel.sent, T.funnel.pick)}) → liens ouverts ${T.funnel.open} → téléchargés ${T.funnel.got} (${pct(T.funnel.got, T.funnel.open)}).`,
      `Modes : ${top(T.modes, 7).map(([k, v]) => `${MODE_LABEL[k] || k} ${v}`).join(' · ') || '—'}.`,
      `Provenance : ${top(T.src).map(([k, v]) => `${e(k)} ${v}`).join(' · ') || '—'}. Pays : ${top(T.cc).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}.`,
      `Mode Direct : ${T.p2p.ok} réussis, ${T.p2p.fail} échoués${r.relayShare != null ? `, ${Math.round(r.relayShare * 100)} % via relais` : ''}${r.p2pAvgSpeed ? `, vitesse moyenne ${fmtB(r.p2pAvgSpeed)}/s` : ''}.`,
      `Avis : ${T.fb.n}${r.moodAvg ? ` · note moyenne ${r.moodAvg.toFixed(1)}/5` : ''}.`
    ];
    if (r.errors.length) paragraphs.push('Problèmes les plus vus : ' + r.errors.slice(0, 4).map(([k, v]) => `« ${e(k)} » (${v})`).join(' · ') + '.');
    if (recent.length) paragraphs.push('Derniers messages :<br>' + recent.map(f => `• ${f.mood ? '★'.repeat(f.mood) + ' ' : ''}${e(f.text || '(sans texte)').slice(0, 220)}`).join('<br>'));
    if (ideasTop.length) paragraphs.push('Idées les plus votées : ' + ideasTop.map(i => `${e(i.title)} (${i.voters.length})`).join(' · ') + '.');
    return { r, paragraphs };
  }
  async function sendWeekly(force) {
    await ready;
    const to = env.ADMIN_EMAIL;
    if (!to || !mailer || !mailer.enabled) { const e = new Error('Renseignez ADMIN_EMAIL et l\'e-mail (SendGrid ou SMTP) pour recevoir le bilan.'); e.status = 503; throw e; }
    const { paragraphs } = await weeklyHtml();
    const base = String(env.PUBLIC_URL || '').replace(/\/$/, '');
    const html = mailer.simple ? mailer.simple({ title: 'Votre semaine sur Lestha Send', paragraphs, action: base ? { href: base + '/' + (env.ADMIN_PATH || 'admin'), label: 'Ouvrir la console' } : undefined, note: 'Statistiques anonymes et agrégées.' }) : paragraphs.map(p => `<p>${p}</p>`).join('');
    await mailer.send({ to, subject: 'Lestha Send — bilan de la semaine', html, text: paragraphs.join('\n\n').replace(/<[^>]+>/g, '') });
    if (!force) { meta.lastWeekly = weekKey(); touch('meta'); }
    return true;
  }
  function weekKey(ts = now()) {
    const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  const weeklyTimer = setInterval(async () => {
    try {
      await ready;
      const d = new Date(now());
      if (d.getUTCDay() === 1 && d.getUTCHours() >= 8 && meta.lastWeekly !== weekKey() && env.ADMIN_EMAIL && mailer && mailer.enabled) await sendWeekly(false);
    } catch (e) { console.error('bilan hebdo', e.message); }
  }, 30 * 60e3);
  if (weeklyTimer.unref) weeklyTimer.unref();

  /* ---------------- Routes publiques ---------------- */
  function mountPublic(app) {
    const evLimit = rateLimiter({ windowMs: 10 * 60e3, max: 300 });
    const fbLimit = rateLimiter({ windowMs: 3600e3, max: 8 });
    const voteLimit = rateLimiter({ windowMs: 3600e3, max: 80 });
    const textBody = express.text({ type: ['text/plain', 'application/json'], limit: '8kb' });
    app.post('/api/ux', textBody, async (req, res) => {
      res.status(204).end();
      if (!evLimit(clientIp(req))) return;
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return; } }
      const list = Array.isArray(b) ? b.slice(0, 20) : [b];
      for (const ev of list) { if (ev && typeof ev === 'object') await record(ev, req).catch(() => {}); }
    });
    app.post('/api/feedback', async (req, res) => {
      if (!fbLimit(clientIp(req))) return res.status(429).json({ error: 'Merci ! Vous avez déjà envoyé plusieurs avis, réessayez plus tard.' });
      try { await addFeedback(req.body || {}, req); res.json({ ok: true }); }
      catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Impossible d\'enregistrer votre avis.' }); }
    });
    app.get('/api/ideas', async (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ items: await listIdeas(String(req.query.aid || '')) }); });
    app.post('/api/ideas/:id/vote', async (req, res) => {
      if (!voteLimit(clientIp(req))) return res.status(429).json({ error: 'Trop de votes, réessayez plus tard.' });
      try { res.json(await vote(String(req.params.id), String((req.body || {}).aid || ''))); }
      catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
  }

  /* ---------------- Routes de la console (après contrôle admin) ---------------- */
  function mountAdmin(r) {
    r.get('/insights', async (req, res, next) => { try { res.json(await report(req.query.days)); } catch (e) { next(e); } });
    r.get('/feedback', async (req, res) => {
      await ready;
      const st = String(req.query.status || ''), kind = String(req.query.kind || '');
      let list = feedback;
      if (st) list = list.filter(f => f.status === st);
      if (kind) list = list.filter(f => f.kind === kind);
      res.json({ total: list.length, items: list.slice(0, 300) });
    });
    r.patch('/feedback/:id', async (req, res) => {
      await ready;
      const f = feedback.find(x => x.id === req.params.id);
      if (!f) return res.status(404).json({ error: 'Avis introuvable.' });
      if (['new', 'lu', 'traite'].includes(req.body.status)) f.status = req.body.status;
      if ('note' in req.body) f.note = clip(req.body.note, 500);
      touch('feedback'); res.json(f);
    });
    r.delete('/feedback/:id', async (req, res) => {
      await ready;
      const i = feedback.findIndex(x => x.id === req.params.id);
      if (i >= 0) { feedback.splice(i, 1); touch('feedback'); }
      res.json({ ok: true });
    });
    r.get('/ideas', async (req, res) => { await ready; res.json({ items: ideas.map(i => Object.assign(publicIdea(i, null), { createdAt: i.createdAt })) }); });
    r.post('/ideas', async (req, res) => {
      await ready;
      const title = clip(req.body.title, 90);
      if (!title) return res.status(400).json({ error: 'Titre requis.' });
      const i = { id: crypto.randomBytes(5).toString('hex'), title, desc: clip(req.body.desc, 400), status: 'open', createdAt: now(), voters: [] };
      ideas.push(i); touch('ideas'); res.json(publicIdea(i, null));
    });
    r.patch('/ideas/:id', async (req, res) => {
      await ready;
      const i = ideas.find(x => x.id === req.params.id);
      if (!i) return res.status(404).json({ error: 'Idée introuvable.' });
      if (req.body.title) i.title = clip(req.body.title, 90);
      if ('desc' in req.body) i.desc = clip(req.body.desc, 400);
      if (['open', 'planned', 'done', 'hidden'].includes(req.body.status)) i.status = req.body.status;
      touch('ideas'); res.json(publicIdea(i, null));
    });
    r.delete('/ideas/:id', async (req, res) => {
      await ready;
      const k = ideas.findIndex(x => x.id === req.params.id);
      if (k >= 0) { ideas.splice(k, 1); touch('ideas'); }
      res.json({ ok: true });
    });
    r.post('/weekly', async (req, res) => {
      try { await sendWeekly(true); res.json({ ok: true, to: String(env.ADMIN_EMAIL).replace(/^(.)[^@]*(@.*)$/, '$1***$2') }); }
      catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
  }

  return { ready, record, addFeedback, listIdeas, vote, report, sendWeekly, weeklyHtml, mountPublic, mountAdmin, flush, _people: () => people };
}

module.exports = { createInsights, normSource, normError, normCountry, deviceOf };
