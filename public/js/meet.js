/* Lestha Send — Réunions audio et vidéo
   Lien ou code à 6 chiffres, sans compte. Micro coupé à l'arrivée, main levée, partage d'écran,
   commandes de l'organisateur. Deux moteurs : « mesh » (appareil à appareil) ou « sfu » (Cloudflare Realtime). */
import { $, $$, esc, icon, ls, api, bytes, toast, modal, confirmDialog, copyText, shareTo, renderQR, keepAwake, getSocket, isMobile } from './core.js';
import { navigate } from './router.js';
import { track } from './ux.js';

const AUDIO_C = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
let root = null;
const S = { id: null };                                        // réunion en cours
if (location.hostname === 'localhost') window.__meet = S;      // essais locaux uniquement
const hostKeyOf = (id) => ls.get('tx_meet_host_' + id, null);
/* Liens durables : « jusqu'au 10 oct. à 14:30 » */
const until = (ts) => new Date(ts).toLocaleString('fr-FR', { day: 'numeric', month: 'short' }) + ' à ' + new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/* Mes réunions (sur cet appareil) : pour revenir au même lien */
const myMeetings = () => { const a = ls.get('tx_meet_mine', []); return (Array.isArray(a) ? a : []).filter(x => x && x.id && x.exp > Date.now()); };
const saveMine = (list) => ls.set('tx_meet_mine', list.slice(0, 12));
const forgetMine = (id) => saveMine(myMeetings().filter(x => x.id !== id));
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const initials = (n) => (String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
const hue = (pid) => { let h = 0; for (const c of String(pid)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const emitAck = (socket, ev, data, ms = 10000) => new Promise((res) => socket.timeout(ms).emit(ev, data, (err, r) => res(err ? { error: 'Le serveur ne répond pas. Vérifiez votre connexion.' } : r)));
const linkOf = (id) => location.origin + '/reunion/' + id;

/* Réactions (autocollants) ; les mains et pouces prennent la couleur de peau choisie */
const REACTS = [['hand', '✋', 1, 'Main levée'], ['ok', '👍', 1, 'D\'accord'], ['yes', '✅', 0, 'Oui'], ['no', '👎', 1, 'Non'], ['clap', '👏', 1, 'Bravo'], ['thanks', '🙏', 1, 'Merci'], ['love', '❤️', 0, 'J\'aime'], ['laugh', '😂', 0, 'Rire'], ['wow', '😮', 0, 'Surpris'], ['q', '❓', 0, 'Question']];
const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const emo = (k, t) => { const r = REACTS.find(x => x[0] === k); return r ? r[1] + (r[2] ? TONES[t] || '' : '') : ''; };
const isStaff = () => !!(S.self && (S.self.host || S.self.cohost));
const isCourse = () => !!(S.meeting && S.meeting.mode === 'course');
const canTalk = () => !isCourse() || isStaff() || !!(S.self && S.self.floor);
const myTone = () => Math.max(0, Math.min(5, +ls.get('tx_meet_tone', 0) || 0));

let iceCfg = null;
async function getIce() {
  if (iceCfg && Date.now() - iceCfg.at < (iceCfg.ttl || 1200) * 1000) return iceCfg;
  try { const j = await (await fetch('/api/ice-config', { cache: 'no-store' })).json(); iceCfg = Object.assign(j, { at: Date.now() }); }
  catch (e) { iceCfg = iceCfg || { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] }; }
  return iceCfg;
}

/* ======================================================================
   FAIBLE DÉLAI : la voix passe en premier ; la présentation et la caméra sont
   plafonnées pour ne jamais saturer l'envoi (sinon les images s'accumulent et
   le retard grandit). En mode direct, le débit est partagé entre les participants.
   ====================================================================== */
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
function encFor(kind, n) {
  n = Math.max(1, n || 1);
  if (kind === 'a') return { priority: 'high', networkPriority: 'high' };
  if (kind === 's') return { maxBitrate: Math.round(clampN(3200e3 / n, 300e3, 2500e3)), maxFramerate: 15, priority: 'high', networkPriority: 'high' };
  const teacher = isCourse() && S.self && S.self.host;
  const cap = S.sharing ? clampN(400e3 / n, 80e3, 200e3) : teacher ? clampN(2000e3 / n, 200e3, 1200e3) : clampN(1500e3 / n, 150e3, 900e3);
  return { maxBitrate: Math.round(cap), maxFramerate: S.sharing ? 12 : 24, priority: teacher && !S.sharing ? 'medium' : 'low', networkPriority: 'low' };
}
function tuneSender(sender, kind, n) {
  if (!sender || !sender.getParameters || !sender.setParameters) return;
  let p; try { p = sender.getParameters(); } catch (e) { return; }
  if (!p || !p.encodings || !p.encodings.length) return;          // pas encore négocié
  const want = encFor(kind, n), e = p.encodings[0];
  if (Object.keys(want).every(k => e[k] === want[k])) return;
  Object.assign(e, want);
  sender.setParameters(p).catch(() => {});
}
/* Grand nombre de participants en direct : présentation en 720p pour rester fluide */
function fitScreen(n) {
  if (!S.screen || !S.screen.applyConstraints) return;
  const big = n >= 6;
  if (S.screenBig === big) return;
  S.screenBig = big;
  S.screen.applyConstraints(big ? { width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 15, max: 15 } } : { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 15, max: 30 } }).catch(() => {});
}

/* ======================================================================
   MOTEUR « MESH » : une connexion par participant, 3 pistes fixes
   (0 = micro, 1 = caméra, 2 = écran) : couper / rallumer = replaceTrack, sans renégociation
   ====================================================================== */
const KIND_AT = ['a', 'c', 's'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** replaceTrack peut lever une erreur immédiate si la connexion vient d'être fermée */
function safeReplace(sender, track) { try { return sender.replaceTrack(track).catch(() => {}); } catch (e) { return Promise.resolve(); } }
class Mesh {
  constructor(h) { this.h = h; this.pcs = new Map(); this.making = new Map(); this.sq = new Map(); getIce().catch(() => {}); }
  /** Une seule connexion par personne, même si plusieurs messages arrivent en même temps
     (sinon la caméra partait sur une connexion vide : image noire chez l'autre) */
  pcFor(pid, initiator) {
    const x = this.pcs.get(pid); if (x) return Promise.resolve(x);
    if (!this.making.has(pid)) this.making.set(pid, this.makePc(pid, initiator).finally(() => this.making.delete(pid)));
    return this.making.get(pid);
  }
  async makePc(pid, initiator) {
    let x;
    const cfg = await getIce();
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, bundlePolicy: 'max-bundle' });
    x = { pc, initiator, pending: [], restarts: 0, timer: null };
    this.pcs.set(pid, x);
    pc.onicecandidate = (e) => { if (e.candidate) this.h.signal(pid, { cand: e.candidate }); };
    pc.ontrack = (e) => { const i = pc.getTransceivers().indexOf(e.transceiver); if (i >= 0 && i < 3) this.h.onTrack(pid, KIND_AT[i], e.track, e.receiver); };
    pc.onconnectionstatechange = () => {
      if (this.pcs.get(pid) !== x) return;
      const st = pc.connectionState;
      if (st === 'connected') { x.restarts = 0; clearTimeout(x.timer); this.tune(); }
      else if (st === 'disconnected') { clearTimeout(x.timer); x.timer = setTimeout(() => { if (pc.connectionState === 'disconnected') this.recover(pid, 'disconnected'); }, 4000); }
      else if (st === 'failed') this.recover(pid, 'failed');
      this.h.onLink(pid, st);
    };
    if (initiator) {
      ['audio', 'video', 'video'].forEach((k, i) => { const t = pc.addTransceiver(k, { direction: 'sendrecv' }); safeReplace(t.sender, this.h.local(KIND_AT[i])); });
    }
    return x;
  }
  /** Coupure : relance ICE (3 essais), puis nouvelle connexion complète avec cette personne */
  recover(pid, why) {
    const x = this.pcs.get(pid); if (!x) return;
    x.restarts++;
    this.h.diag('ice-' + why, 'r' + x.restarts);
    if (x.restarts > 3) {
      if (x.initiator) this.rebuild(pid); else this.h.signal(pid, { rebuildReq: 1 });
      return;
    }
    if (x.initiator) { try { x.pc.restartIce(); } catch (e) { /* ignore */ } this.offer(pid, true).catch(() => {}); }
    else this.h.signal(pid, { restart: 1 });
  }
  async rebuild(pid) {
    this.h.signal(pid, { reset: 1 });
    this.removePeer(pid);
    await sleep(300);
    await this.addPeer(pid);
  }
  async offer(pid, iceRestart) {
    const x = this.pcs.get(pid); if (!x || x.pc.signalingState !== 'stable') return;
    await x.pc.setLocalDescription(await x.pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
    this.h.signal(pid, { sdp: x.pc.localDescription });
  }
  async addPeer(pid) { await this.pcFor(pid, true); await this.offer(pid); }
  /** Messages d'une même personne traités dans l'ordre, un par un */
  onSignal(from, data) {
    const q = (this.sq.get(from) || Promise.resolve()).then(() => this.handle(from, data)).catch(e => this.h.diag('mesh-signal', e && e.name));
    this.sq.set(from, q);
    return q;
  }
  async handle(from, data) {
    if (data.reset) { this.removePeer(from); return; }
    if (data.rebuildReq) { const x = this.pcs.get(from); if (x && x.initiator) await this.rebuild(from); return; }
    if (data.restart) { const x = this.pcs.get(from); if (x && x.initiator) { try { x.pc.restartIce(); } catch (e) { /* ignore */ } await this.offer(from, true); } return; }
    if (data.sdp && data.sdp.type === 'offer') {
      let x = this.pcs.get(from);
      // Offres croisées : celui qui a lancé la connexion garde la sienne, l'autre annule
      if (x && x.pc.signalingState !== 'stable') { if (x.initiator) return; await x.pc.setLocalDescription({ type: 'rollback' }).catch(() => {}); }
      x = x || await this.pcFor(from, false);
      try {
        await x.pc.setRemoteDescription(data.sdp);
        x.pc.getTransceivers().forEach((t, i) => { try { t.direction = 'sendrecv'; } catch (e) { /* ignore */ } if (i < 3) safeReplace(t.sender, this.h.local(KIND_AT[i])); });
        await x.pc.setLocalDescription(await x.pc.createAnswer());
        this.h.signal(from, { sdp: x.pc.localDescription });
      } catch (e) { this.h.diag('mesh-offer', e.name); this.h.signal(from, { rebuildReq: 1 }); return; }
      x.pending.splice(0).forEach(c => x.pc.addIceCandidate(c).catch(() => {}));
      this.tune();
    } else if (data.sdp && data.sdp.type === 'answer') {
      const x = this.pcs.get(from); if (!x || x.pc.signalingState !== 'have-local-offer') return;
      try { await x.pc.setRemoteDescription(data.sdp); } catch (e) { this.h.diag('mesh-answer', e.name); this.rebuild(from); return; }
      x.pending.splice(0).forEach(c => x.pc.addIceCandidate(c).catch(() => {}));
      this.tune();
    } else if (data.cand) {
      const x = this.pcs.get(from) || await this.pcFor(from, false);
      if (x.pc.remoteDescription) x.pc.addIceCandidate(data.cand).catch(() => {}); else x.pending.push(data.cand);
    }
  }
  setTrack(kind, track) {
    const i = KIND_AT.indexOf(kind);
    this.pcs.forEach(x => { const t = x.pc.getTransceivers()[i]; if (t) safeReplace(t.sender, track); });
    this.tune();
  }
  /** Débit de chaque envoi selon le nombre de participants (l'envoi total reste sous ~3 Mbit/s) */
  tune() {
    const n = this.pcs.size;
    this.pcs.forEach(x => x.pc.getTransceivers().slice(0, 3).forEach((t, i) => tuneSender(t.sender, KIND_AT[i], n)));
    fitScreen(n);
  }
  conns() { return [...this.pcs.values()].map(x => x.pc); }
  repull() { /* les images reprennent d'elles-mêmes en direct */ }
  sync() { /* rien à faire : les pistes arrivent d'elles-mêmes */ }
  removePeer(pid) { const x = this.pcs.get(pid); if (x) { clearTimeout(x.timer); try { x.pc.close(); } catch (e) { /* ignore */ } this.pcs.delete(pid); this.tune(); } }
  close() { [...this.pcs.keys()].forEach(p => this.removePeer(p)); }
}

/* ======================================================================
   MOTEUR « SFU » : une seule connexion vers Cloudflare Realtime.
   Règles de Cloudflare : une opération à la fois (file), attendre que la
   connexion soit établie avant de récupérer les pistes des autres, ne
   récupérer que les caméras allumées, et recréer la session si elle expire.
   Après 3 reconstructions ratées, la réunion bascule en mode direct.
   ====================================================================== */
