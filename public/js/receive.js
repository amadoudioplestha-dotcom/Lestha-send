/* TransferX — page de téléchargement (mode Cloud) */
import { $, $$, esc, icon, bytes, fileKind, relTime, ls, ss, api, visitorId, toast, modal, copyText, isMobile } from './core.js';

let root = null, id = null, data = null, timer = null, poll = null;

export default {
  async render(r, { match }) {
    root = r; id = match[1];
    root.innerHTML = skeleton();
    await load();
  },
  destroy() { clearInterval(timer); clearTimeout(poll); root = null; }
};

const token = () => ss.get('tx_tk_' + id) || ls.get('tx_tk_' + id, null);
const q = (extra = '') => `v=${encodeURIComponent(visitorId())}${token() ? '&tk=' + encodeURIComponent(token()) : ''}${extra}`;
const fileUrl = (fid, inline) => `/api/public/t/${id}/f/${fid}?${q(inline ? '&inline=1' : '')}`;
const absUrl = (p) => location.origin + p;

function skeleton() {
  return `<section class="receive-card stack"><div class="card stack">
    <div class="row"><div class="skeleton" style="width:50px;height:50px;border-radius:16px"></div><div class="grow stack" style="gap:8px"><div class="skeleton" style="height:18px;width:60%"></div><div class="skeleton" style="height:12px;width:35%"></div></div></div>
    <div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div></div></section>`;
}

async function load() {
  clearTimeout(poll);
  try {
    data = await api(`/api/public/t/${id}?${q()}`);
  } catch (e) {
    if (!root) return;
    if (e.network) { root.innerHTML = state('warn', 'wifi-off', 'Hors connexion', 'Impossible de joindre le serveur. Nouvelle tentative…'); poll = setTimeout(load, 4000); return; }
    root.innerHTML = state('bad', 'x', 'Lien introuvable', 'Ce transfert n\'existe pas ou a expiré et ses fichiers ont été supprimés.', cta());
    return;
  }
  if (!root) return;
  if (data.locked && data.pinRequired && data.state !== 'expired' && data.state !== 'disabled') return renderPin();
  switch (data.state) {
    case 'expired': root.innerHTML = state('warn', 'clock', 'Ce transfert a expiré', `Les fichiers ont été supprimés le ${new Date(data.expiresAt).toLocaleDateString('fr-FR')}. Demandez à l'expéditeur un nouveau lien.`, cta()); return;
    case 'disabled': root.innerHTML = state('warn', 'power', 'Transfert désactivé', 'L\'expéditeur a temporairement désactivé ce lien.', cta()); return;
    case 'uploading':
      root.innerHTML = state('info', 'upload', 'Envoi en cours…', `L'expéditeur est en train d'envoyer ${data.fileCount} fichier${data.fileCount > 1 ? 's' : ''} (${bytes(data.totalSize)}). Cette page s'actualise automatiquement dès que tout est prêt.`, '<div class="spinner lg"></div>');
      poll = setTimeout(load, 5000); return;
    case 'limit':
      if (!data.alreadyRecipient) { root.innerHTML = state('bad', 'download', 'Limite atteinte', 'Ce transfert a déjà été téléchargé le nombre de fois autorisé par l\'expéditeur.', cta()); return; }
      break;
  }
  renderReady();
}

function state(kind, ic, title, text, extra = '') {
  return `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon ${kind}">${icon(ic)}</div><h2>${esc(title)}</h2><p class="muted" style="max-width:460px">${text}</p>${extra}</div></div></section>`;
}
const cta = () => `<a class="btn" href="/" data-link>${icon('upload')}Envoyer mes propres fichiers</a>`;

function renderPin(err = '') {
  root.innerHTML = state('info', 'lock', 'Transfert protégé', `${data.fileCount} fichier${data.fileCount > 1 ? 's' : ''} · ${bytes(data.totalSize)}${data.senderName ? ' · de ' + esc(data.senderName) : ''}<br>Saisissez le code PIN communiqué par l'expéditeur.`, `
    <form id="pinForm" class="stack" style="width:100%;max-width:320px;margin-top:6px">
      <input class="input pin-input" id="pinEntry" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="one-time-code" placeholder="••••" aria-label="Code PIN">
      <button class="btn primary block" type="submit">${icon('unlock')}Déverrouiller</button>
      ${err ? `<p class="small" style="color:var(--rose)">${esc(err)}</p>` : ''}
    </form>`);
  const f = $('#pinForm', root), inp = $('#pinEntry', root);
  inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 8); });
  setTimeout(() => inp.focus(), 60);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const pin = inp.value.trim();
    if (!/^\d{4,8}$/.test(pin)) return renderPin('Le code contient 4 à 8 chiffres');
    const btn = f.querySelector('button'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Vérification…';
    try {
      const r = await api(`/api/public/t/${id}/unlock`, { method: 'POST', body: { pin } });
      ss.set('tx_tk_' + id, r.token);
      toast('Déverrouillé', 'success');
      load();
    } catch (err2) {
      renderPin(err2.message);
      const i = $('#pinEntry', root); if (i) { i.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 300, iterations: 2 }); }
    }
  };
}

