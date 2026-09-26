/* TransferX — gestion d'un transfert : statistiques détaillées, contrôle et activité en direct */
import { $, esc, icon, bytes, num, timeLeft, fmtDate, fileKind, ls, owned, api, toast, modal, renderQR, animateCount, getSocket, notify, confirmDialog } from './core.js';
import { navigate } from './router.js';
import { bucketize, barChart, feedItem, refreshTimes } from './charts.js';
import { shareGrid, bindShare, resumePending } from './send.js';

function onComment(d) { if (!t || !d || d.id !== t.id) return; t.comments = (t.comments || []).concat(d.comment); renderComments(); }
let root = null, id = null, key = null, t = null, timer = null, sock = null, onEv = null, onConn = null;

export default {
  async render(r, { match, hash }) {
    root = r; id = match[1];
    if (hash && /^[A-Za-z0-9_-]{10,}$/.test(hash)) {
      owned.upsert({ id, key: hash, createdAt: (owned.get(id) || {}).createdAt || Date.now(), title: (owned.get(id) || {}).title || 'Transfert' });
      history.replaceState({}, '', '/m/' + id);             // la clé ne reste pas dans l'historique
    }
    const o = owned.get(id);
    if (!o) return askKey();
    key = o.key;
    root.innerHTML = `<section class="stack"><div class="skeleton" style="height:180px;border-radius:20px"></div><div class="kpis">${'<div class="skeleton" style="height:110px;border-radius:18px"></div>'.repeat(4)}</div><div class="skeleton" style="height:260px;border-radius:20px"></div></section>`;
    await load();
    clearInterval(timer);
    timer = setInterval(() => { tickLife(); refreshTimes(root); }, 15000);
    live();
  },
  destroy() { clearInterval(timer); if (sock && onEv) { sock.off('transfer-event', onEv); sock.off('transfer-deleted', onEv); } if (sock && onConn) sock.off('connect', onConn); root = null; }
};

function askKey() {
  root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon info">${icon('lock')}</div><h2>Lien de gestion requis</h2>
    <p class="muted">Ce transfert a été créé sur un autre appareil. Collez son lien de gestion (reçu à la création) pour le piloter ici.</p>
    <div class="input-group" style="width:100%;max-width:460px"><input class="input" id="mk" placeholder="https://…/m/${esc(id)}#…"><button class="btn primary" id="mkGo" type="button">Ouvrir</button></div></div></div></section>`;
  $('#mkGo', root).onclick = () => {
    const v = $('#mk', root).value.trim();
    const m = v.match(/#([A-Za-z0-9_-]{10,})/) || v.match(/^([A-Za-z0-9_-]{10,})$/);
    if (!m) return toast('Lien invalide', 'warn');
    navigate('/m/' + id + '#' + m[1], { replace: true });
  };
}

async function load() {
  try { t = await api(`/api/transfers/${id}`, { key }); }
  catch (e) {
    if (!root) return;
    if (e.status === 404) { root.innerHTML = gone(); return; }
    if (e.status === 403) { owned.remove(id); return askKey(); }
    root.innerHTML = `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('wifi-off')}</div><h2>Connexion impossible</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">${icon('refresh')}Réessayer</button></div></div></section>`;
    return;
  }
  owned.upsert({ id, key, title: t.title || (t.files[0] && t.files[0].name) || 'Transfert', totalSize: t.totalSize, fileCount: t.fileCount, expiresAt: t.expiresAt });
  if (root) renderAll();
}

function gone() {
  return `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon">${icon('trash')}</div><h2>Transfert supprimé</h2><p class="muted">Il a expiré ou a été supprimé : les fichiers ne sont plus stockés.</p><a class="btn" href="/dashboard" data-link>${icon('arrow-left')}Tableau de bord</a></div></div></section>`;
}

const titleOf = () => t.title || (t.fileCount === 1 ? t.files[0].name : t.fileCount + ' fichiers');
const STATE = { ready: ['ok', 'Actif'], uploading: ['warn', 'Envoi incomplet'], expired: ['', 'Expiré'], disabled: ['bad', 'Désactivé'], limit: ['warn', 'Limite atteinte'] };

