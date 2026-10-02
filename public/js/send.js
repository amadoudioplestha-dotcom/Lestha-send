/* Lestha Send — vue "Envoyer" (Cloud & Direct P2P) */
import { $, $$, esc, icon, bytes, speed, duration, timeLeft, fileKind, ls, ss, owned, api, getConfig, toast, modal, copyText, shareTo, renderQR, confetti, keepAwake, notify, isMobile, sparkPath, ensureVerified, verifiedEmail, captchaToken, forgetSender } from './core.js';
import { Uploader } from './uploader.js';
import { navigate } from './router.js';
import * as p2p from './p2p.js';
import { MAX_DIRECT_BYTES, validateDirectFiles } from './direct-limits.mjs';
import { openProfile, openHandle } from './profile.js';

/* Compteurs publics de la page d'accueil (vrais chiffres, affichés seulement à partir d'un certain volume) */
let statsCache = null;
async function homeStats(box) {
  if (!box) return;
  try { statsCache = statsCache || await api('/api/public/stats'); } catch (e) { return; }
  const s = statsCache;
  if (!s || !s.show || !box.isConnected) return;
  const n = (v) => Number(v).toLocaleString('fr-FR');
  box.innerHTML = `<div class="home-stat"><b>${n(s.transfers)}</b><span>envois Cloud</span></div><div class="home-stat"><b>${n(s.files)}</b><span>fichiers partagés</span></div><div class="home-stat"><b>${bytes(s.bytes, 0)}</b><span>transférés</span></div>${s.direct ? `<div class="home-stat"><b>${n(s.direct)}</b><span>liens directs</span></div>` : ''}`;
  box.classList.remove('hidden');
}

const HOUR = 3600e3, DAY = 24 * HOUR;
const S = {
  mode: ls.get('tx_mode', 'cloud'),
  items: [],                                  // { uid, file, path, thumb }
  opts: { ttl: 7 * DAY, p2pTtl: DAY, pin: '', limit: 0, title: '', message: '', emails: [], senderName: ls.get('tx_sender_name', ''), senderEmail: ls.get('tx_sender_email', ''), notify: ls.get('tx_notify', false), destroy: false, playback: 'off', allowComments: false, watermark: '' },
  optsOpen: false
};
let active = null;          // envoi cloud en cours { uploader, id, key, link, manageLink, emails, phase }
let rootEl = null;
let uidSeq = 0;
let cleanupFns = [];

/* ================================================================== */
export default {
  async render(root, { params }) {
    rootEl = root;
    if (params.get('shared') === '1') await importShared();
    if (p2p.isSending()) return p2p.renderSender(root);
    if (active && active.phase === 'upload') return renderUploading();
    if (active && active.phase === 'done') return renderSuccess();
    renderCompose();
  },
  destroy() { cleanupFns.forEach(f => f()); cleanupFns = []; rootEl = null; }
};

