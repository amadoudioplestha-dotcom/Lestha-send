/* Lestha Send — « Demande de fichiers » : créer un lien de dépôt, déposer, gérer les dépôts reçus */
import { $, $$, esc, icon, bytes, speed, duration, timeLeft, relTime, fmtDate, fileKind, ls, ss, api, getConfig, toast, modal, confirmDialog, renderQR, confetti, keepAwake, notify, getSocket, visitorId, copyText, isMobile, animateCount, ensureVerified, verifiedEmail, captchaToken } from './core.js';
import { navigate } from './router.js';
import { Uploader } from './uploader.js';
import { pick, bindShare, shareGrid } from './send.js';

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3, MB = 1024 ** 2;
const owned = {
  all: () => ls.get('tx_requests', []),
  get: (id) => owned.all().find(x => x.id === id),
  upsert(it) { const l = owned.all().filter(x => x.id !== it.id); l.unshift(Object.assign(owned.get(it.id) || {}, it)); ls.set('tx_requests', l.slice(0, 200)); },
  remove(id) { ls.set('tx_requests', owned.all().filter(x => x.id !== id)); }
};
export const ownedRequests = owned;

/* ====================================================================== */
/*  1. Créer une demande                                                    */
/* ====================================================================== */
export const createView = {
  async render(root) {
    const cfg = await getConfig();
    const o = { ttl: 7 * DAY, maxBytes: 5 * GB };
    root.innerHTML = `
    <section class="narrow stack">
      <div class="hero" style="margin-bottom:6px">
        <span class="eyebrow"><span class="pulse-dot"></span>Demande de fichiers</span>
        <h1 style="font-size:clamp(30px,5.4vw,46px)">Recevez des fichiers <span class="grad-text">sans effort.</span></h1>
        <p class="lead">Créez un lien de dépôt et partagez-le : apprenants, clients ou collègues y déposent leurs fichiers, vous les retrouvez tous au même endroit.</p>
      </div>
      ${cfg.cloudEnabled === false ? `<div class="banner bad">${icon('x')}<span>Le stockage Cloud n'est pas configuré sur ce serveur : la demande de fichiers est indisponible.</span></div>` : ''}
      <form class="card glow stack" id="rf">
        <label class="field"><span>Titre de la demande</span><input class="input" id="rTitle" maxlength="140" required placeholder="Ex. Rendus TP infographie — Groupe A"></label>
        <label class="field"><span>Consignes (facultatif)</span><textarea class="input" id="rMsg" maxlength="1500" placeholder="Format attendu, nommage des fichiers, date limite…"></textarea></label>
        <label class="field"><span>Votre nom</span><input class="input" id="rName" maxlength="80" value="${esc(ls.get('tx_sender_name', ''))}" placeholder="Affiché aux déposants"></label>
        <div class="field"><span>${icon('clock', 'sm')}Dépôts ouverts pendant</span><div class="chips" id="rTtl">${[[DAY, '1 jour'], [3 * DAY, '3 jours'], [7 * DAY, '7 jours'], [14 * DAY, '14 jours'], [30 * DAY, '30 jours']].filter(([v]) => v <= (cfg.maxTtl || 30 * DAY)).map(([v, l]) => `<button type="button" class="chip ${v === o.ttl ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
        <div class="field"><span>${icon('cloud', 'sm')}Taille maximale par dépôt</span><div class="chips" id="rMax">${[[100 * MB, '100 Mo'], [GB, '1 Go'], [5 * GB, '5 Go'], [20 * GB, '20 Go'], [100 * GB, '100 Go']].map(([v, l]) => `<button type="button" class="chip ${v === o.maxBytes ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
        <label class="field"><span>${icon('lock', 'sm')}Code pour déposer (facultatif)</span><input class="input" id="rPin" inputmode="numeric" maxlength="8" placeholder="6 à 8 chiffres"></label>
        ${cfg.email ? `<label class="switch"><input type="checkbox" id="rNotify"><span class="track"></span><span class="small">M'avertir par e-mail à chaque dépôt</span></label>
        <label class="field hidden" id="rMailF"><span>Votre e-mail (confirmé par un code)</span><input class="input" id="rMail" type="email" value="${esc(verifiedEmail() || ls.get('tx_sender_email', ''))}" ${verifiedEmail() ? 'readonly' : ''}></label>` : ''}
        <button class="btn primary xl block" type="submit" ${cfg.cloudEnabled === false ? 'disabled' : ''}>${icon('inbox')}Créer le lien de dépôt</button>
      </form>
    </section>`;
    const chips = (sel, key) => $(sel, root).addEventListener('click', (e) => { const c = e.target.closest('[data-v]'); if (!c) return; o[key] = Number(c.dataset.v); $$(sel + ' .chip', root).forEach(x => x.classList.toggle('active', x === c)); });
    chips('#rTtl', 'ttl'); chips('#rMax', 'maxBytes');
    const pin = $('#rPin', root); pin.oninput = () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 8); };
    const nt = $('#rNotify', root); if (nt) nt.onchange = () => $('#rMailF', root).classList.toggle('hidden', !nt.checked);
    $('#rf', root).onsubmit = async (e) => {
      e.preventDefault();
      const body = { title: $('#rTitle', root).value.trim(), message: $('#rMsg', root).value.trim(), ownerName: $('#rName', root).value.trim(), ttl: o.ttl, maxBytes: o.maxBytes, pin: pin.value || null };
      if (body.pin && !/^\d{6,8}$/.test(body.pin)) return toast('Le code contient 6 à 8 chiffres', 'warn');
      // Une demande de fichiers est réservée aux adresses confirmées (sauf instance privée avec code d'accès)
      if (cfg.tier !== 'full' && !verifiedEmail()) {
        const ok = await ensureVerified('Les demandes de fichiers sont réservées aux adresses e-mail confirmées. C\'est gratuit et prend une minute.');
        if (!ok) return;
      }
      if (nt && nt.checked) { body.notify = true; body.ownerEmail = verifiedEmail() || $('#rMail', root).value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.ownerEmail)) return toast('E-mail invalide', 'warn'); ls.set('tx_sender_email', body.ownerEmail); }
      ls.set('tx_sender_name', body.ownerName);
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Création…';
      let r;
      for (let attempt = 0; ; attempt++) {
        if (cfg.uploadCodeRequired && !ls.get('tx_upload_code', '')) {
          const code = await modal({ title: 'Code d\'accès', body: '<p class="small muted" style="margin-bottom:10px">Saisissez le code d\'accès de cette instance Lestha Send.</p><input class="input" id="upCode" type="password">', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Valider', cls: 'primary', handler: (bd) => bd.querySelector('#upCode').value.trim() || false }] });
          if (!code) { btn.disabled = false; btn.innerHTML = icon('inbox') + 'Créer le lien de dépôt'; return; }
          ls.set('tx_upload_code', code);
        }
        const headers = { 'X-Upload-Code': ls.get('tx_upload_code', '') };
        if (cfg.tier !== 'full') { const cap = await captchaToken(); if (cap) headers['X-Turnstile'] = cap; }
        try { r = await api('/api/requests', { method: 'POST', body, headers }); break; }
        catch (err) {
          if (err.status === 401 && err.data && err.data.needCode) { ls.del('tx_upload_code'); cfg.uploadCodeRequired = true; toast('Code d\'accès incorrect', 'warn'); continue; }
          if (attempt < 2 && err.data && err.data.needVerify && await ensureVerified()) continue;
          if (attempt < 2 && err.data && err.data.needCaptcha) continue;
          toast(err.message, 'error'); btn.disabled = false; btn.innerHTML = icon('inbox') + 'Créer le lien de dépôt'; return;
        }
      }
      owned.upsert({ id: r.id, key: r.ownerKey, title: body.title || 'Déposez vos fichiers', createdAt: Date.now(), expiresAt: r.expiresAt });
      success(root, r, body);
    };
  }
};

function success(root, r, body) {
  root.innerHTML = `
  <section class="narrow stack"><div class="card glow stack">
    <div class="center"><div class="success-burst">${icon('check')}</div><h2>Votre lien de dépôt est prêt</h2><p class="muted" style="margin-top:6px">${esc(body.title || 'Déposez vos fichiers')} · ouvert ${timeLeft(r.expiresAt - Date.now())}</p></div>
    <div class="link-box"><input id="shareLink" readonly value="${esc(r.link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
    ${shareGrid()}
    <div class="qr-card"><div class="qr" id="qrBox"></div><div class="stack" style="gap:6px"><h3>Scannez pour déposer</h3><p class="small muted">Idéal à projeter en classe : chacun dépose ses fichiers depuis son téléphone ou son ordinateur.</p></div></div>
    <div class="row wrap"><a class="btn grow" href="/r/${esc(r.id)}" data-link>${icon('inbox')}Voir les dépôts</a><a class="btn ghost grow" href="/demande" data-link id="again">${icon('plus')}Nouvelle demande</a></div>
  </div></section>`;
  bindShare(root, r.link, body.title || 'Déposez vos fichiers', null);
  root.querySelectorAll('[data-share]').forEach(b => { const old = b.onclick; b.onclick = () => { if (b.dataset.share !== 'mail') return old(); location.href = `mailto:?subject=${encodeURIComponent(body.title || 'Déposez vos fichiers')}&body=${encodeURIComponent('Déposez vos fichiers ici : ' + r.link)}`; }; });
  renderQR($('#qrBox', root), r.link);
  $('#again', root).onclick = (e) => { e.preventDefault(); createView.render(root); };
  confetti(40);
}

/* ====================================================================== */
/*  2. Déposer (page publique)                                              */
/* ====================================================================== */
export const depositView = (() => {
  let root, id, info, items = [], up = null;
  const token = () => ss.get('tx_dtk_' + id);
  return {
    async render(r, { match }) {
      root = r; id = match[1]; items = [];
      root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:380px;border-radius:20px"></div></section>`;
      await load();
    },
    destroy() { if (up && up.state === 'running') toast('Dépôt en cours : gardez la page ouverte', 'warn'); root = null; }
  };
  async function load() {
    try { info = await api(`/api/public/d/${id}?v=${encodeURIComponent(visitorId())}`, { token: token() }); }
    catch (e) { return screen('bad', 'x', 'Lien introuvable', 'Ce lien de dépôt n\'existe pas ou a expiré.'); }
    if (info.state === 'expired') return screen('warn', 'clock', 'Dépôts terminés', 'La période de dépôt est terminée. Contactez la personne qui vous a envoyé ce lien.');
    if (info.state === 'closed') return screen('warn', 'lock', 'Dépôts fermés', 'Les dépôts sont temporairement fermés par l\'organisateur.');
    if (info.locked) return pinGate();
    form();
  }
  function screen(kind, ic, t, m) { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon ${kind}">${icon(ic)}</div><h2>${esc(t)}</h2><p class="muted">${esc(m)}</p></div></div></section>`; }
  function pinGate(err = '') {
    root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon info">${icon('lock')}</div><h2>${esc(info.title)}</h2><p class="muted">Saisissez le code communiqué par ${esc(info.ownerName || 'l\'organisateur')} pour déposer vos fichiers.</p>
      <form id="pf" class="stack" style="width:100%;max-width:320px"><input class="input pin-input" id="pe" inputmode="numeric" maxlength="8" placeholder="••••"><button class="btn primary block" type="submit">${icon('unlock')}Continuer</button>${err ? `<p class="small" style="color:var(--rose)">${esc(err)}</p>` : ''}</form></div></div></section>`;
    $('#pf', root).onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api(`/api/public/d/${id}/unlock`, { method: 'POST', body: { pin: $('#pe', root).value.trim() } }); ss.set('tx_dtk_' + id, r.token); load(); }
      catch (e2) { pinGate(e2.message); }
    };
  }
  function form() {
    const total = items.reduce((s, it) => s + it.file.size, 0);
    root.innerHTML = `
    <section class="narrow stack">
      <div class="card glow stack">
        <div class="sender-head"><div class="avatar">${icon('inbox')}</div><div style="min-width:0"><div class="small muted">${info.ownerName ? esc(info.ownerName) + ' vous demande des fichiers' : 'Demande de fichiers'} · ouvert encore ${timeLeft(info.expiresAt - Date.now())}</div><h2 style="font-size:clamp(20px,4vw,28px)">${esc(info.title)}</h2></div></div>
        ${info.message ? `<div class="message-bubble">${esc(info.message)}</div>` : ''}
        <label class="field"><span>Votre nom *</span><input class="input" id="dName" maxlength="80" value="${esc(ls.get('tx_depositor_name', ''))}" placeholder="Prénom et nom"></label>
        <div id="dz" class="dropzone ${items.length ? 'compact' : ''}" tabindex="0" role="button">
          <div class="dz-orb">${icon(items.length ? 'plus' : 'upload')}</div>
          <div><div class="dz-title">${items.length ? 'Ajouter d\'autres fichiers' : isMobile ? 'Touchez pour choisir vos fichiers' : 'Glissez vos fichiers ici'}</div><div class="dz-sub">Jusqu'à ${bytes(info.maxBytes, 0)} par dépôt</div></div>
          ${items.length ? '' : `<div class="dz-actions"><button type="button" class="chip" data-pick="files">${icon('file', 'sm')}Fichiers</button><button type="button" class="chip" data-pick="folder">${icon('folder', 'sm')}Dossier</button>${isMobile ? `<button type="button" class="chip" data-pick="gallery">${icon('image', 'sm')}Galerie</button>` : ''}</div>`}
        </div>
        ${items.length ? `<div class="file-list">${items.map((it, i) => { const k = fileKind(it.file.name, it.file.type); return `<div class="file-row"><div class="ficon" style="--c:${k.c}">${icon(k.icon)}</div><div class="fmeta"><div class="fname">${esc(it.path || it.file.name)}</div><div class="fsub">${bytes(it.file.size)}</div></div><button type="button" class="btn sm icon ghost" data-rm="${i}">${icon('x', 'sm')}</button></div>`; }).join('')}</div>
          <div class="file-summary"><span>${items.length} fichier(s)</span><b style="${total > info.maxBytes ? 'color:var(--rose)' : ''}">${bytes(total)}</b></div>` : ''}
        <label class="field"><span>Message (facultatif)</span><textarea class="input" id="dMsg" maxlength="1500" placeholder="Un mot pour l'organisateur…"></textarea></label>
        <button type="button" class="btn primary xl block" id="dGo" ${items.length && total <= info.maxBytes ? '' : 'disabled'}>${icon('upload')}Déposer${items.length ? ' · ' + bytes(total) : ''}</button>
      </div>
    </section>`;
    const dz = $('#dz', root);
    dz.onclick = async (e) => { const c = e.target.closest('[data-pick]'); const kind = c ? c.dataset.pick : 'files'; const fs = await pick(kind); add(fs.map(f => ({ file: f, path: kind === 'folder' ? f.webkitRelativePath || null : null }))); };
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); add([...e.dataTransfer.files].map(f => ({ file: f, path: null }))); });
    root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { keep(); items.splice(+b.dataset.rm, 1); form(); });
    $('#dGo', root).onclick = start;
  }
  function keep() { const n = $('#dName', root); if (n) ls.set('tx_depositor_name', n.value.trim()); const m = $('#dMsg', root); if (m) keep.msg = m.value; }
  function add(list) { if (!list.length) return; keep(); items.push(...list); form(); if (keep.msg) $('#dMsg', root).value = keep.msg; }

  async function start() {
    keep();
    const name = ($('#dName', root).value || '').trim();
    if (!name) { toast('Indiquez votre nom', 'warn'); return $('#dName', root).focus(); }
    const btn = $('#dGo', root); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Préparation…';
    let r;
    try {
      const capTok = await captchaToken();
      r = await api(`/api/public/d/${id}/deposit`, { method: 'POST', token: token(), headers: capTok ? { 'X-Turnstile': capTok } : {}, body: { name, message: ($('#dMsg', root).value || '').trim(), files: items.map(it => ({ name: it.file.name, size: it.file.size, type: it.file.type, lastModified: it.file.lastModified, path: it.path })) } });
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.innerHTML = icon('upload') + 'Déposer'; return; }
    const total = items.reduce((s, it) => s + it.file.size, 0);
    up = new Uploader({ id: r.transferId, key: r.uploadKey, items: items.map((it, i) => ({ file: it.file, meta: r.files[i] })) });
    const C = 2 * Math.PI * 104;
    root.innerHTML = `<section class="narrow"><div class="card glow"><div class="progress-hero">
      <span class="eyebrow"><span class="pulse-dot"></span><span id="st">Dépôt en cours</span></span><h2>${esc(info.title)}</h2>
      <div class="ring" id="ring"><svg viewBox="0 0 240 240"><circle class="glow" cx="120" cy="120" r="104"/><circle class="track" cx="120" cy="120" r="104"/><circle class="bar" id="bar" cx="120" cy="120" r="104" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
      <div class="ring-center"><div class="ring-pct"><span id="pc">0</span><small>%</small></div><div class="ring-sub" id="by">0 o / ${bytes(total)}</div></div></div>
      <div class="metrics"><div class="metric"><b id="sp">—</b><span>Vitesse</span></div><div class="metric"><b id="eta">—</b><span>Restant</span></div><div class="metric"><b>${items.length}</b><span>Fichiers</span></div></div>
      <div id="ban"></div>
      <p class="small faint">Gardez cette page ouverte jusqu'à la fin. En cas de coupure, l'envoi reprend tout seul.</p>
    </div></div></section>`;
    keepAwake(true);
    up.addEventListener('progress', (e) => {
      const d = e.detail; if (!root) return; const bar = $('#bar', root); if (!bar) return;
      const p = d.total ? d.loaded / d.total : 1;
      bar.style.strokeDashoffset = String(C * (1 - p));
      $('#pc', root).textContent = Math.floor(p * 100); $('#by', root).textContent = bytes(d.loaded) + ' / ' + bytes(d.total);
      const waiting = d.phase === 'confirming' || d.phase === 'assembling';
      $('#sp', root).textContent = d.speed >= 1 && !waiting ? speed(d.speed) : '—'; $('#eta', root).textContent = d.speed >= 1 && !waiting ? duration(d.eta) : '—';
      const stEl = $('#st', root); if (stEl && up.state === 'running') stEl.textContent = d.phase === 'assembling' ? 'Assemblage…' : d.phase === 'confirming' ? 'Derniers octets en route…' : 'Dépôt en cours';
    });
    up.addEventListener('state', () => { const b = root && $('#ban', root); if (b) b.innerHTML = up.state === 'offline' ? `<div class="banner warn">${icon('wifi-off')}<span>Connexion perdue : reprise automatique au retour du réseau.</span></div>` : ''; });
    up.addEventListener('stalled', (e) => { const b = root && $('#ban', root); if (!b) return; const msg = e.detail.kind === 'cors' ? 'L\'envoi n\'arrive pas à démarrer : le stockage refuse la connexion depuis ce site. Prévenez l\'organisateur (règle CORS du stockage à vérifier). La page continue d\'essayer.' : 'Fichiers envoyés, mais l\'assemblage échoue (« ' + e.detail.message + ' »). La page réessaie automatiquement.'; b.innerHTML = `<div class="banner bad">${icon('shield')}<span>${esc(msg)}</span></div>`; });
    up.addEventListener('error', (e) => { keepAwake(false); toast('Dépôt interrompu : ' + e.detail.message, 'error'); });
    up.addEventListener('done', async () => {
      for (let i = 0; i < 5; i++) { try { await api(`/api/transfers/${r.transferId}/finalize`, { method: 'POST', key: r.uploadKey, body: {} }); break; } catch (e) { await new Promise(res => setTimeout(res, 1500)); } }
      keepAwake(false);
      if (!root) return toast('Dépôt terminé ✅', 'success');
      root.innerHTML = `<section class="narrow"><div class="card glow"><div class="state-screen"><div class="success-burst">${icon('check')}</div><h2>Merci, c'est déposé !</h2>
        <p class="muted">${items.length} fichier(s) · ${bytes(total)} transmis à ${esc(info.ownerName || 'l\'organisateur')}.</p>
        <button type="button" class="btn" id="again">${icon('plus')}Déposer d'autres fichiers</button></div></div></section>`;
      confetti(50);
      items = [];
      $('#again', root).onclick = () => form();
    });
    up.start();
  }
})();

