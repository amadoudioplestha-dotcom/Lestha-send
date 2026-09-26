/* TransferX — Tableau de bord : tous vos transferts, statistiques et activité en direct */
import { $, $$, esc, icon, bytes, num, timeLeft, relTime, fileKind, ls, owned, api, getConfig, toast, modal, copyText, animateCount, getSocket, notify, sparkPath, confirmDialog } from './core.js';
import { navigate } from './router.js';
import { bucketize, barChart, feedItem, refreshTimes } from './charts.js';
import { resumePending } from './send.js';
import * as p2p from './p2p.js';

let subFn = null, discFn = null;
let root = null, items = [], filter = ls.get('tx_dash_filter', 'all'), search = '', timer = null, sock = null;

export default {
  async render(r) {
    root = r;
    ls.set('tx_seen', Date.now());
    const b = document.getElementById('navBadge'); if (b) b.classList.add('hidden');
    root.innerHTML = shell();
    bindStatic();
    await refresh();
    clearInterval(timer);
    timer = setInterval(() => { refreshTimes(root); if (document.visibilityState === 'visible') refresh(true); }, 30000);
    watchLive();
  },
  destroy() { clearInterval(timer); root = null; if (sock) sock.off('transfer-event', onLive); const c = $('#chart'); if (c && c._cleanup) c._cleanup(); }
};

