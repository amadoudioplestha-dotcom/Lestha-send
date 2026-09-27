/* TransferX — « Direct » : salles de diffusion en direct
 *  - lien de plateforme (lecteur officiel YouTube / Facebook / Vimeo / Twitch / Instagram / TikTok)
 *  - caméra, écran ou micro diffusés depuis le navigateur (WebRTC, petits groupes)
 *  - flux .m3u8 (OBS, régie) lu avec hls.js
 * + discussion en direct, compteur de spectateurs, compte à rebours, partage WhatsApp / QR */
import { $, esc, icon, ls, api, toast, getSocket, copyText, shareTo, renderQR, confirmDialog } from './core.js';
import { navigate } from './router.js';

const mine = {
  all: () => ls.get('tx_lives', []),
  get: (id) => mine.all().find(x => x.id === id),
  add: (x) => ls.set('tx_lives', [x].concat(mine.all().filter(y => y.id !== x.id)).slice(0, 50)),
  remove: (id) => ls.set('tx_lives', mine.all().filter(y => y.id !== id))
};
const PROVIDERS = { youtube: 'YouTube', facebook: 'Facebook', vimeo: 'Vimeo', twitch: 'Twitch', instagram: 'Instagram', tiktok: 'TikTok' };
const linkOf = (id) => location.origin + '/live/' + id;
const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
let iceCache = null;
async function ice() {
  if (iceCache) return iceCache;
  try { iceCache = (await (await fetch('/api/ice-config', { cache: 'no-store' })).json()).iceServers; } catch (e) { iceCache = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  return iceCache;
}

/* ============================== 1. Studio : créer un direct ============================== */
export const studioView = (() => {
  let root, kind = 'embed';
  return {
    render(r) { root = r; draw(); },
    destroy() { root = null; }
  };
  function draw() {
    const list = mine.all();
    root.innerHTML = `
    <section class="narrow stack">
      <div class="hero-mini"><span class="eyebrow"><span class="pulse-dot"></span>Direct</span><h1 style="font-size:clamp(26px,5vw,38px)">Diffusez en direct, partagez un lien</h1>
        <p class="muted">Événements, cours, cérémonies : une page de direct à votre nom, avec discussion en direct et QR code à projeter.</p></div>
      <div class="card glow stack">
        <div class="chips" id="kinds">${[['embed', 'Lien YouTube, Facebook…'], ['camera', 'Caméra / écran'], ['hls', 'Flux pro .m3u8']].map(([k, l]) => `<button type="button" class="chip ${kind === k ? 'active' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
        <p class="small muted" id="kindHelp"></p>
        <label class="field ${kind === 'camera' ? 'hidden' : ''}" id="urlField"><span id="urlLabel">Lien</span><input class="input" id="lUrl" placeholder="https://" inputmode="url"></label>
        <div class="grid-2" style="gap:12px">
          <label class="field"><span>Titre *</span><input class="input" id="lTitle" maxlength="120" placeholder="Ex. Cérémonie de remise des diplômes"></label>
          <label class="field"><span>Présenté par</span><input class="input" id="lHost" maxlength="60" value="${esc(ls.get('tx_sender_name', ''))}" placeholder="Lestha TV"></label>
        </div>
        <label class="field"><span>Description</span><textarea class="input" id="lDesc" maxlength="1000" placeholder="Programme, intervenants…" style="min-height:70px"></textarea></label>
        <div class="grid-2" style="gap:12px">
          <label class="field"><span>Début prévu (facultatif)</span><input class="input" type="datetime-local" id="lStart"></label>
          <label class="control" style="padding:0;border:0"><div class="control-text"><b>Discussion en direct</b><span>Les spectateurs peuvent écrire</span></div><span class="switch"><input type="checkbox" id="lChat" checked><span class="track"></span></span></label>
        </div>
        <button type="button" class="btn primary xl block" id="lGo">${icon('video')}Créer la salle de direct</button>
      </div>
      ${list.length ? `<div class="card"><div class="card-title"><h3>${icon('video')}Mes directs</h3><span class="small faint">${list.length}</span></div><div class="stack" style="gap:6px">${list.map(x => `<div class="dl-row"><div class="ficon" style="--c:#f43f5e;width:36px;height:36px">${icon('video', 'sm')}</div><div class="fmeta"><div class="fname">${esc(x.title)}</div><div class="fsub">${x.kind === 'camera' ? 'Caméra / écran' : x.kind === 'hls' ? 'Flux .m3u8' : 'Lien ' + (PROVIDERS[x.provider] || '')} · ${new Date(x.createdAt).toLocaleDateString('fr-FR')}</div></div><a class="btn sm" href="/live/${x.id}" data-link>Ouvrir</a></div>`).join('')}</div></div>` : ''}
    </section>`;
    const help = {
      embed: 'Collez le lien d\'une vidéo ou d\'un direct YouTube, Facebook, Vimeo ou Twitch, ou d\'une publication Instagram / TikTok. La vidéo reste chez la plateforme : aucun coût de stockage.',
      camera: 'Vous diffusez votre caméra, votre écran ou votre micro depuis ce navigateur. Idéal pour un cours ou une réunion jusqu\'à 25 spectateurs (au-delà : diffusez sur YouTube et collez le lien).',
      hls: 'Pour OBS ou une régie : collez l\'adresse https de votre flux HLS (se termine par .m3u8).'
    };
    $('#kindHelp', root).textContent = help[kind];
    $('#urlLabel', root).textContent = kind === 'hls' ? 'Adresse du flux .m3u8' : 'Lien YouTube, Facebook, Vimeo, Twitch, Instagram ou TikTok';
    $('#kinds', root).onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; kind = b.dataset.k; draw(); };
    $('#lGo', root).onclick = async () => {
      const title = $('#lTitle', root).value.trim(); if (!title) { toast('Donnez un titre au direct', 'error'); $('#lTitle', root).focus(); return; }
      const hostName = $('#lHost', root).value.trim(); ls.set('tx_sender_name', hostName);
      const st = $('#lStart', root).value ? new Date($('#lStart', root).value).getTime() : null;
      const btn = $('#lGo', root); btn.disabled = true;
      try {
        const r = await api('/api/lives', { method: 'POST', body: { kind, url: $('#lUrl', root)?.value.trim(), title, hostName, description: $('#lDesc', root).value.trim(), startsAt: st, chat: $('#lChat', root).checked } });
        mine.add({ id: r.id, key: r.hostKey, title, kind, provider: r.live.provider, createdAt: Date.now() });
        toast('Salle de direct créée 🎬', 'success');
        navigate('/live/' + r.id);
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
  }
})();

/* ============================== 2. Salle de direct ============================== */
export const roomView = (() => {
  let root, id, L, me, sock, handlers = [], timer, hlsInst;
  // diffusion (hôte)
  let stream = null, pcs = new Map(), source = null, micOn = true;
  // réception (spectateur)
  let vpc = null, vq = [];

  return {
    async render(r, { match }) {
      root = r; id = match[1]; me = mine.get(id);
      root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:420px;border-radius:20px"></div></section>`;
      try { L = await api('/api/public/live/' + id); } catch (e) { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('video')}</div><h2>Direct introuvable</h2><p class="muted">Ce direct n'existe plus.</p><a class="btn" href="/direct" data-link>${icon('video')}Créer un direct</a></div></div></section>`; return; }
      draw(); connect();
    },
    destroy() {
      clearInterval(timer);
      handlers.forEach(([e, f]) => sock && sock.off(e, f)); handlers = [];
      if (sock && sock.connected) sock.emit('live-leave');
      stopBroadcast(true); if (vpc) { vpc.close(); vpc = null; }
      if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
      root = null;
    }
  };

  function draw() {
    const host = !!me;
    root.innerHTML = `
    <section class="watch-wrap">
      <div class="watch-main">
        <div class="player-box live-box ${L.vertical ? 'vertical' : ''}" id="stage"></div>
        ${host && L.kind === 'camera' ? `<div class="rv-bar"><div class="rv-ctrl">
          <button type="button" class="btn sm ${source === 'camera' ? 'primary' : ''}" data-src="camera">${icon('camera', 'sm')}Caméra</button>
          <button type="button" class="btn sm ${source === 'screen' ? 'primary' : ''}" data-src="screen">${icon('monitor', 'sm')}Écran</button>
          <button type="button" class="btn sm ${source === 'audio' ? 'primary' : ''}" data-src="audio">${icon('music', 'sm')}Micro seul</button>
          <span class="grow"></span>
          <button type="button" class="btn sm ghost" id="bMic">${micOn ? 'Couper le micro' : 'Activer le micro'}</button>
          ${stream ? `<button type="button" class="btn sm danger" id="bStop">${icon('x', 'sm')}Arrêter</button>` : ''}
        </div><div class="tiny faint">${stream ? `En direct vers <b id="nPeers">${pcs.size}</b> spectateur(s). Gardez cette page ouverte.` : 'Choisissez une source pour démarrer la diffusion. Les spectateurs déjà présents la reçoivent aussitôt.'}</div></div>` : ''}
        <div class="watch-head">
          <div style="min-width:0">
            <div class="row" style="gap:8px;flex-wrap:wrap"><span class="live-badge ${L.status === 'live' ? 'on' : ''}" id="lBadge">${L.status === 'live' ? '● EN DIRECT' : L.status === 'ended' ? 'TERMINÉ' : 'BIENTÔT'}</span><span class="pill" id="lViewers">${icon('eye', 'sm')}<b>${L.viewers || 0}</b></span>${L.provider ? `<span class="pill">${PROVIDERS[L.provider]}</span>` : ''}</div>
            <h2 style="font-size:clamp(20px,3.6vw,28px);margin-top:8px">${esc(L.title)}</h2>
            ${L.hostName ? `<div class="small muted">Présenté par ${esc(L.hostName)}</div>` : ''}
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button type="button" class="btn sm" id="shWa">${icon('whatsapp', 'sm')}WhatsApp</button>
            <button type="button" class="btn sm" id="shCopy">${icon('copy', 'sm')}Copier le lien</button>
            <button type="button" class="btn sm icon ghost" id="shQr" title="QR code à projeter">${icon('qr', 'sm')}</button>
          </div>
        </div>
        ${L.description ? `<div class="message-bubble">${esc(L.description)}</div>` : ''}
        ${host ? `<div class="card"><div class="card-title"><h3>${icon('settings')}Régie</h3></div><div class="row" style="gap:6px;flex-wrap:wrap">
          ${L.status !== 'live' ? `<button type="button" class="btn sm primary" data-st="live">${icon('play', 'sm')}Passer en direct</button>` : ''}
          ${L.status !== 'ended' ? `<button type="button" class="btn sm" data-st="ended">${icon('check', 'sm')}Terminer le direct</button>` : `<button type="button" class="btn sm" data-st="live">Rouvrir</button>`}
          <button type="button" class="btn sm ghost" id="bChatT">${L.chat ? 'Fermer la discussion' : 'Ouvrir la discussion'}</button>
          <button type="button" class="btn sm danger" id="bDel">${icon('trash', 'sm')}Supprimer</button>
        </div></div>` : ''}
      </div>
      <aside class="watch-side stack">
        <div class="card live-chat">
          <div class="card-title"><h3>${icon('message')}Discussion</h3></div>
          <div class="chat-list" id="chat"></div>
          ${L.chat ? `<form id="chatForm" class="stack" style="gap:6px;margin-top:10px">
            <input class="input" id="chName" maxlength="40" placeholder="Votre nom" value="${esc(ls.get('tx_comment_name', host ? (L.hostName || '') : ''))}">
            <div class="input-group" style="display:flex;gap:6px"><input class="input" id="chText" maxlength="300" placeholder="Écrire un message…" autocomplete="off"><button class="btn primary" type="submit" aria-label="Envoyer">${icon('arrow-right')}</button></div>
          </form>` : '<p class="small faint">La discussion est fermée.</p>'}
        </div>
      </aside>
    </section>`;
    renderStage(); renderChat(L.messages || []); bind();
  }

  /* ---------------- scène (lecteur) ---------------- */
  function renderStage() {
    const st = $('#stage', root); if (!st) return;
    clearInterval(timer);
    if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
    const waiting = L.startsAt && L.startsAt > Date.now() && L.status !== 'live';
    if (L.status === 'ended' && !me) { st.innerHTML = overlay('Ce direct est terminé', 'Merci de l\'avoir suivi !'); return; }
    if (waiting && !me) {
      st.innerHTML = overlay('Le direct commence bientôt', '<b class="countdown" id="cd"></b>');
      const tick = () => { const s = Math.max(0, Math.round((L.startsAt - Date.now()) / 1000)); const e = $('#cd', root); if (e) e.textContent = (s >= 86400 ? Math.floor(s / 86400) + ' j ' : '') + [Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':'); if (!s) { L.status = 'live'; renderStage(); } };
      tick(); timer = setInterval(tick, 1000); return;
    }
    if (L.kind === 'embed') {
      const src = L.provider === 'twitch'
        ? `https://player.twitch.tv/?${L.twitch.video ? 'video=' + encodeURIComponent(L.twitch.video) : 'channel=' + encodeURIComponent(L.twitch.channel)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true`
        : L.src;
      st.innerHTML = `<iframe class="live-frame" src="${esc(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="${esc(L.title)}"></iframe>`;
      return;
    }
    if (L.kind === 'hls') {
      st.innerHTML = `<video id="lv" class="player" controls playsinline autoplay muted></video><button type="button" class="unmute" id="unmute">🔊 Activer le son</button>`;
      const v = $('#lv', root);
      if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = L.hls;
      else loadScript('/vendor/hls.min.js').then(() => {
        if (!window.Hls || !Hls.isSupported()) { st.innerHTML = overlay('Lecture impossible', 'Ce navigateur ne lit pas les flux HLS.'); return; }
        hlsInst = new Hls({ lowLatencyMode: true }); hlsInst.loadSource(L.hls); hlsInst.attachMedia(v);
        hlsInst.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) st.insertAdjacentHTML('beforeend', `<div class="player-error">${icon('wifi-off', 'lg')}<b>Flux indisponible</b><span class="small">Le direct n'a peut-être pas encore commencé. Réessayez dans un instant.</span></div>`); });
      });
      bindUnmute(v); return;
    }
    // caméra
    if (me) {
      st.innerHTML = stream ? `<video id="lv" class="player" autoplay playsinline muted></video>${source === 'audio' ? '<div class="audio-art" style="position:absolute;inset:0">' + icon('music', 'xl') + '</div>' : ''}` : overlay('Prêt à diffuser', 'Choisissez Caméra, Écran ou Micro seul ci-dessous.');
      if (stream) $('#lv', root).srcObject = stream;
    } else {
      st.innerHTML = `<video id="lv" class="player" autoplay playsinline muted></video><button type="button" class="unmute" id="unmute">🔊 Activer le son</button><div class="live-wait ${vpc ? 'hidden' : ''}" id="wait">${overlayInner(L.hostOnline ? 'Connexion au direct…' : 'En attente de l\'hôte', 'La diffusion démarre dès que l\'hôte lance sa caméra.')}</div>`;
      bindUnmute($('#lv', root));
    }
  }
  function overlayInner(t, m) { return `<div class="state-screen" style="padding:40px 20px">${'<div class="state-icon info">' + icon('video') + '</div>'}<h2>${t}</h2><p class="muted">${m}</p></div>`; }
  function overlay(t, m) { return `<div class="live-empty">${overlayInner(t, m)}</div>`; }
  function bindUnmute(v) {
    const b = $('#unmute', root); if (!b || !v) return;
    b.onclick = () => { v.muted = false; v.play().catch(() => {}); b.remove(); };
  }

  /* ---------------- discussion ---------------- */
  function renderChat(list) {
    const box = $('#chat', root); if (!box) return;
    box.innerHTML = list.length ? list.map(msgHtml).join('') : '<p class="small faint" id="chEmpty">Soyez le premier à écrire 👋</p>';
    box.scrollTop = box.scrollHeight;
  }
  function msgHtml(m) { return `<div class="chat-msg ${m.h ? 'host' : ''}"><b>${esc(m.n)}${m.h ? ' · hôte' : ''}</b> ${esc(m.t)}</div>`; }
  function addMsg(m) {
    const box = $('#chat', root); if (!box) return;
    const e = $('#chEmpty', root); if (e) e.remove();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.insertAdjacentHTML('beforeend', msgHtml(m));
    if (near) box.scrollTop = box.scrollHeight;
  }

  function bind() {
    const link = linkOf(id);
    $('#shWa', root).onclick = () => shareTo('whatsapp', { link, text: `🔴 ${L.title} — suivez le direct` });
    $('#shCopy', root).onclick = async () => { await copyText(link); toast('Lien du direct copié', 'success'); };
    $('#shQr', root).onclick = () => {
      const bd = document.createElement('div'); bd.className = 'qr-full';
      bd.innerHTML = `<div class="qr-card"><div id="qrBox"></div><b>${esc(L.title)}</b><span class="small">${esc(link.replace(/^https?:\/\//, ''))}</span></div>`;
      bd.onclick = () => bd.remove(); document.body.appendChild(bd); renderQR($('#qrBox', bd), link);
    };
    const f = $('#chatForm', root);
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const t = $('#chText', root).value.trim(); if (!t || !sock) return;
      const n = $('#chName', root).value.trim(); if (!n) { toast('Indiquez votre nom', 'error'); $('#chName', root).focus(); return; }
      ls.set('tx_comment_name', n); sock.emit('live-name', { name: n }); sock.emit('live-chat', { text: t });
      $('#chText', root).value = '';
    };
    if (me) {
      root.querySelectorAll('[data-st]').forEach(b => b.onclick = () => patch({ status: b.dataset.st }));
      $('#bChatT', root).onclick = () => patch({ chat: !L.chat });
      $('#bDel', root).onclick = async () => {
        if (!(await confirmDialog('Supprimer ce direct ?', 'Le lien ne fonctionnera plus.', 'Supprimer', true))) return;
        try { await api('/api/lives/' + id, { method: 'DELETE', key: me.key }); mine.remove(id); toast('Direct supprimé', 'success'); navigate('/direct'); } catch (e) { toast(e.message, 'error'); }
      };
      root.querySelectorAll('[data-src]').forEach(b => b.onclick = () => startBroadcast(b.dataset.src));
      const mic = $('#bMic', root); if (mic) mic.onclick = () => { micOn = !micOn; if (stream) stream.getAudioTracks().forEach(t => { t.enabled = micOn; }); draw(); };
      const stop = $('#bStop', root); if (stop) stop.onclick = () => { stopBroadcast(); draw(); };
    }
  }
  async function patch(body) {
    try { L = Object.assign(L, await api('/api/lives/' + id, { method: 'PATCH', key: me.key, body })); draw(); } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------------- temps réel ---------------- */
  async function connect() {
    sock = await getSocket();
    const on = (e, fn) => { sock.on(e, fn); handlers.push([e, fn]); };
    const join = () => sock.emit('live-join', { id, key: me && me.key, name: ls.get('tx_comment_name', '') }, (r) => {
      if (!r || r.error) { if (r && r.error) toast(r.error, 'error'); return; }
      setViewers(r.viewers);
      if (me && stream) sock.emit('live-peers', null, (list) => list.forEach(offerTo));
    });
    on('connect', join); if (sock.connected) join();
    on('live-chat', (m) => addMsg(m));
    on('live-viewers', (d) => { if (d.id === id) setViewers(d.n); });
    on('live-update', (u) => {
      if (u.deleted) { toast('Ce direct a été supprimé', 'info'); L.status = 'ended'; renderStage(); return; }
      const reStage = u.status !== L.status; L = Object.assign(L, u); if (me) draw(); else if (reStage) { const b = $('#lBadge', root); if (b) { b.className = 'live-badge ' + (L.status === 'live' ? 'on' : ''); b.textContent = L.status === 'live' ? '● EN DIRECT' : L.status === 'ended' ? 'TERMINÉ' : 'BIENTÔT'; } renderStage(); }
    });
    if (L.kind !== 'camera') return;
    if (me) {
      on('live-viewer', ({ peer }) => { if (stream) offerTo(peer); });
      on('live-viewer-left', ({ peer }) => { const pc = pcs.get(peer); if (pc) { pc.close(); pcs.delete(peer); peersCount(); } });
      on('live-signal', async ({ from, data }) => {
        const pc = pcs.get(from); if (!pc) return;
        try {
          if (data.sdp) { await pc.setRemoteDescription(data.sdp); for (const c of pc._q || []) await pc.addIceCandidate(c).catch(() => {}); pc._q = []; }
          else if (data.c) { if (pc.remoteDescription) await pc.addIceCandidate(data.c).catch(() => {}); else (pc._q = pc._q || []).push(data.c); }
        } catch (e) { /* ignore */ }
      });
    } else {
      on('live-host', ({ online }) => { L.hostOnline = online; if (!online) { if (vpc) { vpc.close(); vpc = null; } renderStage(); } });
      on('live-signal', async ({ from, data }) => {
        try {
          if (data.sdp && data.sdp.type === 'offer') {
            const reuse = vpc && vpc._from === from && !['failed', 'closed'].includes(vpc.connectionState);
            if (!reuse) {
              if (vpc) vpc.close();
              vpc = new RTCPeerConnection({ iceServers: await ice() }); vq = []; vpc._from = from;
            }
            vpc.ontrack = (ev) => { const v = $('#lv', root); if (v && v.srcObject !== ev.streams[0]) { v.srcObject = ev.streams[0]; v.play().catch(() => {}); } const w = $('#wait', root); if (w) w.classList.add('hidden'); };
            vpc.onicecandidate = (ev) => { if (ev.candidate) sock.emit('live-signal', { to: from, data: { c: ev.candidate } }); };
            vpc.onconnectionstatechange = () => { if (vpc && ['failed', 'closed'].includes(vpc.connectionState)) { const w = $('#wait', root); if (w) w.classList.remove('hidden'); } };
            await vpc.setRemoteDescription(data.sdp);
            for (const c of vq) await vpc.addIceCandidate(c).catch(() => {}); vq = [];
            const ans = await vpc.createAnswer(); await vpc.setLocalDescription(ans);
            sock.emit('live-signal', { to: from, data: { sdp: vpc.localDescription } });
          } else if (data.c) { if (vpc && vpc.remoteDescription) await vpc.addIceCandidate(data.c).catch(() => {}); else vq.push(data.c); }
        } catch (e) { /* ignore */ }
      });
    }
  }
  function setViewers(n) { L.viewers = n; const e = $('#lViewers b', root); if (e) e.textContent = n; }
  function peersCount() { const e = $('#nPeers', root); if (e) e.textContent = pcs.size; tuneBitrate(); }

  /* ---------------- diffusion (hôte, mode caméra) ---------------- */
  async function startBroadcast(kind) {
    let s;
    try {
      if (kind === 'screen') {
        s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        try { const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); if (!s.getAudioTracks().length) mic.getAudioTracks().forEach(t => s.addTrack(t)); } catch (e) { /* écran sans micro */ }
      } else if (kind === 'audio') s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      else s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) { toast(kind === 'screen' ? 'Partage d\'écran refusé ou non disponible sur cet appareil' : 'Accès à la caméra / au micro refusé', 'error'); return; }
    const old = stream; stream = s; source = kind;
    stream.getAudioTracks().forEach(t => { t.enabled = micOn; });
    stream.getVideoTracks().forEach(t => { t.onended = () => { if (stream === s) { stopBroadcast(); draw(); } }; });
    if (pcs.size) {
      // changement de source à chaud : on remplace les pistes sans couper les spectateurs
      for (const pc of pcs.values()) {
        const senders = pc.getSenders();
        for (const tr of stream.getTracks()) { const sd = senders.find(x => x.track && x.track.kind === tr.kind); if (sd) sd.replaceTrack(tr); else pc.addTrack(tr, stream); }
        senders.forEach(sd => { if (sd.track && !stream.getTracks().some(t => t.kind === sd.track.kind)) sd.replaceTrack(null); });
      }
      renegotiateAll();
    }
    if (old) old.getTracks().forEach(t => t.stop());
    if (L.status !== 'live') patch({ status: 'live' }); else draw();
    if (sock) sock.emit('live-peers', null, (list) => list.forEach(p => { if (!pcs.has(p)) offerTo(p); }));
    toast('Vous êtes en direct 🔴', 'success');
  }
  async function offerTo(peer) {
    if (!stream || !sock) return;
    const old = pcs.get(peer); if (old) old.close();
    const pc = new RTCPeerConnection({ iceServers: await ice() });
    pcs.set(peer, pc); peersCount();
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => { if (e.candidate) sock.emit('live-signal', { to: peer, data: { c: e.candidate } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && pcs.get(peer) === pc) { pcs.delete(peer); peersCount(); } if (pc.connectionState === 'connected') tuneBitrate(); };
    await sendOffer(pc, peer);
  }
  async function sendOffer(pc, peer) {
    try { const o = await pc.createOffer(); await pc.setLocalDescription(o); sock.emit('live-signal', { to: peer, data: { sdp: pc.localDescription } }); } catch (e) { /* ignore */ }
  }
  function renegotiateAll() { for (const [peer, pc] of pcs) sendOffer(pc, peer); }
  /** Plus il y a de spectateurs, plus on réduit le débit de chaque envoi (la connexion de l'hôte est partagée) */
  function tuneBitrate() {
    const n = Math.max(1, pcs.size), max = n <= 3 ? 1500e3 : n <= 8 ? 800e3 : n <= 15 ? 500e3 : 350e3;
    for (const pc of pcs.values()) pc.getSenders().forEach(sd => {
      if (!sd.track || sd.track.kind !== 'video') return;
      const p = sd.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = max; sd.setParameters(p).catch(() => {});
    });
  }
  function stopBroadcast(silent) {
    for (const pc of pcs.values()) pc.close(); pcs.clear();
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; source = null;
    if (!silent && root) toast('Diffusion arrêtée', 'info');
  }
})();
