'use strict';
/**
 * Réunions audio et vidéo (mode « Réunion »).
 *
 *  - Créer : un lien /reunion/ID + un code à 6 chiffres, sans compte. L'organisateur garde une clé privée.
 *  - Rejoindre : prénom, micro coupé à l'arrivée ; lever la main ; partage d'écran.
 *  - Organisateur : couper un micro ou tous les micros, baisser une main, retirer quelqu'un,
 *    verrouiller la réunion, la terminer pour tous.
 *  - Outils de l'enseignant (3.14) : annotations sur la présentation ou le tableau blanc (stylo, surligneur,
 *    encre éphémère, formes, texte, notes, tampons, pointeur laser), minuteur commun, « J'ai compris / Je suis perdu ».
 *  - Présenter un fichier (3.15) : l'enseignant dépose un PDF, un PowerPoint ou des images ; son navigateur
 *    transforme chaque page en image, que chacun reçoit (léger, net, même sur un petit réseau). Annotations
 *    gardées page par page, navigation libre pour les élèves (si l'enseignant l'autorise), support téléchargeable.
 *    Les pages restent en mémoire le temps de la séance seulement.
 *
 * Deux moteurs :
 *  - « mesh » (par défaut) : chaque appareil se connecte aux autres (WebRTC + relais TURN).
 *    Idéal jusqu'à 12 personnes en audio, 6 en vidéo.
 *  - « sfu » (si CF_SFU_APP_ID et CF_SFU_APP_TOKEN sont définis) : chacun envoie sa voix une seule fois
 *    au serveur Cloudflare Realtime, qui la redistribue. Jusqu'à MEET_MAX personnes (50 par défaut).
 *    Le secret Cloudflare reste sur le serveur : l'écran passe par /api/meet/:id/sfu.
 *
 * Lien durable (24 h, 7 jours, 30 jours) : seule la fiche de la réunion est gardée (sujet, réglages,
 * empreinte de la clé organisateur, code, date d'expiration) dans meets/ID.json. Le même lien et le même
 * code resservent après un départ, un « Terminer pour tous » ou un redémarrage du serveur.
 * Rien d'autre n'est enregistré : ni la voix, ni la vidéo, ni la discussion, ni la liste des participants.
 */
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { rateLimiter, clientIp, socketIp, sha256, safeEqual } = require('./util');

const ID_RE = /^[a-z0-9]{10}$/;
const KINDS = ['audio', 'video'];
const TRACKS = ['a', 'c', 's', 'x'];               // micro, caméra, écran, son de l'écran (3.15)
const REACTS = ['hand', 'ok', 'yes', 'clap', 'love', 'laugh', 'thanks', 'q', 'no', 'wow'];
/* Annotations : outils autorisés, couleur #rrggbb, coordonnées de 0 à 1 dans l'image présentée */
const INK_TOOLS = ['pen', 'hl', 'fade', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note', 'stamp'];
const INK_MAX = 600;                                // traits gardés pour ceux qui arrivent en cours de route
const PULSES = ['ok', 'lost'];
/* Présentation de fichiers : limites de mémoire (les pages ne sont jamais écrites sur disque) */
const DOC_PAGES = 200, DOC_PAGE_MAX = 4 * 1024 * 1024, DOC_MAX = 60 * 1024 * 1024, DOCS_ALL_MAX = 240 * 1024 * 1024, DOC_FILE_MAX = 60 * 1024 * 1024;
const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

/* PowerPoint / Word → PDF avec LibreOffice, s'il est installé sur le serveur (sinon : code no_office) */
let officeBin;
function findOffice() {
  if (officeBin !== undefined) return Promise.resolve(officeBin);
  const tries = [process.env.SOFFICE_PATH, 'soffice', 'libreoffice', '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'].filter(Boolean);
  return tries.reduce((p, bin) => p.then(found => found || new Promise(res => execFile(bin, ['--version'], { timeout: 15000 }, (e) => res(e ? null : bin)))), Promise.resolve(null))
    .then(bin => { officeBin = bin; return bin; });
}
let officeBusy = Promise.resolve();
function officeToPdf(buf, ext) {
  const job = officeBusy.then(async () => {               // une conversion à la fois (LibreOffice est gourmand)
    const bin = await findOffice();
    if (!bin) throw Object.assign(new Error('no_office'), { code: 'no_office' });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lsdoc-'));
    try {
      const src = path.join(dir, 'cours.' + ext);
      await fsp.writeFile(src, buf);
      await new Promise((res, rej) => execFile(bin, ['--headless', '--norestore', '-env:UserInstallation=file://' + path.join(dir, 'profile'), '--convert-to', 'pdf', '--outdir', dir, src], { timeout: 120000 }, (e) => e ? rej(Object.assign(e, { code: 'convert' })) : res()));
      return await fsp.readFile(path.join(dir, 'cours.pdf'));
    } finally { fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });
  officeBusy = job.catch(() => {});
  return job;
}
const IDLE_MS = 15 * 60e3;                          // réunion vide : fermée après 15 min
const MAX_MS = 10 * 3600e3;                         // durée maximale d'une réunion sans lien durable
// Validité du lien : 'end' = jusqu'à la fin de la réunion (ancien fonctionnement)
const LIFE = { end: 0, '1d': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 };
const clip = (s, n) => String(s == null ? '' : s).replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const newId = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 10; i++) s += a[crypto.randomInt(a.length)]; return s; };

function createSfu(env, { fetchImpl = globalThis.fetch } = {}) {
  const appId = (env.CF_SFU_APP_ID || '').trim(), token = (env.CF_SFU_APP_TOKEN || '').trim();
  if (!appId || !token) return null;
  const base = `${String(env.CF_SFU_API_BASE || 'https://rtc.live.cloudflare.com/v1').replace(/\/$/, '')}/apps/${encodeURIComponent(appId)}`;
  async function call(method, path, body) {
    const r = await fetchImpl(base + path, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined   // Cloudflare peut attendre 5 s que la connexion soit prête
    });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || j.errorCode) {
      // On garde le code de Cloudflare : 425 = connexion pas encore prête, 410 = session expirée, 406 = conflit
      const e = new Error('Cloudflare Realtime : ' + ((j && (j.errorDescription || j.errorCode)) || 'HTTP ' + r.status));
      e.cfStatus = r.status; e.code = (j && j.errorCode) || ('http_' + r.status);
      e.status = r.status === 425 ? 425 : r.status === 410 ? 410 : r.status === 406 ? 409 : r.status === 401 || r.status === 403 ? 503 : 502;
      throw e;
    }
    return j;
  }
  return {
    newSession: () => call('POST', '/sessions/new'),
    tracks: (sid, body) => call('POST', `/sessions/${encodeURIComponent(sid)}/tracks/new`, body),
    renegotiate: (sid, body) => call('PUT', `/sessions/${encodeURIComponent(sid)}/renegotiate`, body),
    close: (sid, body) => call('PUT', `/sessions/${encodeURIComponent(sid)}/tracks/close`, body)
  };
}