function renderAll() {
  const [sc, sl] = STATE[t.state] || ['', t.state];
  const dl = t.stats.downloads + t.stats.zipDownloads;
  const young = Date.now() - t.createdAt < 3 * 86400e3;
  const pend = ls.get('tx_pending', {})[id];
  root.innerHTML = `
  <section class="stack">
    <a href="/dashboard" data-link class="btn ghost sm" style="align-self:flex-start">${icon('arrow-left', 'sm')}Tableau de bord</a>
    <div class="card glow stack">
      <div class="row wrap between">
        <div class="row grow" style="min-width:240px">
          <div class="ficon" style="--c:${fileKind(titleOf()).c};width:52px;height:52px;border-radius:16px">${icon(t.fileCount > 1 ? 'folder' : fileKind(titleOf()).icon, 'lg')}</div>
          <div class="fmeta">
            <div class="row"><h2 style="font-size:clamp(20px,3.6vw,28px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(titleOf())}</h2><button type="button" class="btn sm icon ghost" id="btnRename" aria-label="Renommer">${icon('edit', 'sm')}</button></div>
            <div class="small muted">${t.fileCount} fichier${t.fileCount > 1 ? 's' : ''} · ${bytes(t.totalSize)} · créé le ${fmtDate(t.createdAt)}</div>
          </div>
        </div>
        <span class="pill ${sc}" style="font-size:13px">${sl}</span>
      </div>
      ${t.state === 'uploading' ? `<div class="banner warn">${icon('refresh')}<span class="grow">L'envoi n'est pas terminé : le lien ne fonctionne pas encore.</span>${pend ? `<button type="button" class="btn sm" id="btnResume">Reprendre</button>` : ''}</div>` : ''}
      <div id="life"></div>
      ${t.state !== 'uploading' ? `<div class="link-box"><input id="shareLink" readonly value="${esc(t.link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>${shareGrid()}` : ''}
    </div>

    <div class="kpis">
      <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Ouvertures<span class="kpi-icon">${icon('eye')}</span></div><div class="kpi-value" id="m1">0</div><div class="kpi-foot">${num(t.stats.uniqueVisitors)} visiteur${t.stats.uniqueVisitors > 1 ? 's' : ''} unique${t.stats.uniqueVisitors > 1 ? 's' : ''}</div></div>
      <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Téléchargements<span class="kpi-icon">${icon('download')}</span></div><div class="kpi-value" id="m2">0</div><div class="kpi-foot">${num(t.stats.zipDownloads)} en ZIP · ${num(t.stats.downloads)} fichier${t.stats.downloads > 1 ? 's' : ''}</div></div>
      <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Destinataires<span class="kpi-icon">${icon('users')}</span></div><div class="kpi-value" id="m3">0</div><div class="kpi-foot">${t.maxDownloads ? 'limite : ' + t.maxDownloads : 'sans limite'} · ${t.stats.uniqueVisitors ? Math.min(100, Math.round(t.stats.recipients / t.stats.uniqueVisitors * 100)) : 0} % de conversion</div></div>
      <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Données servies<span class="kpi-icon">${icon('bolt')}</span></div><div class="kpi-value" id="m4">0 o</div><div class="kpi-foot">${t.stats.failedPins ? `<span style="color:var(--rose)">${t.stats.failedPins} PIN erroné${t.stats.failedPins > 1 ? 's' : ''}</span>` : 'aucune tentative suspecte'}</div></div>
    </div>

    <div class="grid-2">
      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>${icon('chart')}Activité ${young ? '· 48 h' : '· 30 jours'}</h3><div class="legend"><span><i style="background:rgba(0,180,216,.5)"></i>Vues</span><span><i style="background:linear-gradient(#00b4d8,#06d6a0)"></i>Téléch.</span></div></div>
          <div id="mChart"></div>
        </div>
        <div class="card">
          <div class="card-title"><h3>${icon('file')}Fichiers les plus téléchargés</h3></div>
          <div class="per-file" id="perFile"></div>
        </div>
        <div class="card ${t.allowComments || (t.comments || []).length ? '' : 'hidden'}" id="cmCard">
          <div class="card-title"><h3>${icon('message')}Commentaires horodatés</h3><span class="small faint" id="cmCount"></span></div>
          <div class="stack comments" id="cmList" style="gap:6px"></div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-title"><h3>${icon('settings')}Contrôles</h3></div>
          <div class="controls" id="controls"></div>
        </div>
        <div class="card">
          <div class="card-title"><h3>${icon('bolt')}Journal d'activité</h3><span class="live-badge off" id="mLive"><i></i><span>…</span></span></div>
          <div class="feed" id="mFeed"></div>
        </div>
      </div>
    </div>
  </section>`;
  animateCount($('#m1', root), t.stats.views);
  animateCount($('#m2', root), dl);
  animateCount($('#m3', root), t.stats.recipients);
  animateCount($('#m4', root), t.stats.bytesOut, (v) => bytes(v));
  tickLife();
  barChart($('#mChart', root), bucketize(t.events, young ? { hours: 48 } : { days: 30 }));
  renderPerFile();
  renderComments();
  renderControls();
  renderFeed();
  if (t.state !== 'uploading') bindShare(root, t.link, titleOf(), { id, key });
  const rn = $('#btnRename', root); if (rn) rn.onclick = rename;
  const rs = $('#btnResume', root); if (rs) rs.onclick = () => resumePending(id);
}

function tickLife() {
  const el = root && $('#life', root); if (!el || !t) return;
  const now = Date.now();
  if (t.state === 'uploading') { el.innerHTML = ''; return; }
  const start = t.finalizedAt || t.createdAt;
  const total = t.expiresAt - start, left = Math.max(0, t.expiresAt - now);
  const pct = total > 0 ? left / total * 100 : 0;
  el.innerHTML = `<div class="row between small" style="margin-bottom:6px"><span class="muted">${icon('clock', 'sm')} ${left ? 'Expire dans <b style="color:var(--text)">' + timeLeft(left) + '</b>' : 'Expiré'}</span><span class="faint">${fmtDate(t.expiresAt)}</span></div><div class="life ${pct < 20 ? 'low' : ''}"><i style="width:${pct}%"></i></div>`;
}

const fmtT = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
function renderComments() {
  const card = root && $('#cmCard', root); if (!card) return;
  const list = (t.comments || []).slice().sort((a, b) => a.fid === b.fid ? a.time - b.time : a.fid.localeCompare(b.fid));
  card.classList.toggle('hidden', !t.allowComments && !list.length);
  $('#cmCount', root).textContent = list.length || '';
  const nameOf = (fid) => (t.files.find(f => f.id === fid) || {}).name || '';
  $('#cmList', root).innerHTML = list.length ? list.map(c => `<div class="comment" style="cursor:default"><a class="c-time" href="/w/${esc(t.id)}?f=${esc(c.fid)}" data-link title="Ouvrir le lecteur">${fmtT(c.time)}</a><span class="c-body" style="flex:1"><b>${esc(c.name)}</b> ${esc(c.text)}<small>${esc(nameOf(c.fid))} · ${relTimeLocal(c.at)}</small></span><button type="button" class="btn sm icon ghost" data-delc="${esc(c.id)}" aria-label="Supprimer">${icon('trash', 'sm')}</button></div>`).join('') : '<p class="small faint">Aucun commentaire pour l\'instant.</p>';
  $('#cmList', root).onclick = async (e) => {
    const b = e.target.closest('[data-delc]'); if (!b) return;
    try { const r = await api(`/api/transfers/${id}/comments/${b.dataset.delc}`, { method: 'DELETE', key }); t.comments = r.comments; renderComments(); } catch (err) { toast(err.message, 'error'); }
  };
}
const relTimeLocal = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'à l\'instant' : m < 60 ? 'il y a ' + m + ' min' : m < 1440 ? 'il y a ' + Math.round(m / 60) + ' h' : new Date(ts).toLocaleDateString('fr-FR'); };

function renderPerFile() {
  const el = $('#perFile', root);
  const files = t.files.slice().sort((a, b) => b.downloads - a.downloads).slice(0, 12);
  const max = Math.max(1, ...files.map(f => f.downloads));
  const w = t.watch || {};
  el.innerHTML = files.map(f => `<div class="pf-row"><span class="fname" title="${esc(f.path || f.name)}">${esc(f.name)}</span><span class="small muted">${num(f.downloads)} · ${bytes(f.size)}</span><div class="pf-bar"><i style="width:${f.downloads / max * 100}%"></i></div>${w[f.id] ? `<span class="tiny" style="grid-column:1/-1;color:#c4b5fd">${icon('play', 'sm')} ${w[f.id].viewers} spectateur(s) · ${w[f.id].avg} % vu en moyenne · ${w[f.id].completes} jusqu'au bout</span>` : ''}</div>`).join('')
    + (t.files.length > 12 ? `<div class="tiny faint">+ ${t.files.length - 12} autres fichiers</div>` : '')
    + (t.stats.zipDownloads ? `<div class="tiny faint">${icon('zip', 'sm')} ${num(t.stats.zipDownloads)} téléchargement(s) de l'ensemble en ZIP</div>` : '');
}