/* ============================ COMPOSITION ============================ */
async function renderCompose() {
  const cfg = await getConfig();
  if (!rootEl) return;
  const total = S.items.reduce((s, it) => s + it.file.size, 0);
  const directValidation = validateDirectFiles(S.items.map(it => it.file));
  if (cfg.cloudEnabled === false && S.mode === 'cloud') S.mode = 'p2p';
  const cloud = S.mode === 'cloud';
  rootEl.innerHTML = `
  <section class="stack">
    <div class="hero">
      <span class="eyebrow"><span class="pulse-dot"></span>Transfert de fichiers nouvelle génération</span>
      <h1>Envoyez <span class="grad-text">sans limites.</span></h1>
      <p class="lead">${cloud ? `Jusqu'à ${bytes(cfg.maxTransferBytes, 0)} par envoi, un lien qui reste actif même quand vous fermez l'application, et des téléchargements qui reprennent là où ils s'étaient arrêtés.` : `Jusqu'à ${bytes(MAX_DIRECT_BYTES, 0)} par transfert direct, si le navigateur et le disque du destinataire le permettent.`}</p>
      <div class="hero-badges">
        <span class="hero-badge">${icon('bolt')}Vitesse maximale</span>
        <span class="hero-badge">${icon('refresh')}Reprise automatique</span>
        <span class="hero-badge">${icon('lock')}PIN & expiration</span>
        <span class="hero-badge">${icon('chart')}Suivi en temps réel</span>
      </div>
      <div class="home-stats hidden" id="homeStats" aria-label="Lestha Send en chiffres"></div>
    </div>

    ${restoreBanner()}
    ${cloud && cfg.cloudEnabled !== false ? tierBanner(cfg) : ''}
    <div class="grid-2">
      <div class="stack">
        <div class="segmented" id="modeSeg" data-value="${S.mode}" role="tablist" aria-label="Mode d'envoi">
          <span class="seg-pill"></span>
          <button type="button" role="tab" data-mode="cloud" class="${cloud ? 'active' : ''}" aria-selected="${cloud}" ${cfg.cloudEnabled === false ? 'aria-disabled="true" style="opacity:.45"' : ''}>${icon('cloud')}<span>Cloud<small>${cfg.cloudEnabled === false ? 'Indisponible' : 'Lien permanent'}</small></span></button>
          <button type="button" role="tab" data-mode="p2p" class="${!cloud ? 'active' : ''}" aria-selected="${!cloud}">${icon('bolt')}<span>Direct P2P<small>Zéro stockage</small></span></button>
        </div>
        <div class="mode-hint ${cloud ? '' : 'p2p'}">${cloud
          ? `${icon('cloud')}<span>Vos fichiers sont déposés de façon sécurisée : <b>vous pouvez fermer l'application</b>, le lien reste valide jusqu'à son expiration puis tout est supprimé automatiquement.</span>`
          : `${icon('bolt')}<span>Transfert direct d'appareil à appareil, chiffré de bout en bout, <b>rien n'est stocké</b>. Le destinataire télécharge tant que Lestha Send reste ouvert chez vous ; si vous le quittez un instant, le transfert reprend à votre retour.</span>`}</div>

        <div id="dropzone" class="dropzone ${S.items.length ? 'compact' : ''}" tabindex="0" role="button" aria-label="Ajouter des fichiers">
          <div class="dz-orb">${icon(S.items.length ? 'plus' : 'upload')}</div>
          <div>
            <div class="dz-title">${S.items.length ? 'Ajouter d\'autres fichiers' : (isMobile ? 'Touchez pour choisir vos fichiers' : 'Glissez vos fichiers ou dossiers ici')}</div>
            <div class="dz-sub">${S.items.length ? 'Glisser-déposer, coller ou parcourir' : 'Tous formats · dossiers complets · jusqu\'à ' + bytes(cloud ? cfg.maxTransferBytes : MAX_DIRECT_BYTES, 0)}</div>
          </div>
          ${S.items.length ? '' : `<div class="dz-actions">
            <button type="button" class="chip" data-pick="files">${icon('file', 'sm')}Fichiers</button>
            <button type="button" class="chip" data-pick="folder">${icon('folder', 'sm')}Dossier</button>
            ${isMobile ? `<button type="button" class="chip" data-pick="gallery">${icon('image', 'sm')}Galerie</button><button type="button" class="chip" data-pick="camera">${icon('camera', 'sm')}Caméra</button>` : ''}
          </div>`}
        </div>

        ${S.items.length ? `
        <div class="card">
          <div class="card-title">
            <h3>${icon('file')}${S.items.length} élément${S.items.length > 1 ? 's' : ''}</h3>
            <div class="row">
              <button type="button" class="btn sm ghost" data-pick="folder">${icon('folder', 'sm')}Dossier</button>
              <button type="button" class="btn sm ghost" id="btnClear">${icon('trash', 'sm')}Vider</button>
            </div>
          </div>
          <div class="file-list" id="fileList">${renderFileRows()}</div>
          <div class="file-summary" style="margin-top:12px"><span>Total</span><b>${bytes(total)}</b></div>
          ${total > cfg.maxTransferBytes ? `<div class="banner bad" style="margin-top:10px">${icon('x')}Dépasse la limite de ${bytes(cfg.maxTransferBytes, 0)} par envoi.</div>` : ''}
          ${!cloud && !directValidation.ok ? `<div class="banner bad" style="margin-top:10px">${icon('x')}${directValidation.error}</div>` : ''}
        </div>` : ''}
      </div>

      <div class="stack">
        <div class="card glow">
          <button type="button" class="options-toggle" id="optToggle" aria-expanded="${S.optsOpen}">
            <h3 class="row">${icon('settings')}Options du lien</h3>
            <span class="row small muted">${optSummary()}<svg class="i chev"><use href="#i-arrow-right"/></svg></span>
          </button>
          <div class="options-body ${S.optsOpen ? 'open' : ''}" id="optBody"><div>
            <div class="opt-grid">
              <div class="field full"><span>${icon('clock', 'sm')}Expiration</span>
                <div class="chips" id="ttlChips">${ttlChoices(cfg).map(([v, l]) => `<button type="button" class="chip ${curTtl() === v ? 'active' : ''}" data-ttl="${v}">${l}</button>`).join('')}</div>
              </div>
              <label class="field"><span>${icon('lock', 'sm')}Code PIN (optionnel)</span>
                <input class="input" id="optPin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="6 à 8 chiffres" value="${esc(S.opts.pin)}">
              </label>
              ${cloud ? `<div class="field"><span>${icon('download', 'sm')}Téléchargements</span>
                <div class="chips" id="limitChips">${[[0, 'Illimité'], [1, '1 seul'], [3, '3'], [10, '10']].map(([v, l]) => `<button type="button" class="chip ${S.opts.limit === v ? 'active' : ''}" data-limit="${v}">${l}</button>`).join('')}</div>
              </div>` : `<label class="switch field" style="flex-direction:row;align-self:end;min-height:46px"><input type="checkbox" id="optDestroy" ${S.opts.destroy ? 'checked' : ''}><span class="track"></span><span class="small">Auto-destruction après le 1<sup>er</sup> téléchargement</span></label>`}
              ${cloud ? `
              <div class="field full"><span>${icon('film', 'sm')}Lecture en ligne (vidéo / audio)</span>
                <div class="chips" id="playChips">${[['off', 'Désactivée'], ['on', 'Lecture + téléchargement'], ['only', 'Visionnage seul']].map(([v, l]) => `<button type="button" class="chip ${S.opts.playback === v ? 'active' : ''}" data-play="${v}">${l}</button>`).join('')}</div>
              </div>
              <div class="full stack ${S.opts.playback === 'off' ? 'hidden' : ''}" id="playOpts" style="gap:10px">
                <label class="switch"><input type="checkbox" id="optComments" ${S.opts.allowComments ? 'checked' : ''}><span class="track"></span><span class="small">Commentaires horodatés (validation de montage, retours clients)</span></label>
                <label class="field ${S.opts.playback === 'only' ? '' : 'hidden'}" id="wmField"><span>Filigrane affiché sur la vidéo</span><input class="input" id="optWatermark" maxlength="60" placeholder="Ex. Confidentiel · Lestha TV" value="${esc(S.opts.watermark)}"></label>
              </div>
              <label class="field full"><span>Titre</span><input class="input" id="optTitle" maxlength="140" placeholder="Ex. Rushes reportage Walo" value="${esc(S.opts.title)}"></label>
              <label class="field full"><span>Message au destinataire</span><textarea class="input" id="optMsg" maxlength="1500" placeholder="Quelques mots pour accompagner l'envoi…">${esc(S.opts.message)}</textarea></label>
              <label class="field"><span>Votre nom</span><input class="input" id="optName" maxlength="80" placeholder="Affiché au destinataire" value="${esc(S.opts.senderName)}"></label>
              ${cfg.email ? `<div class="field full"><span>${icon('mail', 'sm')}Envoyer le lien par e-mail à</span>
                <div class="tag-input" id="emailTags">${S.opts.emails.map(e => `<span class="tag">${esc(e)}<button type="button" data-rm-email="${esc(e)}" aria-label="Retirer">${icon('x')}</button></span>`).join('')}<input id="emailEntry" type="email" inputmode="email" placeholder="${S.opts.emails.length ? '' : 'adresse@exemple.com, puis Entrée'}"></div></div>
              <label class="switch full"><input type="checkbox" id="optNotify" ${S.opts.notify ? 'checked' : ''}><span class="track"></span><span class="small">M'avertir par e-mail au premier téléchargement</span></label>
              <label class="field full ${S.opts.notify ? '' : 'hidden'}" id="notifyEmailField"><span>Votre e-mail (confirmé par un code)</span><input class="input" id="optSenderEmail" type="email" placeholder="vous@exemple.com" value="${esc(verifiedEmail() || S.opts.senderEmail)}" ${verifiedEmail() ? 'readonly' : ''}></label>` : ''}` : ''}
            </div>
          </div></div>
        </div>

        <button type="button" class="btn primary xl block" id="btnGo" ${S.items.length && (cloud ? total <= cfg.maxTransferBytes : directValidation.ok) ? '' : 'disabled'}>
          ${icon(cloud ? 'upload' : 'link')}${cloud ? (S.items.length ? 'Envoyer · ' + bytes(total) : 'Envoyer') : 'Créer le lien direct'}
        </button>
        <p class="small faint center">${cloud ? 'Upload direct vers le stockage, en parallèle et reprenable. Aucune limite de débit imposée.' : `Jusqu'à ${bytes(MAX_DIRECT_BYTES, 0)} par transfert ; réception sur disque si le navigateur et l'espace disponible le permettent. Gardez Lestha Send ouvert pendant le téléchargement.`}</p>
        <a class="card request-cta" href="/demande" data-link>
          <span class="ficon" style="--c:#06d6a0">${icon('inbox')}</span>
          <span class="fmeta"><b>Besoin de <span class="grad-text">recevoir</span> des fichiers ?</b><span class="small muted">Créez un lien de dépôt : vos apprenants, clients ou collègues vous envoient leurs fichiers.</span></span>
          ${icon('arrow-right')}
        </a>
      </div>
    </div>
  </section>`;
  bindCompose(cfg);
}

