/* Lestha Send — « Direct » : salles de diffusion en direct
 *  - lien de plateforme (lecteur officiel YouTube / Facebook / Vimeo / Twitch / Instagram / TikTok)
 *  - caméra, écran ou micro diffusés depuis le navigateur (WebRTC, petits groupes)
 *  - flux .m3u8 (OBS, régie) lu avec hls.js
 * + discussion en direct, compteur de spectateurs, compte à rebours, partage WhatsApp / QR */
import { $, esc, icon, ls, api, toast, getSocket, copyText, shareTo, renderQR, confirmDialog, visitorId, getConfig, owned, modal } from './core.js';
import { Uploader } from './uploader.js';
import { navigate } from './router.js';
import { track } from './ux.js';

const mine = {
  all: () => ls.get('tx_lives', []),
  get: (id) => mine.all().find(x => x.id === id),
  add: (x) => ls.set('tx_lives', [x].concat(mine.all().filter(y => y.id !== x.id)).slice(0, 50)),
  remove: (id) => ls.set('tx_lives', mine.all().filter(y => y.id !== id))
};
const hue = (t) => { let h = 0; for (const c of String(t || '')) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const initials = (t) => String(t || '?').trim().split(/\s+/).slice(0, 2).map(w => [...w][0] || '').join('').toUpperCase() || '?';
const longDate = (t) => new Date(t).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).replace(/^./, c => c.toUpperCase());
const hhmm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
  function detect(url) {
    let h = ''; try { h = new URL(url).hostname.replace(/^(www|m|web)\./, ''); } catch (e) { return null; }
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return 'youtube';
    if (/(^|\.)facebook\.com$|^fb\.watch$/.test(h)) return 'facebook';
    if (/(^|\.)vimeo\.com$/.test(h)) return 'vimeo';
    if (/(^|\.)twitch\.tv$/.test(h)) return 'twitch';
    if (/(^|\.)instagram\.com$/.test(h)) return 'instagram';
    if (/(^|\.)tiktok\.com$/.test(h)) return 'tiktok';
    return 'unknown';
  }
  function draw() {
    const list = mine.all().filter(x => x.kind !== 'camera');
    const kinds = [
      ['embed', icon('link'), 'Lien d\'une plateforme', 'YouTube, Facebook, Vimeo, Twitch, Instagram, TikTok'],
      ['hls', icon('film'), 'Flux professionnel', 'OBS, régie, encodeur : adresse .m3u8']
    ];
    root.innerHTML = `
    <section class="lv-studio">
      <div class="lv-hero">
        <span class="lv-hero-badge"><span class="lv-dot"></span>Direct</span>
        <h1>Votre direct, <span class="grad-text">votre page</span></h1>
        <p class="muted">Cérémonies, cours, conférences, matchs : une belle page de direct à votre nom, avec discussion, réactions et QR code à projeter.</p>
        <div class="lv-perks"><span>${icon('message', 'sm')}Discussion en direct</span><span>${icon('smile', 'sm')}Réactions</span><span>${icon('qr', 'sm')}QR code</span><span>${icon('whatsapp', 'sm')}Partage WhatsApp</span></div>
      </div>
      <div class="lv-studio-grid">
        <div class="card glow lv-form-card">
          <div class="lv-step"><span>1</span>Source de la vidéo</div>
          <div class="lv-kinds" id="kinds" role="radiogroup" aria-label="Source de la vidéo">${kinds.map(([k, ic, t, d]) => `<button type="button" role="radio" aria-checked="${kind === k}" class="lv-kind ${kind === k ? 'active' : ''}" data-k="${k}"><span class="lv-kind-ico">${ic}</span><b>${t}</b><span>${d}</span></button>`).join('')}</div>
          <label class="field" id="urlField"><span id="urlLabel">Lien</span>
            <div class="lv-url"><input class="input" id="lUrl" placeholder="https://" inputmode="url" autocomplete="off"><span class="lv-detect hidden" id="lDetect"></span></div>
            <span class="small faint" id="kindHelp"></span></label>
          <div class="lv-step"><span>2</span>Présentation</div>
          <div class="grid-2" style="gap:12px">
            <label class="field"><span>Titre *</span><input class="input" id="lTitle" maxlength="120" placeholder="Ex. Cérémonie de remise des diplômes"></label>
            <label class="field"><span>Présenté par</span><input class="input" id="lHost" maxlength="60" value="${esc(ls.get('tx_sender_name', ''))}" placeholder="Lestha TV"></label>
          </div>
          <label class="field"><span>Description</span><textarea class="input" id="lDesc" maxlength="1000" placeholder="Programme, intervenants, lieu…" style="min-height:76px"></textarea></label>
          <div class="lv-step"><span>3</span>Options</div>
          <div class="grid-2" style="gap:12px;align-items:end">
            <label class="field"><span>Début prévu (facultatif)</span><input class="input" type="datetime-local" id="lStart"></label>
            <label class="control lv-switch"><div class="control-text"><b>Discussion en direct</b><span>Les spectateurs peuvent écrire</span></div><span class="switch"><input type="checkbox" id="lChat" checked><span class="track"></span></span></label>
          </div>
          <button type="button" class="btn primary xl block lv-go" id="lGo">${icon('video')}Créer ma page de direct</button>
          <div class="tip">${icon('call')}<span>Un cours où chacun peut parler, lever la main et répondre à des sondages ? Utilisez <a href="/reunion" data-link><b>Réunion</b></a> en mode Cours.</span></div>
        </div>
        <aside class="lv-preview" aria-hidden="true">
          <span class="lv-label">Aperçu de votre page</span>
          <div class="lv-mock">
            <div class="lv-mock-stage"><span class="live-badge on">● EN DIRECT</span><span class="lv-glass">${icon('eye', 'sm')}<b>128</b></span><div class="lv-mock-play">${icon('play', 'lg')}</div><span class="lv-mock-prov" id="pvProv"></span>
              <div class="lv-mock-reacts"><i>❤️</i><i>👏</i><i>👍</i></div></div>
            <div class="lv-mock-info"><div class="lv-avatar sm" id="pvAv">LT</div><div><b id="pvTitle">Titre de votre direct</b><span id="pvHost">Présenté par…</span></div></div>
            <div class="lv-mock-chat"><div><i style="--h:200">AW</i><span><b>Awa</b> Bonjour depuis Dakar 👋</span></div><div><i style="--h:30">MD</i><span><b>Moussa</b> Félicitations à tous !</span></div><div><i style="--h:140">FS</i><span><b>Fatou</b> Le son est parfait 👌</span></div></div>
          </div>
        </aside>
      </div>
      ${list.length ? `<div class="lv-mine"><div class="lv-mine-head"><h2>${icon('video')}Mes directs</h2><span class="pill">${list.length}</span></div><div class="lv-mine-grid">${list.map(x => `<a class="lv-mine-card" href="/live/${x.id}" data-link><span class="lv-mine-thumb" style="--h:${hue(x.title)}">${x.kind === 'hls' ? icon('film') : icon('play')}<em>${x.kind === 'hls' ? 'Flux HD' : (PROVIDERS[x.provider] || 'Lien')}</em></span><span class="lv-mine-txt"><b>${esc(x.title)}</b><span>Créé le ${new Date(x.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span></span><span class="lv-mine-go">Ouvrir ${icon('arrow-right', 'sm')}</span></a>`).join('')}</div></div>` : ''}
    </section>`;
    const help = {
      embed: 'La vidéo reste chez la plateforme : aucun coût de stockage, qualité d\'origine.',
      hls: 'Pour OBS ou une régie : collez l\'adresse https de votre flux HLS (se termine par .m3u8).'
    };
    $('#kindHelp', root).textContent = help[kind];
    $('#urlLabel', root).textContent = kind === 'hls' ? 'Adresse du flux .m3u8' : 'Lien de la vidéo ou du direct';
    $('#lUrl', root).placeholder = kind === 'hls' ? 'https://…/live.m3u8' : 'https://youtube.com/live/…';
    $('#kinds', root).onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b || b.dataset.k === kind) return; kind = b.dataset.k; draw(); };
    const preview = () => {
      const t = $('#lTitle', root).value.trim(), h = $('#lHost', root).value.trim(), d = detect($('#lUrl', root).value.trim());
      $('#pvTitle', root).textContent = t || 'Titre de votre direct';
      $('#pvHost', root).textContent = h ? 'Présenté par ' + h : 'Présenté par…';
      const av = $('#pvAv', root); av.textContent = initials(h || t || 'Lestha TV'); av.style.setProperty('--h', hue(h || t));
      const name = d === 'hls' ? 'Flux HD' : PROVIDERS[d];
      const det = $('#lDetect', root);
      det.className = 'lv-detect ' + (d ? (d === 'unknown' ? 'bad' : 'p-' + d) : 'hidden');
      det.textContent = d === 'unknown' ? 'Lien non reconnu' : name ? '✓ ' + name : '';
      const pv = $('#pvProv', root); pv.textContent = name || ''; pv.className = 'lv-mock-prov ' + (d && d !== 'unknown' ? 'p-' + d : 'hidden');
    };
    ['#lTitle', '#lHost', '#lUrl'].forEach(s => { $(s, root).oninput = preview; });
    preview();
    $('#lGo', root).onclick = async () => {
      const title = $('#lTitle', root).value.trim(); if (!title) { toast('Donnez un titre au direct', 'error'); $('#lTitle', root).focus(); return; }
      const hostName = $('#lHost', root).value.trim(); ls.set('tx_sender_name', hostName);
      const st = $('#lStart', root).value ? new Date($('#lStart', root).value).getTime() : null;
      const btn = $('#lGo', root); btn.disabled = true;
      try {
        track('use', { m: 'live' });
        const r = await api('/api/lives', { method: 'POST', body: { kind, url: $('#lUrl', root)?.value.trim(), title, hostName, description: $('#lDesc', root).value.trim(), startsAt: st, chat: $('#lChat', root).checked, waitingRoom: !!$('#lWait', root)?.checked } });
        mine.add({ id: r.id, key: r.hostKey, modKey: r.modKey, role: 'host', title, kind, provider: r.live.provider, createdAt: Date.now() });
        toast('Salle de direct créée 🎬', 'success');
        navigate('/live/' + r.id);
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
  }
})();