function renderReady() {
  const d = data;
  const files = d.files || [];
  const title = d.title || (files.length === 1 ? files[0].name : `${files.length} fichiers`);
  const initial = (d.senderName || 'TX').trim().charAt(0).toUpperCase();
  const got = ls.get('tx_got_' + id, {});
  const hasFolders = files.some(f => f.path && f.path.includes('/'));
  root.innerHTML = `
  <section class="receive-card stack">
    <div class="card glow stack">
      <div class="sender-head">
        <div class="avatar">${esc(initial)}</div>
        <div class="grow" style="min-width:0">
          <div class="small muted">${d.senderName ? esc(d.senderName) + ' vous a envoyé' : 'Vous avez reçu'} · ${relTime(d.createdAt)}</div>
          <h2 style="font-size:clamp(20px,4vw,28px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</h2>
        </div>
      </div>
      ${d.message ? `<div class="message-bubble">${esc(d.message)}</div>` : ''}
      <div class="row wrap between">
        <div class="summary-line">
          <span class="pill info">${icon('file')}${files.length} fichier${files.length > 1 ? 's' : ''}</span>
          <span class="pill info">${icon('cloud')}${bytes(d.totalSize)}</span>
          ${d.pinRequired ? `<span class="pill violet">${icon('lock')}Protégé</span>` : ''}
          ${d.downloadsLeft != null ? `<span class="pill warn">${icon('download')}${d.alreadyRecipient ? 'Accès accordé' : d.downloadsLeft + ' téléchargement' + (d.downloadsLeft > 1 ? 's' : '') + ' restant' + (d.downloadsLeft > 1 ? 's' : '')}</span>` : ''}
        </div>
        <div class="countdown" id="cd" title="Temps restant avant suppression"></div>
      </div>
      ${files.length === 1
        ? `<a class="btn primary xl block" href="${fileUrl(files[0].id)}" data-dl="${files[0].id}">${icon('download')}Télécharger · ${bytes(files[0].size)}</a>`
        : `<div class="row wrap cta-row">
            <a class="btn primary xl grow" href="/api/public/t/${id}/zip?${q()}" data-zip>${icon('zip')}Tout télécharger (.zip)</a>
            <button type="button" class="btn xl grow" id="btnSeq">${icon('download')}Un par un</button>
          </div>`}
      <div class="tip">${icon('refresh')}<span>${files.length > 1 ? `Le ZIP ${hasFolders ? 'conserve l\'arborescence des dossiers' : 'regroupe tout'} ; « Un par un » télécharge chaque fichier séparément <b>avec reprise possible</b>. ` : ''}Téléchargement interrompu ? Ouvrez les téléchargements du navigateur et touchez <b>Reprendre</b> : il repart là où il s'était arrêté.</span></div>
    </div>

    <div class="card">
      <div class="card-title"><h3>${icon('folder')}Contenu</h3><span class="small faint">${bytes(d.totalSize)}</span></div>
      <div class="stack" style="gap:8px" id="dlList">
        ${files.map(f => {
          const k = fileKind(f.name, f.type);
          const thumb = k.kind === 'image' && f.size < 12e6 && files.length <= 80;
          const canPreview = ['image', 'video', 'audio'].includes(k.kind) || k.kind === 'pdf';
          return `<div class="dl-row" data-fid="${f.id}">
            <div class="ficon" style="--c:${k.c}" ${canPreview ? `data-preview="${f.id}" title="Aperçu"` : ''}>${thumb ? `<img src="${fileUrl(f.id, true)}" alt="" loading="lazy" decoding="async">` : icon(k.icon)}</div>
            <div class="fmeta"><div class="fname" title="${esc(f.path || f.name)}">${esc(f.name)}</div><div class="fsub">${bytes(f.size)}${f.path && f.path.includes('/') ? ' · ' + esc(f.path.split('/').slice(0, -1).join('/')) : ''}${got[f.id] ? ' · <span style="color:var(--ok)">téléchargé</span>' : ''}</div></div>
            ${!isMobile ? `<button type="button" class="btn sm icon ghost" data-copy="${f.id}" title="Copier le lien direct (gestionnaire de téléchargement)">${icon('link', 'sm')}</button>` : ''}
            <a class="btn sm dl-btn ${got[f.id] ? 'ok' : ''}" href="${fileUrl(f.id)}" data-dl="${f.id}" aria-label="Télécharger ${esc(f.name)}">${icon(got[f.id] ? 'check' : 'download', 'sm')}<span>${got[f.id] ? 'Encore' : 'Télécharger'}</span></a>
          </div>`;
        }).join('')}
      </div>
    </div>
    <p class="center small faint">Vous aussi, envoyez vos fichiers lourds gratuitement · <a href="/" data-link>TransferX</a></p>
  </section>`;
  bindReady(files);
  tickCountdown();
  clearInterval(timer);
  timer = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  const el = root && $('#cd', root); if (!el || !data) return;
  const ms = Math.max(0, data.expiresAt - Date.now());
  const d = Math.floor(ms / 86400e3), h = Math.floor(ms % 86400e3 / 3600e3), m = Math.floor(ms % 3600e3 / 60e3), s = Math.floor(ms % 60e3 / 1000);
  const parts = d > 0 ? [[d, 'jours'], [h, 'h'], [m, 'min']] : [[h, 'h'], [m, 'min'], [s, 's']];
  el.innerHTML = parts.map(([v, l]) => `<span>${String(v).padStart(2, '0')}<small>${l}</small></span>`).join('');
  if (ms <= 0) { clearInterval(timer); load(); }
}