function shell() {
  return `
  <section>
    <div class="dash-head">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span>Centre de contrôle</span>
        <h2 style="margin-top:8px">Tableau de bord</h2>
        <p class="muted small" style="margin-top:4px">Suivez qui ouvre et télécharge vos fichiers, en temps réel.</p>
      </div>
      <div class="row wrap">
        <button type="button" class="btn sm" id="btnNotif">${icon('bell', 'sm')}<span>Alertes</span></button>
        <button type="button" class="btn sm" id="btnTools">${icon('settings', 'sm')}Outils</button>
        <a class="btn sm primary" href="/" data-link>${icon('plus', 'sm')}Nouvel envoi</a>
      </div>
    </div>
    <div id="pendingZone"></div>
    <div class="kpis" id="kpis">${['#00b4d8', '#06d6a0', '#8b7bff', '#fbbf24'].map(c => `<div class="kpi" style="--kc:${c}"><div class="skeleton" style="height:14px;width:60%"></div><div class="skeleton" style="height:30px;width:50%;margin-top:14px"></div></div>`).join('')}</div>
    <div class="grid-2" style="margin-bottom:18px">
      <div class="card">
        <div class="card-title"><h3>${icon('chart')}Activité · 14 jours</h3><div class="legend"><span><i style="background:rgba(0,180,216,.5)"></i>Vues</span><span><i style="background:linear-gradient(#00b4d8,#06d6a0)"></i>Téléchargements</span></div></div>
        <div id="chart"><div class="skeleton" style="height:200px"></div></div>
        <div id="storage" style="margin-top:14px"></div>
      </div>
      <div class="card">
        <div class="card-title"><h3>${icon('bolt')}En direct</h3><span class="live-badge off" id="liveBadge"><i></i><span>Connexion…</span></span></div>
        <div class="feed" id="feed"><div class="skeleton" style="height:48px"></div></div>
      </div>
    </div>
    <div class="toolbar">
      <div class="chips" id="filters">${[['all', 'Tous'], ['active', 'Actifs'], ['uploading', 'En cours'], ['p2p', 'Direct P2P'], ['expired', 'Expirés']].map(([v, l]) => `<button type="button" class="chip ${filter === v ? 'active' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
      <label class="search">${icon('search')}<input class="input" id="q" placeholder="Rechercher un transfert…" value="${esc(search)}"></label>
    </div>
    <div class="t-list" id="tlist"></div>
  </section>`;
}

function bindStatic() {
  $('#filters', root).onclick = (e) => { const c = e.target.closest('[data-f]'); if (!c) return; filter = c.dataset.f; ls.set('tx_dash_filter', filter); $$('#filters .chip', root).forEach(x => x.classList.toggle('active', x === c)); renderList(); };
  $('#q', root).oninput = (e) => { search = e.target.value.trim().toLowerCase(); renderList(); };
  $('#tlist', root).onclick = (e) => {
    const card = e.target.closest('[data-open]'); if (!card) return;
    const it = items.find(x => x.key === card.dataset.open); if (!it) return;
    if (it.kind === 'cloud') navigate('/m/' + it.id);
    else if (it.kind === 'p2p') p2pInfo(it);
    else if (it.kind === 'pending') resumePending(it.id);
  };
  const nb = $('#btnNotif', root);
  const upd = () => { const on = 'Notification' in window && Notification.permission === 'granted'; nb.classList.toggle('ok', on); nb.lastChild.textContent = on ? 'Alertes actives' : 'Alertes'; };
  upd();
  nb.onclick = async () => {
    if (!('Notification' in window)) return toast('Notifications non prises en charge par ce navigateur', 'warn');
    if (Notification.permission === 'granted') return toast('Vous serez alerté à chaque téléchargement tant que TransferX est ouvert', 'info');
    const p = await Notification.requestPermission(); upd();
    if (p === 'granted') toast('Alertes activées 🔔', 'success');
  };
  $('#btnTools', root).onclick = tools;
}

/* ---------------- Données ---------------- */
async function refresh(silent) {
  const cfg = await getConfig();
  const mine = owned.all();
  let summaries = [];
  if (mine.length) {
    try { summaries = (await api('/api/owner/summary', { method: 'POST', body: { items: mine.map(x => ({ id: x.id, key: x.key })) } })).items; }
    catch (e) { if (!silent) toast(e.message, 'error'); summaries = mine.map(x => ({ id: x.id, offline: true })); }
  }
  const pend = ls.get('tx_pending', {});
  items = [];
  mine.forEach((o, i) => {
    const s = summaries[i] || { id: o.id, offline: true };
    if (pend[o.id] && (s.status === 'uploading' || s.offline)) {
      items.push({ kind: 'pending', key: 'p:' + o.id, id: o.id, title: o.title, totalSize: o.totalSize, fileCount: o.fileCount, createdAt: o.createdAt, uploaded: s.uploaded || 0, state: 'uploading' });
      return;
    }
    if (s.gone) {
      if (Date.now() - (o.expiresAt || o.createdAt) > 14 * 86400e3) { owned.remove(o.id); return; }
      items.push({ kind: 'cloud-gone', key: 'c:' + o.id, id: o.id, title: o.title, totalSize: o.totalSize, fileCount: o.fileCount, createdAt: o.createdAt, expiresAt: o.expiresAt || o.createdAt, state: 'expired', stats: {}, events: [] });
      return;
    }
    if (s.offline) { items.push({ kind: 'cloud', key: 'c:' + o.id, id: o.id, title: o.title, totalSize: o.totalSize, fileCount: o.fileCount, createdAt: o.createdAt, expiresAt: o.expiresAt || 0, state: 'unknown', stats: {}, events: [] }); return; }
    if (s.expiresAt && s.expiresAt !== o.expiresAt && s.status === 'ready') owned.upsert({ id: o.id, expiresAt: s.expiresAt });
    items.push(Object.assign({ kind: 'cloud', key: 'c:' + s.id }, s, { title: s.title || o.title || s.firstFile }));
  });
  const activeP2P = ls.get('tx_p2p_active', null);
  ls.get('transferx_history', []).forEach(h => {
    const isActive = h.expiresAt > Date.now() && ((p2p.isSending() || activeP2P) && activeP2P && activeP2P.roomId === h.roomId);
    items.push({ kind: 'p2p', key: 'r:' + h.roomId, id: h.roomId, title: h.fileName, totalSize: h.fileSize, fileCount: h.fileCount || 1, createdAt: h.createdAt, expiresAt: h.expiresAt, state: isActive ? 'ready' : 'expired', pinEnabled: !!h.pin, stats: { downloads: h.downloadCount || 0, views: 0, uniqueVisitors: 0 }, events: [] });
  });
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!root) return;
  renderKpis(cfg);
  renderChartAndFeed();
  renderPending();
  renderList();
}

function renderKpis(cfg) {
  const cloud = items.filter(x => x.kind === 'cloud');
  const active = items.filter(x => (x.kind === 'cloud' || x.kind === 'p2p') && x.state === 'ready');
  const hosted = cloud.filter(x => x.state === 'ready' || x.state === 'limit' || x.state === 'disabled').reduce((s, x) => s + (x.totalSize || 0), 0);
  const downloads = items.reduce((s, x) => s + ((x.stats && (x.stats.downloads || 0) + (x.stats.zipDownloads || 0)) || 0), 0);
  const visitors = cloud.reduce((s, x) => s + (x.stats.uniqueVisitors || 0), 0);
  const views = cloud.reduce((s, x) => s + (x.stats.views || 0), 0);
  const served = cloud.reduce((s, x) => s + (x.stats.bytesOut || 0), 0);
  const recipients = cloud.reduce((s, x) => s + (x.stats.recipients || 0), 0);
  const conv = visitors ? Math.min(100, Math.round(recipients / visitors * 100)) : 0;
  const k = $('#kpis', root);
  k.innerHTML = `
    <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Liens actifs<span class="kpi-icon">${icon('link')}</span></div><div class="kpi-value" id="k1">0</div><div class="kpi-foot">${items.length} transfert${items.length > 1 ? 's' : ''} au total</div></div>
    <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Téléchargements<span class="kpi-icon">${icon('download')}</span></div><div class="kpi-value" id="k2">0</div><div class="kpi-foot">${bytes(served)} servis</div></div>
    <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Visiteurs uniques<span class="kpi-icon">${icon('eye')}</span></div><div class="kpi-value" id="k3">0</div><div class="kpi-foot">${num(views)} ouverture${views > 1 ? 's' : ''} · ${conv} % ont téléchargé</div></div>
    <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Volume en ligne<span class="kpi-icon">${icon('cloud')}</span></div><div class="kpi-value" id="k4">0 o</div><div class="kpi-foot">${cfg.quotaBytes ? 'sur ' + bytes(cfg.quotaBytes, 0) : 'supprimé à expiration'}</div></div>`;
  animateCount($('#k1', k), active.length);
  animateCount($('#k2', k), downloads);
  animateCount($('#k3', k), visitors);
  animateCount($('#k4', k), hosted, (v) => bytes(v));
  const st = $('#storage', root);
  if (cfg.quotaBytes) {
    const pct = Math.min(100, hosted / cfg.quotaBytes * 100);
    st.innerHTML = `<div class="row between small" style="margin-bottom:6px"><span class="muted">Stockage utilisé</span><b>${bytes(hosted)} / ${bytes(cfg.quotaBytes, 0)}</b></div><div class="gauge"><i style="width:${pct}%"></i></div>`;
  } else st.innerHTML = '';
}

function renderChartAndFeed() {
  const all = [];
  items.forEach(x => (x.events || []).forEach(e => all.push(Object.assign({ title: x.title }, e))));
  barChart($('#chart', root), bucketize(all, { days: 14 }));
  const feed = $('#feed', root);
  const recent = all.filter(e => e.type !== 'ready').sort((a, b) => b.t - a.t).slice(0, 30);
  feed.innerHTML = recent.length ? recent.map(e => feedItem(e, e.title)).join('') : `<div class="empty" style="padding:26px 10px"><div class="state-icon info">${icon('bolt')}</div><span class="small">Les ouvertures et téléchargements apparaîtront ici en temps réel.</span></div>`;
}

function renderPending() {
  const z = $('#pendingZone', root);
  const pend = items.filter(x => x.kind === 'pending');
  z.innerHTML = pend.length ? `<div class="stack" style="gap:10px;margin-bottom:18px">${pend.map(p => {
    const pct = p.totalSize ? Math.round(p.uploaded / p.totalSize * 100) : 0;
    return `<div class="card pending-card"><div class="row wrap between"><div class="row grow" style="min-width:220px"><div class="ficon" style="--c:#fbbf24">${icon('refresh')}</div><div class="fmeta"><div class="fname">Envoi interrompu · ${esc(p.title)}</div><div class="fsub">${p.fileCount} fichier${p.fileCount > 1 ? 's' : ''} · ${bytes(p.totalSize)} · ${pct ? pct + ' % finalisés · ' : ''}morceaux déjà reçus conservés · ${relTime(p.createdAt)}</div><div class="fbar"><i style="width:${pct}%"></i></div></div></div>
      <div class="row"><button type="button" class="btn sm primary" data-resume="${esc(p.id)}">${icon('play', 'sm')}Reprendre</button><button type="button" class="btn sm ghost icon" data-drop="${esc(p.id)}" aria-label="Abandonner">${icon('trash', 'sm')}</button></div></div></div>`;
  }).join('')}</div>` : '';
  z.onclick = async (e) => {
    const r = e.target.closest('[data-resume]'); if (r) return resumePending(r.dataset.resume);
    const d = e.target.closest('[data-drop]');
    if (d && await confirmDialog('Abandonner cet envoi ?', 'Les morceaux déjà envoyés seront supprimés.', 'Abandonner', true)) {
      const o = owned.get(d.dataset.drop);
      if (o) api(`/api/transfers/${o.id}`, { method: 'DELETE', key: o.key }).catch(() => {});
      const pend2 = ls.get('tx_pending', {}); delete pend2[d.dataset.drop]; ls.set('tx_pending', pend2);
      owned.remove(d.dataset.drop);
      refresh(true);
    }
  };
}

function matches(x) {
  if (x.kind === 'pending') return false;
  if (search && !String(x.title || '').toLowerCase().includes(search)) return false;
  if (filter === 'active') return x.state === 'ready';
  if (filter === 'uploading') return x.state === 'uploading';
  if (filter === 'p2p') return x.kind === 'p2p';
  if (filter === 'expired') return ['expired', 'deleted'].includes(x.state);
  return true;
}

function renderList() {
  const list = $('#tlist', root); if (!list) return;
  const shown = items.filter(matches);
  if (!shown.length) {
    list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="state-icon info">${icon(items.length ? 'search' : 'upload')}</div><h3>${items.length ? 'Aucun résultat' : 'Aucun transfert pour l\'instant'}</h3><p class="small">${items.length ? 'Essayez un autre filtre.' : 'Vos envois apparaîtront ici avec leurs statistiques en temps réel.'}</p>${items.length ? '' : `<a class="btn primary" href="/" data-link>${icon('upload')}Envoyer des fichiers</a>`}</div>`;
    return;
  }
  const now = Date.now();
  list.innerHTML = shown.map((x, i) => {
    const k = fileKind(x.title || '');
    const lifeTotal = (x.expiresAt || 0) - (x.createdAt || 0);
    const lifeLeft = Math.max(0, (x.expiresAt || 0) - now);
    const lifePct = lifeTotal > 0 ? Math.round(lifeLeft / lifeTotal * 100) : 0;
    const dl = (x.stats.downloads || 0) + (x.stats.zipDownloads || 0);
    const series = bucketize(x.events || [], { days: 7 }).map(b => b.views + b.downloads * 2);
    const st = stateChip(x);
    return `<article class="t-card ${['expired', 'deleted'].includes(x.state) ? 'dim' : ''}" data-open="${esc(x.key)}" style="animation-delay:${Math.min(i, 12) * 40}ms" tabindex="0">
      <div class="t-card-head">
        <div class="ficon" style="--c:${x.kind === 'p2p' ? '#8b7bff' : k.c}">${icon(x.kind === 'p2p' ? 'bolt' : x.fileCount > 1 ? 'folder' : k.icon)}</div>
        <div class="fmeta"><div class="fname">${esc(x.title || 'Transfert')}</div><div class="fsub">${x.fileCount || 1} fichier${(x.fileCount || 1) > 1 ? 's' : ''} · ${bytes(x.totalSize)} · ${relTime(x.createdAt)}</div></div>
        ${st}
      </div>
      <div class="row between">
        <div class="t-stats">
          ${x.kind === 'cloud' ? `<span title="Visiteurs uniques">${icon('eye')}${num(x.stats.uniqueVisitors || 0)}</span>` : ''}
          <span title="Téléchargements">${icon('download')}${num(dl)}</span>
          ${x.pinEnabled ? `<span title="Protégé par PIN">${icon('lock')}</span>` : ''}
          ${x.maxDownloads ? `<span title="Limite">${icon('users')}${x.maxDownloads}</span>` : ''}
        </div>
        ${x.kind === 'cloud' && series.some(v => v) ? `<svg class="spark" viewBox="0 0 84 26" preserveAspectRatio="none"><path d="${sparkPath(series, 84, 26)}"/></svg>` : ''}
      </div>
      ${x.state === 'ready' || x.state === 'limit' || x.state === 'disabled' ? `<div><div class="life ${lifePct < 20 ? 'low' : ''}"><i style="width:${lifePct}%"></i></div><div class="tiny faint" style="margin-top:5px">${icon('clock', 'sm')} Expire dans ${timeLeft(lifeLeft)}</div></div>` : ''}
    </article>`;
  }).join('');
  list.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('[data-open]')) e.target.click(); };
}