class Sfu {
  constructor(h) { this.h = h; this.q = Promise.resolve(); this.mids = new Map(); this.pulled = new Map(); this.gens = new Map(); this.retries = new Map(); this.local = {}; this.pc = null; this.ready = false; this.attempts = 0; this.errs = 0; this.closed = false; this.dead = false; }
  run(fn) { const p = this.q.then(() => (this.closed ? null : fn())); this.q = p.catch(() => {}); return p; }
  async call(body) {
    try { return await api(`/api/meet/${S.id}/sfu`, { method: 'POST', body, headers: { 'X-Meet-Token': S.token } }); }
    catch (e) { e.code = (e.data && e.data.code) || (e.network ? 'network' : 'error'); e.retry = !e.data || e.data.retry !== false; e.rebuild = !!(e.data && e.data.rebuild); throw e; }
  }
  async callRetry(body, n = 3) {
    for (let i = 0; ; i++) {
      try { return await this.call(body); }
      catch (e) { if (!e.retry || e.rebuild || i >= n || this.closed) throw e; await sleep(e.status === 425 ? 1200 : 700 * 2 ** i); }
    }
  }
  connected(pc, ms) {
    return new Promise((res, rej) => {
      if (pc.connectionState === 'connected') return res();
      const fail = (code) => { off(); rej(Object.assign(new Error(code), { code })); };
      const t = setTimeout(() => fail('ice_timeout'), ms);
      const on = () => { if (pc.connectionState === 'connected') { off(); res(); } else if (pc.connectionState === 'failed') fail('ice_failed'); };
      const off = () => { clearTimeout(t); pc.removeEventListener('connectionstatechange', on); };
      pc.addEventListener('connectionstatechange', on);
    });
  }
  async start() {
    this.closed = false; this.ready = false; this.dead = false;
    const cfg = await getIce();
    const pc = this.pc = new RTCPeerConnection({ iceServers: cfg.iceServers, bundlePolicy: 'max-bundle' });
    pc.ontrack = (e) => { const m = this.mids.get(e.transceiver.mid); if (m) this.h.onTrack(m.pid, m.kind, e.track, e.receiver); };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      const st = pc.connectionState;
      this.h.onLink('sfu', st);
      if (st === 'failed') this.recover('ice_failed');
      else if (st === 'disconnected') { clearTimeout(this.dt); this.dt = setTimeout(() => { if (pc === this.pc && pc.connectionState === 'disconnected') this.recover('ice_disconnected'); }, 5000); }
    };
    try {
      await this.run(() => this.push('a', this.h.local('a')));
      await this.connected(pc, 15000);
      await this.run(() => this.callRetry({ op: 'ready' }));
      this.ready = true; this.errs = 0;
      for (const k of ['c', 's']) { const t = this.h.local(k); if (t) await this.run(() => this.push(k, t)); }
      this.sync([...S.people.values()]);
      clearTimeout(this.okT); this.okT = setTimeout(() => { this.attempts = 0; }, 60e3);
      this.h.status();
    } catch (e) {
      if (this.closed || pc !== this.pc) return;
      this.h.diag('sfu-start', e.code || e.name);
      this.recover(e.code || 'start');
    }
  }
  async push(kind, trackObj) {
    const pc = this.pc;
    if (this.local[kind]) { await safeReplace(this.local[kind].sender, trackObj); return; }
    if (!trackObj) return;
    const t = pc.addTransceiver(trackObj, { direction: 'sendonly', sendEncodings: [encFor(kind, 1)] });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const r = await this.callRetry({ op: 'push', sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks: [{ kind, mid: t.mid }] });
      await pc.setRemoteDescription(r.sessionDescription);
      this.local[kind] = t;
    } catch (e) {
      // Connexion remise dans un état propre avant l'opération suivante (évite les erreurs en cascade)
      if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
      safeReplace(t.sender, null); try { if (t.stop) t.stop(); } catch (x) { /* ignore */ }
      throw e;
    }
  }
  setTrack(kind, trackObj) {
    if (this.local[kind]) safeReplace(this.local[kind].sender, trackObj);
    else if (trackObj && this.ready) this.run(() => this.push(kind, trackObj)).catch(e => this.onErr(e, 'push'));
    this.tune();
  }
  /** Avec le serveur de réunion, on n'envoie qu'une fois : pleine qualité */
  tune() { Object.entries(this.local).forEach(([k, t]) => tuneSender(t.sender, k, 1)); }
  conns() { return this.pc ? [this.pc] : []; }
  sync(people) {
    if (!this.ready || this.closed) return;
    const want = [];
    people.forEach(p => {
      if ((p.gen || 0) !== (this.gens.get(p.pid) || 0)) { this.dropPeer(p.pid); this.gens.set(p.pid, p.gen || 0); }
      if (!p.ready) return;
      (p.tracks || []).forEach(k => {
        const on = k === 'a' || (k === 'c' && p.cam) || (k === 's' && p.screen);
        const key = p.pid + '-' + k, rt = this.retries.get(key);
        if (on && !this.pulled.has(key) && !(rt && rt.timer)) { this.pulled.set(key, null); want.push({ pid: p.pid, kind: k }); }
      });
    });
    if (!want.length) return;
    this.run(() => this.pull(want)).catch(e => { want.forEach(w => { this.pulled.delete(w.pid + '-' + w.kind); this.later(w); }); this.onErr(e, 'pull'); });
  }
  async pull(want) {
    const pc = this.pc;
    const r = await this.callRetry({ op: 'pull', tracks: want });
    const got = [];
    (r.tracks || []).forEach(t => {
      const key = t.pid + '-' + t.kind;
      if (t.mid && !t.error) { this.mids.set(t.mid, { pid: t.pid, kind: t.kind }); this.pulled.set(key, t.mid); got.push(t); }
      else { this.pulled.delete(key); this.later(t); }
    });
    if (r.requiresImmediateRenegotiation && r.sessionDescription) {
      try {
        await pc.setRemoteDescription(r.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        await this.callRetry({ op: 'renegotiate', sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } });
      } catch (e) {
        if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        got.forEach(t => { this.mids.delete(t.mid); this.pulled.delete(t.pid + '-' + t.kind); this.later(t); });
        throw e;
      }
    }
    got.forEach(t => this.retries.delete(t.pid + '-' + t.kind));
  }
  /** Piste pas encore disponible : nouvel essai 1,5 s, 3 s, 6 s… (6 fois au plus) */
  later(t) {
    const key = t.pid + '-' + t.kind, r = this.retries.get(key) || { n: 0, timer: null };
    if (r.timer || r.n >= 6 || this.closed) return;
    r.timer = setTimeout(() => { r.timer = null; const p = S.people.get(t.pid); if (p) this.sync([p]); }, Math.min(20e3, 1500 * 2 ** r.n));
    r.n++; this.retries.set(key, r);
  }
  /** Image noire : on récupère à nouveau la caméra de cette personne */
  repull(pid, kind) {
    const key = pid + '-' + kind, mid = this.pulled.get(key);
    if (!mid) return;                               // pas encore reçue, ou demande déjà en cours
    this.pulled.delete(key); this.retries.delete(key);
    if (mid) { this.mids.delete(mid); this.run(() => this.call({ op: 'close', mids: [mid] })).catch(() => {}); }
    const p = S.people.get(pid); if (p) this.sync([p]);
  }
  onErr(e, where) {
    if (this.closed || e.code === 'switched' || e.code === 'gone') return;
    this.h.diag('sfu-' + where, e.code);
    if (e.rebuild) return this.recover('expired');
    if (++this.errs >= 4) this.recover('errors');
    this.h.status();
  }
  async recover(why) {
    if (this.recovering || this.closed) return;
    this.recovering = true; this.attempts++;
    this.h.onLink('sfu', 'disconnected');
    this.h.diag('sfu-recover', why);
    try { this.pc && this.pc.close(); } catch (e) { /* ignore */ }
    this.pc = null; this.ready = false; this.local = {}; this.mids.clear(); this.pulled.clear(); this.retries.forEach(r => clearTimeout(r.timer)); this.retries.clear(); this.q = Promise.resolve();
    if (this.attempts > 3) {
      // Le serveur de réunion ne répond pas : on demande le passage en mode direct
      this.recovering = false;
      const r = await this.call({ op: 'fail', why }).catch(() => null);
      if (!r || !r.switched) { this.dead = true; this.h.status('err'); }
      return;
    }
    await this.call({ op: 'reset', why }).catch(() => {});
    await sleep(600 * this.attempts);
    this.recovering = false;
    if (!this.closed) this.start();
  }
  dropPeer(pid) {
    const mids = [];
    for (const [k, mid] of this.pulled) if (k.startsWith(pid + '-')) { if (mid) mids.push(mid); this.pulled.delete(k); }
    for (const [k, r] of this.retries) if (k.startsWith(pid + '-')) { clearTimeout(r.timer); this.retries.delete(k); }
    mids.forEach(m => this.mids.delete(m));
    if (mids.length && this.ready) this.run(() => this.call({ op: 'close', mids })).catch(() => {});
  }
  removePeer(pid) { this.dropPeer(pid); this.gens.delete(pid); }
  close() { this.closed = true; clearTimeout(this.dt); clearTimeout(this.okT); this.retries.forEach(r => clearTimeout(r.timer)); try { this.pc && this.pc.close(); } catch (e) { /* ignore */ } }
}

/* ======================================================================
   SON : niveau de voix (qui parle), pistes silencieuses si micro refusé
   ====================================================================== */
let actx = null;
function audioCtx() { if (!actx) { const C = window.AudioContext || window.webkitAudioContext; actx = C ? new C() : null; } if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); return actx; }
function silentTrack() { const a = audioCtx(); if (!a) return null; const d = a.createMediaStreamDestination(); const o = a.createOscillator(); const g = a.createGain(); g.gain.value = 0; o.connect(g).connect(d); o.start(); const t = d.stream.getAudioTracks()[0]; t.enabled = false; return t; }
function meter(trackObj) {
  const a = audioCtx(); if (!a || !trackObj) return null;
  try { const src = a.createMediaStreamSource(new MediaStream([trackObj])); const an = a.createAnalyser(); an.fftSize = 512; src.connect(an); const buf = new Uint8Array(an.fftSize); return () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } return Math.sqrt(s / buf.length); }; }
  catch (e) { return null; }
}

/* ======================================================================
   ÉCRANS
   ====================================================================== */