function markGot(fid) {
  const got = ls.get('tx_got_' + id, {}); got[fid] = Date.now(); ls.set('tx_got_' + id, got);
  const a = root && root.querySelector(`.dl-btn[data-dl="${fid}"]`);
  if (a) { a.classList.add('ok'); a.innerHTML = icon('check', 'sm') + '<span>Encore</span>'; }
}

function bindReady(files) {
  root.onclick = async (e) => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { markGot(dl.dataset.dl); toast('Téléchargement lancé', 'success'); return; }
    if (e.target.closest('[data-zip]')) { toast('Préparation du ZIP… le téléchargement démarre', 'success'); files.forEach(f => markGot(f.id)); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) { await copyText(absUrl(fileUrl(cp.dataset.copy))); toast('Lien direct copié — collez-le dans IDM, aria2… pour un téléchargement multi-connexions', 'success'); return; }
    const pv = e.target.closest('[data-preview]');
    if (pv) { const f = files.find(x => x.id === pv.dataset.preview); if (f) preview(f); }
  };
  const seq = $('#btnSeq', root);
  if (seq) seq.onclick = async () => {
    seq.disabled = true;
    toast('Les téléchargements démarrent un par un. Autorisez les téléchargements multiples si le navigateur le demande.', 'info', { duration: 7000 });
    const links = $$('.dl-btn[data-dl]', root);
    for (const a of links) { a.click(); await new Promise(r => setTimeout(r, 1400)); }
    seq.disabled = false;
  };
}

function preview(f) {
  const k = fileKind(f.name, f.type);
  const src = fileUrl(f.id, true);
  const media = k.kind === 'image' ? `<img class="preview-media" src="${src}" alt="${esc(f.name)}" style="object-fit:contain">`
    : k.kind === 'video' ? `<video class="preview-media" src="${src}" controls autoplay playsinline></video>`
    : k.kind === 'audio' ? `<audio src="${src}" controls autoplay style="width:100%"></audio>`
    : `<iframe src="${src}" title="${esc(f.name)}" style="width:100%;height:70vh;border:0;border-radius:12px;background:#fff"></iframe>`;
  modal({ title: f.name, wide: true, body: media, actions: [{ label: 'Fermer', cls: 'ghost' }, { label: 'Télécharger', cls: 'primary', icon: 'download', handler: () => { const a = document.createElement('a'); a.href = fileUrl(f.id); document.body.appendChild(a); a.click(); a.remove(); markGot(f.id); } }] });
}