function restoreBanner() {
  const a = p2p.restorable();
  const pend = Object.values(ls.get('tx_pending', {}));
  let html = '';
  if (a) html += `<div class="banner info">${icon('bolt')}<span class="grow">Un lien direct est toujours actif (${esc((a.info && a.info.files || []).length)} fichier(s)). Resélectionnez les fichiers pour le réactiver.</span><button type="button" class="btn sm" id="btnRestoreP2P">Réactiver</button><button type="button" class="btn sm ghost icon" id="btnForgetP2P" aria-label="Ignorer">${icon('x', 'sm')}</button></div>`;
  if (pend.length && !(active && active.phase === 'upload')) html += `<div class="banner warn">${icon('refresh')}<span class="grow">${pend.length} envoi${pend.length > 1 ? 's' : ''} interrompu${pend.length > 1 ? 's' : ''} : « ${esc(pend[0].title)} »${pend.length > 1 ? '…' : ''}</span><button type="button" class="btn sm" data-resume="${esc(pend[0].id)}">Reprendre</button></div>`;
  return html;
}

function curTtl() { return S.mode === 'cloud' ? S.opts.ttl : S.opts.p2pTtl; }
function ttlChoices(cfg) {
  if (S.mode === 'p2p') return [[HOUR, '1 h'], [6 * HOUR, '6 h'], [DAY, '24 h'], [3 * DAY, '3 j'], [7 * DAY, '7 j']];
  return [[HOUR, '1 h'], [DAY, '1 jour'], [3 * DAY, '3 jours'], [7 * DAY, '7 jours'], [14 * DAY, '14 jours'], [30 * DAY, '30 jours']].filter(([v]) => v <= (cfg.maxTtl || 30 * DAY));
}
function optSummary() {
  const t = curTtl();
  const parts = [t >= DAY ? (t / DAY) + ' j' : (t / HOUR) + ' h'];
  if (S.opts.pin) parts.push('PIN');
  if (S.mode === 'cloud' && S.opts.limit) parts.push(S.opts.limit + ' tél.');
  if (S.mode === 'p2p' && S.opts.destroy) parts.push('auto-destr.');
  return esc(parts.join(' · '));
}