/* ============================== 2. Salle de direct / classe virtuelle ============================== */
const REACTIONS = ['👍', '👏', '❤️', '😂', '❓', '🐢'];
const ROLE_LABEL = { host: 'Tuteur', mod: 'Modérateur', learner: 'Participant' };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export const roomView = (() => {
  let root, id, L, me, sock, handlers = [], timer, hlsInst;
  let role = 'learner', joined = false, waiting = false, hostPeer = null, tab = 'chat';
  let st = { participants: [], locked: false, waitingRoom: false, poll: null, viewers: 0 }, waitList = [];
  const out = { stream: null, pcs: new Map(), source: null, mic: true, cam: true };   // flux que J'ENVOIE (tuteur, ou apprenant qui a la parole)
  const inc = new Map();                                                               // flux que je REÇOIS : peer -> { pc, q, stream }
  let speaking = false, hand = false, myVote = null, nMsg = 0, lastReact = 0;
  const rec = { mr: null, chunks: [], parts: [], ctx: null, dest: null, srcs: new Set() };

  const staff = () => role === 'host' || role === 'mod';
  const isClass = () => L.kind === 'camera';

  return {
    async render(r, { match, hash }) {
      root = r; id = match[1];
      const m = (hash || '').match(/^m=([\w-]{10,})$/);
      if (m) { mine.add({ id, key: m[1], role: 'mod', title: 'Co-animation', kind: 'camera', createdAt: Date.now() }); history.replaceState(history.state, '', '/live/' + id); }
      me = mine.get(id); role = me ? (me.role || 'host') : 'learner';
      root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:420px;border-radius:20px"></div></section>`;
      try { L = await api('/api/public/live/' + id); if (L && L.kind === 'camera') { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon info">${icon('call')}</div><h2>Cette classe a été remplacée</h2><p class="muted">Les classes virtuelles se font désormais dans « Réunion », en mode Cours : discussion, sondages, liste de présence et enregistrement MP3.</p><a class="btn primary" href="/reunion" data-link>${icon('call')}Créer un cours</a></div></div></section>`; return; } } catch (e) { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('video')}</div><h2>Direct introuvable</h2><p class="muted">Ce direct n'existe plus.</p><a class="btn" href="/direct" data-link>${icon('video')}Créer un direct</a></div></div></section>`; return; }
      if (isClass() && !me && !ls.get('tx_comment_name', '')) return prejoin();
      draw(); connect();
    },
    destroy() {
      clearInterval(timer);
      if (rec.mr) stopRecording();
      handlers.forEach(([e, f]) => sock && sock.off(e, f)); handlers = [];
      if (sock && sock.connected) sock.emit('live-leave');
      stopOut(true); inc.forEach(x => x.pc.close()); inc.clear();
      if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
      root = null; joined = false;
    }
  };

  function prejoin() {
    root.innerHTML = `<section class="narrow"><div class="card glow"><div class="state-screen">
      <div class="state-icon info">${icon('users')}</div><h2>${esc(L.title)}</h2>
      <p class="muted">${L.hostName ? 'Animé par ' + esc(L.hostName) + ' · ' : ''}Classe virtuelle</p>
      <input class="input" id="pjName" maxlength="40" placeholder="Votre prénom et nom" style="max-width:320px">
      <button type="button" class="btn primary" id="pjGo">${icon('arrow-right')}Rejoindre</button>
      <p class="tiny faint">Votre nom sert à la liste de présence. Votre caméra et votre micro restent coupés tant que l'animateur ne vous donne pas la parole.</p>
    </div></div></section>`;
    const go = () => { const n = $('#pjName', root).value.trim(); if (!n) { toast('Indiquez votre nom', 'error'); return; } ls.set('tx_comment_name', n); draw(); connect(); };
    $('#pjGo', root).onclick = go; $('#pjName', root).onkeydown = (e) => { if (e.key === 'Enter') go(); };
    setTimeout(() => $('#pjName', root)?.focus(), 50);
  }

  /* ---------------- mise en page ---------------- */
  function draw() {
    const host = role === 'host';
    const name = ls.get('tx_comment_name', host ? (L.hostName || '') : '');
    const when = L.startsAt && L.status !== 'live' ? longDate(L.startsAt) : '';
    root.innerHTML = `
    <div class="lv-page">
      <div class="lv-top" data-back-slot></div>
      <section class="watch-wrap lv ${isClass() ? 'class-room' : ''} ${L.status === 'live' ? 'is-live' : ''}" id="lvWrap">
        <div class="watch-main">
          <div class="lv-stage-wrap">
            <div class="player-box live-box ${L.vertical ? 'vertical' : ''}" id="stage"></div>
            <div class="lv-hud">
              <span class="live-badge ${L.status === 'live' ? 'on' : ''}" id="lBadge">${badgeText()}</span>
              <span class="lv-glass" id="lViewers" title="Spectateurs en ce moment">${icon('eye', 'sm')}<b>${L.viewers || 0}</b></span>
            </div>
            <div class="react-layer" id="reacts"></div>
          </div>
          ${isClass() ? `<div class="tiles" id="tiles"></div><div class="class-bar" id="bar"></div>` : ''}
          <div class="lv-actions">
            <div class="lv-reacts" id="lvReacts" role="group" aria-label="Réagir en direct">${REACTIONS.map(e => `<button type="button" class="lv-react" data-e="${e}" aria-label="Réagir ${e}">${e}</button>`).join('')}</div>
            <div class="lv-share">
              <button type="button" class="lv-pill wa" id="shWa">${icon('whatsapp', 'sm')}<span>WhatsApp</span></button>
              <button type="button" class="lv-pill" id="shCopy">${icon('link', 'sm')}<span>Copier le lien</span></button>
              <button type="button" class="lv-pill icon" id="shQr" title="QR code à projeter" aria-label="QR code à projeter">${icon('qr', 'sm')}</button>
            </div>
          </div>
          <div class="lv-info card">
            <div class="lv-host">
              <div class="lv-avatar" style="--h:${hue(L.hostName || L.title)}">${esc(initials(L.hostName || L.title))}</div>
              <div class="lv-meta">
                <h1 class="lv-title">${esc(L.title)}</h1>
                <div class="lv-sub">
                  ${L.hostName ? `<b>${esc(L.hostName)}</b>` : ''}
                  ${L.provider ? `<span class="lv-prov p-${L.provider}">${PROVIDERS[L.provider]}</span>` : L.kind === 'hls' ? '<span class="lv-prov">Flux HD</span>' : ''}
                  ${when ? `<span class="lv-when">${icon('clock', 'sm')}${esc(when)}</span>` : ''}
                  ${isClass() ? `<span class="pill violet">${ROLE_LABEL[role]}</span>` : ''}
                </div>
              </div>
            </div>
            ${L.description ? `<div class="lv-about"><span class="lv-label">À propos</span><p>${esc(L.description)}</p></div>` : ''}
          </div>
          ${staff() ? `<div class="card lv-regie"><div class="lv-regie-head"><div><span class="lv-label">Régie</span><b>Vous êtes l'animateur de ce direct</b></div><span class="small faint">Visible par vous seul</span></div><div class="lv-regie-row" id="regie"></div></div>` : ''}
        </div>
        <aside class="watch-side">
          <div class="card live-chat lv-chat">
            ${isClass() ? `          <div class="chips side-tabs" id="tabs" role="tablist" aria-label="Outils de la classe">
              <button type="button" class="chip" id="tab-chat" role="tab" aria-controls="pane-chat" data-tab="chat">${icon('message', 'sm')}Discussion</button>
              <button type="button" class="chip" id="tab-people" role="tab" aria-controls="pane-people" data-tab="people">${icon('users', 'sm')}Participants <b id="pCount"></b><em class="nav-badge hidden" id="wBadge"></em></button>
              <button type="button" class="chip" id="tab-poll" role="tab" aria-controls="pane-poll" data-tab="poll">${icon('chart', 'sm')}Sondage</button></div>` : `<div class="lv-chat-head"><h2 id="discussion-title"><span class="lv-dot"></span>Discussion en direct</h2><span class="lv-count" id="chCount"></span></div>`}
            <div id="pane-chat" class="lv-pane" role="${isClass() ? 'tabpanel' : 'region'}" aria-labelledby="${isClass() ? 'tab-chat' : 'discussion-title'}"><div class="chat-list" id="chat" role="log" aria-live="polite" aria-relevant="additions" aria-label="Discussion du direct"></div>
            ${L.chat || staff() ? `<form id="chatForm" class="lv-form">
              ${isClass() ? '' : `<div class="lv-as ${name ? '' : 'hidden'}" id="chAs">${icon('edit', 'sm')}<span>Vous écrivez en tant que <b id="chAsName">${esc(name)}</b></span><button type="button" id="chAsEdit">Modifier</button></div>
              <input class="input ${name ? 'hidden' : ''}" id="chName" maxlength="40" placeholder="Votre nom (affiché dans la discussion)" value="${esc(name)}">`}
              <div class="lv-send"><input class="input" id="chText" maxlength="300" placeholder="Écrire un message…" aria-label="Votre message" autocomplete="off"><button class="lv-send-btn" type="submit" aria-label="Envoyer">${icon('arrow-right')}</button></div>
            </form>` : '<p class="lv-closed">' + icon('lock', 'sm') + 'La discussion est fermée.</p>'}</div>
            ${isClass() ? '<div id="pane-people" class="hidden" role="tabpanel" aria-labelledby="tab-people"></div><div id="pane-poll" class="hidden" role="tabpanel" aria-labelledby="tab-poll"></div>' : ''}
          </div>
        </aside>
      </section>
    </div>`;
    renderStage(); renderChat(L.messages || []); bindCommon();
    if (isClass()) { renderBar(); renderTiles(); renderPeople(); renderPoll(); setTab(tab); }
    if (staff()) renderRegie();
  }
  function badgeText() { return L.status === 'live' ? '● EN DIRECT' : L.status === 'ended' ? 'TERMINÉ' : 'BIENTÔT'; }
  function setTab(t) {
    tab = t;
    root.querySelectorAll('#tabs [data-tab]').forEach(b => {
      const active = b.dataset.tab === t;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    });
    ['chat', 'people', 'poll'].forEach(k => { const p = $('#pane-' + k, root); if (p) p.classList.toggle('hidden', k !== t); });
  }

  /* ---------------- scène principale ---------------- */
  function renderStage() {
    const stg = $('#stage', root); if (!stg) return;
    clearInterval(timer);
    if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
    const early = L.startsAt && L.startsAt > Date.now() && L.status !== 'live';
    if (L.status === 'ended' && !staff()) { stg.innerHTML = `<div class="live-empty lv-soon"><div class="lv-soon-in"><span class="lv-end-ico">🎬</span><b class="lv-soon-t">Ce direct est terminé</b><span class="small">Merci de l'avoir suivi ! Partagez le lien pour la prochaine fois.</span></div></div>`; return; }
    if (waiting) { stg.innerHTML = overlay('Salle d\'attente', 'L\'animateur va vous faire entrer dans un instant…'); return; }
    if (early && !staff()) {
      stg.innerHTML = `<div class="live-empty lv-soon"><div class="lv-soon-in"><span class="lv-label">Le direct commence dans</span><b class="live-countdown" id="cd"></b><span class="lv-soon-t">${esc(L.title)}</span><span class="small">${longDate(L.startsAt)}</span></div></div>`;
      const tick = () => { const s = Math.max(0, Math.round((L.startsAt - Date.now()) / 1000)); const e = $('#cd', root); if (e) e.textContent = (s >= 86400 ? Math.floor(s / 86400) + ' j ' : '') + [Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':'); if (!s) { L.status = 'live'; const b = $('#lBadge', root); if (b) { b.className = 'live-badge on'; b.textContent = badgeText(); } $('#lvWrap', root)?.classList.add('is-live'); renderStage(); } };
      tick(); timer = setInterval(tick, 1000); return;
    }
    if (L.kind === 'embed') {
      const src = L.provider === 'twitch'
        ? `https://player.twitch.tv/?${L.twitch.video ? 'video=' + encodeURIComponent(L.twitch.video) : 'channel=' + encodeURIComponent(L.twitch.channel)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true`
        : L.src;
      stg.innerHTML = `<iframe class="live-frame" src="${esc(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="${esc(L.title)}"></iframe>`;
      return;
    }
    if (L.kind === 'hls') {
      stg.innerHTML = `<video id="lv" class="player" controls playsinline autoplay muted></video><button type="button" class="unmute" id="unmute">🔊 Activer le son</button>`;
      const v = $('#lv', root);
      if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = L.hls;
      else loadScript('/vendor/hls.min.js').then(() => {
        if (!window.Hls || !Hls.isSupported()) { stg.innerHTML = overlay('Lecture impossible', 'Ce navigateur ne lit pas les flux HLS.'); return; }
        hlsInst = new Hls({ lowLatencyMode: true }); hlsInst.loadSource(L.hls); hlsInst.attachMedia(v);
        hlsInst.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) stg.insertAdjacentHTML('beforeend', `<div class="player-error">${icon('wifi-off', 'lg')}<b>Flux indisponible</b><span class="small">Le direct n'a peut-être pas encore commencé. Réessayez dans un instant.</span></div>`); });
      });
      bindUnmute(v); return;
    }
    // classe virtuelle
    stg.innerHTML = `<video id="lv" class="player" autoplay playsinline ${role === 'host' ? 'muted' : ''}></video>
      ${role !== 'host' ? '<button type="button" class="unmute hidden" id="unmute">🔊 Activer le son</button>' : ''}
      <div class="live-wait" id="wait">${overlayInner(role === 'host' ? 'Prêt à diffuser' : 'En attente du tuteur', role === 'host' ? 'Choisissez Caméra, Écran ou Micro seul dans la barre ci-dessous.' : 'Le cours démarre dès que le tuteur lance sa caméra ou son écran.')}</div>
      ${role === 'host' && out.source === 'audio' ? `<div class="audio-art" style="position:absolute;inset:0">${icon('music', 'xl')}</div>` : ''}`;
    const v = $('#lv', root);
    if (role === 'host' && out.stream) { v.srcObject = out.stream; $('#wait', root).classList.add('hidden'); }
    else if (hostPeer && inc.get(hostPeer)?.stream) attachMain(inc.get(hostPeer).stream);
    bindUnmute(v);
  }
  function attachMain(stream) {
    const v = $('#lv', root); if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    v.muted = false;
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); const u = $('#unmute', root); if (u) u.classList.remove('hidden'); });
    const w = $('#wait', root); if (w) w.classList.add('hidden');
  }
  function overlayInner(t, m) { return `<div class="state-screen" style="padding:40px 20px"><div class="state-icon info">${icon('video')}</div><h2>${t}</h2><p class="muted">${m}</p></div>`; }
  function overlay(t, m) { return `<div class="live-empty">${overlayInner(t, m)}</div>`; }
  function bindUnmute(v) { const b = $('#unmute', root); if (!b || !v) return; b.onclick = () => { v.muted = false; v.play().catch(() => {}); b.classList.add('hidden'); }; }

  /* ---------------- vignettes des intervenants ---------------- */
  function renderTiles() {
    const box = $('#tiles', root); if (!box) return;
    const nameOf = (pid) => (st.participants.find(p => p.id === pid) || {}).name || 'Participant';
    const items = [];
    if (speaking && out.stream) items.push({ key: 'me', name: 'Vous', stream: out.stream, me: true, muted: !out.mic });
    inc.forEach((x, pid) => { if (pid !== hostPeer && x.stream) items.push({ key: pid, name: nameOf(pid), stream: x.stream, muted: (st.participants.find(p => p.id === pid) || {}).muted }); });
    if (role === 'host' && hostPeer == null) { /* le tuteur voit les intervenants ici */ }
    box.classList.toggle('hidden', !items.length);
    const keep = new Set(items.map(i => i.key));
    box.querySelectorAll('[data-tile]').forEach(t => { if (!keep.has(t.dataset.tile)) t.remove(); });
    items.forEach(it => {
      let t = box.querySelector(`[data-tile="${it.key}"]`);
      if (!t) { t = document.createElement('div'); t.className = 'tile'; t.dataset.tile = it.key; t.innerHTML = `<video autoplay playsinline ${it.me ? 'muted' : ''}></video><span class="tile-name"></span>`; box.appendChild(t); }
      const v = t.querySelector('video'); if (v.srcObject !== it.stream) { v.srcObject = it.stream; v.play().catch(() => {}); }
      const hasVideo = it.stream.getVideoTracks().some(tr => tr.readyState === 'live' && tr.enabled);
      t.classList.toggle('audio-only', !hasVideo);
      t.querySelector('.tile-name').textContent = (it.muted ? '🔇 ' : '🎤 ') + it.name;
    });
  }

  /* ---------------- barre de commandes ---------------- */
  function renderBar() {
    const bar = $('#bar', root); if (!bar) return;
    const reactionNames = { '👍': 'J’aime', '👏': 'Applaudissements', '❤️': 'Cœur', '😂': 'Rire', '❓': 'Question', '🐢': 'Ralentir' };
    const reacts = `<span class="react-row" role="group" aria-label="Réactions">${REACTIONS.map(e => `<button type="button" class="react-btn" data-react="${e}" title="${reactionNames[e]}" aria-label="${reactionNames[e]}">${e}</button>`).join('')}</span>`;
    if (role === 'host') {
      const canShareScreen = !!(window.isSecureContext && navigator.mediaDevices?.getDisplayMedia);
      const canSwitchCamera = out.source === 'camera' && !!out.stream?.getVideoTracks().length && !!navigator.mediaDevices?.getUserMedia;
      bar.innerHTML = `
        <button type="button" class="btn sm ${out.source === 'camera' ? 'primary' : ''}" data-src="camera" aria-pressed="${out.source === 'camera'}">${icon('camera', 'sm')}${out.source === 'screen' ? 'Revenir à la caméra' : 'Caméra'}</button>
        <button type="button" class="btn sm ${out.source === 'screen' ? 'primary' : ''}" data-src="screen" aria-pressed="${out.source === 'screen'}" ${canShareScreen ? '' : 'disabled title="Le partage d’écran n’est pas disponible dans ce navigateur ou contexte."'}>${icon('monitor', 'sm')}Présenter l'écran</button>
        <button type="button" class="btn sm ${out.source === 'audio' ? 'primary' : ''}" data-src="audio" aria-pressed="${out.source === 'audio'}">${icon('music', 'sm')}Micro seul</button>
        ${out.stream ? `<button type="button" class="btn sm ${out.mic ? '' : 'danger'}" id="bMic" aria-label="${out.mic ? 'Couper le micro' : 'Réactiver le micro'}" aria-pressed="${!out.mic}">${out.mic ? '🎤 Micro actif · couper' : '🔇 Micro coupé · réactiver'}</button>
        ${canSwitchCamera ? '<button type="button" class="btn sm" id="bFlip" aria-label="Changer de caméra">🔄 Changer de caméra</button>' : ''}
        <button type="button" class="btn sm ${rec.mr ? 'danger' : ''}" id="bRec">${rec.mr ? '⏹ Arrêter l\'enregistrement' : '⏺ Enregistrer'}</button>
        <button type="button" class="btn sm danger" id="bStop" aria-label="${out.source === 'screen' ? 'Arrêter le partage d’écran et revenir à la salle' : 'Arrêter la diffusion'}">${icon('x', 'sm')}${out.source === 'screen' ? 'Arrêter la présentation' : 'Arrêter la diffusion'}</button>` : ''}
        <span class="grow"></span>${reacts}
        <div class="tiny faint" style="flex-basis:100%">${out.stream ? `Diffusion vers <b id="nPeers">${out.pcs.size}</b> participant(s)${rec.mr ? ' · <span style="color:#fda4af">● enregistrement en cours</span>' : ''}. Gardez cette page ouverte.` : 'Choisissez une source : les participants la reçoivent aussitôt.'}${canShareScreen ? '' : ' Le partage d’écran nécessite un navigateur compatible et une connexion HTTPS; essayez depuis un ordinateur.'}</div>`;
    } else if (speaking) {
      bar.innerHTML = `<span class="pill ok">🎤 Vous avez la parole</span>
        <button type="button" class="btn sm ${out.mic ? '' : 'danger'}" id="bMic">${out.mic ? '🎤 Micro' : '🔇 Micro coupé'}</button>
        <button type="button" class="btn sm" id="bCam">${out.stream && out.stream.getVideoTracks().length ? '📷 Couper la caméra' : '📷 Activer la caméra'}</button>
        <button type="button" class="btn sm ghost" id="bGive">Rendre la parole</button><span class="grow"></span>${reacts}`;
    } else {
      bar.innerHTML = `${role === 'learner' ? `<button type="button" class="btn sm ${hand ? 'primary' : ''}" id="bHand" aria-pressed="${hand}">✋ ${hand ? 'Baisser la main' : 'Lever la main'}</button>` : ''}<span class="grow"></span>${reacts}`;
    }
    bar.onclick = (e) => {
      const r = e.target.closest('[data-react]'); if (r && sock) { sock.emit('live-react', { e: r.dataset.react }); return; }
      const s = e.target.closest('[data-src]'); if (s) return startOut(s.dataset.src);
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'bMic') toggleMic();
      else if (b.id === 'bFlip') switchCamera();
      else if (b.id === 'bCam') toggleCam();
      else if (b.id === 'bStop') { const wasPresenting = out.source === 'screen'; stopOut(); renderBar(); renderStage(); toast(wasPresenting ? 'Présentation arrêtée' : 'Diffusion arrêtée', 'info'); }
      else if (b.id === 'bRec') rec.mr ? stopRecording() : startRecording();
      else if (b.id === 'bHand') { hand = !hand; sock.emit('live-hand', { up: hand }); renderBar(); toast(hand ? 'Main levée ✋ — l\'animateur est prévenu' : 'Main baissée', 'info'); }
      else if (b.id === 'bGive') { sock.emit('live-hand', { up: false }); endSpeaking(true); }
    };
  }

  /* ---------------- participants & modération ---------------- */
  function renderPeople() {
    const box = $('#pane-people', root); if (!box) return;
    const order = { host: 0, mod: 1, learner: 2 };
    const list = st.participants.slice().sort((a, b) => (order[a.role] - order[b.role]) || ((b.speaker ? 1 : 0) - (a.speaker ? 1 : 0)) || ((a.hand || 9e15) - (b.hand || 9e15)) || a.name.localeCompare(b.name));
    const pc = $('#pCount', root); if (pc) pc.textContent = list.length;
    const wb = $('#wBadge', root); if (wb) { wb.textContent = waitList.length; wb.classList.toggle('hidden', !staff() || !waitList.length); }
    const hands = list.filter(p => p.hand).length;
    box.innerHTML = `
      ${staff() && waitList.length ? `<div class="wait-box"><div class="row between"><b>Salle d'attente (${waitList.length})</b><button type="button" class="btn sm primary" data-mod="admitAll">Tout admettre</button></div>
        ${waitList.map(w => `<div class="p-row"><span class="grow">${esc(w.name)}</span><button type="button" class="btn sm" data-mod="admit" data-t="${w.id}">Admettre</button><button type="button" class="btn sm ghost" data-mod="deny" data-t="${w.id}">Refuser</button></div>`).join('')}</div>` : ''}
      ${staff() ? `<div class="row" style="gap:6px;flex-wrap:wrap;margin:8px 0"><button type="button" class="btn sm" data-mod="muteAll">🔇 Couper tous les micros</button>${hands ? `<button type="button" class="btn sm" data-mod="lowerAll">Baisser les ${hands} main(s)</button>` : ''}</div>` : ''}
      <div class="stack" style="gap:4px">${list.map(p => `<div class="p-row ${p.id === sock?.id ? 'me' : ''}">
        <span class="p-av">${esc((p.name || '?').charAt(0).toUpperCase())}</span>
        <span class="grow" style="min-width:0"><b>${esc(p.name)}</b>${p.id === sock?.id ? ' (vous)' : ''}<br><span class="tiny faint">${ROLE_LABEL[p.role]}${p.speaker ? ' · a la parole' : ''}</span></span>
        ${p.hand ? '<span title="Main levée">✋</span>' : ''}${p.speaker ? `<span>${p.muted ? '🔇' : '🎤'}</span>` : ''}
        ${staff() && p.role === 'learner' ? `<span class="p-actions">
          ${p.speaker ? `<button type="button" class="btn sm" data-mod="unfloor" data-t="${p.id}">Retirer la parole</button><button type="button" class="btn sm icon ghost" data-mod="mute" data-t="${p.id}" title="Couper son micro">🔇</button>` : `<button type="button" class="btn sm ${p.hand ? 'primary' : ''}" data-mod="floor" data-t="${p.id}">Donner la parole</button>`}
          <button type="button" class="btn sm icon ghost" data-mod="remove" data-t="${p.id}" title="Retirer de la salle">${icon('x', 'sm')}</button></span>` : ''}
      </div>`).join('')}</div>`;
    box.onclick = async (e) => {
      const b = e.target.closest('[data-mod]'); if (!b || !sock) return;
      if (b.dataset.mod === 'remove' && !(await confirmDialog('Retirer ce participant ?', 'Il ne pourra plus revenir dans cette salle pendant ce cours.', 'Retirer', true))) return;
      sock.emit('live-mod', { action: b.dataset.mod, target: b.dataset.t });
    };
  }

  /* ---------------- sondages ---------------- */
  function renderPoll() {
    const box = $('#pane-poll', root); if (!box) return;
    const p = st.poll;
    const voted = p && myVote && myVote.id === p.id;
    const results = p ? p.opts.map((o, i) => { const n = p.counts[i], pct = p.total ? Math.round(n / p.total * 100) : 0; return `<div class="poll-res ${voted && myVote.i === i ? 'mine' : ''}"><div class="row between small"><span>${esc(o)}</span><b>${pct} % · ${n}</b></div><div class="life"><i style="width:${pct}%"></i></div></div>`; }).join('') : '';
    box.innerHTML = `
      ${p ? `<div class="stack" style="gap:8px"><b style="font-size:15px">${esc(p.q)}</b><span class="tiny faint">${p.total} réponse(s)${p.open ? '' : ' · sondage clos'}</span>
        ${p.open && !voted && !staff() ? p.opts.map((o, i) => `<button type="button" class="btn block" data-vote="${i}">${esc(o)}</button>`).join('') : results}
        ${staff() ? `<div class="row" style="gap:6px">${p.open ? '<button type="button" class="btn sm" data-pm="pollClose">Clore le sondage</button>' : ''}<button type="button" class="btn sm ghost" data-pm="pollClear">Effacer</button></div>` : ''}</div>`
      : `<p class="small faint">${staff() ? 'Posez une question à la classe : les réponses s\'affichent en direct.' : 'Aucun sondage en cours.'}</p>`}
      ${staff() && (!p || !p.open) ? `<form id="pollForm" class="stack" style="gap:6px;margin-top:12px">
        <input class="input" id="pQ" maxlength="200" placeholder="Question (ex. Avez-vous compris ?)">
        <textarea class="input" id="pO" placeholder="Une réponse par ligne&#10;Oui&#10;Non&#10;Pas tout à fait" style="min-height:84px"></textarea>
        <button class="btn primary sm" type="submit">${icon('chart', 'sm')}Lancer le sondage</button></form>` : ''}`;
    box.onclick = (e) => {
      const v = e.target.closest('[data-vote]'); if (v && sock) { myVote = { id: p.id, i: +v.dataset.vote }; sock.emit('live-vote', { i: myVote.i }); renderPoll(); toast('Réponse envoyée', 'success'); return; }
      const m = e.target.closest('[data-pm]'); if (m && sock) sock.emit('live-mod', { action: m.dataset.pm });
    };
    const f = $('#pollForm', root);
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const q = $('#pQ', root).value.trim(), opts = $('#pO', root).value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!q || opts.length < 2) { toast('Une question et au moins 2 réponses', 'error'); return; }
      sock.emit('live-mod', { action: 'poll', q, opts }); toast('Sondage lancé', 'success');
    };
  }

  /* ---------------- régie (tuteur / modérateur) ---------------- */
  function renderRegie() {
    const box = $('#regie', root); if (!box) return;
    const host = role === 'host';
    box.innerHTML = `
      ${host && L.status !== 'live' ? `<button type="button" class="btn sm primary" data-st="live">${icon('play', 'sm')}Passer en direct</button>` : ''}
      ${host ? (L.status !== 'ended' ? `<button type="button" class="btn sm" data-st="ended">${icon('check', 'sm')}Terminer</button>` : '<button type="button" class="btn sm" data-st="live">Rouvrir</button>') : ''}
      ${isClass() ? `<button type="button" class="btn sm ${st.locked ? 'danger' : ''}" id="bLock">${st.locked ? '🔒 Salle verrouillée' : '🔓 Verrouiller la salle'}</button>
        <button type="button" class="btn sm ${st.waitingRoom ? 'primary' : ''}" id="bWR">${st.waitingRoom ? '🚪 Salle d\'attente : active' : '🚪 Salle d\'attente'}</button>
        <button type="button" class="btn sm" id="bAtt">${icon('download', 'sm')}Présence (Excel)</button>
        ${host && me.modKey ? `<button type="button" class="btn sm" id="bModLink">${icon('users', 'sm')}Lien modérateur</button>` : ''}` : ''}
      ${host ? `<button type="button" class="btn sm ghost" id="bChatT">${L.chat ? 'Fermer la discussion' : 'Ouvrir la discussion'}</button>
        <button type="button" class="btn sm danger" id="bDel">${icon('trash', 'sm')}Supprimer</button>` : ''}`;
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.st) return patch({ status: b.dataset.st });
      if (b.id === 'bLock') sock.emit('live-mod', { action: 'lock', on: !st.locked });
      if (b.id === 'bWR') sock.emit('live-mod', { action: 'waitingRoom', on: !st.waitingRoom });
      if (b.id === 'bAtt') exportAttendance();
      if (b.id === 'bModLink') { await copyText(linkOf(id) + '#m=' + me.modKey); toast('Lien modérateur copié : envoyez-le seulement à votre co-animateur', 'success', { duration: 6000 }); }
      if (b.id === 'bChatT') patch({ chat: !L.chat });
      if (b.id === 'bDel') {
        if (!(await confirmDialog('Supprimer ce direct ?', 'Le lien ne fonctionnera plus.', 'Supprimer', true))) return;
        try { await api('/api/lives/' + id, { method: 'DELETE', key: me.key }); mine.remove(id); toast('Direct supprimé', 'success'); navigate('/direct'); } catch (err) { toast(err.message, 'error'); }
      }
    };
  }
  async function patch(body) {
    try { L = Object.assign(L, await api('/api/lives/' + id, { method: 'PATCH', key: me.key, body })); draw(); } catch (e) { toast(e.message, 'error'); }
  }
  async function exportAttendance() {
    try {
      const r = await api(`/api/lives/${id}/attendance`, { key: me.key });
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const f = (t) => t ? new Date(t).toLocaleString('fr-FR') : '';
      const rows = [['Nom', 'Rôle', 'Arrivée', 'Dernière présence', 'Durée (min)', 'Connexions', 'En ligne']].concat(r.rows.sort((a, b) => a.first - b.first).map(x => [x.name, ROLE_LABEL[x.role] || x.role, f(x.first), f(x.last), x.minutes, x.joins, x.online ? 'oui' : 'non']));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(rw => rw.map(q).join(';')).join('\r\n')], { type: 'text/csv' }));
      a.download = `presence_${(r.title || 'cours').replace(/[\\/:*?"<>|]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      toast(`Liste de présence : ${r.rows.length} personne(s)`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------------- discussion ---------------- */
  function renderChat(list) {
    const box = $('#chat', root); if (!box) return;
    nMsg = list.length; setCount();
    box.innerHTML = list.length ? list.map(msgHtml).join('') : `<div class="lv-empty-chat" id="chEmpty"><span>💬</span><b>Aucun message pour l'instant</b><span class="small">Dites bonjour et lancez la discussion !</span></div>`;
    box.scrollTop = box.scrollHeight;
  }
  function setCount() { const c = $('#chCount', root); if (c) c.textContent = nMsg ? nMsg + ' message' + (nMsg > 1 ? 's' : '') : ''; }
  function msgHtml(m) {
    return `<div class="chat-msg ${m.h ? 'host' : ''}"><span class="lv-av" style="--h:${hue(m.n)}">${esc(initials(m.n))}</span><div class="lv-msg"><div class="lv-msg-head"><b>${esc(m.n)}</b>${m.h ? '<em>Animateur</em>' : ''}${m.at ? `<time>${hhmm(m.at)}</time>` : ''}</div><p>${esc(m.t)}</p></div></div>`;
  }
  function addMsg(m) {
    const box = $('#chat', root); if (!box) return;
    const e = $('#chEmpty', root); if (e) e.remove();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.insertAdjacentHTML('beforeend', msgHtml(m)); nMsg++; setCount();
    if (near) box.scrollTop = box.scrollHeight;
    if (isClass() && tab !== 'chat') { const b = root.querySelector('#tabs [data-tab="chat"]'); if (b) b.classList.add('pulse'); }
  }
  function bindCommon() {
    const link = linkOf(id);
    $('#shWa', root).onclick = () => shareTo('whatsapp', { link, text: `🔴 ${L.title} — ${isClass() ? 'rejoignez le cours en direct' : 'suivez le direct'}` });
    $('#shCopy', root).onclick = async () => { await copyText(link); toast('Lien copié', 'success'); };
    $('#shQr', root).onclick = () => {
      const bd = document.createElement('div'); bd.className = 'qr-full';
      bd.innerHTML = `<div class="qr-card"><div id="qrBox"></div><b>${esc(L.title)}</b><span class="small">${esc(link.replace(/^https?:\/\//, ''))}</span></div>`;
      bd.onclick = () => bd.remove(); document.body.appendChild(bd); renderQR($('#qrBox', bd), link);
    };
    const tabs = $('#tabs', root);
    if (tabs) {
      tabs.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { b.classList.remove('pulse'); setTab(b.dataset.tab); } };
      tabs.onkeydown = (e) => {
        const current = e.target.closest('[data-tab]');
        if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const buttons = [...tabs.querySelectorAll('[data-tab]')];
        const index = buttons.indexOf(current);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        setTab(buttons[next].dataset.tab);
        buttons[next].focus();
      };
    }
    const ed = $('#chAsEdit', root);
    if (ed) ed.onclick = () => { $('#chAs', root).classList.add('hidden'); const ni = $('#chName', root); ni.classList.remove('hidden'); ni.focus(); ni.select(); };
    $('#lvReacts', root).onclick = (e) => {
      const b = e.target.closest('[data-e]'); if (!b || !sock) return;
      const now = Date.now(); if (now - lastReact < 850) return; lastReact = now;
      sock.emit('live-react', { e: b.dataset.e });
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    };
    const f = $('#chatForm', root);
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const t = $('#chText', root).value.trim(); if (!t || !sock) return;
      const ni = $('#chName', root);
      if (ni) {
        const n = ni.value.trim(); if (!n) { toast('Indiquez votre nom', 'error'); ni.classList.remove('hidden'); ni.focus(); return; }
        if (n !== ls.get('tx_comment_name', '') || !ni.classList.contains('hidden')) { ls.set('tx_comment_name', n); sock.emit('live-name', { name: n }); }
        ni.classList.add('hidden'); const as = $('#chAs', root); if (as) { as.classList.remove('hidden'); $('#chAsName', root).textContent = n; }
      }
      sock.emit('live-chat', { text: t }); $('#chText', root).value = '';
    };
  }

  /* ---------------- temps réel ---------------- */
  async function connect() {
    sock = await getSocket();
    const on = (e, fn) => { sock.on(e, fn); handlers.push([e, fn]); };
    const join = () => sock.emit('live-join', { id, key: me && me.key, name: ls.get('tx_comment_name', '') || (me ? L.hostName : ''), v: visitorId() }, (r) => {
      if (!r || r.error) { if (r && r.error) { toast(r.error, 'error', { duration: 8000 }); const s = $('#stage', root); if (s) s.innerHTML = overlay('Accès impossible', esc(r.error)); } return; }
      role = r.role || role;
      if (r.waiting) { waiting = true; renderStage(); }
      setViewers(r.viewers || 0);
    });
    on('connect', join); if (sock.connected) join();
    on('live-admitted', ({ role: rl, hostPeer: hp }) => {
      const was = waiting; waiting = false; joined = true; role = rl || role; if (hp) hostPeer = hp;
      if (was) { toast('Vous êtes dans la salle 🎓', 'success'); renderStage(); }
      if (out.stream) sock.emit('live-peers', null, (list) => list.forEach(offerTo));   // reconnexion pendant une diffusion
    });
    on('live-chat', (m) => addMsg(m));
    on('live-react', ({ e }) => floatReaction(e));
    on('live-viewers', (d) => { if (d.id === id) setViewers(d.n); });
    on('live-update', (u) => {
      if (u.deleted) { toast('Ce direct a été supprimé', 'info'); L.status = 'ended'; renderStage(); return; }
      const reStage = u.status !== L.status; L = Object.assign(L, u);
      if (staff()) draw(); else if (reStage) { const b = $('#lBadge', root); if (b) { b.className = 'live-badge ' + (L.status === 'live' ? 'on' : ''); b.textContent = badgeText(); } const w = $('#lvWrap', root); if (w) w.classList.toggle('is-live', L.status === 'live'); renderStage(); }
    });
    if (!isClass()) return;
    on('live-state', (s) => {
      const prevPoll = st.poll && st.poll.id; st = s;
      renderPeople(); renderPoll(); renderTiles();
      if (staff()) renderRegie();
      if (s.poll && s.poll.id !== prevPoll && s.poll.open && !staff()) { toast('📊 Nouveau sondage', 'info'); setTab('poll'); }
      const meP = s.participants.find(p => p.id === sock.id); if (meP && !meP.hand && hand) { hand = false; renderBar(); }
    });
    on('live-waiting', (w) => { waitList = w; renderPeople(); });
    on('live-knock', ({ name }) => toast(`🚪 ${name} attend dans la salle d'attente`, 'info', { action: 'Voir', onAction: () => setTab('people') }));
    on('live-hand-up', ({ name }) => toast(`✋ ${name} lève la main`, 'info', { action: 'Voir', onAction: () => setTab('people') }));
    on('live-host', ({ online, peer }) => {
      if (online) hostPeer = peer;
      else { const x = hostPeer && inc.get(hostPeer); if (x) { x.pc.close(); inc.delete(hostPeer); } hostPeer = null; if (role !== 'host') renderStage(); }
    });
    on('live-viewer', ({ peer }) => { if (out.stream) offerTo(peer); });
    on('live-viewer-left', ({ peer }) => { closeOut(peer); closeIn(peer); });
    on('live-speaker-off', ({ peer }) => { closeIn(peer); });
    on('live-floor', ({ on: ok }) => { if (ok) beginSpeaking(); else endSpeaking(false); });
    on('live-muted', ({ by }) => { if (out.stream && out.mic) { toggleMic(false); toast(`${by} a coupé votre micro`, 'info'); } });
    on('live-kicked', (d) => { stopOut(true); inc.forEach(x => x.pc.close()); inc.clear(); const s = $('#stage', root); if (s) s.innerHTML = overlay(d && d.denied ? 'Accès refusé' : 'Vous avez été retiré de la salle', 'L\'animateur a mis fin à votre participation.'); const bar = $('#bar', root); if (bar) bar.innerHTML = ''; });
    on('live-signal', onSignal);
  }
  function setViewers(n) { L.viewers = n; const e = $('#lViewers b', root); if (e) e.textContent = n; }

  /* ---------------- WebRTC : d = 'o' (émis par le pc SORTANT de l'expéditeur) / 'i' (par son pc ENTRANT) ---------------- */
  async function onSignal({ from, data }) {
    try {
      if (data.sdp && data.sdp.type === 'offer') {
        let x = inc.get(from);
        if (!x || ['failed', 'closed'].includes(x.pc.connectionState)) {
          if (x) x.pc.close();
          const pc = new RTCPeerConnection({ iceServers: await ice() });
          x = { pc, q: [], stream: null }; inc.set(from, x);
          pc.ontrack = (ev) => {
            x.stream = ev.streams[0] || new MediaStream([ev.track]);
            if (from === hostPeer || (!hostPeer && role !== 'host' && !st.participants.find(p => p.id === from && p.speaker))) { hostPeer = hostPeer || from; attachMain(x.stream); }
            else renderTiles();
            if (rec.mr && rec.ctx) mixIn(x.stream);
            ev.track.onunmute = () => renderTiles(); ev.track.onended = () => renderTiles();
          };
          pc.onicecandidate = (ev) => { if (ev.candidate) sock.emit('live-signal', { to: from, data: { c: ev.candidate, d: 'i' } }); };
        }
        await x.pc.setRemoteDescription(data.sdp);
        for (const c of x.q) await x.pc.addIceCandidate(c).catch(() => {}); x.q = [];
        const ans = await x.pc.createAnswer(); await x.pc.setLocalDescription(ans);
        sock.emit('live-signal', { to: from, data: { sdp: x.pc.localDescription } });
      } else if (data.sdp && data.sdp.type === 'answer') {
        const pc = out.pcs.get(from); if (!pc) return;
        await pc.setRemoteDescription(data.sdp);
        for (const c of pc._q || []) await pc.addIceCandidate(c).catch(() => {}); pc._q = [];
      } else if (data.c) {
        if (data.d === 'o') { const x = inc.get(from); if (!x) return; if (x.pc.remoteDescription) await x.pc.addIceCandidate(data.c).catch(() => {}); else x.q.push(data.c); }
        else { const pc = out.pcs.get(from); if (!pc) return; if (pc.remoteDescription) await pc.addIceCandidate(data.c).catch(() => {}); else (pc._q = pc._q || []).push(data.c); }
      }
    } catch (e) { /* ignore */ }
  }
  function closeIn(peer) { const x = inc.get(peer); if (!x) return; x.pc.close(); inc.delete(peer); if (peer === hostPeer) { hostPeer = null; if (role !== 'host') renderStage(); } renderTiles(); }
  function closeOut(peer) { const pc = out.pcs.get(peer); if (pc) { pc.close(); out.pcs.delete(peer); peersCount(); } }
  function peersCount() { const e = $('#nPeers', root); if (e) e.textContent = out.pcs.size; tuneBitrate(); }

  async function offerTo(peer) {
    if (!out.stream || !sock || peer === sock.id) return;
    closeOut(peer);
    const pc = new RTCPeerConnection({ iceServers: await ice() });
    out.pcs.set(peer, pc); peersCount();
    out.stream.getTracks().forEach(t => pc.addTrack(t, out.stream));
    pc.onicecandidate = (e) => { if (e.candidate) sock.emit('live-signal', { to: peer, data: { c: e.candidate, d: 'o' } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && out.pcs.get(peer) === pc) { out.pcs.delete(peer); peersCount(); } if (pc.connectionState === 'connected') tuneBitrate(); };
    await sendOffer(pc, peer);
  }
  async function sendOffer(pc, peer) { try { const o = await pc.createOffer(); await pc.setLocalDescription(o); sock.emit('live-signal', { to: peer, data: { sdp: pc.localDescription } }); } catch (e) { /* ignore */ } }
  function tuneBitrate() {
    const n = Math.max(1, out.pcs.size), speaker = role !== 'host';
    const max = speaker ? (n <= 5 ? 400e3 : 200e3) : (n <= 3 ? 1500e3 : n <= 8 ? 800e3 : n <= 15 ? 500e3 : 350e3);
    for (const pc of out.pcs.values()) pc.getSenders().forEach(sd => {
      if (!sd.track || sd.track.kind !== 'video') return;
      const p = sd.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = max; sd.setParameters(p).catch(() => {});
    });
  }
  /** Remplace les pistes envoyées sans couper les participants */
  function swapTracks() {
    for (const [peer, pc] of out.pcs) {
      const senders = pc.getSenders();
      for (const tr of out.stream.getTracks()) { const sd = senders.find(x => x.track && x.track.kind === tr.kind) || senders.find(x => !x.track); if (sd) sd.replaceTrack(tr); else pc.addTrack(tr, out.stream); }
      senders.forEach(sd => { if (sd.track && !out.stream.getTracks().includes(sd.track)) sd.replaceTrack(null); });
      sendOffer(pc, peer);
    }
  }

  async function switchCamera() {
    if (!out.stream || out.source !== 'camera' || !navigator.mediaDevices?.getUserMedia) return;
    const oldTrack = out.stream.getVideoTracks().find(track => track.readyState === 'live');
    if (!oldTrack) { toast('Aucune caméra active à changer.', 'error'); return; }
    const settings = oldTrack.getSettings();
    let nextTrack;
    try {
      const cameras = navigator.mediaDevices.enumerateDevices
        ? (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput')
        : [];
      const currentIndex = cameras.findIndex(device => device.deviceId && device.deviceId === settings.deviceId);
      if (cameras.length > 1 && currentIndex >= 0) {
        const nextCamera = cameras[(currentIndex + 1) % cameras.length];
        try {
          const selected = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: nextCamera.deviceId } }, audio: false });
          nextTrack = selected.getVideoTracks()[0];
        } catch (e) { /* Retente avec facingMode quand la sélection par appareil échoue. */ }
      }
      if (!nextTrack) {
        const facingMode = settings.facingMode === 'environment' ? 'user' : 'environment';
        const selected = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 360 } }, audio: false });
        nextTrack = selected.getVideoTracks()[0];
      }
      if (!nextTrack) throw new Error('Aucune piste caméra n’a été fournie.');
    } catch (e) {
      toast('Impossible de changer de caméra. Vérifiez les permissions et les caméras disponibles.', 'error');
      return;
    }

    const stream = out.stream;
    stream.removeTrack(oldTrack);
    stream.addTrack(nextTrack);
    oldTrack.stop();
    nextTrack.onended = () => {
      if (out.stream !== stream || !stream.getTracks().includes(nextTrack)) return;
      if (role === 'host') { stopOut(); renderBar(); renderStage(); }
      else toggleCam(false);
    };
    if (out.pcs.size) swapTracks();
    if (rec.mr) restartRecordingPart();
    renderBar();
    renderTiles();
    toast('Caméra changée', 'success');
  }

  async function startOut(kind) {
    let s;
    try {
      if (kind === 'screen') {
        s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
        try { const mic = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }); if (!s.getAudioTracks().length) mic.getAudioTracks().forEach(t => s.addTrack(t)); else s.addTrack(mic.getAudioTracks()[0]); } catch (e) { /* écran sans micro */ }
      } else if (kind === 'audio') s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
      else s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: role === 'host' ? 1280 : 640 }, height: { ideal: role === 'host' ? 720 : 360 }, frameRate: { ideal: role === 'host' ? 30 : 20 } }, audio: AUDIO });
    } catch (e) { toast(kind === 'screen' ? 'Partage d\'écran refusé ou non disponible sur cet appareil' : 'Accès à la caméra / au micro refusé', 'error'); return false; }
    const old = out.stream; out.stream = s; out.source = kind;
    s.getAudioTracks().forEach(t => { t.enabled = out.mic; });
    s.getVideoTracks().forEach(t => { t.onended = () => { if (out.stream === s) { if (role === 'host') { stopOut(); renderBar(); renderStage(); } else { toggleCam(false); } } }; });
    if (out.pcs.size) swapTracks();
    if (old) old.getTracks().forEach(t => { if (!s.getTracks().includes(t)) t.stop(); });
    if (rec.mr) restartRecordingPart();
    if (role === 'host') { if (L.status !== 'live') patch({ status: 'live' }); else { renderBar(); renderStage(); } }
    sock.emit('live-peers', null, (list) => list.forEach(p => { if (!out.pcs.has(p)) offerTo(p); }));
    if (role === 'host') toast('Vous êtes en direct 🔴', 'success');
    return true;
  }
  function stopOut(silent) {
    for (const pc of out.pcs.values()) pc.close(); out.pcs.clear();
    if (out.stream) out.stream.getTracks().forEach(t => t.stop());
    out.stream = null; out.source = null;
    if (rec.mr) stopRecording();
    if (!silent && root) toast('Diffusion arrêtée', 'info');
  }
  function toggleMic(force) {
    out.mic = force != null ? force : !out.mic;
    if (out.stream) out.stream.getAudioTracks().forEach(t => { t.enabled = out.mic; });
    if (sock) sock.emit('live-muted-self', { muted: !out.mic });
    renderBar(); renderTiles();
  }
  async function toggleCam(force) {
    if (!out.stream) return;
    const has = out.stream.getVideoTracks().length > 0;
    const want = force != null ? force : !has;
    if (want && !has) {
      try {
        const v = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20 } } });
        out.stream.addTrack(v.getVideoTracks()[0]);
      } catch (e) { toast('Caméra indisponible ou refusée', 'error'); return; }
    } else if (!want && has) { out.stream.getVideoTracks().forEach(t => { t.stop(); out.stream.removeTrack(t); }); }
    swapTracks(); renderBar(); renderTiles();
  }
  /* L'animateur donne la parole : micro (caméra en option) diffusés à toute la classe */
  async function beginSpeaking() {
    if (speaking) return;
    speaking = true; hand = false; out.mic = true;
    toast('🎤 L\'animateur vous donne la parole', 'success');
    const ok = await startOut('audio');
    if (!ok) { speaking = false; sock.emit('live-hand', { up: false }); }
    renderBar(); renderTiles();
  }
  function endSpeaking(self) {
    if (!speaking) return;
    speaking = false; stopOut(true);
    toast(self ? 'Vous avez rendu la parole' : 'La parole vous a été retirée', 'info');
    renderBar(); renderTiles();
    if (self) sock.emit('live-giveback');
  }

  /* ---------------- réactions ---------------- */
  function floatReaction(e) {
    const layer = $('#reacts', root); if (!layer) return;
    const el = document.createElement('span'); el.className = 'react-float'; el.textContent = e;
    el.style.left = (6 + Math.random() * 22) + '%';
    el.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
    el.style.fontSize = (28 + Math.random() * 14).toFixed(0) + 'px';
    while (layer.children.length > 24) layer.firstChild.remove();
    layer.appendChild(el); setTimeout(() => el.remove(), 2600);
  }

  /* ---------------- enregistrement du cours (côté tuteur) ---------------- */
  function mixIn(stream) {
    if (!rec.ctx || !stream || rec.srcs.has(stream.id) || !stream.getAudioTracks().length) return;
    try { rec.ctx.createMediaStreamSource(stream).connect(rec.dest); rec.srcs.add(stream.id); } catch (e) { /* ignore */ }
  }
  function recStream() {
    const tracks = [];
    const vt = out.stream && out.stream.getVideoTracks()[0]; if (vt) tracks.push(vt);
    rec.dest.stream.getAudioTracks().forEach(t => tracks.push(t));
    return new MediaStream(tracks);
  }
  function newRecorder() {
    mixIn(out.stream); inc.forEach(x => mixIn(x.stream));
    const stream = recStream();
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mime = stream.getVideoTracks().length ? types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4');
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => { if (chunks.length) rec.parts.push(new Blob(chunks, { type: mr.mimeType || mime })); if (rec.finishing && !rec.mr) finishRecording(); };
    mr.start(4000);
    return mr;
  }
  function startRecording() {
    if (!out.stream || !window.MediaRecorder) { toast('Enregistrement non disponible sur ce navigateur', 'error'); return; }
    rec.ctx = new (window.AudioContext || window.webkitAudioContext)(); rec.dest = rec.ctx.createMediaStreamDestination();
    rec.parts = []; rec.finishing = false; rec.started = Date.now(); rec.srcs.clear();
    rec.mr = newRecorder();
    toast('⏺ Enregistrement démarré', 'success'); renderBar();
  }
  function restartRecordingPart() { const old = rec.mr; rec.mr = null; old.stop(); rec.mr = newRecorder(); }
  function stopRecording() {
    const mr = rec.mr; if (!mr) return;
    rec.mr = null; rec.finishing = true; mr.stop();
    if (rec.ctx) { rec.ctx.close().catch(() => {}); rec.ctx = null; }
    if (root) renderBar();
  }
  function finishRecording() {
    rec.finishing = false;
    const parts = rec.parts.slice(); rec.parts = [];
    if (!parts.length) return;
    const ext = (b) => (b.type.includes('mp4') ? 'mp4' : 'webm');
    const base = (L.title || 'cours').replace(/[\\/:*?"<>|]+/g, '_') + '_' + new Date(rec.started || Date.now()).toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const files = parts.map((b, i) => new File([b], `${base}${parts.length > 1 ? '_partie' + (i + 1) : ''}.${ext(b)}`, { type: b.type }));
    const size = files.reduce((s, f) => s + f.size, 0);
    modal({
      title: 'Enregistrement du cours prêt',
      body: `<p class="muted">${files.length} fichier(s) · ${(size / 1048576).toFixed(1)} Mo. Publiez-le en replay : un lien Lestha Send avec lecture en ligne et remarques horodatées, à envoyer aux absents.</p><div id="recUp" class="stack" style="gap:6px"></div>`,
      actions: [{ label: 'Télécharger', value: 'dl' }, { label: 'Publier le replay', cls: 'primary', value: 'pub', handler: () => { publishReplay(files); return false; } }]
    }).then(v => { if (v === 'dl') files.forEach(f => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }); });
  }
  async function publishReplay(files) {
    const box = document.querySelector('#recUp'); const say = (h) => { if (box) box.innerHTML = h; };
    try {
      const cfg = await getConfig();
      if (cfg.cloudEnabled === false) throw new Error('Mode Cloud indisponible : téléchargez l\'enregistrement.');
      const headers = cfg.uploadCodeRequired ? { 'X-Upload-Code': ls.get('tx_upload_code', '') } : {};
      const r = await api('/api/transfers', { method: 'POST', headers, body: { title: 'Replay — ' + L.title, ttl: 30 * 86400e3, playback: 'on', allowComments: true, senderName: L.hostName || '', files: files.map(f => ({ name: f.name, size: f.size, type: f.type, lastModified: Date.now() })) } });
      say(`<div class="small">Envoi du replay… <b id="rp">0 %</b></div><div class="life"><i id="rb" style="width:0%"></i></div>`);
      const up = new Uploader({ id: r.id, key: r.ownerKey, items: files.map((f, i) => ({ file: f, meta: r.files[i] })) });
      up.addEventListener('progress', (e) => { const p = e.detail.total ? e.detail.loaded / e.detail.total * 100 : 100; const a = document.querySelector('#rp'), b = document.querySelector('#rb'); if (a) a.textContent = Math.floor(p) + ' %'; if (b) b.style.width = p + '%'; });
      up.addEventListener('error', (e) => say(`<div class="banner bad">${esc(e.detail.message)}</div>`));
      up.addEventListener('done', async () => {
        const f = await api(`/api/transfers/${r.id}/finalize`, { method: 'POST', key: r.ownerKey, body: {} });
        owned.upsert({ id: r.id, key: r.ownerKey, title: 'Replay — ' + L.title, createdAt: Date.now() });
        const link = (f.link || r.link || (location.origin + '/t/' + r.id)).replace('/t/', '/w/');
        say(`<div class="banner info">${icon('check')}<span>Replay en ligne !</span></div><div class="row" style="gap:6px"><input class="input" readonly value="${esc(link)}"><button type="button" class="btn primary" id="rpCopy">Copier</button></div>`);
        const c = document.querySelector('#rpCopy'); if (c) c.onclick = async () => { await copyText(link); toast('Lien du replay copié', 'success'); };
        if (sock && L.chat) sock.emit('live-chat', { text: '🎬 Replay du cours : ' + link });
      });
      up.start();
    } catch (e) { say(`<div class="banner bad">${esc(e.message)}</div>`); }
  }
})();