function renderCreate() {
  document.title = 'Réunion · Lestha Send';
  const name = ls.get('tx_meet_name', '') || ls.get('tx_sender_name', '');
  root.innerHTML = `
  <section class="narrow"><div class="card glow">
    <div class="center stack" style="gap:6px">
      <span class="eyebrow"><span class="pulse-dot"></span>Nouveau</span>
      <h2>Réunion ou cours en ligne</h2>
      <p class="muted">Sans inscription. Partagez un lien ou un code à 6 chiffres, chacun rejoint en un appui.</p>
    </div>
    <form id="mtForm" class="stack" style="margin-top:16px" autocomplete="off">
      <label class="field"><span>Sujet de la réunion</span><input class="input" id="mtTitle" maxlength="80" placeholder="Ex. : Point de l'équipe pédagogique"></label>
      <label class="field"><span>Votre prénom</span><input class="input" id="mtName" maxlength="30" value="${esc(name)}" placeholder="Votre prénom" required></label>
      <div class="field"><span>Usage</span>
        <div class="seg mt-kind" id="mtMode" role="radiogroup" aria-label="Usage">
          <button type="button" class="active" data-mode="meeting" role="radio" aria-checked="true">${icon('users')}<span><b>Réunion</b><small>Chacun prend la parole librement</small></span></button>
          <button type="button" data-mode="course" role="radio" aria-checked="false">${icon('doc')}<span><b>Cours</b><small>L'enseignant au centre, il donne la parole</small></span></button>
        </div></div>
      <div class="field"><span>Format</span>
        <div class="seg mt-kind" role="radiogroup" aria-label="Format de la réunion">
          <button type="button" class="active" data-kind="audio" role="radio" aria-checked="true">${icon('mic')}<span><b>Audio</b><small>Léger, idéal en 4G</small></span></button>
          <button type="button" data-kind="video" role="radio" aria-checked="false">${icon('video')}<span><b>Vidéo</b><small>Caméra et présentations</small></span></button>
        </div></div>
      <label class="field"><span>Validité du lien</span>
        <select class="input" id="mtLife" aria-label="Validité du lien">
          <option value="1d" selected>24 heures · le même lien resservira</option>
          <option value="7d">7 jours · réunion ou cours de la semaine</option>
          <option value="30d">30 jours · lien permanent du mois</option>
          <option value="end">Seulement pour cette réunion</option>
        </select></label>
      <div class="stack" style="gap:8px">
        <label class="switch full"><input type="checkbox" id="mtChat" checked><span class="track"></span><span class="small"><b>Discussion écrite</b> · questions sans couper la parole</span></label>
        <label class="switch full"><input type="checkbox" id="mtWait"><span class="track"></span><span class="small"><b>Salle d'attente</b> · vous faites entrer chaque personne</span></label>
      </div>
      <button class="btn primary xl block" type="submit" id="mtGo">${icon('call')}<span id="mtGoL">Lancer la réunion</span></button>
      <button class="btn danger block" type="button" id="mtUrgent">${icon('bell')}Réunion d'urgence</button>
      <p class="small faint center">Invité à une réunion ? Ouvrez le lien reçu, ou tapez le code dans <a href="/recevoir" data-link>Recevoir</a>.</p>
    </form>
  </div>
  <div id="mtMine"></div></section>`;
  drawMine();
  const preTitle = new URLSearchParams(location.search).get('title'); if (preTitle) $('#mtTitle', root).value = preTitle.slice(0, 80);
  let kind = 'audio', mode = 'meeting';
  const pick = (sel, attr, fn) => $$(sel, root).forEach(b => b.onclick = () => { fn(b.dataset[attr]); $$(sel, root).forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', x === b); }); });
  pick('[data-kind]', 'kind', v => { kind = v; });
  pick('[data-mode]', 'mode', v => { mode = v; $('#mtGoL', root).textContent = v === 'course' ? 'Commencer le cours' : 'Lancer la réunion'; });
  const go = async (emergency) => {
    const nm = $('#mtName', root).value.trim();
    if (!nm) { toast('Indiquez votre prénom', 'warn'); $('#mtName', root).focus(); return; }
    ls.set('tx_meet_name', nm);
    const btn = emergency ? $('#mtUrgent', root) : $('#mtGo', root); btn.disabled = true;
    const socket = await getSocket();
    const title = $('#mtTitle', root).value.trim();
    const r = await emitAck(socket, 'meet-create', { title, kind: emergency ? 'audio' : kind, mode: emergency ? 'meeting' : mode, chat: $('#mtChat', root).checked, waiting: $('#mtWait', root).checked, emergency, life: $('#mtLife', root).value });
    btn.disabled = false;
    if (!r || r.error) return toast((r && r.error) || 'Impossible de créer la réunion.', 'error');
    ls.set('tx_meet_host_' + r.id, r.hostKey);
    if (r.expiresAt) saveMine([{ id: r.id, title: title || (emergency ? 'Réunion urgente' : mode === 'course' ? 'Cours' : 'Réunion'), code: r.code, exp: r.expiresAt, kind: r.kind, mode: r.mode }].concat(myMeetings()));
    track('use', { m: 'meet' });
    S.autoJoin = true; S.urgent = !!emergency;
    navigate('/reunion/' + r.id);
  };
  $('#mtForm', root).onsubmit = (e) => { e.preventDefault(); go(false); };
  $('#mtUrgent', root).onclick = () => go(true);
}

/** « Mes réunions » : les liens encore valables créés sur cet appareil */
function drawMine() {
  const el = $('#mtMine'); if (!el) return;
  const list = myMeetings();
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card" style="margin-top:14px"><div class="card-title"><h3 style="margin:0">Mes réunions</h3><span class="small faint">liens encore valables</span></div>
    <div class="stack" style="gap:6px">${list.map(x => `<div class="mt-row mt-mine" data-id="${esc(x.id)}">
      <span class="mt-dot" style="--h:${hue(x.id)}">${x.mode === 'course' ? '🎓' : esc(initials(x.title))}</span>
      <span class="mt-rn"><b>${esc(x.title)}</b><small class="muted">${x.kind === 'video' ? 'Vidéo' : 'Audio'}${x.code ? ' · code ' + esc(x.code.slice(0, 3) + ' ' + x.code.slice(3)) : ''} · jusqu'au ${until(x.exp)}</small></span>
      <span class="mt-act"><a class="btn sm primary" href="/reunion/${esc(x.id)}" data-link>${icon('call', 'sm')}Ouvrir</a>
      <button type="button" class="btn sm ghost" data-copy title="Copier le lien">${icon('copy', 'sm')}</button>
      <button type="button" class="btn sm ghost" data-forget title="Retirer de la liste">${icon('x', 'sm')}</button></span></div>`).join('')}</div></div>`;
  el.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { if (await copyText(linkOf(b.closest('[data-id]').dataset.id))) toast('Lien copié', 'success'); });
  el.querySelectorAll('[data-forget]').forEach(b => b.onclick = () => { forgetMine(b.closest('[data-id]').dataset.id); drawMine(); });
}

async function renderLobby(id) {
  root.innerHTML = `<section class="narrow"><div class="card"><p class="muted"><span class="spinner"></span> Connexion à la réunion…</p></div></section>`;
  const socket = await getSocket();
  const peek = await emitAck(socket, 'meet-peek', { id });
  if (!root) return;
  if (peek.error) {
    forgetMine(id);
    root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon bad">${icon('x')}</div><h2>Réunion introuvable</h2><p class="muted">${esc(peek.error)}</p><a class="btn primary" href="/reunion" data-link>${icon('call')}Créer une réunion</a></div></div></section>`;
    return;
  }
  const m = peek.meeting, host = !!hostKeyOf(id);
  document.title = m.title + ' · Réunion';
  if (S.autoJoin) { S.autoJoin = false; return join(id, ls.get('tx_meet_name', 'Organisateur')); }
  root.innerHTML = `
  <section class="narrow"><div class="card glow"><div class="state-screen">
    <div class="state-icon info">${icon(m.kind === 'video' ? 'video' : 'call')}</div>
    <h2>${esc(m.title)}</h2>
    <div class="summary-line" style="justify-content:center">
      ${m.mode === 'course' ? `<span class="pill violet">${icon('doc')}Cours</span>` : ''}
      <span class="pill ${m.kind === 'video' ? 'violet' : 'info'}">${icon(m.kind === 'video' ? 'video' : 'mic')}${m.kind === 'video' ? 'Vidéo' : 'Audio'}</span>${m.waiting ? `<span class="pill">${icon('clock')}Salle d'attente</span>` : ''}
      <span class="pill">${icon('users')}${peek.count} présent${peek.count > 1 ? 's' : ''}</span>
      ${m.emergency ? `<span class="pill bad">${icon('bell')}Urgent</span>` : ''}${m.recording ? `<span class="pill bad">${icon('rec')}Enregistrée</span>` : ''}${m.locked ? `<span class="pill warn">${icon('lock')}Verrouillée</span>` : ''}
    </div>
    ${m.expiresAt ? `<p class="small faint" style="margin:0">${icon('clock', 'sm')} Lien valable jusqu'au ${until(m.expiresAt)}</p>` : ''}
    <form id="lbForm" class="stack" style="width:100%;max-width:360px;margin-top:8px" autocomplete="off">
      <input class="input" id="lbName" maxlength="30" placeholder="Votre prénom" value="${esc(ls.get('tx_meet_name', '') || ls.get('tx_rc_name', ''))}" aria-label="Votre prénom" required>
      <button class="btn primary xl block" type="submit">${icon('call')}${host ? 'Reprendre la réunion' : 'Rejoindre'}</button>
      <p class="small faint">${m.mode === 'course' ? 'Votre micro reste coupé pendant le cours. Levez la main : l\'enseignant vous donnera la parole.' : 'Votre micro sera coupé à l\'arrivée. Vous l\'activez quand vous voulez parler.'}</p>
    </form>
  </div></div></section>`;
  const inp = $('#lbName', root); if (!inp.value) setTimeout(() => inp.focus(), 60);
  $('#lbForm', root).onsubmit = (e) => { e.preventDefault(); const n = inp.value.trim(); if (!n) { toast('Indiquez votre prénom', 'warn'); inp.focus(); return; } ls.set('tx_meet_name', n); join(id, n); };
}

/* ======================================================================
   DANS LA RÉUNION
   ====================================================================== */
async function join(id, name) {
  audioCtx();                                                  // geste de l'utilisateur : le son peut démarrer
  root.innerHTML = `<section class="narrow"><div class="card"><p class="muted"><span class="spinner"></span> Ouverture du micro…</p></div></section>`;
  let mic = null;
  try { mic = (await navigator.mediaDevices.getUserMedia({ audio: AUDIO_C })).getAudioTracks()[0]; }
  catch (e) { toast(micError(e), 'warn', { duration: 9000 }); diag('mic-error', e.name); }
  if (!root) { if (mic) mic.stop(); return; }
  if (mic) mic.enabled = false;
  Object.assign(S, { id, name, mic, micOk: !!mic, placeholder: mic ? null : silentTrack(), cam: null, screen: null, people: new Map(), muted: true, hand: false, camOn: false, sharing: false, panel: false, ended: false, gone: false });
  await connect();
}

async function connect() {
  const socket = await getSocket();
  S.socket = socket;
  bindSocket(socket);
  const r = await emitAck(socket, 'meet-join', { id: S.id, name: S.name, hostKey: hostKeyOf(S.id), tone: myTone() });
  if (!root) return;
  if (!r || r.error) { stopLocal(); return renderEnd((r && r.error) || 'Impossible de rejoindre la réunion.', true); }
  if (r.waiting) { S.waitingRoom = true; S.meeting = r.meeting; return renderWaiting(); }
  return afterJoin(r);
}

function renderWaiting() {
  if (!root) return;
  root.innerHTML = `<section class="narrow"><div class="card glow"><div class="state-screen"><div class="state-icon info"><span class="spinner"></span></div><h2>Salle d'attente</h2><p class="muted">${esc(S.meeting.title)} · l'organisateur va vous faire entrer dans un instant.</p><button type="button" class="btn ghost" id="wtQuit">${icon('x')}Quitter</button></div></div></section>`;
  $('#wtQuit').onclick = () => { S.socket.emit('meet-leave'); S.waitingRoom = false; stopLocal(); S.ended = true; renderEnd('Vous avez quitté la salle d\'attente.'); };
}

async function afterJoin(r) {
  const socket = S.socket;
  if (!r || r.error) { stopLocal(); return renderEnd((r && r.error) || 'Impossible de rejoindre la réunion.', true); }
  S.waitingRoom = false;
  Object.assign(S, { self: r.self, token: r.token, meeting: r.meeting, messages: r.messages || [], poll: r.poll || null, wait: r.wait || [], unread: 0, tab: S.tab || 'people' });
  S.people.clear();
  r.people.forEach(p => S.people.set(p.pid, Object.assign({ streams: {} }, p)));
  S.h = engineHooks(socket);
  S.engine = r.meeting.engine === 'sfu' ? new Sfu(S.h) : new Mesh(S.h);
  renderRoom();
  keepAwake(true);
  S.net = null; refreshNet();
  if (S.engine instanceof Sfu) S.engine.start();
  else for (const pid of S.people.keys()) S.engine.addPeer(pid).catch(e => diag('mesh-offer', e.name));
  if (S.urgent) { S.urgent = false; setTimeout(() => invite(true), 400); }
  if (!S.ticker) S.ticker = setInterval(tick, 100);
  if (!S.qTimer) S.qTimer = setInterval(() => { measure().catch(() => {}); }, 3000);
}

function bindSocket(socket) {
  if (S.bound === socket) return;
  S.bound = socket;
  const mine = () => !!S.id && !S.ended;
  socket.on('meet-joined', (p) => { if (!mine()) return; S.people.set(p.pid, Object.assign({ streams: {} }, p)); drawPeople(); if (p.cam) camWatch(p.pid); toast(p.name + ' a rejoint la réunion', 'info', { duration: 2500 }); });
  socket.on('meet-left', ({ pid, why }) => {
    if (!mine()) return;
    const p = S.people.get(pid); if (!p) return;
    S.engine && S.engine.removePeer(pid);
    if (p.audioEl) p.audioEl.remove();
    S.people.delete(pid); drawPeople();
    toast(p.name + (why === 'removed' ? ' a été retiré de la réunion' : ' a quitté la réunion'), 'info', { duration: 2500 });
  });
  socket.on('meet-state', (p) => {
    if (!mine()) return;
    if (S.self && p.pid === S.self.pid) { S.self = Object.assign(S.self, p); if (!p.hand && S.hand) S.hand = false; drawBar(); drawPeople(); return; }
    const cur = S.people.get(p.pid); if (!cur) return;
    const raised = !cur.hand && p.hand, camOn = !cur.cam && p.cam;
    Object.assign(cur, p);
    if (camOn) camWatch(cur.pid);
    if (S.engine && S.engine.sync) S.engine.sync([cur]);
    if (raised) toast('✋ ' + cur.name + ' lève la main', 'info', { duration: 3500 });
    drawPeople();
  });
  socket.on('meet-signal', ({ from, data }) => { if (mine() && S.engine instanceof Mesh) S.engine.onSignal(from, data).catch(e => console.warn('signal', e)); });
  socket.on('meet-force', (f = {}) => {
    const { action, by } = f;
    if (!mine()) return;
    if (action === 'mute') { if (!S.muted) { S.muted = true; if (S.mic) S.mic.enabled = false; sendState({ muted: true }); drawBar(); drawPeople(); } if (S.self && f.unfloor) S.self.floor = false; if (by) toast(f.unfloor ? by + ' a repris la parole' : by + ' a coupé votre micro', 'info'); }
    if (action === 'floor') { if (S.self) S.self.floor = true; S.hand = false; drawBar(); toast('🎤 ' + by + ' vous donne la parole : ouvrez votre micro', 'success', { duration: 8000, action: 'Ouvrir le micro', onAction: () => setMuted(false) }); }
    if (action === 'remove') { leave(false); renderEnd('L\'organisateur vous a retiré de la réunion.'); }
  });
  socket.on('meet-info', (m) => {
    if (!mine()) return;
    const wasRec = S.meeting.recording, wasEngine = S.meeting.engine;
    S.meeting = Object.assign(S.meeting, m);
    if (m.engine && wasEngine && m.engine !== wasEngine) switchEngine(m.engine);
    drawTop(); drawBar(); if (S.panel) drawPanel();
    if (m.recording && !wasRec && !(S.self && S.self.host)) toast('🔴 L\'organisateur enregistre la réunion', 'warn', { duration: 6000 });
  });
  socket.on('meet-react', ({ pid, r, t }) => { if (mine()) showReact(pid, r, t); });
  socket.on('meet-admitted', (r) => { if (S.waitingRoom && !S.ended) { toast('Vous êtes entré dans la réunion', 'success'); afterJoin(r); } });
  socket.on('meet-denied', ({ reason }) => { if (S.waitingRoom && !S.ended) { S.waitingRoom = false; stopLocal(); S.ended = true; renderEnd(reason, true); } });
  socket.on('meet-chat', (msg) => {
    if (!mine() || !S.messages) return;
    S.messages.push(msg); if (S.messages.length > 300) S.messages.shift();
    const open = S.panel && S.tab === 'chat';
    if (!open && (!S.self || msg.pid !== S.self.pid)) { S.unread = (S.unread || 0) + 1; toast('💬 ' + msg.name + ' : ' + msg.text.slice(0, 80), 'info', { duration: 3500, action: 'Répondre', onAction: () => openPanel('chat') }); }
    if (open) drawPanel(); drawBar();
  });
  socket.on('meet-poll', (p) => {
    if (!mine()) return;
    const isNew = p && (!S.poll || S.poll.id !== p.id);
    S.poll = p;
    if (isNew && !isStaff()) toast('📊 Sondage : ' + p.q, 'info', { duration: 8000, action: 'Répondre', onAction: () => openPanel('poll') });
    if (S.panel && S.tab === 'poll') drawPanel(); drawBar();
  });
  socket.on('meet-wait', (list) => {
    if (!mine()) return;
    const more = (list || []).length > (S.wait || []).length;
    S.wait = list || [];
    if (more && isStaff()) { const w = S.wait[S.wait.length - 1]; toast('🚪 ' + w.name + ' attend pour entrer', 'info', { duration: 8000, action: 'Faire entrer', onAction: () => S.socket.emit('meet-host', { action: 'admit', sid: w.sid }) }); }
    if (S.panel) drawPanel(); drawBar();
  });
  socket.on('meet-ended', ({ reason, keep, expiresAt }) => { if (!mine()) return; leave(false); if (!keep) S.gone = true; renderEnd((reason === 'expired' ? 'La réunion est terminée.' : reason) + (keep ? ' Le même lien resservira jusqu\'au ' + until(expiresAt) + '.' : '')); });
  // Coupure réseau : on rejoint automatiquement avec les mêmes réglages
  socket.on('disconnect', () => { if (mine() && S.engine) setNet('reco'); });
  socket.on('connect', () => {
    if (S.waitingRoom && !S.ended) { connect(); return; }
    if (!mine() || !S.engine) return;
    S.engine.close(); S.engine = null;
    S.people.forEach(p => p.audioEl && p.audioEl.remove());
    toast('Connexion rétablie, reprise de la réunion…', 'info', { duration: 2500 });
    S.engine = null; setNet('reco');
    connect().then(() => {
      if (!S.engine) return;
      sendState({ muted: S.muted, cam: S.camOn, screen: S.sharing, hand: S.hand });
      if (S.cam) S.engine.setTrack('c', S.cam);
      if (S.screen) S.engine.setTrack('s', S.screen);
      refreshNet();
    });
  });
}

function onTrack(pid, kind, trackObj, receiver) {
  const p = S.people.get(pid); if (!p) return;
  p.streams[kind] = new MediaStream([trackObj]);
  if (receiver) { p.recv = p.recv || {}; p.recv[kind] = receiver; }
  // Présentation : chaque image est affichée dès qu'elle arrive (pas de mise en mémoire tampon)
  if (kind === 's' && receiver) { try { receiver.playoutDelayHint = 0; } catch (e) { /* ignore */ } try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; } catch (e) { /* ignore */ } }
  if (kind === 'a') {
    if (!p.audioEl) { p.audioEl = document.createElement('audio'); p.audioEl.autoplay = true; p.audioEl.setAttribute('playsinline', ''); $('#mtAudios').appendChild(p.audioEl); }
    p.audioEl.srcObject = p.streams.a; p.audioEl.play().catch(() => { S.needTap = true; drawTop(); });
    // Niveau de voix lu directement sur la réception WebRTC (fiable, sans traitement audio)
    recAdd(pid, trackObj);
    const sync = receiver && receiver.getSynchronizationSources ? () => { const s = receiver.getSynchronizationSources()[0]; return s && Date.now() - s.timestamp < 1000 ? (s.audioLevel || 0) : 0; } : () => 0;
    const rms = meter(trackObj) || (() => 0);
    p.level = () => Math.max(sync(), rms() * 0.8);
  }
  drawPeople();
}
function onLink(pid, state) {
  if (pid === 'sfu') S.sfuLink = state; else { const p = S.people.get(pid); if (p) p.link = state; }
  refreshNet(); drawPeople();
}

function sendState(s) { S.socket && S.socket.emit('meet-state', s); }
function setMuted(m, silent) {
  if (!S.mic && !m) { toast('Autorisez le micro dans le navigateur pour prendre la parole', 'warn'); return; }
  if (!m && !canTalk()) { toast('Levez la main : l\'enseignant vous donnera la parole.', 'info'); if (!S.hand) toggleHand(); return; }
  S.muted = m; if (S.mic) S.mic.enabled = !m;
  if (!silent) sendState({ muted: m });
  if (!m && S.mic && !S.selfLevel) S.selfLevel = meter(S.mic);
  drawBar(); drawPeople();
}
async function toggleScreen() {
  if (S.sharing) { stopScreen(); return; }
  try { S.screen = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false })).getVideoTracks()[0]; }
  catch (e) { return; }
  try { S.screen.contentHint = 'detail'; } catch (e) { /* ignore */ }
  S.screen.onended = stopScreen;
  S.screenBig = null;
  S.sharing = true; S.engine.setTrack('s', S.screen); sendState({ screen: true });
  drawBar(); drawPeople();
}
function stopScreen() { if (!S.sharing) return; S.screen && S.screen.stop(); S.screen = null; S.sharing = false; S.engine && S.engine.setTrack('s', null); sendState({ screen: false }); drawBar(); drawPeople(); }
function toggleHand() { S.hand = !S.hand; sendState({ hand: S.hand }); drawBar(); }

function removeChrome() { ['mtBar', 'mtPanel', 'mtReact', 'mtMore'].forEach(i => { const e = document.getElementById(i); if (e) e.remove(); }); document.body.classList.remove('in-meet', 'mt-idle', 'mt-panel'); }
function stopLocal() { [S.mic, S.cam, S.screen, S.placeholder].forEach(t => { try { t && t.stop(); } catch (e) { /* ignore */ } }); }
function leave(notify = true) {
  if (!S.id || S.ended) return;
  if (R.on) recStop();
  S.ended = true;
  if (notify && S.socket) S.socket.emit('meet-leave');
  S.engine && S.engine.close(); S.engine = null;
  stopLocal();
  S.people && S.people.forEach(p => p.audioEl && p.audioEl.remove());
  clearInterval(S.ticker); S.ticker = null;
  clearInterval(S.qTimer); S.qTimer = null; S.lat = null; S.latPrev = null;
  keepAwake(false);
  if (S.ro) { S.ro.disconnect(); S.ro = null; }
  clearTimeout(S.netT); S.net = null;
  removeChrome();
}

function renderEnd(msg, bad) {
  removeChrome();
  if (!root) return;
  const id = S.id;
  root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon ${bad ? 'bad' : 'info'}">${icon(bad ? 'x' : 'call')}</div><h2>${bad ? 'Impossible de rejoindre' : 'Vous avez quitté la réunion'}</h2><p class="muted">${esc(msg || '')}</p>
    ${R.url ? `<button type="button" class="btn primary block" id="recAgain" style="margin-bottom:8px">${icon('download')}Télécharger l'enregistrement (${bytes(R.size)})</button>` : ''}
    <div class="row wrap" style="justify-content:center">${id && !bad && !S.gone ? `<button type="button" class="btn" id="mtAgain">${icon('refresh')}Rejoindre à nouveau</button>` : ''}<a class="btn primary" href="/reunion" data-link>${icon('call')}Nouvelle réunion</a></div></div></div></section>`;
  document.title = 'Réunion · Lestha Send';
  const ra = $('#recAgain'); if (ra) ra.onclick = saveRec;
  // Même adresse : on force le réaffichage (un simple lien serait ignoré)
  const again = $('#mtAgain'); if (again) again.onclick = () => navigate('/reunion/' + id, { replace: true });
}

/* ======================================================================
   ÉTAT DE LA CONNEXION : Connecté · Reconnexion… · Connexion instable · Reconnecté · Erreur
   ====================================================================== */
const NET = { wait: ['wait', 'Connexion…'], ok: ['ok', 'Connecté'], reco: ['reco', 'Reconnexion…'], weak: ['weak', 'Connexion instable'], back: ['ok back', 'Reconnecté'], err: ['err', 'Erreur de connexion'] };
function diag(ev, code) { try { S.socket && S.socket.emit('meet-diag', { ev, code: String(code || '') }); } catch (e) { /* ignore */ } }
function engineHooks(socket) {
  return {
    local: (k) => (k === 'a' ? (S.mic || S.placeholder) : k === 'c' ? S.cam : S.screen),
    signal: (to, data) => socket.emit('meet-signal', { to, data }),
    onTrack, onLink, diag,
    status: (st) => (st === 'err' ? setNet('err') : refreshNet()),
    error: (msg) => toast(msg, 'warn')
  };
}
function refreshNet() {
  if (!S.engine || S.ended) return;
  let st;
  if (S.socket && !S.socket.connected) st = 'reco';
  else if (S.engine instanceof Sfu) st = S.engine.dead ? 'err' : /failed|disconnected/.test(S.sfuLink || '') ? 'reco' : S.sfuLink === 'connected' ? (S.weak ? 'weak' : 'ok') : 'wait';
  else {
    const ps = [...S.people.values()], bad = ps.filter(p => /failed|disconnected/.test(p.link || '')).length;
    st = !ps.length ? 'ok' : bad && bad === ps.length ? 'reco' : bad || S.weak ? 'weak' : ps.some(p => p.link === 'connected') ? 'ok' : 'wait';
  }
  setNet(st);
}
function setNet(st) {
  const prev = S.net;
  if (st === 'ok' && (prev === 'reco' || prev === 'err' || prev === 'weak')) {
    st = 'back'; clearTimeout(S.netT);
    S.netT = setTimeout(() => { if (S.net === 'back') { S.net = 'ok'; drawNet(); } }, 3000);
  }
  if (st === 'ok' && prev === 'back') return;
  if (prev === st) return;
  S.net = st; drawNet();
}
function drawNet() {
  const el = $('#mtNet'); if (!el) return;
  const [cls, txt] = NET[S.net] || NET.wait;
  el.className = 'mt-net ' + cls; el.querySelector('span').textContent = txt; el.title = txt + ' · touchez pour le diagnostic'; el.setAttribute('aria-label', txt);
}
/** Le serveur a basculé la réunion vers l'autre moteur (repli automatique) */
function switchEngine(kind) {
  if (!S.engine || S.ended) return;
  S.engine.close();
  S.people.forEach(p => { p.streams = {}; p.recv = {}; p.level = null; if (p.audioEl) { p.audioEl.remove(); p.audioEl = null; } });
  S.engine = kind === 'sfu' ? new Sfu(S.h) : new Mesh(S.h);
  if (S.engine instanceof Sfu) S.engine.start();
  else S.people.forEach((p, pid) => { if (S.self && S.self.pid < pid) S.engine.addPeer(pid).catch(() => {}); });
  if (kind === 'mesh') toast('Le serveur de réunion ne répond pas : passage en connexion directe pour rester en ligne.', 'info', { duration: 5000 });
  drawPeople(); refreshNet();
}

/* ======================================================================
   SALLE : barre réduite + menu « Plus », grand écran, incrustation, bande
   ====================================================================== */
const narrow = () => window.matchMedia('(max-width: 720px)').matches;
function renderRoom() {
  const m = S.meeting;
  document.title = m.title + ' · Réunion';
  root.innerHTML = `
  <section class="meet ${m.kind === 'video' ? 'is-video' : 'is-audio'} ${m.mode === 'course' ? 'is-course' : ''} lay-grid" id="mtRoom">
    <header class="meet-top" id="mtTop"></header>
    <div class="meet-main" id="mtMain">
      <div class="meet-stage hidden" id="mtStage">
        <video id="mtStageV" autoplay playsinline muted></video>
        <span class="meet-stage-l" id="mtStageL"></span>
        <button type="button" class="meet-stop hidden" id="mtStopShare">${icon('x', 'sm')}Arrêter la présentation</button>
        <button type="button" class="meet-fs" data-fs="mtStage" aria-label="Plein écran">${icon('fullscreen', 'sm')}</button>
        <div class="meet-pip hidden" id="mtPip"></div>
      </div>
      <div class="meet-spot hidden" id="mtSpot"></div>
      <div class="meet-grid" id="mtGrid"></div>
    </div>
    <div id="mtAudios" hidden></div>
  </section>`;
  // Barre et panneau fixés à l'écran : placés directement dans la page (hors du conteneur animé)
  removeChrome();
  const bar = document.createElement('footer'); bar.className = 'meet-bar'; bar.id = 'mtBar'; bar.setAttribute('aria-label', 'Commandes de la réunion');
  const panel = document.createElement('aside'); panel.className = 'meet-panel card hidden'; panel.id = 'mtPanel';
  document.body.append(panel, bar); document.body.classList.add('in-meet');
  const onPin = (e) => { const b = e.target.closest('.mt-pin'); if (!b) return; const pid = b.closest('.mt-tile').dataset.pid; S.pin = S.pin === pid ? null : pid; toast(S.pin ? 'Participant épinglé en grand (pour vous seulement)' : 'Participant détaché', 'info', { duration: 2000 }); drawPeople(); };
  $('#mtGrid').addEventListener('click', onPin); $('#mtSpot').addEventListener('click', onPin);
  root.querySelectorAll('[data-fs]').forEach(b => b.onclick = () => { const el = document.getElementById(b.dataset.fs); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {}); });
  $('#mtStopShare').onclick = stopScreen;
  pipDrag($('#mtPip'));
  if (S.ro) S.ro.disconnect();
  if (window.ResizeObserver) { S.ro = new ResizeObserver(() => { fitGrid(); placePip(); }); S.ro.observe($('#mtMain')); }
  if (!S.mq) { S.mq = window.matchMedia('(max-width: 720px)'); const on = () => { closeMore(); drawBar(); }; if (S.mq.addEventListener) S.mq.addEventListener('change', on); else S.mq.addListener(on); }
  idleWatch();
  drawTop(); drawBar(); drawPeople();
}

function drawTop() {
  const el = $('#mtTop'); if (!el) return;
  const m = S.meeting, n = S.people.size + 1;
  el.innerHTML = `
    <svg class="meet-logo" aria-hidden="true"><use href="#i-logo"/></svg>
    <div class="meet-title"><b>${esc(m.title)}</b><span><span id="mtClock">${fmtClock(Date.now() - m.startedAt)}</span><i class="mt-sep"></i>${n} participant${n > 1 ? 's' : ''}${m.mode === 'course' ? '<i class="mt-sep"></i>Cours' : ''}${m.locked ? '<i class="mt-sep"></i>Verrouillée' : ''}</span></div>
    <button type="button" class="mt-net wait" id="mtNet"><i></i><span>Connexion…</span></button>
    ${m.recording ? '<span class="meet-rec"><i></i>REC</span>' : ''}
    ${S.needTap ? `<button type="button" class="btn sm primary" id="mtTap">${icon('play', 'sm')}Activer le son</button>` : ''}
    <button type="button" class="mt-topbtn" id="mtInvite" aria-label="Inviter">${icon('share', 'sm')}<span>Inviter</span></button>`;
  $('#mtInvite').onclick = () => invite(false);
  $('#mtNet').onclick = openDiag;
  const tap = $('#mtTap'); if (tap) tap.onclick = () => { S.needTap = false; audioCtx(); S.people.forEach(p => p.audioEl && p.audioEl.play().catch(() => {})); drawTop(); };
  drawNet();
}

function counts() {
  const hands = [...S.people.values()].filter(p => p.hand).length + (isStaff() ? (S.wait || []).length : 0);
  const chat = S.meeting.chat || isStaff() ? (S.unread || 0) : 0;
  const poll = S.poll && S.poll.open && !isStaff() && !(S.voted && S.poll.id in S.voted) ? 1 : 0;
  return { hands, chat, poll };
}
function drawBar() {
  const el = $('#mtBar'); if (!el) return;
  const video = S.meeting.kind === 'video', small = narrow();
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMobile;
  const c = counts(), chatOn = S.meeting.chat || isStaff();
  const b = (id, ic, label, cls = '', badge = 0, extra = '') => `<button type="button" class="mb ${cls}" id="${id}" aria-label="${esc(label)}" data-tip="${esc(label)}" ${extra}>${ic}${badge ? `<em class="mb-badge">${badge}</em>` : ''}</button>`;
  const micLabel = !canTalk() ? 'Micro verrouillé : levez la main' : S.muted ? 'Activer le micro' : 'Couper le micro';
  const moreBadge = (small ? c.hands + c.chat : 0) + c.poll;
  el.innerHTML = `
    <div class="mb-group">
      ${b('bMic', icon(S.muted ? 'mic-off' : 'mic'), micLabel, (S.muted ? 'off' : 'on') + (!canTalk() ? ' locked' : ''), 0, `aria-pressed="${!S.muted}"`)}
      ${video ? b('bCam', icon(S.camOn ? 'video' : 'video-off'), S.camOn ? 'Couper la caméra' : 'Activer la caméra', S.camOn ? 'on' : 'off', 0, `aria-pressed="${S.camOn}"`) : ''}
      ${canShare && !small ? b('bScr', icon('screen'), S.sharing ? 'Arrêter la présentation' : 'Présenter mon écran', S.sharing ? 'live' : '', 0, `aria-pressed="${S.sharing}"`) : ''}
      ${b('bHand', icon('hand'), S.hand ? 'Baisser la main' : 'Lever la main', S.hand ? 'hand' : '', 0, `aria-pressed="${S.hand}"`)}
      ${!small ? b('bReact', icon('smile'), 'Réactions', '', 0, 'aria-haspopup="true"') : ''}
      ${R.on && S.self && S.self.host ? b('bRec', `${icon('rec')}<span class="mb-t">${fmtClock(Date.now() - R.t0)}</span>`, 'Arrêter l\'enregistrement', 'rec wide') : ''}
      ${b('bMore', icon('more'), 'Plus d\'options', $('#mtMore') ? 'open' : '', moreBadge, 'aria-haspopup="menu"')}
      ${b('bLeave', icon('call-end'), 'Quitter la réunion', 'leave')}
    </div>
    ${!small ? `<div class="mb-group side">
      ${b('bPpl', icon('users'), 'Participants', S.panel && S.tab === 'people' ? 'sel' : '', c.hands, `aria-pressed="${!!(S.panel && S.tab === 'people')}"`)}
      ${chatOn ? b('bChat', icon('message'), 'Discussion', S.panel && S.tab === 'chat' ? 'sel' : '', c.chat, `aria-pressed="${!!(S.panel && S.tab === 'chat')}"`) : ''}
    </div>` : ''}`;
  $('#bMic').onclick = () => setMuted(!S.muted);
  if ($('#bCam')) $('#bCam').onclick = toggleCam;
  if ($('#bScr')) $('#bScr').onclick = toggleScreen;
  $('#bHand').onclick = toggleHand;
  if ($('#bReact')) $('#bReact').onclick = toggleReactions;
  if ($('#bRec')) $('#bRec').onclick = () => recStop();
  $('#bMore').onclick = toggleMore;
  if ($('#bPpl')) $('#bPpl').onclick = () => openPanel('people', true);
  if ($('#bChat')) $('#bChat').onclick = () => openPanel('chat', true);
  $('#bLeave').onclick = async () => {
    if (S.self && S.self.host) {
      const keep = S.meeting.expiresAt ? `<p class="small" style="margin-top:8px">${icon('clock', 'sm')} Dans les deux cas, <b>le lien et le code restent valables jusqu'au ${until(S.meeting.expiresAt)}</b> : vous pourrez relancer la réunion avec le même lien.</p>` : '<p class="small faint" style="margin-top:8px">Ce lien sert seulement pour cette réunion.</p>';
      const r = await modal({ title: 'Quitter la réunion', body: '<p class="muted">Vous êtes l\'organisateur. Les autres peuvent continuer sans vous, ou vous pouvez terminer la réunion pour tout le monde.</p>' + keep, actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Quitter', value: 'leave' }, { label: 'Terminer pour tous', cls: 'danger', value: 'end' }] });
      if (!r) return;
      if (r === 'end') S.socket.emit('meet-host', { action: 'end' });
    }
    leave(true); renderEnd('Merci d\'avoir participé.' + (S.meeting.expiresAt ? ' Le lien reste valable jusqu\'au ' + until(S.meeting.expiresAt) + '.' : ''));
  };
}

/* Menu « Plus » : tout ce qui sert moins souvent, rangé hors de la barre */
function closeMore() { const el = $('#mtMore'); if (!el) return; el.classList.remove('open'); el.id = ''; setTimeout(() => el.remove(), 260); const b = $('#bMore'); if (b) b.classList.remove('open'); }
function toggleMore() {
  if ($('#mtMore')) { closeMore(); return; }
  const small = narrow(), c = counts(), host = !!(S.self && S.self.host), items = [];
  const it = (id, ic, label, fn, o = {}) => items.push(Object.assign({ id, ic, label, fn }, o));
  if (small) {
    it('bReact', icon('smile'), 'Réactions', toggleReactions);
    it('bPpl', icon('users'), 'Participants', () => openPanel('people', true), { badge: c.hands });
    if (S.meeting.chat || isStaff()) it('bChat', icon('message'), 'Discussion', () => openPanel('chat', true), { badge: c.chat });
  }
  it('bPoll', icon('chart'), 'Sondage', () => openPanel('poll', true), { badge: c.poll });
  if (host && !R.on) it('bRec', icon('rec'), 'Enregistrer', recStart, { cls: 'rec' });
  it('bInvite', icon('share'), 'Inviter', () => invite(false));
  if (S.camOn) it('bFlip', icon('flip'), 'Changer de caméra', switchCam);
  it('bLayout', icon('layout'), S.layout === 'grid' ? 'Vue orateur' : 'Vue mosaïque', () => { S.layout = S.layout === 'grid' ? 'auto' : 'grid'; drawPeople(); });
  if (document.documentElement.requestFullscreen) it('bFull', icon('fullscreen'), document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran', toggleFull);
  it('bDiag', icon('pulse'), 'Réglages et diagnostic', openDiag);
  const el = document.createElement('div'); el.id = 'mtMore'; el.className = 'meet-more'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', 'Plus d\'options');
  el.innerHTML = `<div class="mm-head"><b>Plus d'options</b><button type="button" class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button></div>
    <div class="mm-grid">${items.map((x, i) => `<button type="button" class="mm-item ${x.cls || ''}" id="${x.id}" data-i="${i}" role="menuitem">${x.ic}<span>${esc(x.label)}</span>${x.badge ? `<em class="mb-badge">${x.badge}</em>` : ''}</button>`).join('')}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const mb = $('#bMore'); if (mb) mb.classList.add('open');
  el.onclick = (e) => {
    if (e.target.closest('[data-close]')) return closeMore();
    const b = e.target.closest('[data-i]'); if (!b) return;
    closeMore(); items[+b.dataset.i].fn();
  };
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!el.isConnected || !el.id) { document.removeEventListener('pointerdown', off); return; } if (!el.contains(e.target) && !e.target.closest('#bMore')) { closeMore(); document.removeEventListener('pointerdown', off); } }), 0);
}
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else document.documentElement.requestFullscreen().catch(() => {}); }

/* Incrustation de la caméra du présentateur : déplaçable, se range dans le coin le plus proche */
function placePip() {
  const el = $('#mtPip'), st = $('#mtStage'); if (!el || !st || el.classList.contains('hidden') || el.classList.contains('drag')) return;
  const c = el.dataset.corner || 'br', m = narrow() ? 10 : 16;
  const W = st.clientWidth, H = st.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = (c.includes('l') ? m : W - w - m) + 'px';
  el.style.top = (c.includes('t') ? m : H - h - m) + 'px';
}
function pipDrag(el) {
  if (!el) return;
  el.dataset.corner = ls.get('tx_pip', 'br');
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false;
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop; moved = false; el.classList.add('drag'); });
  el.addEventListener('pointermove', (e) => { if (!el.classList.contains('drag')) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; el.style.left = (ox + dx) + 'px'; el.style.top = (oy + dy) + 'px'; });
  const end = () => {
    if (!el.classList.contains('drag')) return;
    const st = el.parentElement;
    if (moved && st) { const cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2; el.dataset.corner = (cy < st.clientHeight / 2 ? 't' : 'b') + (cx < st.clientWidth / 2 ? 'l' : 'r'); ls.set('tx_pip', el.dataset.corner); }
    el.classList.remove('drag'); placePip();
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
}
/* Mosaïque : la taille des vignettes s'ajuste à l'écran (sans défilement jusqu'à ~16 personnes) */
function fitGrid() {
  const g = $('#mtGrid'), main = $('#mtMain'), room = $('#mtRoom'); if (!g || !main || !room) return;
  if (!room.classList.contains('lay-grid')) { g.style.removeProperty('--cols'); g.style.removeProperty('--tw'); g.classList.remove('scroll'); return; }
  const n = g.children.length || 1, W = main.clientWidth, H = main.clientHeight, gap = 12;
  const ar = S.meeting.kind === 'video' ? 16 / 10 : 4 / 3;
  let best = { cols: 1, w: 0 };
  for (let cols = 1; cols <= Math.min(n, 6); cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * ar);
    if (tw > best.w) best = { cols, w: tw };
  }
  if (best.w < 130 && n > 6) { g.classList.add('scroll'); g.style.removeProperty('--cols'); g.style.removeProperty('--tw'); return; }
  g.classList.remove('scroll');
  g.style.setProperty('--cols', best.cols);
  g.style.setProperty('--tw', Math.floor(Math.min(best.w, 760)) + 'px');
}
/* Pendant une présentation, sur ordinateur : la barre s'efface après 3,5 s sans bouger la souris */
function idleWatch() {
  if (S.idleBound) return; S.idleBound = true;
  const wake = () => {
    document.body.classList.remove('mt-idle'); clearTimeout(S.idleT);
    S.idleT = setTimeout(() => { if ($('#mtRoom.lay-stage') && !narrow() && !S.panel && !$('#mtMore') && !$('#mtReact') && !document.querySelector('.meet-bar:hover')) document.body.classList.add('mt-idle'); }, 3500);
  };
  ['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, wake, { passive: true }));
  wake();
}

/* ======================================================================
   RÉGLAGES ET DIAGNOSTIC : ce qui marche, ce qui bloque, et pourquoi
   ====================================================================== */
async function diagRows() {
  const perm = async (n) => { try { return (await navigator.permissions.query({ name: n })).state; } catch (e) { return 'unknown'; } };
  const [pm, pcam] = await Promise.all([perm('microphone'), perm('camera')]);
  let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { /* ignore */ }
  const mics = devs.filter(d => d.kind === 'audioinput'), cams = devs.filter(d => d.kind === 'videoinput');
  const selfV = document.querySelector('.mt-tile.self video');
  let rtt = null, relay = false;
  for (const pc of (S.engine ? S.engine.conns() : []).slice(0, 4)) {
    try {
      const st = await pc.getStats(); let pair = null;
      st.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r; });
      if (pair) { if (pair.currentRoundTripTime != null) rtt = Math.max(rtt || 0, pair.currentRoundTripTime); const lc = st.get(pair.localCandidateId); if (lc && lc.candidateType === 'relay') relay = true; }
    } catch (e) { /* ignore */ }
  }
  const ppl = [...S.people.values()];
  const audioIn = ppl.filter(p => p.streams && p.streams.a).length;
  const camWant = ppl.filter(p => p.cam), camGot = camWant.filter(p => { const v = document.querySelector(`#mtRoom .mt-tile[data-pid="${p.pid}"] video`); return v && v.videoWidth > 0; });
  const sfu = S.engine instanceof Sfu;
  const linkOk = sfu ? S.sfuLink === 'connected' : ppl.every(p => p.link === 'connected');
  const row = (ok, label, detail) => ({ ok, label, detail });
  const rows = [
    row(pm === 'denied' ? false : (S.mic ? true : null), 'Autorisation du micro', pm === 'denied' ? 'Refusée : touchez l\'icône à gauche de l\'adresse du site, puis autorisez le micro.' : S.mic ? 'Accordée' : 'Pas encore accordée'),
    row(S.mic ? S.mic.readyState === 'live' : false, 'Micro', S.mic ? (S.mic.readyState === 'live' ? (S.muted ? 'Prêt (coupé)' : 'Actif') : 'Arrêté par l\'appareil') : (mics.length ? 'Non autorisé' : 'Aucun micro détecté'))
  ];
  if (S.meeting.kind === 'video') {
    rows.push(row(pcam === 'denied' ? false : cams.length ? true : false, 'Caméra détectée', cams.length ? cams.length + ' caméra(s)' + (pcam === 'denied' ? ' · autorisation refusée dans le navigateur' : '') : 'Aucune caméra détectée'));
    rows.push(row(!S.camOn ? null : !!(S.cam && S.cam.readyState === 'live' && !S.cam.muted && selfV && selfV.videoWidth > 0), 'Caméra active', !S.camOn ? 'Éteinte' : S.cam && S.cam.readyState === 'live' ? (selfV && selfV.videoWidth ? `Image ${selfV.videoWidth} × ${selfV.videoHeight}` : 'Allumée mais sans image : fermez les autres applications qui l\'utilisent') : 'Arrêtée'));
    rows.push(row(!camWant.length ? null : camGot.length === camWant.length, 'Vidéos reçues', camWant.length ? `${camGot.length} sur ${camWant.length}` : 'Personne d\'autre n\'a allumé sa caméra'));
  }
  rows.push(row(!!(S.socket && S.socket.connected), 'Connexion au site', S.socket && S.socket.connected ? 'Établie' : 'Coupée : reconnexion automatique en cours…'));
  rows.push(row(!ppl.length && !sfu ? null : linkOk, 'Connexion audio et vidéo', (sfu ? 'Serveur de réunion' : 'Directe entre appareils') + (relay ? ' · via relais' : '') + (rtt != null ? ` · ${Math.round(rtt * 1000)} ms aller-retour` : '') + (S.weak ? ' · réseau lent' : '')));
  rows.push(row(!ppl.length ? null : audioIn === ppl.length, 'Sons reçus', ppl.length ? `${audioIn} sur ${ppl.length} participant(s)` : 'Vous êtes seul pour l\'instant'));
  return { rows, mics, cams };
}
async function openDiag() {
  const fill = async (el) => {
    const { rows, mics, cams } = await diagRows();
    const box = el.querySelector('#dgRows'); if (!box) return;
    box.innerHTML = rows.map(r => `<div class="dg-row"><span class="dg-ic ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'na'}">${r.ok === true ? '✓' : r.ok === false ? '!' : '–'}</span><div><b>${esc(r.label)}</b><span>${esc(r.detail)}</span></div></div>`).join('');
    const dev = el.querySelector('#dgDev');
    if (dev && !dev.dataset.done) {
      dev.dataset.done = '1';
      const cur = (S.mic && S.mic.getSettings && S.mic.getSettings().deviceId) || '';
      const curC = (S.cam && S.cam.getSettings && S.cam.getSettings().deviceId) || S.camId || '';
      dev.innerHTML = `${mics.length > 1 ? `<label class="field"><span>Micro</span><select class="input" id="dgMic">${mics.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Micro ' + (i + 1))}</option>`).join('')}</select></label>` : ''}
        ${S.meeting.kind === 'video' && cams.length > 1 ? `<label class="field"><span>Caméra</span><select class="input" id="dgCam">${cams.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === curC ? 'selected' : ''}>${esc(d.label || 'Caméra ' + (i + 1))}</option>`).join('')}</select></label>` : ''}`;
      const sm = el.querySelector('#dgMic'); if (sm) sm.onchange = () => switchMic(sm.value);
      const sc = el.querySelector('#dgCam'); if (sc) sc.onchange = () => { S.camId = sc.value; if (S.camOn) restartCam(); };
    }
  };
  await modal({
    title: 'Réglages et diagnostic',
    body: `<div id="dgRows" class="dg-rows"><p class="muted"><span class="spinner"></span> Vérification…</p></div><div id="dgDev" class="dg-dev"></div>`,
    actions: [{ label: 'Relancer la connexion', cls: 'ghost', icon: 'refresh', handler: () => { reconnectMedia(); toast('Reconnexion en cours…', 'info', { duration: 2500 }); return false; } }, { label: 'Fermer', cls: 'primary', value: true }],
    onMount(el) {
      fill(el);
      const t = setInterval(() => { if (!el.isConnected) return clearInterval(t); fill(el); }, 2000);
    }
  });
}
function reconnectMedia() {
  if (!S.engine) return;
  diag('manual-reconnect');
  if (S.engine instanceof Sfu) { S.engine.attempts = 0; S.engine.recover('manual'); return; }
  S.engine.pcs.forEach((x, pid) => { if (x.initiator) S.engine.rebuild(pid); else S.h.signal(pid, { rebuildReq: 1 }); });
}
async function switchMic(deviceId) {
  let tr;
  try { tr = (await navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, AUDIO_C, { deviceId: { exact: deviceId } }) })).getAudioTracks()[0]; }
  catch (e) { return toast(micError(e), 'warn'); }
  const old = S.mic; tr.enabled = !S.muted; S.mic = tr; S.micOk = true;
  S.engine && S.engine.setTrack('a', tr); S.selfLevel = meter(tr);
  try { old && old.stop(); } catch (e) { /* ignore */ }
  toast('Micro changé', 'success', { duration: 1800 });
}