function stateChip(x) {
  const map = { ready: ['ok', 'Actif'], uploading: ['warn', 'Envoi…'], expired: ['', 'Expiré'], deleted: ['', 'Supprimé'], disabled: ['bad', 'Désactivé'], limit: ['warn', 'Limite atteinte'], unknown: ['', '…'] };
  const [c, l] = map[x.state] || ['', x.state];
  return `<span class="pill ${c}" style="flex:none">${x.kind === 'p2p' ? 'P2P · ' : ''}${l}</span>`;
}

function p2pInfo(it) {
  if (it.state === 'ready') return navigate('/');
  modal({ title: it.title, body: `<p class="muted small">Lien direct <b class="mono">${esc(it.id)}</b> · ${bytes(it.totalSize)} · ${num(it.stats.downloads)} téléchargement(s).<br><br>Ce lien P2P n'est plus actif : en mode direct, rien n'est stocké. Pour un lien qui reste disponible sans garder l'appli ouverte, utilisez le mode Cloud.</p>`, actions: [{ label: 'Retirer de l\'historique', cls: 'ghost', handler: () => { ls.set('transferx_history', ls.get('transferx_history', []).filter(h => h.roomId !== it.id)); refresh(true); } }, { label: 'OK', cls: 'primary' }] });
}