function renderFileRows() {
  const max = 120;
  const rows = S.items.slice(0, max).map((it) => {
    const k = fileKind(it.file.name, it.file.type);
    if (!it.thumb && k.kind === 'image' && it.file.size < 15e6 && S.items.length <= 60) it.thumb = URL.createObjectURL(it.file);
    return `<div class="file-row" data-uid="${it.uid}">
      <div class="ficon" style="--c:${k.c}">${it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy" decoding="async">` : icon(k.icon)}</div>
      <div class="fmeta"><div class="fname" title="${esc(it.path || it.file.name)}">${esc(it.file.name)}</div><div class="fsub">${bytes(it.file.size)}${it.path ? ' · ' + esc(it.path.split('/').slice(0, -1).join('/')) : ''}</div></div>
      <button type="button" class="btn sm icon ghost" data-rm="${it.uid}" aria-label="Retirer">${icon('x', 'sm')}</button>
    </div>`;
  }).join('');
  return rows + (S.items.length > max ? `<div class="small faint center" style="padding:8px">+ ${S.items.length - max} autres fichiers</div>` : '');
}

function bindCompose(cfg) {
  const r = rootEl;
  const bv = $('#btnVerify', r); if (bv) bv.onclick = async () => { readOpts(); if (await ensureVerified()) renderCompose(); };
  homeStats($('#homeStats', r));
  const bp = $('#btnProfile', r); if (bp) bp.onclick = () => openProfile();
  const bh = $('#btnMyHandle', r); if (bh) bh.onclick = () => openHandle();
  const bf = $('#btnForget', r); if (bf) bf.onclick = async () => { await forgetSender(); toast('Adresse oubliée sur cet appareil', 'info'); renderCompose(); };
  $('#modeSeg', r).addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b || b.dataset.mode === S.mode) return;
    if (b.dataset.mode === 'cloud' && cfg.cloudEnabled === false) return toast('Mode Cloud momentanément indisponible sur ce serveur : utilisez le mode Direct P2P.', 'warn');
    readOpts();
    S.mode = b.dataset.mode; ls.set('tx_mode', S.mode);
    $('#modeSeg', r).dataset.value = S.mode;
    setTimeout(renderCompose, 180);
  });
  const dz = $('#dropzone', r);
  dz.addEventListener('click', (e) => { const c = e.target.closest('[data-pick]'); pickAndAdd(c ? c.dataset.pick : 'files'); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndAdd('files'); } });
  dz.addEventListener('pointermove', (e) => { const b = dz.getBoundingClientRect(); dz.style.setProperty('--mx', (e.clientX - b.left) + 'px'); dz.style.setProperty('--my', (e.clientY - b.top) + 'px'); });
  $$('[data-pick]', r).forEach(b => { if (!dz.contains(b)) b.addEventListener('click', () => pickAndAdd(b.dataset.pick)); });

  // Glisser-déposer sur toute la page
  let depth = 0;
  const onEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dz.classList.add('drag'); };
  const onLeave = () => { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('drag'); };
  const onOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
  const onDrop = async (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dz.classList.remove('drag'); addItems(await filesFromDataTransfer(e.dataTransfer)); };
  const onPaste = (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addItems(fs.map(f => ({ file: f, path: null }))); } };
  window.addEventListener('dragenter', onEnter); window.addEventListener('dragleave', onLeave); window.addEventListener('dragover', onOver); window.addEventListener('drop', onDrop); window.addEventListener('paste', onPaste);
  cleanupFns.push(() => { window.removeEventListener('dragenter', onEnter); window.removeEventListener('dragleave', onLeave); window.removeEventListener('dragover', onOver); window.removeEventListener('drop', onDrop); window.removeEventListener('paste', onPaste); });

  const list = $('#fileList', r);
  if (list) list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    const idx = S.items.findIndex(x => String(x.uid) === b.dataset.rm);
    if (idx >= 0) { const [it] = S.items.splice(idx, 1); if (it.thumb) URL.revokeObjectURL(it.thumb); }
    readOpts(); renderCompose();
  });
  const clr = $('#btnClear', r);
  if (clr) clr.onclick = () => { clearItems(); readOpts(); renderCompose(); };

  $('#optToggle', r).onclick = () => { S.optsOpen = !S.optsOpen; $('#optBody', r).classList.toggle('open', S.optsOpen); $('#optToggle', r).setAttribute('aria-expanded', S.optsOpen); };
  $('#ttlChips', r).addEventListener('click', (e) => { const c = e.target.closest('[data-ttl]'); if (!c) return; if (S.mode === 'cloud') S.opts.ttl = +c.dataset.ttl; else S.opts.p2pTtl = +c.dataset.ttl; $$('#ttlChips .chip', r).forEach(x => x.classList.toggle('active', x === c)); refreshSummary(); });
  const lc = $('#limitChips', r);
  if (lc) lc.addEventListener('click', (e) => { const c = e.target.closest('[data-limit]'); if (!c) return; S.opts.limit = +c.dataset.limit; $$('#limitChips .chip', r).forEach(x => x.classList.toggle('active', x === c)); refreshSummary(); });
  const pc = $('#playChips', r);
  if (pc) pc.addEventListener('click', (e) => {
    const c = e.target.closest('[data-play]'); if (!c) return;
    S.opts.playback = c.dataset.play;
    $$('#playChips .chip', r).forEach(x => x.classList.toggle('active', x === c));
    $('#playOpts', r).classList.toggle('hidden', S.opts.playback === 'off');
    $('#wmField', r).classList.toggle('hidden', S.opts.playback !== 'only');
  });
  const pin = $('#optPin', r);
  pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 8); S.opts.pin = pin.value; refreshSummary(); });
  const nt = $('#optNotify', r);
  if (nt) nt.onchange = () => { S.opts.notify = nt.checked; $('#notifyEmailField', r).classList.toggle('hidden', !nt.checked); };
  const tags = $('#emailTags', r);
  if (tags) {
    const entry = $('#emailEntry', r);
    tags.addEventListener('click', (e) => { const b = e.target.closest('[data-rm-email]'); if (b) { S.opts.emails = S.opts.emails.filter(x => x !== b.dataset.rmEmail); readOpts(); renderCompose(); } else entry.focus(); });
    const commit = () => {
      const vals = entry.value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      let added = false;
      vals.forEach(v => { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && !S.opts.emails.includes(v) && S.opts.emails.length < 20) { S.opts.emails.push(v); added = true; } else if (v) toast('Adresse invalide : ' + v, 'warn'); });
      entry.value = '';
      if (added) { readOpts(); renderCompose(); setTimeout(() => { const n = $('#emailEntry'); if (n) n.focus(); }, 30); }
    };
    entry.addEventListener('keydown', (e) => { if (['Enter', ',', ';', ' '].includes(e.key)) { e.preventDefault(); commit(); } else if (e.key === 'Backspace' && !entry.value && S.opts.emails.length) { S.opts.emails.pop(); readOpts(); renderCompose(); } });
    entry.addEventListener('blur', () => { if (entry.value.trim()) commit(); });
  }
  const rp = $('#btnRestoreP2P', r);
  if (rp) rp.onclick = async () => { if (await p2p.restore(pick)) p2p.renderSender(rootEl); };
  const fp = $('#btnForgetP2P', r);
  if (fp) fp.onclick = () => { p2p.forgetRestorable(); renderCompose(); };
  $$('[data-resume]', r).forEach(b => b.onclick = () => resumePending(b.dataset.resume));
  $('#btnGo', r).onclick = () => { readOpts(); if (S.mode === 'cloud') startCloud(cfg); else startP2P(); };
}

function refreshSummary() { const s = $('#optToggle .small'); if (s) s.firstChild.textContent = optSummary().replace(/&amp;/g, '&'); }

function readOpts() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
  if (v('optTitle') != null) S.opts.title = v('optTitle').trim();
  if (v('optMsg') != null) S.opts.message = v('optMsg').trim();
  if (v('optName') != null) { S.opts.senderName = v('optName').trim(); ls.set('tx_sender_name', S.opts.senderName); }
  if (v('optSenderEmail') != null) { S.opts.senderEmail = v('optSenderEmail').trim(); ls.set('tx_sender_email', S.opts.senderEmail); }
  if (v('optPin') != null) S.opts.pin = v('optPin').trim();
  const d = document.getElementById('optDestroy'); if (d) S.opts.destroy = d.checked;
  const oc = document.getElementById('optComments'); if (oc) S.opts.allowComments = oc.checked;
  if (v('optWatermark') != null) S.opts.watermark = v('optWatermark').trim();
  const n = document.getElementById('optNotify'); if (n) { S.opts.notify = n.checked; ls.set('tx_notify', n.checked); }
  const entry = document.getElementById('emailEntry');
  if (entry && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.value.trim()) && !S.opts.emails.includes(entry.value.trim())) S.opts.emails.push(entry.value.trim());
}

/* ---------------- Sélection de fichiers ---------------- */
const INPUTS = { files: 'inFiles', folder: 'inFolder', gallery: 'inGallery', camera: 'inCamera' };
export function pick(kind = 'files') {
  return new Promise((resolve) => {
    const input = document.getElementById(INPUTS[kind] || 'inFiles');
    input.value = '';
    ss.set('tx_picking', String(Date.now()));
    const done = (files) => { ss.del('tx_picking'); input.onchange = null; input.oncancel = null; resolve(files); };
    input.onchange = () => done([...(input.files || [])]);
    input.oncancel = () => done([]);
    input.click();
  });
}
async function pickAndAdd(kind) {
  const files = await pick(kind);
  if (!files.length) return;
  addItems(files.map(f => ({ file: f, path: kind === 'folder' && f.webkitRelativePath ? f.webkitRelativePath : null })));
}
function hasFiles(e) { return e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'); }

async function filesFromDataTransfer(dt) {
  const entries = [...(dt.items || [])].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null).filter(Boolean);
  if (!entries.length) return [...dt.files].map(f => ({ file: f, path: null }));
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
      if (f) out.push({ file: f, path: prefix ? prefix + f.name : null });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

function addItems(list) {
  if (!list.length) return;
  const seen = new Set(S.items.map(it => (it.path || it.file.name) + '|' + it.file.size));
  let dup = 0;
  for (const it of list) {
    const k = (it.path || it.file.name) + '|' + it.file.size;
    if (seen.has(k)) { dup++; continue; }
    seen.add(k);
    S.items.push({ uid: ++uidSeq, file: it.file, path: it.path || null });
  }
  if (dup) toast(dup + ' doublon(s) ignoré(s)', 'info');
  readOpts();
  if (rootEl && !active) renderCompose();
}
function clearItems() { S.items.forEach(it => it.thumb && URL.revokeObjectURL(it.thumb)); S.items = []; }

async function importShared() {
  try {
    const cache = await caches.open('shared-inbox');
    const keys = await cache.keys();
    const list = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-Filename') || 'fichier-partage');
      list.push({ file: new File([blob], name, { type: res.headers.get('Content-Type') || blob.type }), path: null });
      await cache.delete(req);
    }
    history.replaceState({}, '', '/');
    if (list.length) { S.items.push(...list.map(it => ({ uid: ++uidSeq, file: it.file, path: null }))); toast(list.length + ' fichier(s) reçu(s) depuis le partage', 'success'); }
  } catch (e) { /* ignore */ }
}

/* ============================ ENVOI DIRECT (P2P) ============================ */
async function startP2P() {
  if (!S.items.length) return;
  const validation = validateDirectFiles(S.items.map(it => it.file));
  if (!validation.ok) return toast(validation.error, 'error');
  if (S.opts.pin && !/^\d{6,8}$/.test(S.opts.pin)) { S.optsOpen = true; renderCompose(); return toast('Le PIN doit contenir 6 à 8 chiffres', 'warn'); }
  if (!window.RTCPeerConnection) return toast('Ce navigateur ne gère pas le transfert direct. Utilisez le mode Cloud.', 'error');
  const btn = $('#btnGo'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Création du lien…'; }
  try {
    await p2p.startSend(S.items.map(it => ({ file: it.file, path: it.path })), { ttl: S.opts.p2pTtl, pin: S.opts.pin, destroy: S.opts.destroy });
    if (rootEl) p2p.renderSender(rootEl);
  } catch (e) { toast(e.message, 'error'); if (rootEl) renderCompose(); }
}

/* ============================ ENVOI CLOUD ============================ */
async function startCloud(cfg) {
  if (!S.items.length) return;
  const total = S.items.reduce((s, it) => s + it.file.size, 0);
  if (total > cfg.maxTransferBytes) return toast('Envoi trop volumineux (max ' + bytes(cfg.maxTransferBytes, 0) + ')', 'error');
  if (S.items.length > cfg.maxFiles) return toast('Maximum ' + cfg.maxFiles + ' fichiers par envoi', 'error');
  if (S.opts.pin && !/^\d{6,8}$/.test(S.opts.pin)) { S.optsOpen = true; renderCompose(); return toast('Le PIN doit contenir 6 à 8 chiffres', 'warn'); }
  // E-mails et alertes : uniquement depuis une adresse confirmée (sauf instance privée avec code d'accès)
  if ((S.opts.emails.length || S.opts.notify) && cfg.tier !== 'full' && !verifiedEmail()) {
    const ok = await ensureVerified('Pour envoyer le lien par e-mail ou être averti des téléchargements, confirmez d\'abord votre adresse.');
    if (!ok) { S.optsOpen = true; return toast('Retirez les destinataires e-mail ou confirmez votre adresse pour continuer.', 'warn'); }
  }
  if (S.opts.notify && cfg.tier === 'full' && !verifiedEmail() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(S.opts.senderEmail)) { S.optsOpen = true; renderCompose(); return toast('Indiquez votre e-mail pour être averti', 'warn'); }
  if (cfg.emailRecipients && S.opts.emails.length > cfg.emailRecipients) {
    S.opts.emails = S.opts.emails.slice(0, cfg.emailRecipients);
    toast(`Le lien sera envoyé par e-mail à ${cfg.emailRecipients} destinataire(s) maximum. Partagez-le directement aux autres.`, 'warn');
  }
  if (total > cfg.maxTransferBytes) return toast('Envoi trop volumineux (max ' + bytes(cfg.maxTransferBytes, 0) + ')', 'error');
  const btn = $('#btnGo'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Préparation…'; }
  const items = S.items.slice();
  try {
    const body = {
      title: S.opts.title, message: S.opts.message, senderName: S.opts.senderName, ttl: S.opts.ttl,
      pin: S.opts.pin || null, maxDownloads: S.opts.limit || null,
      playback: S.opts.playback, allowComments: S.opts.playback !== 'off' && S.opts.allowComments, watermark: S.opts.watermark,
      notifyOnDownload: S.opts.notify, senderEmail: S.opts.notify ? (verifiedEmail() || S.opts.senderEmail) : '',
      files: items.map(it => ({ name: it.file.name, size: it.file.size, type: it.file.type, lastModified: it.file.lastModified, path: it.path }))
    };
    let r;
    for (let attempt = 0; ; attempt++) {
      if (cfg.uploadCodeRequired && !ls.get('tx_upload_code', '')) {
        const code = await modal({ title: 'Code d\'accès', body: '<p class="small muted" style="margin-bottom:10px">Cette instance Lestha Send est privée : saisissez le code d\'accès à l\'envoi (il sera mémorisé sur cet appareil).</p><input class="input" id="upCode" type="password" autocomplete="off">', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Valider', cls: 'primary', handler: (bd) => bd.querySelector('#upCode').value.trim() || false }] });
        if (!code) throw new Error('Envoi annulé');
        ls.set('tx_upload_code', code);
      }
      const headers = cfg.uploadCodeRequired ? { 'X-Upload-Code': ls.get('tx_upload_code', '') } : {};
      if (cfg.tier !== 'full') { const cap = await captchaToken(); if (cap) headers['X-Turnstile'] = cap; }
      try { r = await api('/api/transfers', { method: 'POST', body, headers }); break; }
      catch (e) {
        const d = e.data || {};
        if (e.status === 401 && d.needCode) { ls.del('tx_upload_code'); if (!cfg.uploadCodeRequired) cfg.uploadCodeRequired = true; toast('Code d\'accès incorrect', 'warn'); continue; }
        if (d.needCaptcha && attempt < 2) continue;
        if (d.needVerify && attempt < 2) {
          toast(e.message, 'warn', { duration: 9000 });
          if (await ensureVerified()) continue;
        }
        throw e;
      }
    }
    const title = S.opts.title || (items.length === 1 ? items[0].file.name : (items[0].path ? items[0].path.split('/')[0] : items.length + ' fichiers'));
    owned.upsert({ id: r.id, key: r.ownerKey, title, createdAt: Date.now(), totalSize: total, fileCount: items.length, mode: 'cloud' });
    const pend = ls.get('tx_pending', {});
    pend[r.id] = { id: r.id, key: r.ownerKey, title, createdAt: Date.now(), emails: S.opts.emails.slice(), files: items.map((it, i) => ({ fid: r.files[i].id, name: it.file.name, size: it.file.size, lastModified: it.file.lastModified, path: it.path, partSize: r.files[i].partSize, partCount: r.files[i].partCount })) };
    ls.set('tx_pending', pend);
    const up = new Uploader({ id: r.id, key: r.ownerKey, items: items.map((it, i) => ({ file: it.file, meta: r.files[i] })) });
    runUpload({ uploader: up, id: r.id, key: r.ownerKey, link: r.link, manageLink: r.manageLink, emails: S.opts.emails.slice(), title, total, count: items.length, pin: S.opts.pin, limit: S.opts.limit, playback: S.opts.playback });
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; renderCompose(); }
  }
}

/** Rappel de l'offre en cours : sans compte, ou adresse confirmée */
function tierBanner(cfg) {
  if (cfg.tier === 'full') return cfg.admin ? `<div class="banner info" id="tierBanner">${icon('shield')}<span><b>Mode administrateur</b> sur cet appareil : aucune limite de taille, de durée ni d'envois. Se déconnecter de la console rétablit l'offre normale.<span class="banner-links"><button type="button" class="link-btn" id="btnProfile">Personnaliser ma page</button><button type="button" class="link-btn" id="btnMyHandle">Mon lien @</button></span></span></div>` : '';
  const v = cfg.limits && cfg.limits.verified;
  if (cfg.tier === 'verified') {
    return `<div class="banner info" id="tierBanner">${icon('check')}<span>Connecté en tant que <b>${esc(cfg.verifiedEmail)}</b> · envois Cloud jusqu'à ${bytes(cfg.maxTransferBytes, 0)}, liens de ${Math.round(cfg.maxTtl / DAY)} jours.<span class="banner-links"><button type="button" class="link-btn" id="btnProfile">Personnaliser ma page</button><button type="button" class="link-btn" id="btnMyHandle">Mon lien @</button><button type="button" class="link-btn" id="btnForget">Changer d'adresse</button></span></span></div>`;
  }
  return `<div class="banner info" id="tierBanner">${icon('sparkles')}<span>Sans compte : envois Cloud jusqu'à ${bytes(cfg.maxTransferBytes, 0)}, liens de ${Math.round(cfg.maxTtl / DAY)} jours. Le mode Direct reste <b>illimité</b>.${v && cfg.email ? ` <button type="button" class="link-btn" id="btnVerify">Confirmer mon e-mail</button> pour passer à ${bytes(v.maxBytes, 0)} et envoyer le lien par e-mail.` : ''}</span></div>`;
}

/** Lance (ou relance) un envoi et affiche la progression */
export function runUpload(ctx) {
  active = Object.assign(ctx, { phase: 'upload', startedAt: Date.now() });
  const up = ctx.uploader;
  up.addEventListener('progress', (e) => updateUploading(e.detail));
  up.addEventListener('state', () => updateUploadingState());
  up.addEventListener('filecomplete', () => refreshFileBars());
  up.addEventListener('stalled', (e) => {
    const ban = rootEl && $('#upBanner', rootEl);
    const msg = e.detail.kind === 'cors'
      ? 'L\'envoi n\'arrive pas à démarrer : le stockage refuse ce site. Administrateur : vérifiez la règle CORS du bucket R2 (console admin → Système → Lancer le test).'
      : 'Le fichier est envoyé mais son assemblage échoue (« ' + e.detail.message + ' »). Lestha Send réessaie automatiquement ; si ça dure, notez ce message.';
    if (ban) ban.innerHTML = `<div class="banner bad">${icon('shield')}<span>${esc(msg)}</span></div>`; else toast(msg, 'error', { duration: 15000 });
  });
  up.addEventListener('error', (e) => { toast('Envoi interrompu : ' + e.detail.message, 'error'); keepAwake(false); active = null; if (rootEl) renderCompose(); });
  up.addEventListener('done', () => finalize());
  keepAwake(true);
  if (location.pathname !== '/') navigate('/'); else if (rootEl) renderUploading();
  up.start();
}

function renderUploading() {
  if (!rootEl || !active) return;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const C = 2 * Math.PI * 104;
  rootEl.innerHTML = `
  <section class="narrow stack">
    <div class="card glow">
      <div class="progress-hero">
        <span class="eyebrow"><span class="pulse-dot"></span><span id="upState">Envoi en cours</span></span>
        <h2 style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(active.title)}</h2>
        <div class="ring" id="upRing">
          <svg viewBox="0 0 240 240"><circle class="glow" cx="120" cy="120" r="104"/><circle class="track" cx="120" cy="120" r="104"/><circle class="bar" id="upBar" cx="120" cy="120" r="104" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
          <div class="ring-center"><div class="ring-pct"><span id="upPct">0</span><small>%</small></div><div class="ring-sub" id="upBytes">0 o / ${bytes(active.total)}</div></div>
        </div>
        <div class="metrics">
          <div class="metric"><b id="upSpeed">—</b><span>Vitesse</span></div>
          <div class="metric"><b id="upEta">—</b><span>Restant</span></div>
          <div class="metric"><b id="upFiles">0/${active.count}</b><span>Fichiers</span></div>
        </div>
        <svg class="speed-spark" id="upSpark" viewBox="0 0 300 44" preserveAspectRatio="none"><defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06d6a0" stop-opacity=".35"/><stop offset="1" stop-color="#06d6a0" stop-opacity="0"/></linearGradient></defs><path class="area" d=""/><path class="line" d=""/></svg>
        <div id="upBanner"></div>
        <div class="row" style="width:100%">
          <button type="button" class="btn grow" id="btnPause">${icon('pause')}Pause</button>
          <button type="button" class="btn danger grow" id="btnCancelUp">${icon('x')}Annuler</button>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-title"><h3>${icon('file')}Fichiers</h3><span class="small faint" id="upDoneTxt"></span></div><div class="file-list" id="upList"></div></div>
    <div class="tip">${icon('refresh')}<span>Coupure réseau, écran verrouillé ou page fermée : <b>l'envoi reprend automatiquement</b>. Si vous fermez Lestha Send, rouvrez le <a href="/dashboard" data-link>tableau de bord</a> et touchez « Reprendre ».</span></div>
  </section>`;
  $('#btnPause', rootEl).onclick = () => { const u = active.uploader; if (u.state === 'paused') u.resumeUpload(); else u.pause(); };
  $('#btnCancelUp', rootEl).onclick = async () => {
    const ok = await modal({ title: 'Annuler l\'envoi ?', body: '<p class="muted">Les fichiers déjà envoyés seront supprimés et le lien ne fonctionnera pas.</p>', actions: [{ label: 'Continuer l\'envoi', cls: 'ghost', value: false }, { label: 'Annuler l\'envoi', cls: 'danger', value: true }] });
    if (!ok || !active) return;
    const id = active.id;
    await active.uploader.cancel();
    const pend = ls.get('tx_pending', {}); delete pend[id]; ls.set('tx_pending', pend);
    owned.remove(id);
    keepAwake(false); active = null; document.title = 'Lestha Send';
    toast('Envoi annulé', 'info');
    renderCompose();
  };
  refreshFileBars();
  updateUploadingState();
  updateUploading({ loaded: active.uploader.loaded, total: active.total, speed: 0, eta: Infinity, history: active.uploader.speedHistory });
}

function updateUploading(d) {
  if (!rootEl || !active || active.phase !== 'upload') return;
  const bar = $('#upBar', rootEl); if (!bar) return;
  const pct = d.total ? d.loaded / d.total : 1;
  const C = 2 * Math.PI * 104;
  bar.style.strokeDashoffset = String(C * (1 - pct));
  const p = Math.floor(pct * 1000) / 10;
  $('#upPct', rootEl).textContent = pct >= 1 ? '100' : p.toFixed(p < 10 ? 1 : 0).replace('.', ',');
  $('#upBytes', rootEl).textContent = bytes(d.loaded) + ' / ' + bytes(d.total);
  const waiting = d.phase === 'confirming' || d.phase === 'assembling';
  $('#upSpeed', rootEl).textContent = d.speed >= 1 && !waiting ? speed(d.speed) : '—';
  $('#upEta', rootEl).textContent = d.speed >= 1 && !waiting ? duration(d.eta) : '—';
  const stEl = $('#upState', rootEl);
  if (stEl && active.uploader.state === 'running') stEl.textContent = d.phase === 'assembling' ? 'Assemblage du fichier…' : d.phase === 'confirming' ? 'Derniers octets en route…' : 'Envoi en cours';
  document.title = Math.floor(pct * 100) + ' % · Envoi Lestha Send';
  const h = d.history || [];
  if (h.length > 1) {
    const line = sparkPath(h, 300, 44, 3);
    $('#upSpark .line', rootEl).setAttribute('d', line);
    $('#upSpark .area', rootEl).setAttribute('d', line + ' L297,44 L3,44 Z');
  }
  refreshFileBars();
}

function refreshFileBars() {
  if (!rootEl || !active) return;
  const list = $('#upList', rootEl); if (!list) return;
  const fp = active.uploader.fileProgress();
  const doneCount = fp.filter(f => f.done).length;
  const f1 = $('#upFiles', rootEl); if (f1) f1.textContent = doneCount + '/' + fp.length;
  const sorted = fp.slice().sort((a, b) => (a.done - b.done) || ((b.loaded > 0) - (a.loaded > 0))).slice(0, 60);
  list.innerHTML = sorted.map(f => {
    const k = fileKind(f.name);
    const pct = f.size ? Math.round(f.loaded / f.size * 100) : 100;
    return `<div class="file-row"><div class="ficon" style="--c:${f.done ? '#10d49a' : k.c}">${icon(f.done ? 'check' : k.icon)}</div>
      <div class="fmeta"><div class="row between"><span class="fname">${esc(f.name)}</span><span class="small faint">${f.done ? 'Envoyé' : pct + ' %'}</span></div>
      <div class="fbar"><i style="width:${f.done ? 100 : pct}%"></i></div></div></div>`;
  }).join('') + (fp.length > 60 ? `<div class="small faint center">+ ${fp.length - 60} autres</div>` : '');
}

function updateUploadingState() {
  if (!rootEl || !active) return;
  const u = active.uploader;
  const btn = $('#btnPause', rootEl), st = $('#upState', rootEl), ring = $('#upRing', rootEl), ban = $('#upBanner', rootEl);
  if (!btn) return;
  btn.innerHTML = u.state === 'paused' ? icon('play') + 'Reprendre' : icon('pause') + 'Pause';
  st.textContent = { running: 'Envoi en cours', paused: 'En pause', offline: 'Hors connexion', done: 'Finalisation…' }[u.state] || 'Envoi';
  ring.classList.toggle('paused', u.state === 'paused' || u.state === 'offline');
  ban.innerHTML = u.state === 'offline' ? `<div class="banner warn">${icon('wifi-off')}<span>Connexion perdue. L'envoi reprendra automatiquement dès le retour du réseau.</span></div>` : '';
}

async function finalize() {
  if (!active) return;
  const ctx = active;
  let res = null;
  for (let i = 0; i < 6 && !res; i++) {
    try { res = await api(`/api/transfers/${ctx.id}/finalize`, { method: 'POST', key: ctx.key, body: { emails: ctx.emails || [] } }); }
    catch (e) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); if (i === 5) { toast('Finalisation impossible : ' + e.message, 'error'); return; } }
  }
  const pend = ls.get('tx_pending', {}); delete pend[ctx.id]; ls.set('tx_pending', pend);
  owned.upsert({ id: ctx.id, key: ctx.key, finalizedAt: Date.now(), expiresAt: res.expiresAt });
  ctx.link = res.link; ctx.manageLink = res.manageLink; ctx.expiresAt = res.expiresAt; ctx.emailed = res.emailed || [];
  if (res.emailNote === 'needVerify') toast('Le lien n\'a pas été envoyé par e-mail : confirmez votre adresse, puis utilisez le bouton E-mail.', 'warn');
  else if (res.emailNote === 'capped') toast('Le lien a été envoyé au nombre maximal de destinataires. Partagez-le directement aux autres.', 'warn');
  else if (res.emailNote === 'dailyCap') toast('Le service a atteint sa limite d\'e-mails du jour : partagez le lien directement.', 'warn');
  ctx.phase = 'done';
  keepAwake(false);
  document.title = 'Lestha Send — Lien prêt';
  notify('Envoi terminé ✅', ctx.title + ' est prêt à être téléchargé');
  if (rootEl && location.pathname === '/') { renderSuccess(); confetti(); }
  else toast('Envoi terminé : ' + ctx.title, 'success', { action: 'Voir', onAction: () => navigate('/') });
}