function handOrder() {
  const all = [...S.people.values()]; if (S.self) all.push(Object.assign({}, S.self, { hand: S.hand ? (S.self.hand || 1) : 0 }));
  return all.filter(p => p.hand).sort((a, b) => a.hand - b.hand).map(p => p.pid);
}

function drawPeople() {
  const grid = $('#mtGrid'), room = $('#mtRoom'); if (!grid || !room || !S.self) return;
  const order = handOrder();
  const me = Object.assign({}, S.self, { name: S.name, muted: S.muted, cam: S.camOn, screen: S.sharing });
  const list = [...S.people.values()];
  const all = [me, ...list];
  const keep = new Set(all.map(p => p.pid));
  room.querySelectorAll('.mt-tile').forEach(t => { if (!keep.has(t.dataset.pid)) t.remove(); });
  if (S.pin && !keep.has(S.pin)) S.pin = null;
  // Disposition : présentation (grand écran + caméra en incrustation), orateur (enseignant ou épinglé), mosaïque
  const sharer = S.sharing ? me : list.find(p => p.screen && p.streams.s);
  const spotP = !sharer && S.layout !== 'grid' ? (S.pin ? all.find(p => p.pid === S.pin) : isCourse() ? all.find(p => p.host) : null) : null;
  const pipP = sharer && S.layout !== 'grid' && S.meeting.kind === 'video' && sharer.cam ? sharer : null;
  const mode = sharer ? 'stage' : spotP ? 'spot' : 'grid';
  const spot = $('#mtSpot'), pip = $('#mtPip'), stage = $('#mtStage');
  ['grid', 'spot', 'stage'].forEach(k => room.classList.toggle('lay-' + k, k === mode));
  spot.classList.toggle('hidden', mode !== 'spot');
  pip.classList.toggle('hidden', !pipP);
  stage.classList.toggle('hidden', mode !== 'stage');
  all.forEach((p, i) => {
    const self = i === 0;
    const box = pipP && p.pid === pipP.pid ? pip : spotP && p.pid === spotP.pid ? spot : grid;
    let t = room.querySelector(`.mt-tile[data-pid="${p.pid}"]`);
    if (t && t.parentElement !== box) { if (box === grid && self) grid.prepend(t); else box.appendChild(t); }
    if (!t) {
      t = document.createElement('div'); t.className = 'mt-tile'; t.dataset.pid = p.pid; t.style.setProperty('--h', hue(p.pid));
      t.innerHTML = '<video class="mt-v" autoplay playsinline muted></video><div class="mt-av"></div><div class="mt-name"></div><div class="mt-hand"></div><div class="mt-warn"></div><span class="mt-eq" aria-hidden="true"><i></i><i></i><i></i></span><button type="button" class="mt-pin" aria-label="Épingler">📌</button>';
      if (box === grid && self) grid.prepend(t); else box.appendChild(t);
    }
    const video = S.meeting.kind === 'video' && p.cam;
    t.classList.toggle('self', self);
    t.classList.toggle('rear', self && S.facing === 'environment');
    t.classList.toggle('pinned', S.pin === p.pid);
    const pb = t.querySelector('.mt-pin'); if (pb) { pb.title = S.pin === p.pid ? 'Détacher' : 'Épingler en grand'; pb.setAttribute('aria-label', pb.title); pb.setAttribute('aria-pressed', S.pin === p.pid); }
    t.classList.toggle('has-video', !!video);
    t.querySelector('.mt-av').textContent = initials(p.name);
    const role = p.host ? (isCourse() ? 'Enseignant' : 'Organisateur') : p.cohost ? 'Co-animateur' : isCourse() && p.floor ? 'A la parole' : '';
    t.querySelector('.mt-name').innerHTML = (p.muted ? `<span class="mt-mute">${icon('mic-off', 'sm')}</span>` : '') + `<span class="mt-nm">${esc(p.name)}${self ? ' (vous)' : ''}</span>` + (role ? `<span class="mt-role">${role}</span>` : '');
    const n = order.indexOf(p.pid) + 1, hd = t.querySelector('.mt-hand');
    hd.textContent = n ? emo('hand', self ? myTone() : p.tone || 0) + ' ' + n : ''; hd.hidden = !n;
    const w = t.querySelector('.mt-warn'); const bad = !self && p.link && /failed|disconnected/.test(p.link);
    w.textContent = bad ? 'Reconnexion…' : ''; w.hidden = !bad;
    if (!video) t.classList.remove('v-wait');
    const v = t.querySelector('video');
    const want = video ? (self ? S.cam : p.streams.c && p.streams.c.getVideoTracks()[0]) : null;
    const cur = v.srcObject && v.srcObject.getVideoTracks()[0];
    if (want && cur !== want) v.srcObject = self ? new MediaStream([S.cam]) : p.streams.c;
    else if (!want && v.srcObject) v.srcObject = null;
    if (v.srcObject && v.paused) v.play().catch(() => {});   // une vidéo déplacée dans la page se met en pause
  });
  grid.classList.toggle('strip', mode !== 'grid');
  room.classList.toggle('no-strip', !grid.children.length);
  grid.dataset.n = String(Math.min(grid.children.length, 9));
  grid.classList.toggle('dense', mode === 'grid' && list.length + 1 > 6);
  grid.classList.toggle('xdense', mode === 'grid' && list.length + 1 > 15);
  // Présentation
  const v = $('#mtStageV');
  const wantS = sharer ? (sharer === me ? (S.screen ? new MediaStream([S.screen]) : null) : sharer.streams.s) : null;
  const curT = v.srcObject && v.srcObject.getVideoTracks()[0];
  const wantT = wantS ? wantS.getVideoTracks()[0] : null;
  if (wantT && curT !== wantT) v.srcObject = wantS;
  else if (!wantT && v.srcObject) v.srcObject = null;
  if (v.srcObject && v.paused) v.play().catch(() => {});
  const lbl = $('#mtStageL');
  const other = sharer && sharer !== me;
  if (!other || !lbl.querySelector('.lat') || (S.latPrev && S.latPrev.pid !== sharer.pid)) lbl.textContent = other ? sharer.name + ' présente' : S.sharing ? 'Vous présentez votre écran' : '';
  $('#mtStopShare').classList.toggle('hidden', !S.sharing);
  stage.classList.toggle('self-share', !!S.sharing);
  placePip(); fitGrid();
  drawPanel(); drawTop(); drawBar();
}
function drawBarBadge() { drawBar(); }

