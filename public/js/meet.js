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
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const initials = (n) => (String(n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?').toUpperCase();
const hue = (pid) => { let h = 0; for (const c of String(pid)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const emitAck = (socket, ev, data, ms = 10000) => new Promise((res) => socket.timeout(ms).emit(ev, data, (err, r) => res(err ? { error: 'Le serveur ne répond pas. Vérifiez votre connexion.' } : r)));
const linkOf = (id) => location.origin + '/reunion/' + id;

/* Réactions (autocollants) ; les mains et pouces prennent la couleur de peau choisie */
const REACTS = [['hand', '✋', 1, 'Main levée'], ['ok', '👍', 1, 'D\'accord'], ['yes', '✅', 0, 'Oui'], ['no', '👎', 1, 'Non'], ['clap', '👏', 1, 'Bravo'], ['thanks', '🙏', 1, 'Merci'], ['love', '❤️', 0, 'J\'aime'], ['laugh', '😂', 0, 'Rire'], ['wow', '😮', 0, 'Surpris'], ['q', '❓', 0, 'Question']];
const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const emo = (k, t) => { const r = REACTS.find(x => x[0] === k); return r ? r[1] + (r[2] ? TONES[t] || '' : '') : ''; };
const myTone = () => Math.max(0, Math.min(5, +ls.get('tx_meet_tone', 0) || 0));

let iceCfg = null;
async function getIce() {
  if (iceCfg && Date.now() - iceCfg.at < (iceCfg.ttl || 1200) * 1000) return iceCfg;
  try { const j = await (await fetch('/api/ice-config', { cache: 'no-store' })).json(); iceCfg = Object.assign(j, { at: Date.now() }); }
  catch (e) { iceCfg = iceCfg || { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] }; }
  return iceCfg;
}

/* ======================================================================
   MOTEUR « MESH » : une connexion par participant, 3 pistes fixes
   (0 = micro, 1 = caméra, 2 = écran) : couper / rallumer = replaceTrack, sans renégociation
   ====================================================================== */
const KIND_AT = ['a', 'c', 's'];
class Mesh {
  constructor(h) { this.h = h; this.pcs = new Map(); }
  async pcFor(pid, initiator) {
    let x = this.pcs.get(pid); if (x) return x;
    const cfg = await getIce();
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, bundlePolicy: 'max-bundle' });
    x = { pc, initiator, pending: [] };
    this.pcs.set(pid, x);
    pc.onicecandidate = (e) => { if (e.candidate) this.h.signal(pid, { cand: e.candidate }); };
    pc.ontrack = (e) => { const i = pc.getTransceivers().indexOf(e.transceiver); if (i >= 0 && i < 3) this.h.onTrack(pid, KIND_AT[i], e.track, e.receiver); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && initiator) { try { pc.restartIce(); this.offer(pid); } catch (e) { /* ignore */ } }
      this.h.onLink(pid, pc.connectionState);
    };
    if (initiator) {
      ['audio', 'video', 'video'].forEach((k, i) => { const t = pc.addTransceiver(k, { direction: 'sendrecv' }); t.sender.replaceTrack(this.h.local(KIND_AT[i])).catch(() => {}); });
    }
    return x;
  }
  async offer(pid) {
    const x = this.pcs.get(pid); if (!x) return;
    await x.pc.setLocalDescription(await x.pc.createOffer());
    this.h.signal(pid, { sdp: x.pc.localDescription });
  }
  async addPeer(pid) { await this.pcFor(pid, true); await this.offer(pid); }
  async onSignal(from, data) {
    if (data.sdp && data.sdp.type === 'offer') {
      const x = await this.pcFor(from, false);
      await x.pc.setRemoteDescription(data.sdp);
      x.pc.getTransceivers().forEach((t, i) => { try { t.direction = 'sendrecv'; } catch (e) { /* ignore */ } if (i < 3) t.sender.replaceTrack(this.h.local(KIND_AT[i])).catch(() => {}); });
      await x.pc.setLocalDescription(await x.pc.createAnswer());
      this.h.signal(from, { sdp: x.pc.localDescription });
      x.pending.splice(0).forEach(c => x.pc.addIceCandidate(c).catch(() => {}));
    } else if (data.sdp && data.sdp.type === 'answer') {
      const x = this.pcs.get(from); if (!x) return;
      await x.pc.setRemoteDescription(data.sdp).catch(() => {});
      x.pending.splice(0).forEach(c => x.pc.addIceCandidate(c).catch(() => {}));
    } else if (data.cand) {
      const x = this.pcs.get(from) || await this.pcFor(from, false);
      if (x.pc.remoteDescription) x.pc.addIceCandidate(data.cand).catch(() => {}); else x.pending.push(data.cand);
    }
  }
  setTrack(kind, track) {
    const i = KIND_AT.indexOf(kind);
    this.pcs.forEach(x => { const t = x.pc.getTransceivers()[i]; if (t) t.sender.replaceTrack(track).catch(() => {}); });
  }
  sync() { /* rien à faire : les pistes arrivent d'elles-mêmes */ }
  removePeer(pid) { const x = this.pcs.get(pid); if (x) { try { x.pc.close(); } catch (e) { /* ignore */ } this.pcs.delete(pid); } }
  close() { [...this.pcs.keys()].forEach(p => this.removePeer(p)); }
}