/* ============================ SUCCÈS ============================ */
function renderSuccess() {
  if (!rootEl || !active) return;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const c = active;
  rootEl.innerHTML = `
  <section class="narrow stack">
    <div class="card glow stack">
      <div class="center">
        <div class="success-burst">${icon('check')}</div>
        <h2>Votre lien est prêt</h2>
        <p class="muted" style="margin-top:6px">${esc(c.title)} · ${bytes(c.total)} · ${c.count} fichier${c.count > 1 ? 's' : ''}</p>
      </div>
      <div class="summary-line" style="justify-content:center">
        <span class="pill ok">${icon('cloud')}Lien permanent</span>
        <span class="pill info">${icon('clock')}Expire dans ${timeLeft(c.expiresAt - Date.now())}</span>
        ${c.pin ? `<span class="pill violet">${icon('lock')}PIN ${esc(c.pin)}</span>` : ''}
        ${c.playback && c.playback !== 'off' ? `<span class="pill violet">${icon('film')}${c.playback === 'only' ? 'Visionnage seul' : 'Lecture en ligne'}</span>` : ''}
        ${c.limit ? `<span class="pill warn">${icon('download')}${c.limit} téléchargement${c.limit > 1 ? 's' : ''}</span>` : ''}
        ${c.emailed && c.emailed.length ? `<span class="pill ok">${icon('mail')}Envoyé à ${c.emailed.length} destinataire${c.emailed.length > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="link-box"><input id="shareLink" readonly value="${esc(c.link)}" aria-label="Lien de téléchargement"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
      ${shareGrid()}
      <div class="qr-card card" style="box-shadow:none">
        <div class="qr" id="qrBox"></div>
        <div class="stack" style="gap:6px">
          <h3>Scannez pour télécharger</h3>
          <p class="small muted">Le destinataire peut télécharger chaque fichier séparément ou tout en ZIP. Les téléchargements interrompus reprennent automatiquement.</p>
          <button type="button" class="btn sm ghost" id="btnMgmt" style="align-self:flex-start">${icon('link', 'sm')}Copier le lien de gestion (privé)</button>
        </div>
      </div>
      <div class="row wrap">
        <a class="btn grow" href="/m/${esc(c.id)}" data-link>${icon('chart')}Suivre en temps réel</a>
        <button type="button" class="btn ghost grow" id="btnNew">${icon('plus')}Nouvel envoi</button>
      </div>
    </div>
  </section>`;
  bindShare(rootEl, c.link, c.title, c);
  renderQR($('#qrBox', rootEl), c.link);
  $('#btnMgmt', rootEl).onclick = async () => { await copyText(c.manageLink); toast('Lien de gestion copié — gardez-le privé : il permet de gérer ce transfert', 'success'); };
  $('#btnNew', rootEl).onclick = () => { active = null; clearItems(); S.opts.emails = []; S.opts.title = ''; S.opts.message = ''; S.opts.pin = ''; document.title = 'Lestha Send'; renderCompose(); };
}

export function shareGrid() {
  return `<div class="share-grid">
    <button type="button" class="btn" data-share="native">${icon('share')}Partager</button>
    <button type="button" class="btn" data-share="whatsapp">${icon('whatsapp')}WhatsApp</button>
    <button type="button" class="btn" data-share="telegram">${icon('telegram')}Telegram</button>
    <button type="button" class="btn" data-share="mail">${icon('mail')}E-mail</button>
  </div>`;
}

/** Boutons copier / partager ; si ctx.id+key et e-mail serveur dispo → envoi via le serveur */
export function bindShare(root, link, title, ctx) {
  const copyBtn = $('#btnCopy', root);
  if (copyBtn) copyBtn.onclick = async () => {
    await copyText(link);
    copyBtn.innerHTML = icon('check', 'sm') + 'Copié';
    copyBtn.classList.add('ok');
    setTimeout(() => { copyBtn.innerHTML = icon('copy', 'sm') + 'Copier'; copyBtn.classList.remove('ok'); }, 1800);
  };
  const inp = $('#shareLink', root); if (inp) inp.onclick = () => inp.select();
  root.querySelectorAll('[data-share]').forEach(b => b.onclick = async () => {
    const kind = b.dataset.share;
    const text = `Je t'ai envoyé « ${title} » via Lestha Send`;
    if (kind === 'mail') {
      const cfg = await getConfig();
      if (cfg.email && ctx && (ctx.key || ctx.p2p)) return emailDialog(link, title, ctx);
    }
    shareTo(kind, { link, text });
  });
}