/* ======================================================================
   CAMÉRA ET MICRO : messages précis (jamais « erreur serveur » pour un souci d'appareil)
   ====================================================================== */
function micError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Micro bloqué par le navigateur : touchez l\'icône à gauche de l\'adresse du site et autorisez le micro. Vous pouvez écouter en attendant.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Aucun micro détecté sur cet appareil. Vous pouvez écouter la réunion.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'Le micro est déjà utilisé par une autre application (appel, WhatsApp, Zoom…). Fermez-la puis rechargez la page.';
  return 'Micro indisponible : vous pourrez écouter, mais pas parler.';
}
function camError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Caméra bloquée par le navigateur : touchez l\'icône à gauche de l\'adresse du site et autorisez la caméra.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Aucune caméra détectée sur cet appareil.';
  if (n === 'NotReadableError' || n === 'AbortError') return 'La caméra est déjà utilisée par une autre application (WhatsApp, Zoom, appareil photo…). Fermez-la puis réessayez.';
  return 'Impossible d\'allumer la caméra' + (n ? ' (' + n + ')' : '') + '.';
}
async function openCam() {
  const base = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
  const pick = S.camId ? { deviceId: { exact: S.camId } } : { facingMode: S.facing || 'user' };
  try { return (await navigator.mediaDevices.getUserMedia({ video: Object.assign({}, base, pick) })).getVideoTracks()[0]; }
  catch (e) {
    // Contraintes refusées par certains téléphones : on réessaie avec la caméra par défaut
    if (e.name === 'OverconstrainedError' || e.name === 'NotReadableError' || e.name === 'AbortError') { S.camId = null; return (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0]; }
    throw e;
  }
}
function watchCam(tr) {
  tr.onended = () => {
    if (S.cam !== tr) return;
    S.cam = null; S.camOn = false; S.engine && S.engine.setTrack('c', null); sendState({ cam: false }); drawBar(); drawPeople();
    toast('La caméra s\'est arrêtée (débranchée ou prise par une autre application).', 'warn', { duration: 6000 }); diag('cam-ended');
  };
  setTimeout(() => {
    if (S.cam !== tr || !S.camOn) return;
    const v = document.querySelector('.mt-tile.self video');
    if (tr.readyState !== 'live' || tr.muted || (v && !v.videoWidth)) { toast('Caméra allumée mais sans image : fermez les autres applications qui l\'utilisent, puis réessayez.', 'warn', { duration: 7000, action: 'Diagnostic', onAction: openDiag }); diag('cam-black'); }
  }, 3500);
}
async function toggleCam() {
  if (S.camOn) { S.cam && S.cam.stop(); S.cam = null; S.camOn = false; S.engine.setTrack('c', null); sendState({ cam: false }); }
  else {
    const btn = $('#bCam'); if (btn) btn.disabled = true;
    let tr;
    try { tr = await openCam(); }
    catch (e) { if (btn) btn.disabled = false; diag('cam-error', e.name); return toast(camError(e), 'warn', { duration: 8000, action: 'Diagnostic', onAction: openDiag }); }
    S.cam = tr; S.camOn = true; watchCam(tr); S.engine.setTrack('c', tr); sendState({ cam: true });
  }
  drawBar(); drawPeople();
}
async function restartCam() {
  const old = S.cam; try { old && old.stop(); } catch (e) { /* ignore */ }
  let tr;
  try { tr = await openCam(); }
  catch (e) { S.cam = null; S.camOn = false; S.engine.setTrack('c', null); sendState({ cam: false }); drawBar(); drawPeople(); return toast(camError(e), 'warn'); }
  S.cam = tr; watchCam(tr); S.engine.setTrack('c', tr); drawPeople();
}
/* Téléphone : caméra avant / arrière (on libère l'ancienne d'abord, certains appareils n'en ouvrent qu'une) */
async function switchCam() {
  if (!S.camOn) return;
  S.facing = S.facing === 'environment' ? 'user' : 'environment'; S.camId = null;
  await restartCam();
  toast(S.facing === 'environment' ? 'Caméra arrière' : 'Caméra avant', 'info', { duration: 1500 });
}