/* ====================================================================== */
/*  3. Gérer une demande et ses dépôts                                      */
/* ====================================================================== */
export const manageView = (() => {
  let root, id, key, q, sock, onEv, onConn, reloadT;
  return {
    async render(r, { match, hash }) {
      root = r; id = match[1];
      if (hash && /^[A-Za-z0-9_-]{10,}$/.test(hash)) { owned.upsert({ id, key: hash, createdAt: Date.now(), title: (owned.get(id) || {}).title || 'Demande' }); history.replaceState({}, '', '/r/' + id); }
      const o = owned.get(id);
      if (!o) { root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon info">${icon('lock')}</div><h2>Lien de gestion requis</h2><p class="muted">Ouvrez le lien de gestion reçu à la création de cette demande, depuis cet appareil.</p></div></div></section>`; return; }
      key = o.key;
      root.innerHTML = `<section class="stack"><div class="skeleton" style="height:200px;border-radius:20px"></div><div class="skeleton" style="height:300px;border-radius:20px"></div></section>`;
      await load();
      live();
    },
    destroy() { if (sock) { sock.off('request-event', onEv); sock.off('connect', onConn); } root = null; }
  };
  async function load() {
    try { q = await api(`/api/requests/${id}`, { key }); }
    catch (e) {
      if (!root) return;
      if (e.status === 404 || e.status === 403) { owned.remove(id); root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon">${icon('trash')}</div><h2>Demande supprimée</h2><p class="muted">Elle n'existe plus.</p><a class="btn" href="/dashboard" data-link>Tableau de bord</a></div></div></section>`; return; }
      return toast(e.message, 'error');
    }
    owned.upsert({ id, key, title: q.title, expiresAt: q.expiresAt });
    if (root) render();
  }
  function render() {
    const ready = q.deposits.filter(d => d.status === 'ready');
    const vol = ready.reduce((s, d) => s + (d.size || 0), 0);
    const st = { open: ['ok', 'Ouvert'], closed: ['bad', 'Fermé'], expired: ['', 'Terminé'] }[q.state];
    root.innerHTML = `
    <section class="stack">
      <a href="/dashboard" data-link class="btn ghost sm" style="align-self:flex-start">${icon('arrow-left', 'sm')}Tableau de bord</a>
      <div class="card glow stack">
        <div class="row wrap between"><div class="row grow" style="min-width:240px"><div class="ficon" style="--c:#06d6a0;width:52px;height:52px;border-radius:16px">${icon('inbox', 'lg')}</div><div class="fmeta"><h2 style="font-size:clamp(20px,3.6vw,28px)">${esc(q.title)}</h2><div class="small muted">Demande de fichiers · créée le ${fmtDate(q.createdAt)} · ${q.state === 'expired' ? 'terminée' : 'ouverte encore ' + timeLeft(q.expiresAt - Date.now())}</div></div></div><span class="pill ${st[0]}" style="font-size:13px">${st[1]}</span></div>
        <div class="link-box"><input id="shareLink" readonly value="${esc(q.link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
        ${shareGrid()}
      </div>
      <div class="kpis">
        <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Dépôts reçus<span class="kpi-icon">${icon('inbox')}</span></div><div class="kpi-value" id="r1">0</div><div class="kpi-foot">${q.deposits.length - ready.length} en cours d'envoi</div></div>
        <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Volume reçu<span class="kpi-icon">${icon('cloud')}</span></div><div class="kpi-value" id="r2">0 o</div><div class="kpi-foot">max ${bytes(q.maxBytes, 0)} par dépôt</div></div>
        <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Visiteurs<span class="kpi-icon">${icon('eye')}</span></div><div class="kpi-value" id="r3">0</div><div class="kpi-foot">personnes ayant ouvert le lien</div></div>
        <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Fichiers<span class="kpi-icon">${icon('file')}</span></div><div class="kpi-value" id="r4">0</div><div class="kpi-foot">au total</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><div class="card-title"><h3>${icon('inbox')}Dépôts</h3><span class="live-badge off" id="rLive"><i></i><span>…</span></span></div><div class="stack" style="gap:10px" id="dList"></div></div>
        <div class="card"><div class="card-title"><h3>${icon('settings')}Contrôles</h3></div><div class="controls">
          <div class="control"><div class="control-text"><b>Dépôts ouverts</b><span>Fermez pour ne plus rien recevoir</span></div><label class="switch"><input type="checkbox" id="cOpen" ${q.closed ? '' : 'checked'}><span class="track"></span></label></div>
          <div class="control"><div class="control-text"><b>Prolonger</b><span>Repousser la date limite</span></div><div class="chips"><button type="button" class="chip" data-ext="${DAY}">+1 j</button><button type="button" class="chip" data-ext="${7 * DAY}">+7 j</button></div></div>
          <div class="control"><div class="control-text"><b>Code pour déposer</b><span>${q.pinEnabled ? 'Actif' : 'Aucun'}</span></div><div class="row"><button type="button" class="btn sm" id="cPin">${icon('lock', 'sm')}${q.pinEnabled ? 'Changer' : 'Définir'}</button>${q.pinEnabled ? '<button type="button" class="btn sm ghost" id="cPinOff">Retirer</button>' : ''}</div></div>
          <div class="control"><div class="control-text"><b>Taille max par dépôt</b><span>${bytes(q.maxBytes, 0)}</span></div><div class="chips">${[[GB, '1 Go'], [5 * GB, '5 Go'], [20 * GB, '20 Go']].map(([v, l]) => `<button type="button" class="chip ${q.maxBytes === v ? 'active' : ''}" data-max="${v}">${l}</button>`).join('')}</div></div>
          <div class="control"><div class="control-text"><b>QR code</b><span>À projeter en classe</span></div><button type="button" class="btn sm icon" id="cQr">${icon('qr', 'sm')}</button></div>
          <div class="control"><div class="control-text"><b>Supprimer la demande</b><span>Efface aussi tous les dépôts</span></div><button type="button" class="btn sm danger" id="cDel">${icon('trash', 'sm')}Supprimer</button></div>
        </div></div>
      </div>
    </section>`;
    bindShare(root, q.link, q.title, null);
    animateCount($('#r1', root), ready.length); animateCount($('#r2', root), vol, v => bytes(v)); animateCount($('#r3', root), q.stats.visitors); animateCount($('#r4', root), ready.reduce((s, d) => s + (d.files ? d.files.length || d.files : 0), 0));
    renderDeposits();
    bindControls();
  }
  function renderDeposits() {
    const box = $('#dList', root);
    if (!q.deposits.length) { box.innerHTML = `<div class="empty" style="padding:24px"><div class="state-icon info">${icon('inbox')}</div><span class="small">Aucun dépôt pour l'instant. Partagez le lien !</span></div>`; return; }
    box.innerHTML = q.deposits.map(d => `<div class="receiver-item">
      <div class="receiver-top"><span class="row"><span class="avatar" style="width:36px;height:36px;border-radius:12px;font-size:15px">${esc((d.name || '?').charAt(0).toUpperCase())}</span><span><b>${esc(d.name)}</b><br><span class="tiny faint">${relTime(d.at)} · ${d.files.length || 0} fichier(s) · ${bytes(d.size)}</span></span></span>
      ${d.status === 'ready' ? (d.state === 'deleted' ? '<span class="pill">Supprimé</span>' : d.state === 'expired' ? '<span class="pill">Expiré</span>' : '<span class="pill ok">Reçu</span>') : '<span class="pill warn">Envoi en cours…</span>'}</div>
      ${d.message ? `<div class="message-bubble small" style="margin:6px 0">${esc(d.message)}</div>` : ''}
      ${d.files.length ? `<div class="tiny muted" style="margin:6px 0">${d.files.slice(0, 6).map(f => esc(f.path || f.name)).join(' · ')}${d.files.length > 6 ? ' …' : ''}</div>` : ''}
      ${d.status === 'ready' && d.state !== 'deleted' && d.state !== 'expired' ? `<div class="row wrap" style="margin-top:8px"><a class="btn sm" href="/t/${esc(d.id)}" data-link>${icon('external', 'sm')}Ouvrir</a>${d.files.length > 1 ? `<a class="btn sm" href="/api/public/t/${esc(d.id)}/zip?v=owner">${icon('zip', 'sm')}ZIP</a>` : `<a class="btn sm" href="/api/public/t/${esc(d.id)}/f/${esc(d.files[0] && d.files[0].id)}?v=owner">${icon('download', 'sm')}Télécharger</a>`}<button type="button" class="btn sm ghost" data-deld="${esc(d.id)}">${icon('trash', 'sm')}</button></div>` : ''}
    </div>`).join('');
    box.onclick = async (e) => {
      const b = e.target.closest('[data-deld]'); if (!b) return;
      if (!(await confirmDialog('Supprimer ce dépôt ?', 'Les fichiers déposés seront effacés.', 'Supprimer', true))) return;
      try { await api(`/api/transfers/${b.dataset.deld}`, { method: 'DELETE', key }); toast('Dépôt supprimé', 'success'); load(); } catch (err) { toast(err.message, 'error'); }
    };
  }
  async function patch(body, msg) { try { await api(`/api/requests/${id}`, { method: 'PATCH', key, body }); toast(msg, 'success'); load(); } catch (e) { toast(e.message, 'error'); } }
  function bindControls() {
    $('#cOpen', root).onchange = (e) => patch({ closed: !e.target.checked }, e.target.checked ? 'Dépôts rouverts' : 'Dépôts fermés');
    root.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => patch({ extendMs: +b.dataset.ext }, 'Date limite prolongée'));
    root.querySelectorAll('[data-max]').forEach(b => b.onclick = () => patch({ maxBytes: +b.dataset.max }, 'Taille maximale mise à jour'));
    $('#cPin', root).onclick = async () => {
      const pin = await modal({ title: 'Code pour déposer', body: '<input class="input pin-input" id="np" inputmode="numeric" maxlength="8" placeholder="••••">', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Enregistrer', cls: 'primary', handler: (bd) => { const v = bd.querySelector('#np').value.trim(); if (!/^\d{6,8}$/.test(v)) { toast('6 à 8 chiffres', 'warn'); return false; } return v; } }] });
      if (pin) patch({ pin }, 'Code enregistré');
    };
    const off = $('#cPinOff', root); if (off) off.onclick = () => patch({ pin: null }, 'Code retiré');
    $('#cQr', root).onclick = () => modal({ title: q.title, body: `<div class="qr" id="qrM" style="width:260px;height:260px;margin:6px auto"></div><p class="center small muted">${esc(q.link)}</p>`, actions: [{ label: 'Fermer', cls: 'primary' }], onMount: (m) => renderQR(m.querySelector('#qrM'), q.link) });
    $('#cDel', root).onclick = async () => {
      if (!(await confirmDialog('Supprimer cette demande ?', 'Le lien cessera de fonctionner et TOUS les fichiers déposés seront effacés.', 'Tout supprimer', true))) return;
      try { await api(`/api/requests/${id}`, { method: 'DELETE', key }); owned.remove(id); toast('Demande supprimée', 'success'); navigate('/dashboard'); } catch (e) { toast(e.message, 'error'); }
    };
  }
  async function live() {
    sock = await getSocket();
    const badge = () => root && $('#rLive', root);
    onConn = () => sock.emit('watch-requests', [{ id, key }], (r) => { const b = badge(); if (b && r && r.ok.includes(id)) { b.classList.remove('off'); b.lastChild.textContent = 'En direct'; } });
    onEv = (d) => {
      if (!d || d.id !== id) return;
      if (d.event.type === 'deposit') { toast(`Nouveau dépôt de ${d.event.n} 📥`, 'success'); notify('Nouveau dépôt', `${d.event.n} · ${d.event.f}`); }
      clearTimeout(reloadT); reloadT = setTimeout(load, 600);
    };
    sock.on('request-event', onEv);
    sock.on('connect', onConn);
    if (sock.connected) onConn();
  }
})();