async function emailDialog(link, title, ctx) {
  const addr = await modal({
    title: 'Envoyer le lien par e-mail',
    body: `<p class="muted small" style="margin-bottom:12px">Le destinataire reçoit un e-mail avec un bouton de téléchargement.</p><input class="input" id="mailTo" type="email" inputmode="email" placeholder="destinataire@exemple.com">`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Envoyer', cls: 'primary', icon: 'mail', handler: (bd) => { const v = bd.querySelector('#mailTo').value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast('Adresse invalide', 'warn'); return false; } return v; } }],
    onMount: (m) => { const i = m.querySelector('#mailTo'); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.querySelector('.btn.primary').click(); }); }
  });
  if (!addr) return;
  const send = () => ctx.p2p
    ? api('/api/send-email', { method: 'POST', body: { to: addr, link, fileName: title } })
    : api(`/api/transfers/${ctx.id}/email`, { method: 'POST', key: ctx.key, body: { emails: [addr] } });
  try {
    try { await send(); }
    catch (e) {
      if (!(e.data && e.data.needVerify)) throw e;
      if (!(await ensureVerified('Pour envoyer un lien par e-mail, confirmez d\'abord votre adresse.'))) return;
      await send();
    }
    toast('E-mail envoyé à ' + addr, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================ REPRISE APRÈS FERMETURE ============================ */
/** Reprend un envoi interrompu (page fermée) : l'utilisateur resélectionne les mêmes fichiers */
export async function resumePending(id) {
  if (active && active.phase === 'upload') { toast('Un envoi est déjà en cours', 'warn'); return navigate('/'); }
  const p = ls.get('tx_pending', {})[id];
  if (!p) return toast('Envoi introuvable sur cet appareil', 'error');
  const matched = new Map(); // fid -> File
  const hasFolder = p.files.some(f => f.path && f.path.includes('/'));
  const tryMatch = (files) => {
    let n = 0;
    for (const file of files) {
      const rel = file.webkitRelativePath || null;
      const cand = p.files.find(f => !matched.has(f.fid) && f.name === file.name && f.size === file.size && (!rel || !f.path || f.path === rel || f.path.endsWith(rel.split('/').slice(1).join('/'))));
      if (cand) { matched.set(cand.fid, file); n++; }
    }
    return n;
  };
  const missing = () => p.files.filter(f => !matched.has(f.fid));
  const allDoneOnServer = async () => {
    // Fichiers déjà finalisés côté serveur : inutile de les resélectionner
    try {
      const t = await api(`/api/transfers/${id}`, { key: p.key });
      t.files.forEach(f => { if (f.done && !matched.has(f.id)) matched.set(f.id, null); });
      return t;
    } catch (e) {
      if (e.status === 404 || e.status === 403) {
        const pend = ls.get('tx_pending', {}); delete pend[id]; ls.set('tx_pending', pend); owned.remove(id);
        toast('Ce transfert n\'existe plus sur le serveur', 'error');
        return null;
      }
      throw e;
    }
  };
  const t = await allDoneOnServer();
  if (!t) return;
  while (missing().length) {
    const m = missing();
    const choice = await modal({
      title: 'Reprendre l\'envoi',
      body: `<p class="muted small">Pour des raisons de sécurité, le navigateur ne peut pas rouvrir vos fichiers tout seul. Resélectionnez-les : seuls les morceaux manquants seront envoyés.</p>
        <div class="file-summary" style="margin:14px 0 8px"><span>Retrouvés</span><b>${p.files.length - m.length} / ${p.files.length}</b></div>
        <div class="file-list" style="max-height:200px">${m.slice(0, 30).map(f => `<div class="file-row"><div class="ficon" style="--c:${fileKind(f.name).c}">${icon(fileKind(f.name).icon)}</div><div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${bytes(f.size)}${f.path ? ' · ' + esc(f.path) : ''}</div></div></div>`).join('')}</div>`,
      actions: [{ label: 'Plus tard', cls: 'ghost', value: null }, ...(hasFolder ? [{ label: 'Choisir le dossier', icon: 'folder', value: 'folder' }] : []), { label: 'Choisir les fichiers', cls: 'primary', icon: 'file', value: 'files' }]
    });
    if (!choice) return;
    const files = await pick(choice);
    const n = tryMatch(files);
    if (!n && files.length) toast('Ces fichiers ne correspondent pas à l\'envoi (nom ou taille différents)', 'warn');
  }
  const items = p.files.map(f => {
    const serverFile = t.files.find(x => x.id === f.fid);
    const done = !!(serverFile && serverFile.done);
    // Fichier déjà finalisé côté serveur : pas besoin du vrai fichier
    const file = matched.get(f.fid) || { name: f.name, size: f.size, type: '', slice: () => new Blob([]) };
    return { file, meta: { id: f.fid, partSize: f.partSize, partCount: f.partCount, done } };
  });
  const total = p.files.reduce((s, f) => s + f.size, 0);
  const up = new Uploader({ id, key: p.key, items, resume: true });
  runUpload({ uploader: up, id, key: p.key, emails: p.emails || [], title: p.title, total, count: p.files.length, pin: '', limit: t.maxDownloads || 0 });
}