/* ---------------- Temps réel ---------------- */
async function watchLive() {
  const mine = owned.all();
  const badge = $('#liveBadge', root);
  if (!mine.length) { if (badge) { badge.classList.add('off'); badge.lastChild.textContent = 'Aucun lien'; } return; }
  sock = await getSocket();
  const sub = () => sock.emit('watch-transfers', owned.all().map(x => ({ id: x.id, key: x.key })), () => {
    const b = root && $('#liveBadge', root); if (b) { b.classList.remove('off'); b.lastChild.textContent = 'En direct'; }
  });
  sock.off('transfer-event', onLive);
  sock.on('transfer-event', onLive);
  if (subFn) sock.off('connect', subFn);
  if (discFn) sock.off('disconnect', discFn);
  subFn = sub;
  discFn = () => { const b = root && $('#liveBadge', root); if (b) { b.classList.add('off'); b.lastChild.textContent = 'Reconnexion…'; } };
  sock.on('connect', subFn);
  sock.on('disconnect', discFn);
  if (sock.connected) sub();
}

function onLive({ id, event, stats, state }) {
  const it = items.find(x => x.id === id && x.kind === 'cloud');
  const title = it ? it.title : '';
  if (it) { it.stats = Object.assign({}, it.stats, stats); it.state = state || it.state; (it.events = it.events || []).push(event); }
  if (event.type === 'download' || event.type === 'zip') { toast(`${title || 'Transfert'} : téléchargement${event.f ? ' de ' + event.f : ''}`, 'success'); notify('Nouveau téléchargement', (title || '') + (event.d ? ' · ' + event.d : '')); }
  if (!root) return;
  const feed = $('#feed', root);
  if (feed && event.type !== 'ready') {
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    feed.insertAdjacentHTML('afterbegin', feedItem(event, title, true));
  }
  renderKpis({ quotaBytes: null });
  getConfig().then(renderKpis);
  renderList();
}