/* ======================================================================
   MOTEUR « SFU » : une seule connexion vers Cloudflare Realtime ;
   on y envoie ses pistes, on récupère celles des autres (relais par notre serveur)
   ====================================================================== */
class Sfu {
  constructor(h) { this.h = h; this.q = Promise.resolve(); this.mids = new Map(); this.pulled = new Map(); this.local = {}; this.pc = null; }
  run(fn) { const p = this.q.then(fn).catch((e) => { console.warn('sfu', e); this.h.error(e.message || 'Le serveur audio ne répond pas.'); }); this.q = p; return p; }
  call(body) { return api(`/api/meet/${S.id}/sfu`, { method: 'POST', body, headers: { 'X-Meet-Token': S.token } }); }
  async start() {
    const cfg = await getIce();
    this.pc = new RTCPeerConnection({ iceServers: cfg.iceServers, bundlePolicy: 'max-bundle' });
    this.pc.ontrack = (e) => { const m = this.mids.get(e.transceiver.mid); if (m) this.h.onTrack(m.pid, m.kind, e.track, e.receiver); };
    this.pc.onconnectionstatechange = () => this.h.onLink('sfu', this.pc.connectionState);
    await this.run(() => this.push('a', this.h.local('a')));
  }
  async push(kind, trackObj) {
    const t = this.pc.addTransceiver(trackObj, { direction: 'sendonly' });
    this.local[kind] = t;
    await this.pc.setLocalDescription(await this.pc.createOffer());
    const r = await this.call({ op: 'push', sessionDescription: { type: 'offer', sdp: this.pc.localDescription.sdp }, tracks: [{ kind, mid: t.mid }] });
    await this.pc.setRemoteDescription(r.sessionDescription);
  }
  setTrack(kind, trackObj) {
    if (this.local[kind]) this.local[kind].sender.replaceTrack(trackObj).catch(() => {});
    else if (trackObj) this.run(() => this.push(kind, trackObj));
  }
  sync(people) {
    const want = [];
    people.forEach(p => (p.tracks || []).forEach(k => { const key = p.pid + '-' + k; if (!this.pulled.has(key)) { this.pulled.set(key, null); want.push({ pid: p.pid, kind: k }); } }));
    if (!want.length) return;
    this.run(async () => {
      const r = await this.call({ op: 'pull', tracks: want });
      (r.tracks || []).forEach(t => { if (t.mid && !t.error) { this.mids.set(t.mid, { pid: t.pid, kind: t.kind }); this.pulled.set(t.pid + '-' + t.kind, t.mid); } else this.pulled.delete(t.pid + '-' + t.kind); });
      if (r.requiresImmediateRenegotiation && r.sessionDescription) {
        await this.pc.setRemoteDescription(r.sessionDescription);
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.call({ op: 'renegotiate', sessionDescription: { type: 'answer', sdp: this.pc.localDescription.sdp } });
      }
    });
  }
  removePeer(pid) {
    const mids = [];
    for (const [k, mid] of this.pulled) if (k.startsWith(pid + '-')) { if (mid) mids.push(mid); this.pulled.delete(k); }
    mids.forEach(m => this.mids.delete(m));
    if (mids.length) this.run(() => this.call({ op: 'close', mids }));
  }
  close() { try { this.pc && this.pc.close(); } catch (e) { /* ignore */ } }
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
      <h2>Réunion audio ou vidéo</h2>
      <p class="muted">Sans inscription. Partagez un lien ou un code à 6 chiffres, chacun rejoint en un appui.</p>
    </div>
    <form id="mtForm" class="stack" style="margin-top:16px" autocomplete="off">
      <label class="field"><span>Sujet de la réunion</span><input class="input" id="mtTitle" maxlength="80" placeholder="Ex. : Point de l'équipe pédagogique"></label>
      <label class="field"><span>Votre prénom</span><input class="input" id="mtName" maxlength="30" value="${esc(name)}" placeholder="Votre prénom" required></label>
      <div class="field"><span>Format</span>
        <div class="seg mt-kind" role="radiogroup" aria-label="Format de la réunion">
          <button type="button" class="active" data-kind="audio" role="radio" aria-checked="true">${icon('mic')}<span><b>Audio</b><small>Léger, idéal en 4G</small></span></button>
          <button type="button" data-kind="video" role="radio" aria-checked="false">${icon('video')}<span><b>Vidéo</b><small>Caméra et présentations</small></span></button>
        </div></div>
      <button class="btn primary xl block" type="submit" id="mtGo">${icon('call')}Lancer la réunion</button>
      <button class="btn danger block" type="button" id="mtUrgent">${icon('bell')}Réunion d'urgence</button>
      <p class="small faint center">Invité à une réunion ? Ouvrez le lien reçu, ou tapez le code dans <a href="/recevoir" data-link>Recevoir</a>.</p>
    </form>
  </div></section>`;
  let kind = 'audio';
  $$('.mt-kind button', root).forEach(b => b.onclick = () => { kind = b.dataset.kind; $$('.mt-kind button', root).forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', x === b); }); });
  const go = async (emergency) => {
    const nm = $('#mtName', root).value.trim();
    if (!nm) { toast('Indiquez votre prénom', 'warn'); $('#mtName', root).focus(); return; }
    ls.set('tx_meet_name', nm);
    const btn = emergency ? $('#mtUrgent', root) : $('#mtGo', root); btn.disabled = true;
    const socket = await getSocket();
    const r = await emitAck(socket, 'meet-create', { title: $('#mtTitle', root).value.trim(), kind: emergency ? 'audio' : kind, emergency });
    btn.disabled = false;
    if (!r || r.error) return toast((r && r.error) || 'Impossible de créer la réunion.', 'error');
    ls.set('tx_meet_host_' + r.id, r.hostKey);
    track('use', { m: 'meet' });
    S.autoJoin = true; S.urgent = !!emergency;
    navigate('/reunion/' + r.id);
  };
  $('#mtForm', root).onsubmit = (e) => { e.preventDefault(); go(false); };
  $('#mtUrgent', root).onclick = () => go(true);
}

async function renderLobby(id) {
  root.innerHTML = `<section class="narrow"><div class="card"><p class="muted"><span class="spinner"></span> Connexion à la réunion…</p></div></section>`;
  const socket = await getSocket();
  const peek = await emitAck(socket, 'meet-peek', { id });
  if (!root) return;
  if (peek.error) {
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
      <span class="pill ${m.kind === 'video' ? 'violet' : 'info'}">${icon(m.kind === 'video' ? 'video' : 'mic')}${m.kind === 'video' ? 'Vidéo' : 'Audio'}</span>
      <span class="pill">${icon('users')}${peek.count} présent${peek.count > 1 ? 's' : ''}</span>
      ${m.emergency ? `<span class="pill bad">${icon('bell')}Urgent</span>` : ''}${m.recording ? `<span class="pill bad">${icon('rec')}Enregistrée</span>` : ''}${m.locked ? `<span class="pill warn">${icon('lock')}Verrouillée</span>` : ''}
    </div>
    <form id="lbForm" class="stack" style="width:100%;max-width:360px;margin-top:8px" autocomplete="off">
      <input class="input" id="lbName" maxlength="30" placeholder="Votre prénom" value="${esc(ls.get('tx_meet_name', '') || ls.get('tx_rc_name', ''))}" aria-label="Votre prénom" required>
      <button class="btn primary xl block" type="submit">${icon('call')}${host ? 'Reprendre la réunion' : 'Rejoindre'}</button>
      <p class="small faint">Votre micro sera coupé à l'arrivée. Vous l'activez quand vous voulez parler.</p>
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
  catch (e) { toast('Micro non autorisé : vous pourrez écouter, mais pas parler. Autorisez le micro dans le navigateur pour prendre la parole.', 'warn', { duration: 9000 }); }
  if (!root) { if (mic) mic.stop(); return; }
  if (mic) mic.enabled = false;
  Object.assign(S, { id, name, mic, micOk: !!mic, placeholder: mic ? null : silentTrack(), cam: null, screen: null, people: new Map(), muted: true, hand: false, camOn: false, sharing: false, panel: false, ended: false });
  await connect();
}

async function connect() {
  const socket = await getSocket();
  S.socket = socket;
  bindSocket(socket);
  const r = await emitAck(socket, 'meet-join', { id: S.id, name: S.name, hostKey: hostKeyOf(S.id), tone: myTone() });
  if (!root) return;
  if (!r || r.error) { stopLocal(); return renderEnd((r && r.error) || 'Impossible de rejoindre la réunion.', true); }
  Object.assign(S, { self: r.self, token: r.token, meeting: r.meeting });
  S.people.clear();
  r.people.forEach(p => S.people.set(p.pid, Object.assign({ streams: {} }, p)));
  const h = {
    local: (k) => (k === 'a' ? (S.mic || S.placeholder) : k === 'c' ? S.cam : S.screen),
    signal: (to, data) => socket.emit('meet-signal', { to, data }),
    onTrack, onLink, error: (msg) => toast(msg, 'error')
  };
  S.engine = r.meeting.engine === 'sfu' ? new Sfu(h) : new Mesh(h);
  renderRoom();
  keepAwake(true);
  if (S.engine instanceof Sfu) { await S.engine.start(); S.engine.sync([...S.people.values()]); }
  else for (const pid of S.people.keys()) S.engine.addPeer(pid).catch(e => console.warn('peer', e));
  if (S.urgent) { S.urgent = false; setTimeout(() => invite(true), 400); }
  if (!S.ticker) S.ticker = setInterval(tick, 100);
}

function bindSocket(socket) {
  if (S.bound === socket) return;
  S.bound = socket;
  const mine = () => !!S.id && !S.ended;
  socket.on('meet-joined', (p) => { if (!mine()) return; S.people.set(p.pid, Object.assign({ streams: {} }, p)); drawPeople(); toast(p.name + ' a rejoint la réunion', 'info', { duration: 2500 }); });
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
    if (S.self && p.pid === S.self.pid) { S.self = Object.assign(S.self, p); if (!p.hand && S.hand) { S.hand = false; drawBar(); } drawPeople(); return; }
    const cur = S.people.get(p.pid); if (!cur) return;
    const raised = !cur.hand && p.hand;
    Object.assign(cur, p);
    if (S.engine && S.engine.sync) S.engine.sync([cur]);
    if (raised) toast('✋ ' + cur.name + ' lève la main', 'info', { duration: 3500 });
    drawPeople();
  });
  socket.on('meet-signal', ({ from, data }) => { if (mine() && S.engine instanceof Mesh) S.engine.onSignal(from, data).catch(e => console.warn('signal', e)); });
  socket.on('meet-force', ({ action, by }) => {
    if (!mine()) return;
    if (action === 'mute' && !S.muted) { setMuted(true); toast(by + ' a coupé votre micro', 'info'); }
    if (action === 'remove') { leave(false); renderEnd('L\'organisateur vous a retiré de la réunion.'); }
  });
  socket.on('meet-info', (m) => {
    if (!mine()) return;
    const wasRec = S.meeting.recording;
    S.meeting = Object.assign(S.meeting, m); drawTop();
    if (m.recording && !wasRec && !(S.self && S.self.host)) toast('🔴 L\'organisateur enregistre la réunion', 'warn', { duration: 6000 });
  });
  socket.on('meet-react', ({ pid, r, t }) => { if (mine()) showReact(pid, r, t); });
  socket.on('meet-ended', ({ reason }) => { if (!mine()) return; leave(false); renderEnd(reason === 'expired' ? 'La réunion est terminée.' : reason); });
  // Coupure réseau : on rejoint automatiquement avec les mêmes réglages
  socket.on('connect', () => {
    if (!mine() || !S.engine) return;
    S.engine.close(); S.engine = null;
    S.people.forEach(p => p.audioEl && p.audioEl.remove());
    toast('Connexion rétablie, reprise de la réunion…', 'info', { duration: 2500 });
    connect().then(() => {
      if (!S.engine) return;
      sendState({ muted: S.muted, cam: S.camOn, screen: S.sharing, hand: S.hand });
      if (S.cam) S.engine.setTrack('c', S.cam);
      if (S.screen) S.engine.setTrack('s', S.screen);
    });
  });
}

function onTrack(pid, kind, trackObj, receiver) {
  const p = S.people.get(pid); if (!p) return;
  p.streams[kind] = new MediaStream([trackObj]);
  if (kind === 'a') {
    if (!p.audioEl) { p.audioEl = document.createElement('audio'); p.audioEl.autoplay = true; p.audioEl.setAttribute('playsinline', ''); $('#mtAudios').appendChild(p.audioEl); }
    p.audioEl.srcObject = p.streams.a; p.audioEl.play().catch(() => { S.needTap = true; drawTop(); });
    // Niveau de voix lu directement sur la réception WebRTC (fiable, sans traitement audio)
    recAdd(pid, trackObj);
    p.level = receiver && receiver.getSynchronizationSources ? () => { const s = receiver.getSynchronizationSources()[0]; return s && Date.now() - s.timestamp < 1000 ? (s.audioLevel || 0) : 0; } : meter(trackObj);
  }
  drawPeople();
}
function onLink(pid, state) { const p = S.people.get(pid); if (p) { p.link = state; drawPeople(); } }

function sendState(s) { S.socket && S.socket.emit('meet-state', s); }
function setMuted(m, silent) {
  if (!S.mic && !m) { toast('Autorisez le micro dans le navigateur pour prendre la parole', 'warn'); return; }
  S.muted = m; if (S.mic) S.mic.enabled = !m;
  if (!silent) sendState({ muted: m });
  if (!m && S.mic && !S.selfLevel) S.selfLevel = meter(S.mic);
  drawBar(); drawPeople();
}
async function toggleCam() {
  if (S.camOn) { S.cam && S.cam.stop(); S.cam = null; S.camOn = false; S.engine.setTrack('c', null); sendState({ cam: false }); }
  else {
    try { S.cam = (await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, facingMode: 'user' } })).getVideoTracks()[0]; }
    catch (e) { return toast('Caméra non autorisée ou indisponible.', 'warn'); }
    S.camOn = true; S.engine.setTrack('c', S.cam); sendState({ cam: true });
  }
  drawBar(); drawPeople();
}
async function toggleScreen() {
  if (S.sharing) { stopScreen(); return; }
  try { S.screen = (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10 } }, audio: false })).getVideoTracks()[0]; }
  catch (e) { return; }
  try { S.screen.contentHint = 'detail'; } catch (e) { /* ignore */ }
  S.screen.onended = stopScreen;
  S.sharing = true; S.engine.setTrack('s', S.screen); sendState({ screen: true });
  drawBar(); drawPeople();
}
function stopScreen() { if (!S.sharing) return; S.screen && S.screen.stop(); S.screen = null; S.sharing = false; S.engine && S.engine.setTrack('s', null); sendState({ screen: false }); drawBar(); drawPeople(); }
function toggleHand() { S.hand = !S.hand; sendState({ hand: S.hand }); drawBar(); }

function removeChrome() { ['mtBar', 'mtPanel', 'mtReact'].forEach(i => { const e = document.getElementById(i); if (e) e.remove(); }); document.body.classList.remove('in-meet'); }
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
  keepAwake(false);
  removeChrome();
}

function renderEnd(msg, bad) {
  removeChrome();
  if (!root) return;
  const id = S.id;
  root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon ${bad ? 'bad' : 'info'}">${icon(bad ? 'x' : 'call')}</div><h2>${bad ? 'Impossible de rejoindre' : 'Vous avez quitté la réunion'}</h2><p class="muted">${esc(msg || '')}</p>
    ${R.url ? `<button type="button" class="btn primary block" id="recAgain" style="margin-bottom:8px">${icon('download')}Télécharger l'enregistrement (${bytes(R.size)})</button>` : ''}
    <div class="row wrap" style="justify-content:center">${id && !bad ? `<a class="btn" href="/reunion/${esc(id)}" data-link>${icon('refresh')}Rejoindre à nouveau</a>` : ''}<a class="btn primary" href="/reunion" data-link>${icon('call')}Nouvelle réunion</a></div></div></div></section>`;
  document.title = 'Réunion · Lestha Send';
  const ra = $('#recAgain'); if (ra) ra.onclick = saveRec;
}

function renderRoom() {
  const m = S.meeting;
  document.title = m.title + ' · Réunion';
  root.innerHTML = `
  <section class="meet ${m.kind === 'video' ? 'is-video' : 'is-audio'}">
    <header class="meet-top" id="mtTop"></header>
    <div class="meet-stage hidden" id="mtStage"><video id="mtStageV" autoplay playsinline muted></video><span class="meet-stage-l" id="mtStageL"></span></div>
    <div class="meet-grid" id="mtGrid"></div>
    <div id="mtAudios" hidden></div>
  </section>`;
  // Barre et panneau fixés à l'écran : placés directement dans la page (hors du conteneur animé)
  removeChrome();
  const bar = document.createElement('footer'); bar.className = 'meet-bar'; bar.id = 'mtBar'; bar.setAttribute('aria-label', 'Commandes de la réunion');
  const panel = document.createElement('aside'); panel.className = 'meet-panel card hidden'; panel.id = 'mtPanel';
  document.body.append(panel, bar); document.body.classList.add('in-meet');
  drawTop(); drawBar(); drawPeople();
}

function drawTop() {
  const el = $('#mtTop'); if (!el) return;
  const m = S.meeting, n = S.people.size + 1;
  el.innerHTML = `
    <svg class="meet-logo" aria-hidden="true"><use href="#i-logo"/></svg>
    <div class="meet-title"><b>${esc(m.title)}</b><span class="small muted"><span id="mtClock">${fmtClock(Date.now() - m.startedAt)}</span> · ${n} participant${n > 1 ? 's' : ''}${m.locked ? ' · 🔒 verrouillée' : ''}</span></div>
    ${m.recording ? `<span class="pill bad meet-rec"><i></i>Enregistrement</span>` : ''}
    ${S.needTap ? `<button type="button" class="btn sm primary" id="mtTap">${icon('play', 'sm')}Activer le son</button>` : ''}
    <button type="button" class="btn sm" id="mtInvite">${icon('share', 'sm')}Inviter</button>`;
  $('#mtInvite').onclick = () => invite(false);
  const tap = $('#mtTap'); if (tap) tap.onclick = () => { S.needTap = false; audioCtx(); S.people.forEach(p => p.audioEl && p.audioEl.play().catch(() => {})); drawTop(); };
}

function drawBar() {
  const el = $('#mtBar'); if (!el) return;
  const video = S.meeting.kind === 'video';
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMobile;
  const hands = [...S.people.values()].filter(p => p.hand).length;
  el.innerHTML = `
    <button type="button" class="mb ${S.muted ? 'off' : 'on'}" id="bMic" aria-pressed="${!S.muted}">${icon(S.muted ? 'mic-off' : 'mic')}<span>${S.muted ? 'Micro coupé' : 'Micro ouvert'}</span></button>
    ${video ? `<button type="button" class="mb ${S.camOn ? 'on' : 'off'}" id="bCam" aria-pressed="${S.camOn}">${icon('video')}<span>${S.camOn ? 'Caméra' : 'Caméra coupée'}</span></button>` : ''}
    ${canShare ? `<button type="button" class="mb ${S.sharing ? 'on' : ''}" id="bScr" aria-pressed="${S.sharing}">${icon('screen')}<span>${S.sharing ? 'Arrêter' : 'Présenter'}</span></button>` : ''}
    <button type="button" class="mb ${S.hand ? 'hand' : ''}" id="bHand" aria-pressed="${S.hand}"><b class="mb-emo">${emo('hand', myTone())}</b><span>${S.hand ? 'Baisser' : 'Lever la main'}</span></button>
    <button type="button" class="mb" id="bReact" aria-haspopup="true">${'<b class="mb-emo">' + emo('ok', myTone()) + '</b>'}<span>Réagir</span></button>
    ${S.self && S.self.host ? `<button type="button" class="mb ${R.on ? 'rec' : ''}" id="bRec" aria-pressed="${R.on}">${icon('rec')}<span>${R.on ? 'Arrêter ' + fmtClock(Date.now() - R.t0) : 'Enregistrer'}</span></button>` : ''}
    <button type="button" class="mb" id="bPpl" aria-pressed="${S.panel}">${icon('users')}<span>Participants</span>${hands ? `<em class="mb-badge">${hands}</em>` : ''}</button>
    <button type="button" class="mb leave" id="bLeave">${icon('call-end')}<span>Quitter</span></button>`;
  $('#bMic').onclick = () => setMuted(!S.muted);
  if ($('#bCam')) $('#bCam').onclick = toggleCam;
  if ($('#bScr')) $('#bScr').onclick = toggleScreen;
  $('#bHand').onclick = toggleHand;
  $('#bReact').onclick = toggleReactions;
  if ($('#bRec')) $('#bRec').onclick = () => (R.on ? recStop() : recStart());
  $('#bPpl').onclick = () => { S.panel = !S.panel; drawPeople(); drawBar(); };
  $('#bLeave').onclick = async () => {
    if (S.self && S.self.host) {
      const r = await modal({ title: 'Quitter la réunion', body: '<p class="muted">Vous êtes l\'organisateur. Les autres peuvent continuer sans vous, ou vous pouvez terminer la réunion pour tout le monde.</p>', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Quitter', value: 'leave' }, { label: 'Terminer pour tous', cls: 'danger', value: 'end' }] });
      if (!r) return;
      if (r === 'end') S.socket.emit('meet-host', { action: 'end' });
    }
    leave(true); renderEnd('Merci d\'avoir participé.');
  };
}

function handOrder() {
  const all = [...S.people.values()]; if (S.self) all.push(Object.assign({}, S.self, { hand: S.hand ? (S.self.hand || 1) : 0 }));
  return all.filter(p => p.hand).sort((a, b) => a.hand - b.hand).map(p => p.pid);
}

function drawPeople() {
  const grid = $('#mtGrid'); if (!grid || !S.self) return;
  const order = handOrder();
  const me = Object.assign({}, S.self, { name: S.name, muted: S.muted, cam: S.camOn });
  const list = [...S.people.values()];
  const keep = new Set([me.pid, ...list.map(p => p.pid)]);
  grid.querySelectorAll('.mt-tile').forEach(t => { if (!keep.has(t.dataset.pid)) t.remove(); });
  [me, ...list].forEach((p, i) => {
    const self = i === 0;
    let t = grid.querySelector(`.mt-tile[data-pid="${p.pid}"]`);
    if (!t) {
      t = document.createElement('div'); t.className = 'mt-tile'; t.dataset.pid = p.pid; t.style.setProperty('--h', hue(p.pid));
      t.innerHTML = '<video class="mt-v" autoplay playsinline muted></video><div class="mt-av"></div><div class="mt-name"></div><div class="mt-hand"></div><div class="mt-warn"></div>';
      if (self) grid.prepend(t); else grid.appendChild(t);
    }
    const video = S.meeting.kind === 'video' && p.cam;
    t.classList.toggle('self', self);
    t.classList.toggle('has-video', !!video);
    t.querySelector('.mt-av').textContent = initials(p.name);
    t.querySelector('.mt-name').innerHTML = (p.muted ? `<span class="mt-mute">${icon('mic-off', 'sm')}</span>` : '') + esc(p.name) + (self ? ' (vous)' : '') + (p.host ? ' · organisateur' : '');
    const n = order.indexOf(p.pid) + 1, hd = t.querySelector('.mt-hand');
    hd.textContent = n ? emo('hand', self ? myTone() : p.tone || 0) + ' ' + n : ''; hd.hidden = !n;
    const w = t.querySelector('.mt-warn'); const bad = !self && p.link && /failed|disconnected/.test(p.link);
    w.textContent = bad ? 'reconnexion…' : ''; w.hidden = !bad;
    const v = t.querySelector('video');
    const want = video ? (self ? S.cam : p.streams.c && p.streams.c.getVideoTracks()[0]) : null;
    const cur = v.srcObject && v.srcObject.getVideoTracks()[0];
    if (want && cur !== want) v.srcObject = self ? new MediaStream([S.cam]) : p.streams.c;
    else if (!want && v.srcObject) v.srcObject = null;
  });
  grid.dataset.n = String(Math.min(list.length + 1, 9));
  grid.classList.toggle('dense', list.length + 1 > 6);
  grid.classList.toggle('xdense', list.length + 1 > 15);
  // présentation
  const sharer = S.sharing ? null : list.find(p => p.screen && p.streams.s);
  const stage = $('#mtStage');
  if (stage) {
    stage.classList.toggle('hidden', !sharer && !S.sharing);
    const v = $('#mtStageV');
    const want = sharer ? sharer.streams.s : S.sharing && S.screen ? S.screen : null;
    const cur = v.srcObject && v.srcObject.getVideoTracks()[0];
    const wantTrack = want instanceof MediaStream ? want.getVideoTracks()[0] : want;
    if (wantTrack && cur !== wantTrack) v.srcObject = want instanceof MediaStream ? want : new MediaStream([want]);
    else if (!wantTrack) v.srcObject = null;
    $('#mtStageL').textContent = sharer ? sharer.name + ' présente' : S.sharing ? 'Vous présentez votre écran' : '';
  }
  drawPanel(); drawTop(); drawBarBadge();
}
function drawBarBadge() {
  const b = $('#bPpl'); if (!b) return;
  const hands = [...S.people.values()].filter(p => p.hand).length;
  let em = b.querySelector('.mb-badge');
  if (hands && !em) { em = document.createElement('em'); em.className = 'mb-badge'; b.appendChild(em); }
  if (em) { if (hands) em.textContent = hands; else em.remove(); }
}

function drawPanel() {
  const el = $('#mtPanel'); if (!el) return;
  el.classList.toggle('hidden', !S.panel);
  if (!S.panel) return;
  const host = S.self && S.self.host;
  const order = handOrder();
  const all = [Object.assign({}, S.self, { name: S.name, muted: S.muted, me: true })].concat([...S.people.values()]);
  all.sort((a, b) => { const ia = order.indexOf(a.pid), ib = order.indexOf(b.pid); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
  el.innerHTML = `
    <div class="card-title"><h3>${icon('users')}Participants (${all.length})</h3><span class="row" style="gap:6px"><button type="button" class="btn sm" id="pInvite">${icon('share', 'sm')}Inviter</button><button type="button" class="icon-btn" id="pClose" aria-label="Fermer">${icon('x')}</button></span></div>
    ${host ? `<div class="row wrap" style="gap:6px;margin-bottom:10px">
      <button type="button" class="btn sm" data-host="muteAll">${icon('mic-off', 'sm')}Couper tous les micros</button>
      <button type="button" class="btn sm" data-host="${S.meeting.locked ? 'unlock' : 'lock'}">${icon(S.meeting.locked ? 'unlock' : 'lock', 'sm')}${S.meeting.locked ? 'Déverrouiller' : 'Verrouiller'}</button>
      <button type="button" class="btn sm danger" data-host="end">${icon('call-end', 'sm')}Terminer pour tous</button></div>` : ''}
    <div class="stack" style="gap:6px">${all.map(p => {
      const n = order.indexOf(p.pid) + 1;
      return `<div class="mt-row" data-pid="${esc(p.pid)}"><span class="mt-dot" style="--h:${hue(p.pid)}">${esc(initials(p.name))}</span>
        <span class="mt-rn">${esc(p.name)}${p.me ? ' (vous)' : ''}${p.host ? ' <small class="muted">organisateur</small>' : ''}</span>
        ${n ? `<span class="pill warn" style="flex:none">✋ ${n}</span>` : ''}
        <span class="mt-ic">${icon(p.muted ? 'mic-off' : 'mic', 'sm')}</span>
        ${host && !p.me ? `<span class="mt-act">${!p.muted ? `<button type="button" class="btn sm ghost" data-act="mute" title="Couper son micro">${icon('mic-off', 'sm')}</button>` : ''}${p.hand ? `<button type="button" class="btn sm ghost" data-act="lower" title="Baisser sa main">${icon('hand', 'sm')}</button>` : ''}${!p.host ? `<button type="button" class="btn sm ghost" data-act="remove" title="Retirer de la réunion">${icon('x', 'sm')}</button>` : ''}</span>` : ''}
      </div>`; }).join('')}</div>
    <p class="small faint" style="margin-top:10px">${S.meeting.engine === 'sfu' ? 'Jusqu\'à ' + S.meeting.max + ' participants.' : 'Jusqu\'à ' + S.meeting.max + ' participants en ' + (S.meeting.kind === 'video' ? 'vidéo' : 'audio') + '.'} Rien n'est enregistré.</p>`;
  $('#pClose').onclick = () => { S.panel = false; drawPanel(); drawBar(); };
  $('#pInvite').onclick = () => invite(false);
  el.querySelectorAll('[data-host]').forEach(b => b.onclick = async () => {
    const a = b.dataset.host;
    if (a === 'end' && !(await confirmDialog('Terminer la réunion ?', 'Tout le monde sera déconnecté.', 'Terminer', true))) return;
    S.socket.emit('meet-host', { action: a });
    if (a === 'muteAll') toast('Micros coupés', 'success');
  });
  el.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const pid = b.closest('[data-pid]').dataset.pid, a = b.dataset.act;
    if (a === 'remove') { const p = S.people.get(pid); if (!(await confirmDialog('Retirer ' + (p ? p.name : 'ce participant') + ' ?', 'Il sera déconnecté de la réunion.', 'Retirer', true))) return; }
    S.socket.emit('meet-host', { action: a, pid });
  });
}