/* Qualité du réseau (aller-retour, pertes) et vidéos noires, toutes les 3 s */
async function quality() {
  if (!S.engine || S.ended) return;
  let rtt = 0, lost = 0, recv = 0;
  for (const pc of S.engine.conns().slice(0, 4)) {
    try { const st = await pc.getStats(); st.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) rtt = Math.max(rtt, r.currentRoundTripTime); if (r.type === 'inbound-rtp' && r.kind === 'audio') { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; } }); } catch (e) { /* ignore */ }
  }
  const prev = S.qPrev || { lost, recv }; S.qPrev = { lost, recv };
  const dl = Math.max(0, lost - prev.lost), dr = Math.max(0, recv - prev.recv);
  const loss = dl + dr > 50 ? dl / (dl + dr) : 0;
  S.weak = rtt > 0.6 || loss > 0.08;
  S.people.forEach(p => {
    const t = document.querySelector(`#mtRoom .mt-tile[data-pid="${p.pid}"]`), v = t && t.querySelector('video');
    const black = S.meeting.kind === 'video' && p.cam && !!v && !v.videoWidth;
    p.blk = black ? (p.blk || 0) + 1 : 0;
    if (t) t.classList.toggle('v-wait', p.blk >= 2);
    if ((p.blk === 2 || p.blk === 5 || p.blk === 9) && !(p.camWatchUntil > Date.now())) { S.engine.repull(p.pid, 'c'); diag('video-black', S.engine instanceof Sfu ? 'sfu' : 'mesh'); }
  });
  refreshNet();
}
/* Caméra qui vient de s'allumer chez quelqu'un : on vérifie l'image après 3 s puis 5,5 s,
   sans attendre le contrôle régulier. Image toujours noire alors que la vidéo est reçue → on la redemande. */
function camWatch(pid) {
  const check = (last) => {
    const p = S.people.get(pid); if (!p || !p.cam || S.ended || !S.engine) return;
    const v = document.querySelector(`#mtRoom .mt-tile[data-pid="${pid}"] video`);
    if (!v || v.videoWidth) return;
    if (!(p.streams && p.streams.c)) { if (!last) setTimeout(() => check(true), 2500); return; }
    S.engine.repull(pid, 'c'); diag('video-black-early', S.engine instanceof Sfu ? 'sfu' : 'mesh');
    if (!last) setTimeout(() => check(true), 2500);
  };
  const p = S.people.get(pid); if (p) p.camWatchUntil = Date.now() + 8000;
  setTimeout(() => check(false), 3000);
}

function openPanel(tab, toggle) {
  if (toggle && S.panel && S.tab === tab) S.panel = false; else { S.panel = true; S.tab = tab; }
  if (S.tab === 'chat' && S.panel) S.unread = 0;
  drawPanel(); drawBar();
  if (S.panel && tab === 'chat') setTimeout(() => { const i = $('#chIn'); if (i) i.focus(); }, 50);
}
const fmtHour = (ts) => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function drawPanel() {
  const el = $('#mtPanel'); if (!el) return;
  el.classList.toggle('hidden', !S.panel);
  document.body.classList.toggle('mt-panel', !!S.panel);
  if (!S.panel) return;
  const tabs = [['people', 'users', 'Participants'], ...(S.meeting.chat || isStaff() ? [['chat', 'message', 'Discussion']] : []), ['poll', 'chart', 'Sondage']];
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'people';
  el.innerHTML = `
    <div class="card-title"><div class="chips mp-tabs" role="tablist">${tabs.map(([k, ic, l]) => `<button type="button" class="chip ${S.tab === k ? 'active' : ''}" data-tab="${k}" role="tab" aria-selected="${S.tab === k}">${icon(ic, 'sm')}${l}</button>`).join('')}</div>
      <button type="button" class="icon-btn" id="pClose" aria-label="Fermer">${icon('x')}</button></div>
    <div id="mpBody"></div>`;
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => openPanel(b.dataset.tab));
  $('#pClose').onclick = () => { S.panel = false; drawPanel(); drawBar(); };
  const body = $('#mpBody');
  if (S.tab === 'chat') return drawChat(body);
  if (S.tab === 'poll') return drawPoll(body);
  drawPeoplePane(body);
}