/* ---------------- Outils ---------------- */
async function tools() {
  const choice = await modal({
    title: 'Outils',
    body: `<div class="stack" style="gap:10px">
      <p class="small muted">Vos transferts sont liés à cet appareil par une clé de gestion privée. Utilisez ces outils pour les retrouver ailleurs.</p>
      <label class="field"><span>Ajouter un transfert via son lien de gestion</span><div class="input-group"><input class="input" id="mgmtIn" placeholder="https://…/m/abc123#clé"><button type="button" class="btn" id="mgmtGo">Ajouter</button></div></label>
    </div>`,
    actions: [{ label: 'Exporter (sauvegarde)', icon: 'download', value: 'export' }, { label: 'Importer', icon: 'upload', value: 'import' }, { label: 'Fermer', cls: 'ghost', value: null }],
    onMount: (m, close) => {
      m.querySelector('#mgmtGo').onclick = () => {
        const v = m.querySelector('#mgmtIn').value.trim();
        const mm = v.match(/\/m\/([A-Za-z0-9]+)#([A-Za-z0-9_-]+)/);
        if (!mm) return toast('Lien de gestion invalide', 'warn');
        owned.upsert({ id: mm[1], key: mm[2], title: 'Transfert importé', createdAt: Date.now() });
        toast('Transfert ajouté', 'success'); close(null); refresh(); watchLive();
      };
    }
  });
  if (choice === 'export') {
    const blob = new Blob([JSON.stringify({ app: 'TransferX', version: 3, exportedAt: new Date().toISOString(), owned: owned.all(), p2pHistory: ls.get('transferx_history', []) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'transferx-sauvegarde-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Sauvegarde téléchargée — elle contient vos clés de gestion, gardez-la privée', 'warn');
  } else if (choice === 'import') {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try {
        const j = JSON.parse(await inp.files[0].text());
        const list = Array.isArray(j) ? [] : (j.owned || []);
        list.forEach(o => o.id && o.key && owned.upsert(o));
        const hist = Array.isArray(j) ? j : (j.p2pHistory || []);
        if (hist.length) { const cur = ls.get('transferx_history', []); const ids = new Set(cur.map(h => h.roomId)); ls.set('transferx_history', cur.concat(hist.filter(h => h.roomId && !ids.has(h.roomId))).slice(0, 200)); }
        toast('Import réussi', 'success'); refresh(); watchLive();
      } catch (e) { toast('Fichier invalide', 'error'); }
    };
    inp.click();
  }
}

/** Badge de navigation : nouveaux téléchargements depuis la dernière visite */
export async function updateNavBadge() {
  const mine = owned.all();
  const badge = document.getElementById('navBadge');
  if (!badge || !mine.length || location.pathname === '/dashboard') return;
  try {
    const r = await api('/api/owner/summary', { method: 'POST', body: { items: mine.map(x => ({ id: x.id, key: x.key })) } });
    const seen = ls.get('tx_seen', 0);
    const n = r.items.reduce((s, x) => s + (x.events || []).filter(e => (e.type === 'download' || e.type === 'zip') && e.t > seen).length, 0);
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('hidden', !n);
  } catch (e) { /* ignore */ }
}