function renderFeed(newEv) {
  const el = $('#mFeed', root); if (!el) return;
  if (newEv) { if (el.querySelector('.empty')) el.innerHTML = ''; el.insertAdjacentHTML('afterbegin', feedItem(newEv, '', true)); return; }
  const evs = t.events.slice().reverse().slice(0, 80);
  el.innerHTML = evs.length ? evs.map(e => feedItem(e, '')).join('') : `<div class="empty" style="padding:22px"><span class="small">Aucune activité pour l'instant. Partagez le lien !</span></div>`;
}

function renderControls() {
  const el = $('#controls', root);
  el.innerHTML = `
    <div class="control"><div class="control-text"><b>Lecture en ligne</b><span>${t.playback === 'only' ? 'Visionnage seul : téléchargement désactivé' : t.playback === 'on' ? 'Vidéos et audios lisibles en ligne' : 'Téléchargement uniquement'}</span></div><div class="chips">${[['off', 'Non'], ['on', 'Oui'], ['only', 'Seule']].map(([v, l]) => `<button type="button" class="chip ${(t.playback || 'off') === v ? 'active' : ''}" data-pb="${v}">${l}</button>`).join('')}</div></div>
    ${t.playback && t.playback !== 'off' ? `<div class="control"><div class="control-text"><b>Commentaires horodatés</b><span>Les spectateurs commentent un moment précis</span></div><label class="switch"><input type="checkbox" id="cCom" ${t.allowComments ? 'checked' : ''}><span class="track"></span></label></div>
    <div class="control"><div class="control-text"><b>Lien de visionnage</b><span>Ouvre directement le lecteur</span></div><button type="button" class="btn sm" id="cWatch">${icon('copy', 'sm')}Copier</button></div>` : ''}
    <div class="control"><div class="control-text"><b>Lien actif</b><span>Désactivez pour bloquer temporairement l'accès</span></div><label class="switch"><input type="checkbox" id="cActive" ${t.disabled ? '' : 'checked'}><span class="track"></span></label></div>
    <div class="control"><div class="control-text"><b>Prolonger</b><span>Repousser l'expiration</span></div><div class="chips"><button type="button" class="chip" data-ext="${86400e3}">+1 j</button><button type="button" class="chip" data-ext="${7 * 86400e3}">+7 j</button></div></div>
    <div class="control"><div class="control-text"><b>Code PIN</b><span>${t.pinEnabled ? 'Protection activée' : 'Aucune protection'}</span></div><div class="row"><button type="button" class="btn sm" id="cPin">${icon('lock', 'sm')}${t.pinEnabled ? 'Changer' : 'Définir'}</button>${t.pinEnabled ? `<button type="button" class="btn sm ghost" id="cPinOff">Retirer</button>` : ''}</div></div>
    <div class="control"><div class="control-text"><b>Limite de destinataires</b><span>${t.maxDownloads ? t.stats.recipients + ' / ' + t.maxDownloads + ' utilisés' : 'Illimité'}</span></div><div class="chips">${[[0, '∞'], [1, '1'], [5, '5'], [20, '20']].map(([v, l]) => `<button type="button" class="chip ${(t.maxDownloads || 0) === v ? 'active' : ''}" data-lim="${v}">${l}</button>`).join('')}</div></div>
    <div class="control"><div class="control-text"><b>Alerte e-mail</b><span>${t.senderEmail ? esc(t.senderEmail) : 'Au premier téléchargement'}</span></div><label class="switch"><input type="checkbox" id="cNotify" ${t.notifyOnDownload ? 'checked' : ''}><span class="track"></span></label></div>
    <div class="control"><div class="control-text"><b>QR code & gestion</b><span>Partager ou piloter depuis un autre appareil</span></div><div class="row"><button type="button" class="btn sm icon" id="cQr" aria-label="QR code">${icon('qr', 'sm')}</button><button type="button" class="btn sm" id="cMgmt">${icon('link', 'sm')}Lien privé</button></div></div>
    <div class="control"><div class="control-text"><b>Supprimer maintenant</b><span>Efface définitivement les fichiers</span></div><button type="button" class="btn sm danger" id="cDel">${icon('trash', 'sm')}Supprimer</button></div>`;
  el.querySelectorAll('[data-pb]').forEach(b => b.onclick = () => patch({ playback: b.dataset.pb }, 'Mode de lecture mis à jour'));
  const cc = $('#cCom', el); if (cc) cc.onchange = (e) => patch({ allowComments: e.target.checked }, e.target.checked ? 'Commentaires activés' : 'Commentaires désactivés');
  const cw = $('#cWatch', el); if (cw) cw.onclick = async () => { await navigator.clipboard.writeText(t.link.replace('/t/', '/w/')).catch(() => {}); toast('Lien de visionnage copié', 'success'); };
  $('#cActive', el).onchange = (e) => patch({ disabled: !e.target.checked }, e.target.checked ? 'Lien réactivé' : 'Lien désactivé');
  el.querySelectorAll('[data-ext]').forEach(b => b.onclick = () => patch({ extendMs: +b.dataset.ext }, 'Expiration prolongée'));
  el.querySelectorAll('[data-lim]').forEach(b => b.onclick = () => patch({ maxDownloads: +b.dataset.lim || null }, 'Limite mise à jour'));
  $('#cPin', el).onclick = async () => {
    const pin = await modal({ title: t.pinEnabled ? 'Changer le code PIN' : 'Protéger par un code PIN', body: `<p class="small muted" style="margin-bottom:10px">Les destinataires devront saisir ce code. Communiquez-le par un autre canal que le lien.</p><input class="input pin-input" id="newPin" inputmode="numeric" maxlength="8" placeholder="••••">`, actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Enregistrer', cls: 'primary', handler: (bd) => { const v = bd.querySelector('#newPin').value.trim(); if (!/^\d{4,8}$/.test(v)) { toast('4 à 8 chiffres', 'warn'); return false; } return v; } }] });
    if (pin) patch({ pin }, 'Code PIN enregistré');
  };
  const off = $('#cPinOff', el); if (off) off.onclick = () => patch({ pin: null }, 'Code PIN retiré');
  $('#cNotify', el).onchange = async (e) => {
    if (e.target.checked && !t.senderEmail) {
      const mail = await modal({ title: 'Votre e-mail', body: `<input class="input" id="me" type="email" placeholder="vous@exemple.com" value="${esc(ls.get('tx_sender_email', ''))}">`, actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Activer', cls: 'primary', handler: (bd) => { const v = bd.querySelector('#me').value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast('E-mail invalide', 'warn'); return false; } return v; } }] });
      if (!mail) { e.target.checked = false; return; }
      ls.set('tx_sender_email', mail);
      return patch({ notifyOnDownload: true, senderEmail: mail }, 'Alerte activée');
    }
    patch({ notifyOnDownload: e.target.checked }, e.target.checked ? 'Alerte activée' : 'Alerte désactivée');
  };
  $('#cQr', el).onclick = () => modal({ title: 'QR code du lien', body: `<div class="qr" id="qrM" style="width:220px;height:220px;margin:6px auto"></div><p class="center small muted">${esc(t.link)}</p>`, actions: [{ label: 'Fermer', cls: 'primary' }], onMount: (m) => renderQR(m.querySelector('#qrM'), t.link) });
  $('#cMgmt', el).onclick = async () => {
    const link = location.origin + '/m/' + id + '#' + key;
    await navigator.clipboard.writeText(link).catch(() => {});
    toast('Lien de gestion copié : ouvrez-le sur un autre appareil pour piloter ce transfert. Ne le partagez pas.', 'success');
  };
  $('#cDel', el).onclick = async () => {
    if (!(await confirmDialog('Supprimer ce transfert ?', 'Les fichiers seront effacés immédiatement et le lien cessera de fonctionner. Action irréversible.', 'Supprimer', true))) return;
    try { await api(`/api/transfers/${id}`, { method: 'DELETE', key }); } catch (e) { if (e.status !== 404) return toast(e.message, 'error'); }
    owned.remove(id);
    const pend = ls.get('tx_pending', {}); delete pend[id]; ls.set('tx_pending', pend);
    toast('Transfert supprimé', 'success');
    navigate('/dashboard');
  };
}

async function patch(body, msg) {
  try { t = await api(`/api/transfers/${id}`, { method: 'PATCH', key, body }); toast(msg, 'success'); if (root) renderAll(); }
  catch (e) { toast(e.message, 'error'); if (root) renderControls(); }
}

async function rename() {
  const v = await modal({ title: 'Renommer', body: `<input class="input" id="nt" maxlength="140" value="${esc(t.title || '')}" placeholder="${esc(titleOf())}">`, actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Enregistrer', cls: 'primary', handler: (bd) => bd.querySelector('#nt').value.trim() || '' }] });
  if (v === null || v === undefined) return;
  await patch({ title: v }, 'Titre mis à jour');
  owned.upsert({ id, title: v || titleOf() });
}

async function live() {
  sock = await getSocket();
  const badge = () => root && $('#mLive', root);
  onConn = () => sock.emit('watch-transfers', [{ id, key }], (r) => { const b = badge(); if (b && r && r.ok.includes(id)) { b.classList.remove('off'); b.lastChild.textContent = 'En direct'; } });
  onEv = (d) => {
    if (!d || d.id !== id) return;
    if (!d.event) { if (root) root.innerHTML = gone(); return; }  // transfer-deleted
    t.events.push(d.event);
    t.stats = Object.assign(t.stats, d.stats);
    if (d.state) t.state = d.state;
    if (d.event.type === 'download' || d.event.type === 'zip') notify('Nouveau téléchargement', titleOf() + (d.event.f ? ' · ' + d.event.f : ''));
    if (!root) return;
    renderFeed(d.event);
    animateCount($('#m1', root), t.stats.views);
    animateCount($('#m2', root), t.stats.downloads + t.stats.zipDownloads);
    animateCount($('#m3', root), t.stats.recipients);
    animateCount($('#m4', root), t.stats.bytesOut, (v) => bytes(v));
    const young = Date.now() - t.createdAt < 3 * 86400e3;
    barChart($('#mChart', root), bucketize(t.events, young ? { hours: 48 } : { days: 30 }));
    if (d.event.type === 'download') { const f = t.files.find(x => (x.path || x.name) === d.event.f); if (f) { f.downloads++; renderPerFile(); } }
  };
  sock.off('transfer-comment', onComment);
  sock.on('transfer-comment', onComment);
  sock.on('transfer-event', onEv);
  sock.on('transfer-deleted', onEv);
  sock.on('connect', onConn);
  if (sock.connected) onConn();
}