/* Incidents remontés par les navigateurs et comptés dans la console (les autres sont seulement journalisés) */
const DIAG_KNOWN = new Set(['cam-black', 'cam-ended', 'cam-error', 'mic-error', 'mesh-answer', 'mesh-offer', 'mesh-signal', 'ice-failed', 'ice-disconnected',
  'sfu-start', 'sfu-recover', 'sfu-push', 'sfu-pull', 'manual-reconnect', 'video-black', 'video-black-early', 'video-republish']);

function mountMeet(app, io, { env, codes, ctx, fetchImpl, storage } = {}) {
  const sfu = createSfu(env || {}, { fetchImpl });
  const forced = String((env && env.MEET_ENGINE) || 'auto').toLowerCase();
  const engine = forced === 'mesh' || !sfu ? 'mesh' : 'sfu';
  let sfuBrokenUntil = 0;                         // identifiants refusés par Cloudflare : nouvelles réunions en direct pendant 10 min
  const engineNow = () => (engine === 'sfu' && Date.now() < sfuBrokenUntil ? 'mesh' : engine);
  const MAX = Math.max(2, Math.min(200, Number(env && env.MEET_MAX) || 50));
  const limitFor = (m) => (m.engine === 'sfu' ? MAX : m.kind === 'video' ? 6 : 12);
  const meetings = new Map();
  const createLimit = rateLimiter({ windowMs: 3600e3, max: 20 });
  const joinLimit = rateLimiter({ windowMs: 10 * 60e3, max: 60 });
  const sfuLimit = rateLimiter({ windowMs: 60e3, max: 240 });

  const staff = (p) => !!p && (p.host || p.cohost);
  const pub = (p) => ({ pid: p.pid, name: p.name, host: p.host, cohost: !!p.cohost, floor: !!p.floor, muted: p.muted, cam: p.cam, screen: p.screen, hand: p.hand || 0, tone: p.tone || 0, pulse: p.pulse || '', away: !!p.away, tracks: [...p.tracks], ready: !!p.sfuReady, gen: p.gen || 0 });
  /* Minuteur : on envoie le temps restant (et non l'heure de fin) pour ne pas dépendre de l'horloge de chaque appareil */
  const timerPub = (m) => (m.timer && m.timer.end > Date.now() ? { left: m.timer.end - Date.now(), sec: m.timer.sec, label: m.timer.label } : null);
  const info = (m) => ({ id: m.id, title: m.title, kind: m.kind, mode: m.mode, chat: m.chat, waiting: m.waiting, engine: m.engine, code: m.code, locked: m.locked, recording: !!m.recording, startedAt: m.startedAt || m.createdAt, max: limitFor(m), emergency: m.emergency, expiresAt: m.expiresAt || 0, inkAll: !!m.inkAll, board: !!m.board, timer: timerPub(m), doc: docPub(m) });
  /* Fichier présenté : nom, nombre de pages, taille de chaque page, page affichée, pages prêtes */
  const docPub = (m) => {
    const d = m.doc; if (!d || !d.pages.has(0)) return null;
    return { id: d.id, name: d.name, n: d.n, dims: d.dims, page: d.page, ready: d.pages.size, free: !!d.free, dl: !!(d.dl && d.file), file: !!d.file, by: d.by };
  };
  let docBytes = 0;                                // mémoire occupée par toutes les pages de toutes les réunions
  function docDrop(m) {
    const d = m.doc; if (!d) return;
    d.pages.forEach(b => { docBytes -= b.buf.length; });
    if (d.file && storage && storage.deleteKey) storage.deleteKey(d.file.key).catch(() => {});
    m.doc = null; m.docInk = null;
  }
  const pollPub = (m) => {
    const q = m.poll; if (!q) return null;
    const counts = q.opts.map(() => 0); q.votes.forEach(i => { counts[i]++; });
    return { id: q.id, q: q.q, opts: q.opts, counts, total: q.votes.size, open: q.open };
  };
  const room = (m) => 'meet:' + m.id;
  const staffRoom = (m) => 'meet-staff:' + m.id;
  const meOf = (m, socket) => [...m.people.values()].find(x => x.sid === socket.id);
  /* Statistiques anonymes pour la console admin (aucun nom, aucun sujet) */
  const count = (f) => { try { if (ctx && ctx.insights && ctx.insights.count) ctx.insights.count(f).catch(() => {}); } catch (e) { /* ignore */ } };
  const lastQ = new WeakMap();
  /* Journal exploitable (Render → Logs) : identifiants courts, jamais de nom ni de sujet */
  const log = (ev, m, extra) => { try { console.log(JSON.stringify(Object.assign({ t: 'meet', ev, room: m ? m.id.slice(0, 5) : undefined, n: m ? m.people.size : undefined, engine: m ? m.engine : undefined }, extra || {}))); } catch (e) { /* ignore */ } };
  /** Repli automatique : si le serveur de réunion échoue, la réunion passe en mode direct (12 personnes ou moins) */
  function fallback(m, why) {
    if (m.engine !== 'sfu') return false;
    if (m.people.size > 12) { log('fallback-refused', m, { why }); return false; }
    m.engine = 'mesh';
    for (const p of m.people.values()) { p.session = null; p.tracks.clear(); p.mids = []; p.sfuReady = false; }
    log('fallback', m, { why }); count({ meet_fallback: 1 });
    io.to(room(m)).emit('meet-info', Object.assign(info(m), { switched: true }));
    return true;
  }
  /** Une personne sort : minutes de présence ; dernière sortie : durée de la séance */
  function stamp(m, p) {
    const now = Date.now();
    const f = { meet_person_s: Math.round((now - (p.att ? p.att.in : now)) / 1000) };
    if (!m.people.size && m.sessAt) { f.meet_sess_s = Math.round((now - m.sessAt) / 1000); m.sessAt = 0; }
    count(f);
  }

  /* ---------- fiche durable (liens 24 h / 7 j / 30 j) ---------- */
  const recKey = (id) => 'meets/' + id + '.json';
  const FIELDS = ['id', 'title', 'kind', 'mode', 'chat', 'waiting', 'emergency', 'hostHash', 'code', 'createdAt', 'expiresAt', 'locked'];
  function save(m) {
    if (!storage || !m.expiresAt) return;
    const rec = {}; FIELDS.forEach(k => { rec[k] = m[k]; });
    storage.putBuffer(recKey(m.id), Buffer.from(JSON.stringify(rec)), 'application/json').catch(e => console.warn('meet save', e.message));
  }
  function fresh(rec) {
    return Object.assign({}, rec, { engine: engineNow(), startedAt: Date.now(), emptySince: Date.now(), people: new Map(), lobby: new Map(), attendance: [], messages: [], poll: null, recording: false, ink: [], board: false, inkAll: false, timer: null });
  }
  const loading = new Map();
  /** Réunion en mémoire, ou rechargée depuis sa fiche. { m } | { gone: 'expired' } | {} */
  async function find(id) {
    if (!ID_RE.test(String(id || ''))) return {};
    const live = meetings.get(id); if (live) return { m: live };
    if (!storage) return {};
    if (!loading.has(id)) loading.set(id, (async () => {
      const b = await storage.getBuffer(recKey(id)).catch(() => null);
      if (!b) return {};
      let rec; try { rec = JSON.parse(b.toString('utf8')); } catch (e) { return {}; }
      if (!rec || rec.id !== id || !rec.hostHash) return {};
      if (!(rec.expiresAt > Date.now())) { purge(id, rec.code); return { gone: 'expired' }; }
      if (meetings.has(id)) return { m: meetings.get(id) };
      const m = fresh(rec); meetings.set(id, m);
      if (codes && m.code) codes.restoreMeet(m.code, id, m.expiresAt);
      return { m };
    })().finally(() => setTimeout(() => loading.delete(id), 0)));
    return loading.get(id);
  }
  const alive = async (id) => !!(await find(id)).m;
  function purge(id, code) {
    if (codes) codes.dropMeet(id, true);
    if (storage && storage.deleteKey) {
      storage.deleteKey(recKey(id)).catch(() => {});
      if (/^\d{6}$/.test(String(code || ''))) storage.deleteKey('codes/' + code + '.json').catch(() => {});
    }
  }
  const gone = (f) => f.gone === 'expired' ? 'Ce lien de réunion a expiré. Demandez un nouveau lien à l\'organisateur.' : 'Cette réunion n\'existe pas ou a été supprimée.';

  /** Fin de la séance. Lien durable : la fiche reste, le même lien resservira (sauf drop = supprimer le lien) */
  function endMeeting(m, reason, drop) {
    const keep = !!m.expiresAt && !drop && Date.now() < m.expiresAt;
    io.to(room(m)).emit('meet-ended', { reason, keep, expiresAt: keep ? m.expiresAt : 0 });
    m.lobby.forEach((w, sid) => io.to(sid).emit('meet-denied', { reason: 'La réunion est terminée.' }));
    const all = [...m.people.values()];
    for (const p of all) {
      const s = io.sockets.sockets.get(p.sid); if (s) { s.leave(room(m)); s.leave(staffRoom(m)); s.meetId = null; }
    }
    m.people.clear();
    all.forEach(p => stamp(m, p));
    docDrop(m);
    meetings.delete(m.id);
    if (keep) { if (codes) codes.dropMeet(m.id); }    // libéré en mémoire seulement ; rechargé au prochain accès
    else if (m.expiresAt) purge(m.id, m.code);
    else if (codes) codes.dropMeet(m.id);
  }
  let lastPurge = 0;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const m of meetings.values()) {
      if (m.expiresAt && now > m.expiresAt) endMeeting(m, 'Le lien de la réunion a expiré.', true);
      else if (!m.expiresAt && now - m.createdAt > MAX_MS) endMeeting(m, 'Durée maximale atteinte.');
      else if (!m.people.size && !m.lobby.size && now - m.emptySince > IDLE_MS) {
        if (m.expiresAt) { docDrop(m); meetings.delete(m.id); if (codes) codes.dropMeet(m.id); }   // vide : libère la mémoire, le lien reste valable
        else endMeeting(m, 'expired');
      }
    }
    // Une fois par heure : efface les fiches expirées
    if (storage && storage.listKeys && now - lastPurge > 3600e3) {
      lastPurge = now;
      storage.listKeys('meets/').then(keys => Promise.all((keys || []).slice(0, 500).map(async k => {
        const id = String(k.key || k).replace(/^.*meets\//, '').replace(/\.json$/, '');
        if (!meetings.has(id)) await find(id);
      }))).catch(() => {});
    }
  }, 60e3);
  if (sweep.unref) sweep.unref();

  const waitList = (m) => [...m.lobby.entries()].map(([sid, w]) => ({ sid, name: w.name, at: w.at }));
  const pushWait = (m) => io.to(staffRoom(m)).emit('meet-wait', waitList(m));

  function leave(socket, why) {
    const m = meetings.get(socket.meetId);
    if (m && m.lobby.delete(socket.id)) { socket.meetId = null; pushWait(m); return; }
    if (!m) return;
    const p = meOf(m, socket); if (!p) return;
    m.people.delete(p.pid);
    if (p.att) p.att.out = Date.now();
    socket.leave(room(m)); socket.leave(staffRoom(m)); socket.meetId = null;
    io.to(room(m)).emit('meet-left', { pid: p.pid, why: why || 'left' });
    log('leave', m, { pid: p.pid.slice(0, 6), why: why || 'left', s: Math.round((Date.now() - (p.att ? p.att.in : Date.now())) / 1000) });
    if (p.session && sfu && p.mids.length) sfu.close(p.session, { tracks: p.mids.map(mid => ({ mid })), force: true }).catch(() => {});
    if (p.screen) inkReset(m);
    if (!m.people.size) m.emptySince = Date.now();
    stamp(m, p);
  }

  /** Plus de présentation ni de tableau blanc : les annotations disparaissent pour tout le monde */
  function inkReset(m) {
    if (m.board || m.doc || [...m.people.values()].some(x => x.screen) || !m.ink.length) return;
    m.ink = []; io.to(room(m)).emit('meet-ink', { op: 'clear' });
  }
  /** Trait d'annotation reçu d'un navigateur : tout est vérifié et borné */
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.max(-0.2, Math.min(1.2, n)) * 1e4) / 1e4 : null; };
  function cleanInk(s, p) {
    if (!s || typeof s !== 'object' || !INK_TOOLS.includes(s.tool)) return null;
    const id = String(s.id || ''); if (!/^[a-z0-9]{6,16}$/.test(id)) return null;
    const pts = (Array.isArray(s.pts) ? s.pts : []).slice(0, 4000).map(num);
    if (pts.length < 2 || pts.length % 2 || pts.some(v => v == null)) return null;
    const c = /^#[0-9a-f]{6}$/i.test(String(s.c || '')) ? String(s.c).toLowerCase() : '#ef4444';
    const w = Math.max(1, Math.min(40, Number(s.w) || 4));
    const out = { id, by: p.pid, tool: s.tool, c, w, pts };
    if (['text', 'note', 'stamp'].includes(s.tool)) { out.t = clip(s.t, s.tool === 'stamp' ? 8 : 300); if (!out.t) return null; out.pts = pts.slice(0, 2); }
    return out;
  }
  const canInk = (m, p) => !!p && (staff(p) || p.screen || !!m.inkAll);

  /* Entrée effective dans la réunion (directe, ou après la salle d'attente) */
  function enter(socket, m, w) {
    if (m.people.size >= limitFor(m)) return { error: `La réunion est complète (${limitFor(m)} personnes au maximum).` };
    const pid = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(18).toString('base64url');
    const p = { pid, sid: socket.id, token, name: w.name, host: w.host, cohost: false, floor: false, muted: true, cam: false, screen: false, hand: 0, tone: w.tone, tracks: new Set(), session: null, mids: [] };
    p.att = { name: p.name, host: p.host, in: Date.now(), out: 0 };
    if (m.attendance.indexOf(p.att) < 0) m.attendance.push(p.att);
    if (m.attendance.length > 2000) m.attendance.shift();
    const others = [...m.people.values()].map(pub);
    if (!m.people.size && !others.length && m.expiresAt && Date.now() - m.emptySince > 60e3) {
      // Nouvelle séance sur un lien durable : horloge, discussion, sondage et présence repartent de zéro
      Object.assign(m, { startedAt: Date.now(), messages: [], poll: null, attendance: [p.att], recording: false, ink: [], board: false, inkAll: false, timer: null });
      docDrop(m);
    }
    m.people.set(pid, p);
    if (!m.sessAt) { m.sessAt = Date.now(); count({ meet_sessions: 1 }); }
    log('join', m, { pid: pid.slice(0, 6) });
    count({ meet_joins: 1, max_meet_people: m.people.size });
    socket.join(room(m)); socket.meetId = m.id;
    if (staff(p)) socket.join(staffRoom(m));
    socket.to(room(m)).emit('meet-joined', pub(p));
    return { ok: true, self: pub(p), token, meeting: info(m), people: others, messages: m.messages.slice(-80), poll: pollPub(m), wait: staff(p) ? waitList(m) : [], ink: m.ink };
  }

  /* ---------- signalisation (socket.io) ---------- */
  io.on('connection', (socket) => {
    const ip = socketIp(socket);
    let lastChat = 0;

    socket.on('meet-create', async ({ title, kind, mode, chat, waiting, emergency, life } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (ctx && ctx.settings && !ctx.settings.on('meet')) return cb({ error: 'Les réunions sont désactivées pour le moment.' });
      if (!createLimit(ip)) return cb({ error: 'Trop de réunions créées depuis cette connexion. Réessayez plus tard.' });
      let id; do { id = newId(); } while (meetings.has(id));
      const hostKey = crypto.randomBytes(18).toString('base64url');
      const md = mode === 'course' && !emergency ? 'course' : 'meeting';
      const m = {
        id, title: clip(title, 80) || (emergency ? 'Réunion urgente' : md === 'course' ? 'Cours' : 'Réunion'), kind: KINDS.includes(kind) ? kind : 'audio',
        mode: md, chat: chat !== false, waiting: !!waiting && !emergency,
        engine: engineNow(), hostHash: sha256(hostKey), createdAt: Date.now(), startedAt: Date.now(), emptySince: Date.now(), locked: false, emergency: !!emergency,
        expiresAt: storage && LIFE[life] ? Date.now() + LIFE[life] : 0,
        people: new Map(), lobby: new Map(), attendance: [], messages: [], poll: null, ink: [], board: false, inkAll: false, timer: null
      };
      meetings.set(id, m);
      m.code = codes ? await codes.forMeet(id, m.expiresAt) : null;
      save(m);
      count({ meet_created: 1, ['meet_' + m.kind]: 1, ['meet_' + m.mode]: 1, meet_emergency: m.emergency ? 1 : 0, ['meet_life_' + (LIFE[life] && storage ? life : 'end')]: 1 });
      if (ctx && ctx.io) ctx.io.to('admin').emit('admin-event', { id, title: md === 'course' ? 'Cours' : 'Réunion', event: { t: Date.now(), type: 'meet_created', kind: m.kind } });
      cb({ id, hostKey, code: m.code, kind: m.kind, mode: m.mode, expiresAt: m.expiresAt });
    });

    socket.on('meet-peek', async ({ id } = {}, cb) => {
      if (typeof cb !== 'function') return;
      const f = await find(id), m = f.m;
      if (!m) return cb({ error: gone(f), expired: f.gone === 'expired', gone: true });
      cb({ meeting: info(m), count: m.people.size });
    });

    socket.on('meet-join', async ({ id, name, hostKey, tone } = {}, cb) => {
      if (typeof cb !== 'function') return;
      if (!joinLimit(ip)) return cb({ error: 'Trop de tentatives. Patientez quelques minutes.' });
      const f = await find(id), m = f.m;
      if (!m) return cb({ error: gone(f) });
      const isHost = typeof hostKey === 'string' && hostKey.length > 10 && safeEqual(sha256(hostKey), m.hostHash);
      if (socket.meetId) leave(socket, 'left');
      if (m.locked && !isHost) return cb({ error: 'L\'organisateur a verrouillé cette réunion.' });
      const w = { name: clip(name, 30) || 'Invité', host: isHost, tone: Math.max(0, Math.min(5, parseInt(tone, 10) || 0)), at: Date.now() };
      if (m.waiting && !isHost) {
        if (m.lobby.size >= 100) return cb({ error: 'La salle d\'attente est pleine. Réessayez dans un instant.' });
        m.lobby.set(socket.id, w); socket.meetId = m.id;
        pushWait(m);
        return cb({ waiting: true, meeting: info(m) });
      }
      cb(enter(socket, m, w));
    });

    socket.on('meet-state', (s = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const p = meOf(m, socket); if (!p) return;
      if ('muted' in s) {
        // Mode cours : on ne s'ouvre le micro qu'avec la parole
        if (!s.muted && m.mode === 'course' && !staff(p) && !p.floor) { io.to(p.sid).emit('meet-force', { action: 'mute', by: '', quiet: true }); p.muted = true; }
        else p.muted = !!s.muted;
      }
      if ('cam' in s) p.cam = !!s.cam && m.kind === 'video';
      let stopped = false;
      if ('screen' in s) { const was = p.screen; p.screen = !!s.screen && (m.mode !== 'course' || staff(p) || p.floor); if (p.screen && !was) count({ meet_screens: 1 }); stopped = was && !p.screen; }
      if ('hand' in s) p.hand = s.hand ? (p.hand || Date.now()) : 0;
      if ('pulse' in s) p.pulse = PULSES.includes(s.pulse) ? s.pulse : '';
      if ('away' in s) p.away = !!s.away;                   // page du cours cachée (autre onglet, autre application)
      if ('tone' in s) p.tone = Math.max(0, Math.min(5, parseInt(s.tone, 10) || 0));
      io.to(room(m)).emit('meet-state', pub(p));
      if (stopped) inkReset(m);
    });

    /* Signalisation WebRTC (moteur mesh) : uniquement entre membres de la même réunion */
    socket.on('meet-signal', ({ to, data } = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const from = meOf(m, socket);
      const target = m.people.get(to);
      if (!from || !target || !data || typeof data !== 'object') return;
      io.to(target.sid).emit('meet-signal', { from: from.pid, data });
    });

    socket.on('meet-host', ({ action, pid, sid, value } = {}, cb) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const me = meOf(m, socket);
      if (!staff(me)) return;
      const target = pid ? m.people.get(pid) : null;
      const reply = (x) => { if (typeof cb === 'function') cb(x); };
      if (action === 'mute' && target) { target.floor = false; io.to(target.sid).emit('meet-force', { action: 'mute', by: me.name }); io.to(room(m)).emit('meet-state', pub(target)); }
      else if (action === 'muteAll') { for (const p of m.people.values()) if (p.pid !== me.pid && !staff(p)) { p.floor = false; io.to(p.sid).emit('meet-force', { action: 'mute', by: me.name }); io.to(room(m)).emit('meet-state', pub(p)); } }
      else if (action === 'lower' && target) { target.hand = 0; io.to(room(m)).emit('meet-state', pub(target)); }
      else if (action === 'floor' && target) { target.floor = true; target.hand = 0; io.to(target.sid).emit('meet-force', { action: 'floor', by: me.name }); io.to(room(m)).emit('meet-state', pub(target)); }
      else if (action === 'unfloor' && target) { target.floor = false; io.to(target.sid).emit('meet-force', { action: 'mute', by: me.name, unfloor: true }); io.to(room(m)).emit('meet-state', pub(target)); }
      else if (action === 'remove' && target && !target.host) {
        io.to(target.sid).emit('meet-force', { action: 'remove', by: me.name });
        const s = io.sockets.sockets.get(target.sid); if (s) leave(s, 'removed');
      }
      else if ((action === 'cohost' || action === 'uncohost') && target && me.host && !target.host) {
        target.cohost = action === 'cohost';
        const s = io.sockets.sockets.get(target.sid);
        if (s) { if (target.cohost) { s.join(staffRoom(m)); io.to(target.sid).emit('meet-wait', waitList(m)); } else s.leave(staffRoom(m)); }
        io.to(room(m)).emit('meet-state', pub(target));
      }
      else if (action === 'admit' || action === 'deny') {
        const list = sid === '*' ? [...m.lobby.keys()] : [sid];
        for (const id of list) {
          const w = m.lobby.get(id); if (!w) continue;
          m.lobby.delete(id);
          const s = io.sockets.sockets.get(id); if (!s) continue;
          if (action === 'deny') { s.meetId = null; io.to(id).emit('meet-denied', { reason: 'L\'organisateur n\'a pas accepté votre demande.' }); }
          else { s.meetId = null; io.to(id).emit('meet-admitted', enter(s, m, w)); }
        }
        pushWait(m);
      }
      else if (action === 'lock' || action === 'unlock') { m.locked = action === 'lock'; save(m); io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'waiting') { m.waiting = !!value; if (!m.waiting && m.lobby.size) { /* tout le monde entre */ for (const [id, w] of [...m.lobby]) { m.lobby.delete(id); const s = io.sockets.sockets.get(id); if (s) { s.meetId = null; io.to(id).emit('meet-admitted', enter(s, m, w)); } } pushWait(m); } save(m); io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'chat') { m.chat = !!value; save(m); io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'inkAll') { m.inkAll = !!value; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'board') { m.board = !!value; io.to(room(m)).emit('meet-info', info(m)); if (!m.board) inkReset(m); }
      else if (action === 'timer') {
        const sec = Math.round(Number(value && value.sec));
        if (!(sec >= 5 && sec <= 4 * 3600)) return reply({ error: 'Durée invalide.' });
        m.timer = { end: Date.now() + sec * 1000, sec, label: clip(value && value.label, 40) };
        count({ meet_timers: 1 });
        io.to(room(m)).emit('meet-info', info(m));
      }
      else if (action === 'docPage' && m.doc) {
        const d = m.doc, n = parseInt(value, 10);
        if (!(n >= 0 && n < d.n) || n === d.page) return cb && cb({ ok: true });
        // Annotations rangées page par page : chacun retrouve les traits de la page affichée
        m.docInk = m.docInk || new Map(); m.docInk.set(d.page, m.ink);
        d.page = n; m.ink = m.docInk.get(n) || [];
        io.to(room(m)).emit('meet-ink', { op: 'load', ink: m.ink });
        io.to(room(m)).emit('meet-info', info(m));
      }
      else if (action === 'docFree' && m.doc) { m.doc.free = !!value; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'docDl' && m.doc) { m.doc.dl = !!value; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'docClose' && m.doc) { docDrop(m); m.ink = []; io.to(room(m)).emit('meet-ink', { op: 'clear' }); io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'timerStop') { m.timer = null; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'pulseReset') { for (const p of m.people.values()) if (p.pulse) { p.pulse = ''; io.to(room(m)).emit('meet-state', pub(p)); } }
      else if ((action === 'rec' || action === 'unrec') && me.host) { if (action === 'rec' && !m.recording) count({ meet_recs: 1 }); m.recording = action === 'rec'; io.to(room(m)).emit('meet-info', info(m)); }
      else if (action === 'attendance') {
        // Liste de présence : une ligne par personne (même prénom = même personne), durée cumulée
        const now = Date.now(), by = new Map();
        for (const a of m.attendance) {
          const k = a.name.toLowerCase();
          const r = by.get(k) || { name: a.name, host: a.host, first: a.in, last: 0, ms: 0, visits: 0, present: false };
          r.first = Math.min(r.first, a.in); r.last = Math.max(r.last, a.out || now); r.ms += (a.out || now) - a.in; r.visits++; if (!a.out) r.present = true;
          by.set(k, r);
        }
        reply({ title: m.title, startedAt: m.createdAt, rows: [...by.values()].sort((x, y) => x.first - y.first) });
      }
      else if (action === 'end' && me.host) endMeeting(m, 'L\'organisateur a terminé la réunion.');
      else if (action === 'delete' && me.host) endMeeting(m, 'L\'organisateur a terminé la réunion et supprimé le lien.', true);
    });

    /* Discussion écrite */
    socket.on('meet-chat', ({ text } = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const p = meOf(m, socket); if (!p) return;
      if (!m.chat && !staff(p)) return;
      const t = clip(text, 500); if (!t) return;
      const now = Date.now(); if (now - lastChat < 800) return; lastChat = now;
      const msg = { id: crypto.randomBytes(4).toString('hex'), pid: p.pid, name: p.name, staff: staff(p), text: t, at: now };
      m.messages.push(msg); if (m.messages.length > 300) m.messages.shift();
      io.to(room(m)).emit('meet-chat', msg);
    });

    /* Sondages (votes anonymes pour les participants, un vote par personne, modifiable tant qu'il est ouvert) */
    socket.on('meet-poll', ({ q, opts } = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      if (!staff(meOf(m, socket))) return;
      const question = clip(q, 200);
      const options = (Array.isArray(opts) ? opts : []).map(o => clip(o, 80)).filter(Boolean).slice(0, 6);
      if (!question || options.length < 2) return;
      m.poll = { id: crypto.randomBytes(4).toString('hex'), q: question, opts: options, votes: new Map(), open: true };
      io.to(room(m)).emit('meet-poll', pollPub(m));
    });
    socket.on('meet-vote', ({ id, i } = {}) => {
      const m = meetings.get(socket.meetId); if (!m || !m.poll || !m.poll.open || m.poll.id !== id) return;
      const p = meOf(m, socket); if (!p) return;
      const k = parseInt(i, 10); if (!(k >= 0 && k < m.poll.opts.length)) return;
      m.poll.votes.set(p.pid, k);
      io.to(room(m)).emit('meet-poll', pollPub(m));
    });
    socket.on('meet-poll-close', () => {
      const m = meetings.get(socket.meetId); if (!m || !m.poll) return;
      if (!staff(meOf(m, socket))) return;
      m.poll.open = false; io.to(room(m)).emit('meet-poll', pollPub(m));
    });

    /* Réactions (autocollants) : liste fermée, une toutes les 0,6 s au plus */
    socket.on('meet-react', ({ r, t } = {}) => {
      const m = meetings.get(socket.meetId); if (!m || !REACTS.includes(r)) return;
      const p = meOf(m, socket); if (!p) return;
      const now = Date.now(); if (now - (p.lastReact || 0) < 600) return; p.lastReact = now;
      io.to(room(m)).emit('meet-react', { pid: p.pid, r, t: Math.max(0, Math.min(5, parseInt(t, 10) || 0)) });
    });

    /* Annotations sur la présentation ou le tableau blanc.
       live = trait en cours (relayé seulement), add = trait terminé (gardé pour ceux qui arrivent),
       del = gomme / annuler, clear = tout effacer, laser = pointeur (relayé seulement) */
    socket.on('meet-ink', (d = {}) => {
      const m = meetings.get(socket.meetId); if (!m) return;
      const p = meOf(m, socket); if (!p || !d || typeof d !== 'object') return;
      const now = Date.now();
      if (now - (p.inkT || 0) > 1000) { p.inkT = now; p.inkN = 0; }
      if (++p.inkN > 80) return;                         // au plus 80 messages par seconde et par personne
      if (d.op === 'laser') {
        if (!canInk(m, p)) return;
        const x = num(d.x), y = num(d.y); if (x == null || y == null) return;
        socket.to(room(m)).volatile.emit('meet-ink', { op: 'laser', pid: p.pid, x, y, c: /^#[0-9a-f]{6}$/i.test(String(d.c || '')) ? d.c : '#ef4444', off: !!d.off });
      } else if (d.op === 'live') {
        if (!canInk(m, p)) return;
        const s = cleanInk(Object.assign({}, d.s, { pts: d.pts }), p); if (!s) return;
        const at = Math.max(0, Math.min(100000, parseInt(d.at, 10) || 0));
        socket.to(room(m)).volatile.emit('meet-ink', { op: 'live', s: { id: s.id, by: s.by, tool: s.tool, c: s.c, w: s.w }, pts: s.pts, at });
      } else if (d.op === 'add') {
        if (!canInk(m, p)) return;
        const s = cleanInk(d.s, p); if (!s) return;
        if (s.tool !== 'fade') {                          // l'encre éphémère s'efface d'elle-même : rien à garder
          m.ink = m.ink.filter(x => x.id !== s.id); m.ink.push(s);
          if (m.ink.length > INK_MAX) m.ink.splice(0, m.ink.length - INK_MAX);
        }
        socket.to(room(m)).emit('meet-ink', { op: 'add', s });
      } else if (d.op === 'del') {
        const ids = (Array.isArray(d.ids) ? d.ids : []).slice(0, 50).map(String);
        const mayAll = staff(p) || p.screen;
        const gone = m.ink.filter(x => ids.includes(x.id) && (mayAll || x.by === p.pid)).map(x => x.id);
        if (!gone.length) return;
        m.ink = m.ink.filter(x => !gone.includes(x.id));
        io.to(room(m)).emit('meet-ink', { op: 'del', ids: gone });
      } else if (d.op === 'clear') {
        if (!(staff(p) || p.screen)) return;
        m.ink = []; io.to(room(m)).emit('meet-ink', { op: 'clear' });
      }
    });

    /* Incidents remontés par les appareils (sans donnée personnelle) : compteurs + journal */
    const lastDiag = { t: 0, n: 0 };
    socket.on('meet-diag', ({ ev, code } = {}) => {
      const m = meetings.get(socket.meetId); const me = m && meOf(m, socket); if (!me) return;
      const t = Date.now();
      if (t - lastDiag.t > 60e3) { lastDiag.t = t; lastDiag.n = 0; } if (++lastDiag.n > 20) return;
      const e = String(ev || '').replace(/[^a-z-]/g, '').slice(0, 20), c = String(code || '').replace(/[^\w-]/g, '').slice(0, 30);
      if (!e) return;
      log('diag', m, { pid: me.pid.slice(0, 6), e, c });
      count({ ['diag_' + (DIAG_KNOWN.has(e) ? e.replace(/-/g, '_') : 'autre')]: 1 });   // compteurs : liste fermée
    });

    /* Délai mesuré par les spectateurs d'une présentation (au plus une mesure toutes les 20 s par connexion) */
    socket.on('meet-q', ({ lat, fps } = {}) => {
      const m = meetings.get(socket.meetId); if (!m || !meOf(m, socket)) return;
      const t = Date.now(); if (t - (lastQ.get(socket) || 0) < 20e3) return; lastQ.set(socket, t);
      const l = Math.round(Number(lat)), f = Math.round(Number(fps));
      if (!(l > 0 && l < 20000)) return;
      count({ q_n: 1, q_lat: l, q_fps: f >= 0 && f <= 60 ? f : 0, q_slow: l > 700 ? 1 : 0, ['q_' + m.engine]: 1 });
    });

    socket.on('meet-leave', () => leave(socket, 'left'));
    socket.on('disconnect', () => leave(socket, 'left'));
  });

  /* ---------- relais vers Cloudflare Realtime (moteur sfu) ----------
     Règles Cloudflare respectées : une seule opération à la fois par session (file côté appareil),
     aucune récupération de piste avant que la connexion soit établie (« ready »), ni de caméra
     éteinte ; session expirée = nouvelle session (« reset »). */
  const sfuFail = (res, e, p, m, op) => {
    const code = e.name === 'TimeoutError' || e.code === 23 ? 'timeout' : (e.code || 'error');   // 23 = délai dépassé côté serveur
    count({ ['sfu_' + String(code).replace(/[^\w]/g, '_').slice(0, 24)]: 1 });
    log('sfu-error', m, { pid: p ? p.pid.slice(0, 6) : undefined, op: op || undefined, code, http: e.cfStatus });
    const msg = e.status === 425 ? 'Connexion en cours, nouvel essai…' : e.status === 410 ? 'Session expirée, reconnexion…' : e.status === 503 ? 'Serveur de réunion mal configuré.' : 'Le serveur de réunion est momentanément indisponible.';
    res.status(e.status || 502).json({ error: msg, code, retry: e.status !== 503, rebuild: e.status === 410 });
  };
  app.post('/api/meet/:id/sfu', async (req, res) => {
    if (!sfu) return res.status(404).json({ error: 'Serveur de réunion non configuré.', code: 'no_sfu', retry: false });
    // Limite par participant (et non par adresse IP : toute une école peut partager la même)
    if (!sfuLimit(String(req.params.id) + ':' + String(req.get('x-meet-token') || '').slice(0, 12))) return res.status(429).json({ error: 'Trop de requêtes.', code: 'rate', retry: true });
    const m = meetings.get(req.params.id);
    const token = String(req.get('x-meet-token') || '');
    const p = m && [...m.people.values()].find(x => x.token.length === token.length && safeEqual(x.token, token));
    if (!p) return res.status(403).json({ error: 'Vous ne faites plus partie de cette réunion.', code: 'gone', retry: false });
    if (m.engine !== 'sfu') return res.status(409).json({ error: 'La réunion est passée en mode direct.', code: 'switched', retry: false });
    const b = req.body || {};
    try {
      if (b.op === 'reset') {
        // Nouvelle session : les autres reprendront les pistes de cette personne
        if (p.session && p.mids.length) sfu.close(p.session, { tracks: p.mids.map(mid => ({ mid })), force: true }).catch(() => {});
        p.session = null; p.tracks.clear(); p.mids = []; p.sfuReady = false; p.gen = (p.gen || 0) + 1;
        log('sfu-reset', m, { pid: p.pid.slice(0, 6), why: String(b.why || '').slice(0, 20) });
        count({ meet_sfu_reset: 1 });
        io.to(room(m)).emit('meet-state', pub(p));
        return res.json({ ok: true, gen: p.gen });
      }
      if (b.op === 'fail') {
        const done = fallback(m, String(b.why || 'client').replace(/[^\w-]/g, '').slice(0, 20));
        return res.json({ ok: true, switched: done });
      }
      if (b.op === 'ready') {
        p.sfuReady = true;
        io.to(room(m)).emit('meet-state', pub(p));
        return res.json({ ok: true });
      }
      if (!p.session) p.session = (await sfu.newSession()).sessionId;
      if (b.op === 'push') {
        const tracks = (Array.isArray(b.tracks) ? b.tracks : []).filter(t => TRACKS.includes(t.kind) && typeof t.mid === 'string').slice(0, 4);
        if (!tracks.length || !b.sessionDescription) return res.status(400).json({ error: 'Requête invalide.', code: 'bad', retry: false });
        const r = await sfu.tracks(p.session, { sessionDescription: b.sessionDescription, tracks: tracks.map(t => ({ location: 'local', mid: t.mid, trackName: p.pid + '-' + t.kind })) });
        const bad = (r.tracks || []).find(t => t.errorCode);
        if (bad) { const e = new Error(bad.errorDescription || bad.errorCode); e.code = bad.errorCode; e.status = 502; throw e; }
        tracks.forEach(t => { p.tracks.add(t.kind); p.mids.push(t.mid); });
        io.to(room(m)).emit('meet-state', pub(p));
        return res.json({ sessionDescription: r.sessionDescription, tracks: r.tracks || [] });
      }
      if (b.op === 'pull') {
        // On ne demande que des pistes qui envoient vraiment des images ou du son
        const active = (o, k) => k === 'a' || (k === 'c' && o.cam) || ((k === 's' || k === 'x') && o.screen);
        const skipped = [];
        const want = (Array.isArray(b.tracks) ? b.tracks : []).slice(0, 30).map(t => {
          const o = m.people.get(t.pid);
          const ok = o && o.pid !== p.pid && o.session && o.sfuReady && o.tracks.has(t.kind) && active(o, t.kind);
          if (!ok) { skipped.push({ pid: t.pid, kind: t.kind, error: 'not_ready' }); return null; }
          return { location: 'remote', sessionId: o.session, trackName: o.pid + '-' + t.kind, _pid: o.pid, _kind: t.kind };
        }).filter(Boolean);
        if (!want.length) return res.json({ tracks: skipped });
        const r = await sfu.tracks(p.session, { tracks: want.map(({ _pid, _kind, ...t }) => t) });
        const out = (r.tracks || []).map(t => { const w = want.find(x => x.trackName === t.trackName && x.sessionId === t.sessionId) || {}; return { mid: t.mid, pid: w._pid, kind: w._kind, error: t.errorCode || null }; });
        out.forEach(t => { if (t.mid && !t.error) p.mids.push(t.mid); });
        return res.json({ sessionDescription: r.sessionDescription || null, requiresImmediateRenegotiation: !!r.requiresImmediateRenegotiation, tracks: out.concat(skipped) });
      }
      if (b.op === 'renegotiate') {
        if (!b.sessionDescription) return res.status(400).json({ error: 'Requête invalide.', code: 'bad', retry: false });
        await sfu.renegotiate(p.session, { sessionDescription: b.sessionDescription });
        return res.json({ ok: true });
      }
      if (b.op === 'close') {
        const mids = (Array.isArray(b.mids) ? b.mids : []).filter(x => typeof x === 'string').slice(0, 30);
        if (mids.length) await sfu.close(p.session, { tracks: mids.map(mid => ({ mid })), force: true }).catch(() => {});
        p.mids = p.mids.filter(x => !mids.includes(x));
        return res.json({ ok: true });
      }
      res.status(400).json({ error: 'Opération inconnue.', code: 'bad', retry: false });
    } catch (e) {
      if (e.status === 503) { sfuBrokenUntil = Date.now() + 10 * 60e3; fallback(m, 'config'); }
      sfuFail(res, e, p, m, String(b.op || '').slice(0, 12));
    }
  });

  /* ---------- présentation de fichiers ---------- */
  const personOf = (req) => {
    const m = meetings.get(String(req.params.id || '')); if (!m) return {};
    const token = String(req.get('x-meet-token') || '');
    const p = token && [...m.people.values()].find(x => x.token.length === token.length && safeEqual(x.token, token));
    return { m, p };
  };
  const docLimit = rateLimiter({ windowMs: 60e3, max: 600 });
  /** Corps brut (image d'une page, fichier d'origine), avec une taille maximale */
  const raw = (limit) => (req, res, next) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > limit) { over = true; chunks.length = 0; res.status(413).json({ error: 'Fichier trop lourd.' }); req.resume(); } else chunks.push(c); });
    req.on('end', () => { if (over) return; req.raw = Buffer.concat(chunks); next(); });
    req.on('error', () => { if (!res.headersSent) res.status(400).end(); });
  };
  /** Seuls l'organisateur et les co-animateurs présentent un fichier */
  const presenter = (req, res) => {
    if (!docLimit(String(req.params.id) + ':' + String(req.get('x-meet-token') || '').slice(0, 12))) { res.status(429).json({ error: 'Trop de requêtes.' }); return {}; }
    const { m, p } = personOf(req);
    if (!p) { res.status(403).json({ error: 'Vous ne faites plus partie de cette réunion.' }); return {}; }
    if (!staff(p)) { res.status(403).json({ error: 'Seuls l\'organisateur et les co-animateurs peuvent présenter un fichier.' }); return {}; }
    return { m, p };
  };
  if (app.get && app.put) {
    // 1. Nouveau fichier : nom, nombre de pages et format de chaque page (les images arrivent ensuite)
    app.post('/api/meet/:id/doc', (req, res) => {
      const { m, p } = presenter(req, res); if (!m) return;
      const b = req.body || {};
      const n = parseInt(b.n, 10);
      if (!(n >= 1 && n <= DOC_PAGES)) return res.status(400).json({ error: `Le fichier doit avoir entre 1 et ${DOC_PAGES} pages.` });
      const dims = (Array.isArray(b.dims) ? b.dims : []).slice(0, n).map(d => [Math.max(1, Math.min(10000, Math.round(+(d && d[0]) || 16))), Math.max(1, Math.min(10000, Math.round(+(d && d[1]) || 9)))]);
      while (dims.length < n) dims.push(dims[dims.length - 1] || [16, 9]);
      docDrop(m);
      m.doc = { id: crypto.randomBytes(9).toString('base64url'), name: clip(b.name, 120) || 'Présentation', n, dims, page: 0, pages: new Map(), bytes: 0, free: false, dl: false, file: null, by: p.name };
      m.docInk = new Map(); m.ink = [];
      io.to(room(m)).emit('meet-ink', { op: 'clear' });
      io.to(room(m)).emit('meet-info', info(m));
      count({ meet_docs: 1 });
      log('doc', m, { n });
      res.json({ ok: true, id: m.doc.id });
    });
    // 2. Fichier d'origine, pour que les élèves gardent le support du cours (si l'enseignant l'autorise)
    app.put('/api/meet/:id/doc/:doc/file', raw(DOC_FILE_MAX), async (req, res) => {
      const { m } = presenter(req, res); if (!m) return;
      const d = m.doc;
      if (!d || d.id !== req.params.doc) return res.status(409).json({ error: 'Ce fichier n\'est plus présenté.' });
      if (!storage || !storage.putBuffer) return res.status(501).json({ error: 'Téléchargement indisponible.' });
      let name = d.name; try { if (req.get('x-file-name')) name = decodeURIComponent(req.get('x-file-name')); } catch (e) { /* nom par défaut */ }
      name = clip(name, 120).replace(/[\\/:*?"|]+/g, '_') || 'support';
      const key = 'meetdocs/' + m.id + '/' + d.id;
      try { await storage.putBuffer(key, req.raw, 'application/octet-stream'); } catch (e) { return res.status(502).json({ error: 'Envoi du support impossible.' }); }
      if (m.doc !== d) { if (storage.deleteKey) storage.deleteKey(key).catch(() => {}); return res.status(409).json({ error: 'Ce fichier n\'est plus présenté.' }); }
      d.file = { key, name, size: req.raw.length };
      io.to(room(m)).emit('meet-info', info(m));
      res.json({ ok: true });
    });
    app.get('/api/meet/:id/doc/:doc/file', async (req, res) => {
      const m = meetings.get(String(req.params.id || '')), d = m && m.doc;
      if (!d || d.id !== req.params.doc || !d.file || !d.dl) return res.status(404).json({ error: 'Support indisponible.' });
      try {
        const buf = await storage.getBuffer(d.file.key);
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.file.name)}`, 'Cache-Control': 'private, no-store' });
        res.end(buf);
      } catch (e) { res.status(404).json({ error: 'Support indisponible.' }); }
    });
    // 3. Image d'une page (JPEG, WebP ou PNG), gardée en mémoire le temps de la séance
    app.put('/api/meet/:id/doc/:doc/:n', raw(DOC_PAGE_MAX), (req, res) => {
      const { m } = presenter(req, res); if (!m) return;
      const d = m.doc, n = parseInt(req.params.n, 10);
      if (!d || d.id !== req.params.doc) return res.status(409).json({ error: 'Ce fichier n\'est plus présenté.' });
      if (!(n >= 0 && n < d.n)) return res.status(400).json({ error: 'Page invalide.' });
      const type = String(req.get('content-type') || '').split(';')[0].trim();
      const buf = req.raw || Buffer.alloc(0);
      const magic = type === 'image/jpeg' ? buf[0] === 0xff && buf[1] === 0xd8 : type === 'image/png' ? buf.slice(1, 4).toString() === 'PNG' : type === 'image/webp' ? buf.slice(8, 12).toString() === 'WEBP' : false;
      if (!IMG_TYPES[type] || !magic) return res.status(415).json({ error: 'Image de page invalide.' });
      const old = d.pages.get(n), delta = buf.length - (old ? old.buf.length : 0);
      if (d.bytes + delta > DOC_MAX) return res.status(413).json({ error: 'Fichier trop lourd pour être présenté (60 Mo d\'images au maximum).' });
      if (docBytes + delta > DOCS_ALL_MAX) return res.status(503).json({ error: 'Le serveur est très sollicité : réessayez dans un instant, ou partagez votre écran.' });
      d.pages.set(n, { buf, type, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16) + '"' });
      d.bytes += delta; docBytes += delta;
      if (!old && n === 0) io.to(room(m)).emit('meet-info', info(m));   // première page prête : tout le monde voit le fichier
      else io.to(room(m)).emit('meet-doc', { id: d.id, n, ready: d.pages.size });
      res.json({ ok: true, ready: d.pages.size });
    });
    // 4. Lecture d'une page (adresse impossible à deviner, valable le temps de la présentation)
    app.get('/api/meet/:id/doc/:doc/:n', (req, res) => {
      const m = meetings.get(String(req.params.id || '')), d = m && m.doc;
      const pg = d && d.id === req.params.doc && d.pages.get(parseInt(req.params.n, 10));
      if (!pg) return res.status(404).end();
      res.set({ 'Content-Type': pg.type, 'Cache-Control': 'private, max-age=86400, immutable', ETag: pg.etag, 'Cross-Origin-Resource-Policy': 'same-origin' });
      if (req.get('if-none-match') === pg.etag) return res.status(304).end();
      res.end(pg.buf);
    });
    // 5. PowerPoint, Word, OpenOffice : converti en PDF si LibreOffice est installé sur le serveur
    app.post('/api/meet/:id/convert', raw(DOC_FILE_MAX), async (req, res) => {
      const { m } = presenter(req, res); if (!m) return;
      const ext = String(req.get('x-file-ext') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
      if (!['ppt', 'pptx', 'pps', 'ppsx', 'odp', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods'].includes(ext)) return res.status(415).json({ error: 'Format non pris en charge.' });
      try { const pdf = await officeToPdf(req.raw, ext); count({ meet_doc_convert: 1 }); res.type('application/pdf').end(pdf); }
      catch (e) { res.status(e.code === 'no_office' ? 501 : 422).json({ error: e.code === 'no_office' ? 'Conversion PowerPoint indisponible sur ce serveur.' : 'Conversion impossible.', code: e.code === 'no_office' ? 'no_office' : 'convert' }); }
    });
  }

  return {
    engine, alive, meetings,
    engineNow,
    stats: () => { let people = 0, active = 0; meetings.forEach(m => { people += m.people.size; if (m.people.size) active++; }); return { meetings: active, people, engine }; }
  };
}

module.exports = { mountMeet, createSfu };