async function invite(urgent) {
  const link = linkOf(S.id), code = S.meeting.code;
  const pretty = code ? code.slice(0, 3) + ' ' + code.slice(3) : '';
  const text = (urgent || S.meeting.emergency ? '🚨 Réunion urgente : ' : '📞 ') + S.meeting.title + '\nRejoignez maintenant : ' + link + (code ? '\nou tapez le code ' + pretty + ' dans « Recevoir » sur Lestha Send' : '');
  if (urgent) { shareTo('whatsapp', { link, text: text.replace('\nRejoignez maintenant : ' + link, '\nRejoignez maintenant') }); return; }
  await modal({
    title: 'Inviter à la réunion', wide: false,
    body: `<div class="stack">
      <div class="link-box"><input readonly value="${esc(link)}" aria-label="Lien de la réunion"><button type="button" class="btn primary sm" id="ivCopy">${icon('copy', 'sm')}Copier</button></div>
      ${code ? `<div class="rx-codebox"><span class="small muted">ou le code, à taper dans <b>Recevoir</b></span><b class="rx-code-v">${pretty}</b></div>` : ''}
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
  const tileEl = document.querySelector(`#mtGrid .mt-tile[data-pid="${pid}"]`); if (!tileEl) return;
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
  try { const s = R.ac.createMediaStreamSource(new MediaStream([trackObj])); s.connect(R.dest); R.srcs.set(key, s); } catch (e) { /* ignore */ }
}
async function recStart() {
  if (!window.MediaRecorder) return toast('Ce navigateur ne permet pas d\'enregistrer. Utilisez Chrome ou Edge sur ordinateur.', 'warn');
  if (!(await confirmDialog('Enregistrer la réunion ?', 'Tous les participants verront qu\'un enregistrement est en cours. Le fichier sera enregistré sur votre appareil, pas sur nos serveurs.', 'Démarrer l\'enregistrement'))) return;
  const ac = audioCtx(); if (!ac) return toast('Enregistrement impossible sur cet appareil.', 'error');
  Object.assign(R, { ac, dest: ac.createMediaStreamDestination(), srcs: new Map(), on: true, chunks: [], t0: Date.now() });
  recAdd('self', S.mic);
  S.people.forEach(p => p.streams.a && recAdd(p.pid, p.streams.a.getAudioTracks()[0]));
  let video = S.meeting.kind === 'video' || S.sharing || [...S.people.values()].some(p => p.screen);
  let stream = R.dest.stream;
  if (video && HTMLCanvasElement.prototype.captureStream) {
    R.cv = document.createElement('canvas'); R.cv.width = 1280; R.cv.height = 720; R.cx = R.cv.getContext('2d');
    R.draw = setInterval(recDraw, 1000 / 15);
    stream = new MediaStream([...R.cv.captureStream(15).getVideoTracks(), ...R.dest.stream.getAudioTracks()]);
  } else video = false;
  const mime = pickMime(video);
  try { R.mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000, videoBitsPerSecond: 900000 } : undefined); }
  catch (e) { R.on = false; clearInterval(R.draw); return toast('Enregistrement impossible sur cet appareil.', 'error'); }
  R.mime = R.mr.mimeType || mime; R.video = video;
  R.mr.ondataavailable = (e) => { if (e.data && e.data.size) R.chunks.push(e.data); };
  R.mr.onstop = recDone;
  R.mr.start(2000);
  S.socket.emit('meet-host', { action: 'rec' });
  R.tick = setInterval(() => { const b = $('#bRec span'); if (b && R.on) b.textContent = 'Arrêter ' + fmtClock(Date.now() - R.t0); }, 1000);
  drawBar();
}
function recStop() {
  if (!R.on) return;
  R.on = false; clearInterval(R.draw); clearInterval(R.tick);
  try { R.mr.stop(); } catch (e) { recDone(); }
  R.srcs.forEach(s => { try { s.disconnect(); } catch (e) { /* ignore */ } });
  if (S.socket) S.socket.emit('meet-host', { action: 'unrec' });
  drawBar();
}
function recDone() {
  const type = R.mime || (R.video ? 'video/webm' : 'audio/webm');
  const blob = new Blob(R.chunks, { type }); R.chunks = [];
  if (!blob.size) return toast('L\'enregistrement est vide.', 'warn');
  const ext = /mp4/.test(type) ? (R.video ? 'mp4' : 'm4a') : /ogg/.test(type) ? 'ogg' : 'webm';
  const title = String((S.meeting && S.meeting.title) || 'Lestha').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Lestha';
  if (R.url) URL.revokeObjectURL(R.url);
  Object.assign(R, { url: URL.createObjectURL(blob), name: 'Reunion-' + title + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.' + ext, size: blob.size });
  saveRec();
  const ra = $('#recAgain'); if (!ra && S.ended && root) renderEnd('Merci d\'avoir participé.');
}
function saveRec() {
  if (!R.url) return;
  const a = document.createElement('a'); a.href = R.url; a.download = R.name; a.rel = 'noopener'; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1500);
  toast('Enregistrement prêt : ' + bytes(R.size), 'success', { action: 'Télécharger encore', onAction: saveRec, duration: 12000 });
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
  const tiles = [...document.querySelectorAll('#mtGrid .mt-tile')];
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