function drawPeoplePane(body) {
  const staffMe = isStaff(), hostMe = !!(S.self && S.self.host), course = isCourse();
  const order = handOrder();
  const all = [Object.assign({}, S.self, { name: S.name, muted: S.muted, me: true })].concat([...S.people.values()]);
  all.sort((a, b) => { const ia = order.indexOf(a.pid), ib = order.indexOf(b.pid); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
  const wait = staffMe ? (S.wait || []) : [];
  body.innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${all.length} participant${all.length > 1 ? 's' : ''}</b><button type="button" class="btn sm" id="pInvite">${icon('share', 'sm')}Inviter</button></div>
    ${wait.length ? `<div class="mp-wait"><div class="row" style="justify-content:space-between"><b>🚪 Salle d'attente (${wait.length})</b><button type="button" class="btn sm primary" data-admit="*">Tout admettre</button></div>
      ${wait.map(w => `<div class="mt-row"><span class="mt-rn">${esc(w.name)}</span><button type="button" class="btn sm" data-admit="${esc(w.sid)}">Admettre</button><button type="button" class="btn sm ghost" data-deny="${esc(w.sid)}" title="Refuser">${icon('x', 'sm')}</button></div>`).join('')}</div>` : ''}
    ${staffMe ? `<div class="row wrap" style="gap:6px;margin:8px 0 10px">
      <button type="button" class="btn sm" data-host="muteAll">${icon('mic-off', 'sm')}Couper tous les micros</button>
      <button type="button" class="btn sm" data-host="${S.meeting.locked ? 'unlock' : 'lock'}">${icon(S.meeting.locked ? 'unlock' : 'lock', 'sm')}${S.meeting.locked ? 'Déverrouiller' : 'Verrouiller'}</button>
      <button type="button" class="btn sm" data-host="waiting" data-v="${S.meeting.waiting ? '' : '1'}">${icon('clock', 'sm')}${S.meeting.waiting ? 'Sans salle d\'attente' : 'Salle d\'attente'}</button>
      <button type="button" class="btn sm" data-host="chat" data-v="${S.meeting.chat ? '' : '1'}">${icon('message', 'sm')}${S.meeting.chat ? 'Fermer la discussion' : 'Ouvrir la discussion'}</button>
      <button type="button" class="btn sm" id="pAtt">${icon('clipboard', 'sm')}Liste de présence</button>
      ${hostMe ? `<button type="button" class="btn sm danger" data-host="end">${icon('call-end', 'sm')}Terminer pour tous</button>` : ''}
      ${hostMe && S.meeting.expiresAt ? `<button type="button" class="btn sm ghost" data-host="delete">${icon('trash', 'sm')}Supprimer le lien</button>` : ''}</div>
      ${S.meeting.expiresAt ? `<p class="small faint" style="margin:-4px 0 10px">${icon('clock', 'sm')} Lien et code valables jusqu'au ${until(S.meeting.expiresAt)}</p>` : ''}` : ''}
    <div class="stack" style="gap:4px">${all.map(p => {
      const n = order.indexOf(p.pid) + 1;
      const role = p.host ? (course ? 'enseignant' : 'organisateur') : p.cohost ? 'co-animateur' : course && p.floor ? '🎤 a la parole' : '';
      const acts = staffMe && !p.me ? [
        course && !p.host && !p.cohost ? (p.floor ? `<button type="button" class="btn sm" data-act="unfloor">Reprendre la parole</button>` : `<button type="button" class="btn sm ${p.hand ? 'primary' : ''}" data-act="floor">Donner la parole</button>`) : '',
        !p.muted ? `<button type="button" class="btn sm ghost" data-act="mute" title="Couper son micro">${icon('mic-off', 'sm')}</button>` : '',
        p.hand ? `<button type="button" class="btn sm ghost" data-act="lower" title="Baisser sa main">${icon('hand', 'sm')}</button>` : '',
        hostMe && !p.host ? `<button type="button" class="btn sm ghost" data-act="${p.cohost ? 'uncohost' : 'cohost'}" title="${p.cohost ? 'Retirer co-animateur' : 'Nommer co-animateur'}">${icon('shield', 'sm')}</button>` : '',
        !p.host ? `<button type="button" class="btn sm ghost" data-act="remove" title="Retirer de la réunion">${icon('x', 'sm')}</button>` : ''
      ].join('') : '';
      return `<div class="mt-row" data-pid="${esc(p.pid)}"><span class="mt-dot" style="--h:${hue(p.pid)}">${esc(initials(p.name))}</span>
        <span class="mt-rn">${esc(p.name)}${p.me ? ' (vous)' : ''}${role ? ` <small class="muted">${role}</small>` : ''}</span>
        ${n ? `<span class="pill warn" style="flex:none">${emo('hand', p.me ? myTone() : p.tone || 0)} ${n}</span>` : ''}
        <span class="mt-ic">${icon(p.muted ? 'mic-off' : 'mic', 'sm')}</span>
        ${acts ? `<span class="mt-act">${acts}</span>` : ''}
      </div>`; }).join('')}</div>
    <p class="small faint" style="margin-top:10px">Jusqu'à ${S.meeting.max} participants. ${S.meeting.recording ? '🔴 Enregistrement en cours.' : 'Rien n\'est enregistré sur nos serveurs.'}</p>`;
  $('#pInvite').onclick = () => invite(false);
  const att = $('#pAtt'); if (att) att.onclick = exportAttendance;
  body.querySelectorAll('[data-admit]').forEach(b => b.onclick = () => S.socket.emit('meet-host', { action: 'admit', sid: b.dataset.admit }));
  body.querySelectorAll('[data-deny]').forEach(b => b.onclick = () => S.socket.emit('meet-host', { action: 'deny', sid: b.dataset.deny }));
  body.querySelectorAll('[data-host]').forEach(b => b.onclick = async () => {
    const a = b.dataset.host;
    if (a === 'end' && !(await confirmDialog('Terminer la réunion ?', 'Tout le monde sera déconnecté.' + (S.meeting.expiresAt ? ' Le lien et le code resteront valables jusqu\'au ' + until(S.meeting.expiresAt) + ' : vous pourrez relancer la réunion avec le même lien.' : ''), 'Terminer', true))) return;
    if (a === 'delete' && !(await confirmDialog('Supprimer le lien ?', 'La réunion s\'arrête pour tout le monde et le lien ne marchera plus. Cette action est définitive.', 'Supprimer', true))) return;
    if (a === 'delete') forgetMine(S.id);
    S.socket.emit('meet-host', { action: a, value: !!b.dataset.v });
    if (a === 'muteAll') toast('Micros coupés', 'success');
  });
  body.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const pid = b.closest('[data-pid]').dataset.pid, a = b.dataset.act;
    if (a === 'remove') { const p = S.people.get(pid); if (!(await confirmDialog('Retirer ' + (p ? p.name : 'ce participant') + ' ?', 'Il sera déconnecté de la réunion.', 'Retirer', true))) return; }
    S.socket.emit('meet-host', { action: a, pid });
  });
}

function drawChat(body) {
  const can = S.meeting.chat || isStaff();
  const msgs = S.messages || [];
  body.innerHTML = `
    <div class="mp-chat" id="chList" aria-live="polite">${msgs.length ? msgs.map(m => `<div class="mp-msg ${S.self && m.pid === S.self.pid ? 'me' : ''}"><div class="mp-meta"><b>${esc(m.name)}</b>${m.staff ? ' <small class="muted">' + (isCourse() ? 'enseignant' : 'animateur') + '</small>' : ''} <small class="faint">${fmtHour(m.at)}</small></div><div class="mp-txt">${esc(m.text)}</div></div>`).join('') : '<p class="small faint center" style="margin:30px 0">Pas encore de message. Posez votre question ici.</p>'}</div>
    ${can ? `<form id="chForm" class="mp-send" autocomplete="off"><input class="input" id="chIn" maxlength="500" placeholder="Écrire un message…" aria-label="Message"><button type="submit" class="btn primary" aria-label="Envoyer">${icon('arrow-right')}</button></form>` : '<p class="small faint">L\'organisateur a fermé la discussion.</p>'}`;
  const list = $('#chList'); list.scrollTop = list.scrollHeight;
  const f = $('#chForm'); if (f) f.onsubmit = (e) => { e.preventDefault(); const i = $('#chIn'); const t = i.value.trim(); if (!t) return; S.socket.emit('meet-chat', { text: t }); i.value = ''; i.focus(); };
}

function drawPoll(body) {
  const p = S.poll, staffMe = isStaff(), voted = (S.voted || {})[p && p.id];
  const results = p ? p.opts.map((o, i) => { const n = p.counts[i], pc = p.total ? Math.round(n / p.total * 100) : 0; return `<div class="mp-res ${voted === i ? 'mine' : ''}"><div class="row" style="justify-content:space-between"><span>${esc(o)}</span><b>${pc} % <small class="faint">(${n})</small></b></div><div class="pf-bar"><i style="width:${pc}%"></i></div></div>`; }).join('') : '';
  body.innerHTML = `
    ${p ? `<div class="stack" style="gap:8px"><b style="font-size:15px">${esc(p.q)}</b><span class="small faint">${p.total} réponse${p.total > 1 ? 's' : ''} · ${p.open ? 'en cours' : 'terminé'}</span>
      ${p.open && !staffMe ? `<div class="stack" style="gap:6px">${p.opts.map((o, i) => `<button type="button" class="btn block ${voted === i ? 'primary' : ''}" data-vote="${i}">${esc(o)}</button>`).join('')}</div>${voted != null ? '<p class="small faint">Vous pouvez changer votre réponse tant que le sondage est ouvert.</p>' : ''}` : ''}
      ${staffMe || voted != null || !p.open ? results : ''}
      ${staffMe && p.open ? `<button type="button" class="btn sm" id="pollClose">${icon('check', 'sm')}Clore et montrer les résultats</button>` : ''}</div>` : `<p class="small faint">${staffMe ? 'Aucun sondage pour l\'instant.' : 'Aucun sondage en cours. L\'animateur peut en lancer un à tout moment.'}</p>`}
    ${staffMe ? `<form id="pollForm" class="stack mp-pollform" style="gap:8px;margin-top:14px" autocomplete="off">
      <b>${p ? 'Nouveau sondage' : 'Lancer un sondage'}</b>
      <input class="input" id="pQ" maxlength="200" placeholder="Question (ex. : Avez-vous compris ?)" required>
      <textarea class="input" id="pO" rows="4" placeholder="Une réponse par ligne (2 à 6)">Oui\nNon\nPas sûr</textarea>
      <button type="submit" class="btn primary">${icon('chart', 'sm')}Lancer</button></form>` : ''}`;
  body.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => { S.voted = Object.assign(S.voted || {}, { [p.id]: +b.dataset.vote }); S.socket.emit('meet-vote', { id: p.id, i: +b.dataset.vote }); drawPanel(); drawBar(); });
  const c = $('#pollClose'); if (c) c.onclick = () => S.socket.emit('meet-poll-close');
  const f = $('#pollForm'); if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const q = $('#pQ').value.trim(), opts = $('#pO').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 6);
    if (!q || opts.length < 2) return toast('Une question et au moins deux réponses', 'warn');
    S.socket.emit('meet-poll', { q, opts }); toast('Sondage lancé', 'success');
  };
}

/* Liste de présence : fichier CSV qui s'ouvre directement dans Excel */
async function exportAttendance() {
  const r = await emitAck(S.socket, 'meet-host', { action: 'attendance' });
  if (!r || !r.rows) return toast('Liste de présence indisponible.', 'error');
  const d = (ts) => new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [['Nom', 'Rôle', 'Arrivée', 'Départ', 'Durée (min)', 'Connexions', 'Encore présent'].map(q).join(';')];
  r.rows.forEach(x => lines.push([x.name, x.host ? (isCourse() ? 'Enseignant' : 'Organisateur') : 'Participant', d(x.first), x.present ? '' : d(x.last), Math.max(1, Math.round(x.ms / 60000)), x.visits, x.present ? 'oui' : 'non'].map(q).join(';')));
  const head = [q('Réunion : ' + r.title), q('Début : ' + d(r.startedAt)), q('Export : ' + d(Date.now()))].join(';');
  const blob = new Blob(['﻿' + head + '\r\n\r\n' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const name = 'Presence-' + String(r.title).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('Liste de présence téléchargée : ' + r.rows.length + ' personne(s)', 'success');
}

async function invite(urgent) {
  const link = linkOf(S.id), code = S.meeting.code;
  const pretty = code ? code.slice(0, 3) + ' ' + code.slice(3) : '';
  const text = (urgent || S.meeting.emergency ? '🚨 Réunion urgente : ' : '📞 ') + S.meeting.title + '\nRejoignez maintenant : ' + link + (code ? '\nou tapez le code ' + pretty + ' dans « Recevoir » sur Lestha Send' : '') + (S.meeting.expiresAt ? '\n(lien valable jusqu\'au ' + until(S.meeting.expiresAt) + ')' : '');
  if (urgent) { shareTo('whatsapp', { link, text: text.replace('\nRejoignez maintenant : ' + link, '\nRejoignez maintenant') }); return; }
  await modal({
    title: 'Inviter à la réunion', wide: false,
    body: `<div class="stack">
      <div class="link-box"><input readonly value="${esc(link)}" aria-label="Lien de la réunion"><button type="button" class="btn primary sm" id="ivCopy">${icon('copy', 'sm')}Copier</button></div>
      ${code ? `<div class="rx-codebox"><span class="small muted">ou le code, à taper dans <b>Recevoir</b></span><b class="rx-code-v">${pretty}</b></div>` : ''}
      ${S.meeting.expiresAt ? `<p class="small faint center" style="margin:0">${icon('clock', 'sm')} Lien et code valables jusqu'au ${until(S.meeting.expiresAt)}, même après la réunion</p>` : ''}
      <div class="share-grid"><button type="button" class="btn" data-sh="whatsapp">${icon('whatsapp')}WhatsApp</button><button type="button" class="btn" data-sh="native">${icon('share')}Partager</button><button type="button" class="btn" data-sh="sms">${icon('message')}SMS</button><button type="button" class="btn" data-sh="mail">${icon('mail')}E-mail</button></div>
      <div class="qr-card" style="box-shadow:none"><div class="qr" id="ivQr"></div><div class="small muted">Scannez pour rejoindre</div></div></div>`,
    actions: [{ label: 'Fermer', cls: 'ghost' }],
    onMount(el) {
      renderQR(el.querySelector('#ivQr'), link);
      el.querySelector('#ivCopy').onclick = async () => { if (await copyText(link)) toast('Lien copié', 'success'); };
      el.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => shareTo(b.dataset.sh, { link, text: text.split('\nRejoignez')[0] + '\nRejoignez maintenant', title: S.meeting.title }));
    }
  });
}

/* ======================================================================
   RÉACTIONS
   ====================================================================== */
function toggleReactions() {
  let el = $('#mtReact');
  if (el) { el.remove(); return; }
  el = document.createElement('div'); el.id = 'mtReact'; el.className = 'meet-react card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Réactions');
  const draw = () => {
    const t = myTone();
    el.innerHTML = `<div class="mr-tones" role="radiogroup" aria-label="Couleur de peau">${TONES.map((x, i) => `<button type="button" class="${i === t ? 'on' : ''}" data-tone="${i}" role="radio" aria-checked="${i === t}" title="Couleur ${i + 1}">✋${x}</button>`).join('')}</div>
      <div class="mr-grid">${REACTS.map(([k, , , l]) => `<button type="button" data-r="${k}" title="${esc(l)}"><b>${emo(k, t)}</b><small>${esc(l)}</small></button>`).join('')}</div>`;
    el.querySelectorAll('[data-tone]').forEach(b => b.onclick = (e) => { e.stopPropagation(); ls.set('tx_meet_tone', +b.dataset.tone); S.socket.emit('meet-state', { tone: +b.dataset.tone }); draw(); drawBar(); drawPeople(); });
    el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { S.socket.emit('meet-react', { r: b.dataset.r, t: myTone() }); el.remove(); });
  };
  draw();
  document.body.appendChild(el);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!el.contains(e.target) && e.target.closest('#bReact') === null) { el.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function showReact(pid, r, t) {
  const tileEl = document.querySelector(`#mtRoom .mt-tile[data-pid="${pid}"]`); if (!tileEl) return;
  const f = document.createElement('span'); f.className = 'mt-float'; f.textContent = emo(r, t);
  f.style.left = (30 + Math.random() * 40) + '%';
  tileEl.appendChild(f); setTimeout(() => f.remove(), 2800);
}

/* ======================================================================
   ENREGISTREMENT (organisateur) : fichier gardé sur son appareil,
   tous les participants sont prévenus
   ====================================================================== */
const R = { on: false };
function pickMime(video) {
  const list = video ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return list.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}
function recAdd(key, trackObj) {
  if (!R.on || !trackObj || R.srcs.has(key)) return;
  try { const s = R.ac.createMediaStreamSource(new MediaStream([trackObj])); s.connect(R.mix); R.srcs.set(key, s); } catch (e) { /* ignore */ }
}
/** Choix du format avant d'enregistrer : MP3 (cours, podcasts) ou vidéo */
async function recOptions() {
  const canVideo = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream) && (S.meeting.kind === 'video' || S.sharing || [...S.people.values()].some(p => p.screen));
  const last = ls.get('tx_rec_fmt', 'mp3-128');
  const opt = (v, t, d) => `<label class="rec-opt"><input type="radio" name="recf" value="${v}" ${last === v ? 'checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`;
  const r = await modal({
    title: 'Enregistrer la réunion',
    body: `<p class="muted small">Tous les participants verront qu'un enregistrement est en cours. Le fichier est créé sur votre appareil, rien n'est gardé sur nos serveurs.</p>
      <div class="stack" style="gap:8px;margin-top:10px">
        ${opt('mp3-128', 'Audio MP3 · 128 kbit/s', 'Recommandé pour un cours : lisible partout, environ 1 Mo par minute')}
        ${opt('mp3-64', 'Audio MP3 · 64 kbit/s', 'Voix seule, fichier deux fois plus léger (WhatsApp)')}
        ${opt('mp3-192', 'Audio MP3 · 192 kbit/s', 'Meilleure qualité, fichier plus lourd')}
        ${canVideo ? opt('video', 'Vidéo (WebM)', 'Vignettes, noms et présentation à l’écran ; plus lourd') : ''}
      </div>`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Démarrer', cls: 'danger', icon: 'rec', handler: (bd) => (bd.querySelector('input[name=recf]:checked') || {}).value || 'mp3-128' }]
  });
  if (r) ls.set('tx_rec_fmt', r);
  return r;
}
async function recStart() {
  const fmt = await recOptions(); if (!fmt) return;
  const ac = audioCtx(); if (!ac) return toast('Enregistrement impossible sur cet appareil.', 'error');
  const mix = ac.createGain();
  // Limiteur : plusieurs voix en même temps ne saturent pas l'enregistrement
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 10; comp.attack.value = 0.003; comp.release.value = 0.2;
  mix.connect(comp);
  Object.assign(R, { ac, mix, dest: ac.createMediaStreamDestination(), srcs: new Map(), on: true, chunks: [], t0: Date.now(), fmt, video: fmt === 'video', mp3: fmt.startsWith('mp3') });
  comp.connect(R.dest);
  recAdd('self', S.mic);
  S.people.forEach(p => p.streams.a && recAdd(p.pid, p.streams.a.getAudioTracks()[0]));
  if (R.mp3) {
    // MP3 encodé pendant la réunion (pas d'attente à la fin, mémoire réduite)
    try { R.worker = new Worker('/js/mp3-worker.js'); } catch (e) { R.on = false; return toast('Enregistrement MP3 impossible sur cet appareil.', 'error'); }
    R.worker.postMessage({ cmd: 'init', sampleRate: ac.sampleRate, kbps: +fmt.split('-')[1] || 128 });
    R.worker.onmessage = (e) => { if (e.data && e.data.blob) recDone(e.data.blob); };
    R.node = ac.createScriptProcessor(4096, 1, 1);
    R.node.onaudioprocess = (e) => { if (R.on) R.worker.postMessage({ cmd: 'pcm', d: new Float32Array(e.inputBuffer.getChannelData(0)) }); };
    R.mute = ac.createGain(); R.mute.gain.value = 0;
    comp.connect(R.node); R.node.connect(R.mute); R.mute.connect(ac.destination);
  } else {
    if (!window.MediaRecorder) { R.on = false; return toast('Ce navigateur ne permet pas d\'enregistrer en vidéo. Choisissez MP3.', 'warn'); }
    let stream = R.dest.stream;
    if (R.video) {
      R.cv = document.createElement('canvas'); R.cv.width = 1280; R.cv.height = 720; R.cx = R.cv.getContext('2d');
      R.draw = setInterval(recDraw, 1000 / 15);
      stream = new MediaStream([...R.cv.captureStream(15).getVideoTracks(), ...R.dest.stream.getAudioTracks()]);
    }
    const mime = pickMime(R.video);
    try { R.mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000, videoBitsPerSecond: 900000 } : undefined); }
    catch (e) { R.on = false; clearInterval(R.draw); return toast('Enregistrement impossible sur cet appareil.', 'error'); }
    R.mime = R.mr.mimeType || mime;
    R.mr.ondataavailable = (e) => { if (e.data && e.data.size) R.chunks.push(e.data); };
    R.mr.onstop = () => recDone(new Blob(R.chunks, { type: R.mime || (R.video ? 'video/webm' : 'audio/webm') }));
    R.mr.start(2000);
  }
  S.socket.emit('meet-host', { action: 'rec' });
  R.tick = setInterval(() => { const b = $('#bRec .mb-t'); if (b && R.on) b.textContent = fmtClock(Date.now() - R.t0); }, 1000);
  drawBar();
}
function recStop() {
  if (!R.on) return;
  R.on = false; clearInterval(R.draw); clearInterval(R.tick);
  if (R.mp3) { try { R.node.disconnect(); R.mute.disconnect(); } catch (e) { /* ignore */ } R.worker.postMessage({ cmd: 'end' }); }
  else { try { R.mr.stop(); } catch (e) { /* ignore */ } }
  R.srcs.forEach(s => { try { s.disconnect(); } catch (e) { /* ignore */ } });
  if (S.socket) S.socket.emit('meet-host', { action: 'unrec' });
  drawBar();
}
function recDone(blob) {
  R.chunks = [];
  if (R.worker) { R.worker.terminate(); R.worker = null; }
  if (!blob || !blob.size) return toast('L\'enregistrement est vide.', 'warn');
  const type = blob.type || '';
  const ext = /mpeg/.test(type) ? 'mp3' : /mp4/.test(type) ? (R.video ? 'mp4' : 'm4a') : /ogg/.test(type) ? 'ogg' : 'webm';
  const title = String((S.meeting && S.meeting.title) || 'Lestha').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Lestha';
  if (R.url) URL.revokeObjectURL(R.url);
  Object.assign(R, { url: URL.createObjectURL(blob), name: 'Reunion-' + title + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.' + ext, size: blob.size });
  saveRec();
  if (S.ended && root && !$('#recAgain')) renderEnd('Merci d\'avoir participé.');
}
function saveRec() {
  if (!R.url) return;
  const a = document.createElement('a'); a.href = R.url; a.download = R.name; a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1500);
  toast('Enregistrement prêt : ' + R.name.split('.').pop().toUpperCase() + ' · ' + bytes(R.size), 'success', { action: 'Télécharger encore', onAction: saveRec, duration: 12000 });
}
function drawCover(c, v, x, y, w, h, contain) {
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return;
  const k = contain ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh), dw = vw * k, dh = vh * k;
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); c.restore();
}
function recDraw() {
  const c = R.cx, W = 1280, H = 720;
  c.fillStyle = '#070b16'; c.fillRect(0, 0, W, H);
  const sv = $('#mtStageV'), st = $('#mtStage');
  const stageOn = sv && st && !st.classList.contains('hidden') && sv.videoWidth;
  const tiles = [...document.querySelectorAll('#mtRoom .mt-tile:not(#mtPip .mt-tile)')];
  let area = { x: 0, y: 48, w: W, h: H - 48 };
  if (stageOn) { drawCover(c, sv, 0, 48, 980, H - 48, true); area = { x: 980, y: 48, w: 300, h: H - 48 }; }
  const n = Math.min(tiles.length, stageOn ? 5 : 16);
  const cols = stageOn ? 1 : Math.max(1, Math.ceil(Math.sqrt(n))), rows = Math.max(1, Math.ceil(n / cols));
  const tw = area.w / cols, th = area.h / rows;
  tiles.slice(0, n).forEach((t, i) => {
    const x = area.x + (i % cols) * tw + 4, y = area.y + Math.floor(i / cols) * th + 4, w = tw - 8, h = th - 8;
    const hu = t.style.getPropertyValue('--h') || 200;
    c.fillStyle = `hsl(${hu} 40% 18%)`; c.fillRect(x, y, w, h);
    const v = t.querySelector('video');
    if (t.classList.contains('has-video') && v && v.videoWidth) drawCover(c, v, x, y, w, h, false);
    else {
      const r = Math.min(w, h) * 0.2; c.fillStyle = `hsl(${hu} 60% 45%)`; c.beginPath(); c.arc(x + w / 2, y + h / 2 - 8, r, 0, 6.283); c.fill();
      c.fillStyle = '#fff'; c.font = `700 ${Math.round(r * 0.8)}px Inter, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(t.querySelector('.mt-av').textContent, x + w / 2, y + h / 2 - 8); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    }
    if (t.classList.contains('speaking')) { c.strokeStyle = '#06d6a0'; c.lineWidth = 4; c.strokeRect(x + 2, y + 2, w - 4, h - 4); }
    const label = t.querySelector('.mt-name').textContent.slice(0, 40), hand = t.querySelector('.mt-hand');
    c.font = '600 15px Inter, sans-serif'; c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x + 6, y + h - 32, Math.min(w - 12, c.measureText(label).width + 20), 26);
    c.fillStyle = '#fff'; c.fillText(label, x + 16, y + h - 14);
    if (hand && !hand.hidden && hand.textContent) { c.font = '700 18px Inter, sans-serif'; c.fillText(hand.textContent, x + w - 60, y + 26); }
  });
  c.fillStyle = '#e11d48'; c.beginPath(); c.arc(24, 24, 8, 0, 6.283); c.fill();
  c.fillStyle = '#eef6ff'; c.font = '600 18px Inter, sans-serif'; c.fillText(((S.meeting && S.meeting.title) || '').slice(0, 70) + '  ·  ' + fmtClock(Date.now() - (S.meeting ? S.meeting.startedAt : Date.now())), 42, 31);
}

/* Horloge, voix qui parle */
/* Délai mesuré de la présentation (réseau + mémoire tampon + décodage), affiché sur la scène
   et envoyé au serveur toutes les 30 s pour la console admin (moyennes anonymes) */
async function measure() {
  if (!S.engine || S.ended) return;
  await quality();
  const sharer = [...S.people.values()].find(p => p.screen && p.recv && p.recv.s);
  if (!sharer) { S.lat = null; return; }
  let st; try { st = await sharer.recv.s.getStats(); } catch (e) { return; }
  let v = null, rtt = null;
  st.forEach(r => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null && (r.nominated || rtt == null)) rtt = r.currentRoundTripTime;
  });
  if (!v) return;
  const prev = S.latPrev && S.latPrev.pid === sharer.pid ? S.latPrev : null;
  S.latPrev = { pid: sharer.pid, jb: v.jitterBufferDelay || 0, em: v.jitterBufferEmittedCount || 0, dec: v.totalDecodeTime || 0, fd: v.framesDecoded || 0 };
  if (!prev) return;
  const em = S.latPrev.em - prev.em, fd = S.latPrev.fd - prev.fd;
  const jb = em > 0 ? (S.latPrev.jb - prev.jb) / em : 0, dec = fd > 0 ? (S.latPrev.dec - prev.dec) / fd : 0;
  const net = rtt == null ? 0.05 : (S.meeting.engine === 'sfu' ? rtt : rtt / 2);   // serveur : deux trajets
  S.lat = Math.round((net + jb + dec) * 1000 + 60);                                // + capture, encodage, affichage (~60 ms mesurés)
  S.fps = Math.round(v.framesPerSecond || 0);
  const l = $('#mtStageL');
  if (l) l.innerHTML = `${esc(sharer.name)} présente <i class="lat ${S.lat < 300 ? 'ok' : S.lat < 700 ? 'mid' : 'bad'}" title="Délai entre l'écran de ${esc(sharer.name)} et le vôtre">⚡ ${S.lat} ms</i>`;
  if (Date.now() - (S.latSent || 0) > 30e3) { S.latSent = Date.now(); S.socket && S.socket.emit('meet-q', { lat: S.lat, fps: S.fps }); }
}

function tick() {
  const c = $('#mtClock'); if (c && S.meeting) c.textContent = fmtClock(Date.now() - S.meeting.startedAt);
  const grid = $('#mtGrid'); if (!grid) return;
  const self = grid.querySelector('.mt-tile.self');
  const now = Date.now();
  if (!S.muted && S.selfLevel && S.selfLevel() > 0.04) S.selfLoud = now;
  if (self) self.classList.toggle('speaking', !S.muted && now - (S.selfLoud || 0) < 600);
  S.people.forEach(p => {
    if (!p.muted && p.level && p.level() > 0.02) p.loud = now;
    const t = grid.querySelector(`.mt-tile[data-pid="${p.pid}"]`);
    if (t) t.classList.toggle('speaking', !p.muted && now - (p.loud || 0) < 600);
  });
}

export default {
  async render(r, { match }) {
    root = r;
    const id = match[1];
    if (S.id && S.id !== id) leave(true);
    if (!id) { S.id = null; return renderCreate(); }
    if (S.id === id && !S.ended && S.engine) { renderRoom(); return; }
    S.id = id; S.ended = false;
    await renderLobby(id);
  },
  destroy() { if (S.id && !S.ended) leave(true); removeChrome(); root = null; }
};
