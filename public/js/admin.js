/* Lestha Send — Console d'administration (accès réservé) */
import { $, $$, esc, icon, bytes, num, relTime, fmtDate, timeLeft, fileKind, ss, adminPass, api, toast, modal, confirmDialog, animateCount, getSocket, enableRipples, copyText } from './core.js';
import { barChart, feedItem, refreshTimes } from './charts.js';

const TOKEN_KEY = 'tx_admin_token';
const A = { token: ss.get(TOKEN_KEY), tab: ss.get('tx_admin_tab') || 'overview', ov: null, list: { q: '', state: '', sort: 'created', items: [], total: 0, offset: 0 }, live: false };
const root = $('#adm');
enableRipples();

/* ---------------- API ---------------- */
async function aapi(path, opts = {}) {
  try {
    return await api('/api/admin' + path, Object.assign({}, opts, { headers: { Authorization: 'Bearer ' + A.token } }));
  } catch (e) {
    if (e.status === 401) { logout(true); }
    throw e;
  }
}
function logout(expired) {
  A.token = null; ss.del(TOKEN_KEY); adminPass.clear();
  $('#admLogout').classList.add('hidden'); $('#admLive').classList.add('hidden');
  if (expired) toast('Session expirée, reconnectez-vous', 'warn');
  renderLogin();
}
$('#admLogout').onclick = () => logout(false);

/* ---------------- Connexion ---------------- */
function renderLogin(err = '') {
  root.innerHTML = `
  <section class="narrow"><div class="card glow"><div class="state-screen">
    <div class="state-icon info">${icon('shield')}</div>
    <h2>Console d'administration</h2>
    <p class="muted">Accès réservé. Saisissez le mot de passe administrateur.</p>
    <form id="lf" class="stack" style="width:100%;max-width:340px;margin-top:6px">
      <div class="input-group"><input class="input" id="pw" type="password" autocomplete="current-password" placeholder="Mot de passe" aria-label="Mot de passe"><button type="button" class="btn icon" id="pwEye" aria-label="Afficher">${icon('eye')}</button></div>
      <button class="btn primary block" type="submit">${icon('unlock')}Se connecter</button>
      ${err ? `<p class="small" style="color:var(--rose)">${esc(err)}</p>` : ''}
    </form>
  </div></div></section>`;
  const pw = $('#pw');
  setTimeout(() => pw.focus(), 50);
  $('#pwEye').onclick = () => { pw.type = pw.type === 'password' ? 'text' : 'password'; };
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type=submit]'); b.disabled = true; b.innerHTML = '<span class="spinner"></span>Vérification…';
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
      A.token = r.token; ss.set(TOKEN_KEY, r.token);
      start();
    } catch (e2) { renderLogin(e2.message); }
  };
}

/* ---------------- Coque ---------------- */
const TABS = [['overview', 'chart', 'Vue d\'ensemble'], ['insights', 'message', 'Retours & usage'], ['transfers', 'folder', 'Transferts'], ['activity', 'bolt', 'Activité'], ['security', 'shield', 'Sécurité'], ['system', 'settings', 'Système']];
function start() {
  // Le jeton porte sa propre date d'expiration : on la reprend pour l'accès administrateur des pages publiques
  try { const exp = JSON.parse(atob(A.token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).exp; if (exp > Date.now()) adminPass.set(A.token, exp - Date.now() - 60e3); } catch (e) { /* ignore */ }
  $('#admLogout').classList.remove('hidden');
  root.innerHTML = `
  <section>
    <div class="dash-head">
      <div><span class="eyebrow"><span class="pulse-dot"></span>Administration</span><h2 style="margin-top:8px">Console Lestha Send</h2>
      <p class="muted small" style="margin-top:4px">Métadonnées uniquement : le contenu des fichiers et les messages ne sont jamais visibles ici.</p></div>
      <button type="button" class="btn sm" id="admRefresh">${icon('refresh', 'sm')}Actualiser</button>
    </div>
    <div class="chips adm-tabs" id="admTabs" role="tablist">${TABS.map(([k, ic, l]) => `<button type="button" class="chip ${A.tab === k ? 'active' : ''}" data-tab="${k}" role="tab">${icon(ic, 'sm')}${l}</button>`).join('')}</div>
    <div id="admBody"></div>
  </section>`;
  $('#admTabs').onclick = (e) => { const c = e.target.closest('[data-tab]'); if (!c) return; A.tab = c.dataset.tab; ss.set('tx_admin_tab', A.tab); $$('#admTabs .chip').forEach(x => x.classList.toggle('active', x === c)); renderTab(); };
  $('#admRefresh').onclick = () => loadOverview(true).then(renderTab);
  loadOverview(true).then(renderTab).catch(e => toast(e.message, 'error'));
  connectLive();
  setInterval(() => { if (document.visibilityState === 'visible' && A.token) { refreshTimes(root); } }, 30000);
}

async function loadOverview(fresh) {
  A.ov = await aapi('/overview' + (fresh ? '?fresh=1' : ''));
  return A.ov;
}

function renderTab() {
  const body = $('#admBody'); if (!body || !A.ov) return;
  ({ overview: renderOverview, insights: renderInsights, transfers: renderTransfers, activity: renderActivity, security: renderSecurity, system: renderSystem })[A.tab](body);
}

/* ---------------- Vue d'ensemble ---------------- */
function warningBanners(levels) {
  return A.ov.system.warnings.filter(w => levels.includes(w.level)).map(w => `<div class="banner ${w.level === 'bad' ? 'bad' : w.level === 'warn' ? 'warn' : 'info'}">${icon(w.level === 'bad' ? 'x' : w.level === 'warn' ? 'bell' : 'sparkles')}<span>${esc(w.text)}</span></div>`).join('');
}

function renderOverview(body) {
  const o = A.ov, T = o.totals, L = o.live;
  const quota = o.quotaBytes;
  body.innerHTML = `
    <div class="stack" style="gap:10px;margin-bottom:16px">${warningBanners(['bad', 'warn'])}</div>
    <div class="kpis">
      <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Liens actifs<span class="kpi-icon">${icon('link')}</span></div><div class="kpi-value" id="k1">0</div><div class="kpi-foot">${num(T.transfers)} transfert(s) · ${num(T.created.d7)} cette semaine</div></div>
      <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Stockage utilisé<span class="kpi-icon">${icon('cloud')}</span></div><div class="kpi-value" id="k2">0 o</div><div class="kpi-foot">${quota ? `<div class="gauge" style="margin-top:6px"><i style="width:${Math.min(100, T.storedBytes / quota * 100)}%"></i></div>sur ${bytes(quota, 0)}` : 'supprimé automatiquement à expiration'}</div></div>
      <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Téléchargements<span class="kpi-icon">${icon('download')}</span></div><div class="kpi-value" id="k3">0</div><div class="kpi-foot">${bytes(T.bytesOut)} servis</div></div>
      <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Visiteurs uniques<span class="kpi-icon">${icon('eye')}</span></div><div class="kpi-value" id="k4">0</div><div class="kpi-foot">${num(T.views)} ouverture(s) de liens</div></div>
    </div>
    <div class="kpis">
      <div class="kpi" style="--kc:#10d49a"><div class="kpi-top">Connexions en direct<span class="kpi-icon">${icon('users')}</span></div><div class="kpi-value" id="k5">0</div><div class="kpi-foot">onglets Lestha Send ouverts</div></div>
      <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Liens P2P actifs<span class="kpi-icon">${icon('bolt')}</span></div><div class="kpi-value" id="k6">0</div><div class="kpi-foot">${num(L.p2pOnline)} expéditeur(s) en ligne · ${num(L.p2pReceivers)} destinataire(s)</div></div>
      <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Envois (24 h)<span class="kpi-icon">${icon('upload')}</span></div><div class="kpi-value" id="k7">0</div><div class="kpi-foot">${bytes(T.volume.d7)} envoyés sur 7 jours</div></div>
      <div class="kpi" style="--kc:#fb7185"><div class="kpi-top">PIN erronés<span class="kpi-icon">${icon('lock')}</span></div><div class="kpi-value" id="k8">0</div><div class="kpi-foot">${num(T.emails)} e-mail(s) de lien envoyé(s)</div></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="card-title"><h3>${icon('chart')}Activité · 30 jours</h3><div class="legend"><span><i style="background:rgba(0,180,216,.5)"></i>Envois créés</span><span><i style="background:linear-gradient(#00b4d8,#06d6a0)"></i>Téléchargements</span></div></div>
      <div id="ovChart"></div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('phone')}Appareils des destinataires</h3></div>${hbars(o.devices)}</div>
      <div class="card"><div class="card-title"><h3>${icon('monitor')}Navigateurs</h3></div>${hbars(o.browsers)}</div>
    </div>
    <div class="grid-2 adm-grid">
      <div class="card"><div class="card-title"><h3>${icon('download')}Les plus téléchargés</h3></div>${miniList(o.topDownloaded, x => num(x.downloads) + ' téléch.')}</div>
      <div class="card"><div class="card-title"><h3>${icon('cloud')}Les plus volumineux (en ligne)</h3></div>${miniList(o.biggest, x => bytes(x.totalSize))}</div>
    </div>`;
  animateCount($('#k1'), T.states.ready || 0);
  animateCount($('#k2'), T.storedBytes, v => bytes(v));
  animateCount($('#k3'), T.downloads);
  animateCount($('#k4'), T.visitors);
  animateCount($('#k5'), L.sockets);
  animateCount($('#k6'), L.p2pRooms);
  animateCount($('#k7'), T.created.d1);
  animateCount($('#k8'), T.failedPins);
  const buckets = o.days.map(d => { const dt = new Date(d.t); return { label: dt.toLocaleDateString('fr-FR', { day: '2-digit' }), long: dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), views: d.created, downloads: d.downloads }; });
  barChart($('#ovChart'), buckets, ['Envois créés', 'Téléchargements']);
  body.querySelectorAll('[data-open]').forEach(el => el.onclick = () => openDetail(el.dataset.open));
}

function hbars(map) {
  const entries = Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return `<p class="small faint">Pas encore de données.</p>`;
  const max = entries[0][1];
  const total = entries.reduce((s, e) => s + e[1], 0);
  return `<div class="per-file">${entries.map(([k, v]) => `<div class="pf-row"><span class="small" style="font-weight:600;text-transform:capitalize">${esc(k)}</span><span class="small muted">${num(v)} · ${Math.round(v / total * 100)} %</span><div class="pf-bar"><i style="width:${v / max * 100}%"></i></div></div>`).join('')}</div>`;
}

function miniList(items, right) {
  if (!items || !items.length) return `<p class="small faint">Rien à afficher.</p>`;
  return `<div class="stack" style="gap:6px">${items.map(x => { const k = fileKind(x.title); return `<button type="button" class="dl-row adm-mini" data-open="${esc(x.id)}"><div class="ficon" style="--c:${k.c};width:36px;height:36px">${icon(x.fileCount > 1 ? 'folder' : k.icon, 'sm')}</div><div class="fmeta" style="text-align:left"><div class="fname">${esc(x.title)}</div><div class="fsub">${esc(x.id)} · ${relTime(x.createdAt)}</div></div><span class="small muted" style="white-space:nowrap">${right(x)}</span></button>`; }).join('')}</div>`;
}

/* ---------------- Retours & usage (anonyme, agrégé) ---------------- */
const MODE_L = { cloud: 'Cloud (lien)', direct: 'Direct (P2P)', nearby: 'À proximité', live: 'Direct vidéo', classe: 'Classe', review: 'Relecture', request: 'Demande de fichiers' };
const PAGE_L = { home: 'Accueil', nearby: 'À proximité', classe: 'Classe', live: 'Direct vidéo', request: 'Demandes', review: 'Relecture', receive: 'Lien reçu (Cloud)', 'receive-direct': 'Lien reçu (Direct)', 'receive-code': 'Recevoir (code)', dashboard: 'Mes envois', profile: 'Profils @', infos: 'Pages d\'info' };
const HEARD_L = { tiktok: 'TikTok', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', google: 'Google', ami: 'Un proche', ecole: 'École / travail', autre: 'Autre' };
const USE_L = { etudes: 'Études', enseignement: 'Enseignement', travail: 'Travail', creation: 'Création', perso: 'Personnel', autre: 'Autre' };
const KIND_L = { avis: ['info', 'Avis'], idee: ['violet', 'Idée'], probleme: ['bad', 'Problème'] };
const FB_ST = { new: ['warn', 'Nouveau'], lu: ['', 'Lu'], traite: ['ok', 'Traité'] };
const IDEA_ST = { open: ['', 'Ouverte au vote'], planned: ['info', 'Prévue'], done: ['ok', 'Disponible'], hidden: ['bad', 'Masquée'] };
const flag = (cc) => /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0))) + ' ' + cc : '🌐 inconnu';
const relabel = (map, L) => Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [L[k] || k, v]));
const pc = (a, b) => (b ? Math.round(a / b * 100) + ' %' : '—');
A.ins = { days: 30, fbFilter: 'new' };

async function renderInsights(body) {
  body.innerHTML = `<div class="card"><p class="muted"><span class="spinner"></span> Chargement des retours…</p></div>`;
  let R, F, I;
  try {
    [R, F, I] = await Promise.all([aapi('/insights?days=' + A.ins.days), aapi('/feedback' + (A.ins.fbFilter ? '?status=' + A.ins.fbFilter : '')), aapi('/ideas')]);
  } catch (e) { body.innerHTML = `<div class="banner bad">${icon('x')}<span>${esc(e.message)}</span></div>`; return; }
  if (A.tab !== 'insights') return;
  const T = R.totals, L = R.loyalty, F2 = T.funnel, X = T.p2p;
  const moodStars = R.moodAvg ? R.moodAvg.toFixed(1) + ' / 5' : '—';
  const funnel = [['Fichiers choisis', F2.pick], ['Envois terminés', F2.sent], ['Liens ouverts', F2.open], ['Téléchargés', F2.got]];
  const fmax = Math.max(1, ...funnel.map(f => f[1]));
  body.innerHTML = `
    <div class="row wrap" style="gap:8px;margin-bottom:14px;align-items:center">
      <div class="chips" id="insDays">${[7, 30, 90].map(d => `<button type="button" class="chip ${A.ins.days === d ? 'active' : ''}" data-d="${d}">${d} jours</button>`).join('')}</div>
      <span class="small faint" style="flex:1">Mesure anonyme : ni adresse IP, ni nom de fichier, ni contenu. « Ne pas me suivre » respecté.</span>
      <button type="button" class="btn sm" id="insWeekly">${icon('mail', 'sm')}Recevoir le bilan maintenant</button>
    </div>
    ${R.ice && !R.ice.provider ? `<div class="banner warn" style="margin-bottom:12px">${icon('bell')}<span>Aucun relais TURN : le mode Direct échoue sur certains réseaux mobiles. Ajoutez CF_TURN_KEY_ID et CF_TURN_API_TOKEN dans Render.</span></div>` : ''}
    ${R.ice && R.ice.lastError ? `<div class="banner bad" style="margin-bottom:12px">${icon('x')}<span>Relais TURN : ${esc(R.ice.lastError)}</span></div>` : ''}
    <div class="kpis">
      <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Visiteurs<span class="kpi-icon">${icon('users')}</span></div><div class="kpi-value">${num(L.active)}</div><div class="kpi-foot">${num(T.visits)} visites · ${num(L.fresh)} nouveaux</div></div>
      <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Fidélité<span class="kpi-icon">${icon('refresh')}</span></div><div class="kpi-value">${pc(L.back + L.freshReturned, L.active)}</div><div class="kpi-foot">${num(L.back)} revenus · ${num(L.loyal)} fidèles (3 jours ou +)</div></div>
      <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Expéditeurs<span class="kpi-icon">${icon('upload')}</span></div><div class="kpi-value">${num(L.senders)}</div><div class="kpi-foot">${num(L.repeat)} ont envoyé 2 fois ou +</div></div>
      <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Satisfaction<span class="kpi-icon">${icon('message')}</span></div><div class="kpi-value">${moodStars}</div><div class="kpi-foot">${num(T.fb.n)} avis · ${num(R.feedbackNew)} message(s) à lire</div></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="card-title"><h3>${icon('chart')}Visiteurs et envois</h3><div class="legend"><span><i style="background:rgba(0,180,216,.5)"></i>Visiteurs</span><span><i style="background:linear-gradient(#00b4d8,#06d6a0)"></i>Envois</span></div></div>
      <div id="insChart"></div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('arrow-right')}Parcours</h3><span class="small faint">où les gens s'arrêtent</span></div>
        <div class="per-file">${funnel.map(([l, v], i) => `<div class="pf-row"><span class="small" style="font-weight:600">${l}</span><span class="small muted">${num(v)}${i ? ' · ' + pc(v, funnel[i - 1][1]) : ''}</span><div class="pf-bar"><i style="width:${v / fmax * 100}%"></i></div></div>`).join('')}</div></div>
      <div class="card"><div class="card-title"><h3>${icon('bolt')}Usage par mode</h3><span class="small faint">envois et sessions</span></div>${hbars(relabel(T.modes, MODE_L))}</div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('share')}Provenance</h3><span class="small faint">astuce : liens ?src=tiktok</span></div>${hbars(T.src)}</div>
      <div class="card"><div class="card-title"><h3>${icon('radar')}Pays</h3></div>${hbars(Object.fromEntries(Object.entries(T.cc).map(([k, v]) => [flag(k), v])))}</div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('bolt')}Qualité du mode Direct</h3></div>
        <div class="controls">
          <div class="control"><div class="control-text"><b>${num(X.ok)} réussis · ${num(X.fail)} échoués</b><span>Taux de réussite : ${R.p2pSuccess == null ? '—' : Math.round(R.p2pSuccess * 100) + ' %'} · ${num(X.restarts)} reconnexion(s) automatique(s)</span></div></div>
          <div class="control"><div class="control-text"><b>Vitesse moyenne ${R.p2pAvgSpeed ? bytes(R.p2pAvgSpeed) + '/s' : '—'}</b><span>Meilleure : ${X.best ? bytes(X.best) + '/s' : '—'} · ${bytes(X.bytes)} transférés en Direct</span></div></div>
          <div class="control"><div class="control-text"><b>${R.relayShare == null ? '—' : Math.round(R.relayShare * 100) + ' %'} via le relais</b><span>${num(X.direct)} connexion(s) directe(s) · ${num(X.relay)} par relais TURN</span></div></div>
        </div></div>
      <div class="card"><div class="card-title"><h3>${icon('flag')}Problèmes rencontrés</h3><span class="small faint">messages d'erreur vus à l'écran</span></div>
        ${R.errors.length ? `<div class="stack" style="gap:6px">${R.errors.map(([k, v]) => `<div class="row" style="justify-content:space-between;gap:10px"><span class="small">${esc(k)}</span><span class="pill bad" style="flex:none">${num(v)}</span></div>`).join('')}</div>` : '<p class="small faint">Aucun problème signalé 🎉</p>'}</div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('users')}Comment ils vous ont connu</h3><span class="small faint">questionnaire</span></div>${hbars(relabel(T.heard, HEARD_L))}</div>
      <div class="card"><div class="card-title"><h3>${icon('sparkles')}Pour quoi faire</h3><span class="small faint">questionnaire</span></div>${hbars(relabel(T.use, USE_L))}</div>
    </div>
    <div class="grid-2 adm-grid" style="margin-bottom:18px">
      <div class="card"><div class="card-title"><h3>${icon('eye')}Pages visitées</h3></div>${hbars(relabel(T.pages, PAGE_L))}</div>
      <div class="card"><div class="card-title"><h3>${icon('phone')}Appareils</h3></div>${hbars(T.dev)}</div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="card-title"><h3>${icon('message')}Messages des utilisateurs</h3>
        <div class="chips" id="fbFilter">${[['new', 'Nouveaux'], ['lu', 'Lus'], ['traite', 'Traités'], ['', 'Tous']].map(([k, l]) => `<button type="button" class="chip ${A.ins.fbFilter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}</div></div>
      ${F.items.length ? `<div class="stack" style="gap:10px">${F.items.map(f => { const [kc, kl] = KIND_L[f.kind] || KIND_L.avis; const [sc, sl] = FB_ST[f.status] || FB_ST.new; return `
        <div class="dl-row" style="align-items:flex-start;flex-direction:column;gap:6px" data-fb="${esc(f.id)}">
          <div class="row wrap" style="gap:6px;width:100%"><span class="pill ${kc}">${kl}</span>${f.mood ? `<span class="pill">${'★'.repeat(f.mood)}${'☆'.repeat(5 - f.mood)}</span>` : ''}<span class="pill ${sc}">${sl}</span>
            <span class="small faint" style="margin-left:auto">${relTime(f.at)} · ${flag(f.cc)} · ${esc(f.dev || '')}${f.m ? ' · ' + esc(MODE_L[f.m] || f.m) : ''}</span></div>
          ${f.text ? `<p style="margin:0;white-space:pre-wrap">${esc(f.text)}</p>` : '<p class="small faint" style="margin:0">(sans texte)</p>'}
          <div class="row wrap" style="gap:6px;width:100%">
            ${f.heard ? `<span class="small muted">Connu via ${esc(HEARD_L[f.heard] || f.heard)}</span>` : ''}${f.use ? `<span class="small muted">· ${esc(USE_L[f.use] || f.use)}</span>` : ''}
            <span style="flex:1"></span>
            ${f.email ? `<a class="btn sm" href="mailto:${esc(f.email)}?subject=${encodeURIComponent('Votre avis sur Lestha Send')}">${icon('mail', 'sm')}Répondre</a>` : ''}
            ${f.kind === 'idee' ? `<button type="button" class="btn sm" data-promote>${icon('plus', 'sm')}Mettre au vote</button>` : ''}
            ${f.status !== 'traite' ? `<button type="button" class="btn sm" data-st="traite">${icon('check', 'sm')}Traité</button>` : ''}
            ${f.status === 'new' ? `<button type="button" class="btn sm ghost" data-st="lu">Marquer lu</button>` : ''}
            <button type="button" class="btn sm ghost" data-del title="Supprimer">${icon('trash', 'sm')}</button>
          </div></div>`; }).join('')}</div>` : '<p class="small faint">Aucun message dans cette catégorie.</p>'}
    </div>
    <div class="card">
      <div class="card-title"><h3>${icon('sparkles')}Idées soumises au vote</h3><button type="button" class="btn sm primary" id="ideaAdd">${icon('plus', 'sm')}Nouvelle idée</button></div>
      <p class="small muted" style="margin-top:0">Les visiteurs votent depuis « Votre avis ». Vous décidez ensuite quoi construire, sans rien promettre.</p>
      ${I.items.length ? `<div class="stack" style="gap:8px">${I.items.sort((a, b) => b.votes - a.votes).map(i => { const [c, l] = IDEA_ST[i.status] || IDEA_ST.open; return `
        <div class="dl-row" data-idea="${esc(i.id)}"><span class="pill violet" style="flex:none;min-width:52px;justify-content:center">▲ ${num(i.votes)}</span>
          <div class="fmeta" style="text-align:left"><div class="fname">${esc(i.title)}</div>${i.desc ? `<div class="fsub">${esc(i.desc)}</div>` : ''}</div>
          <select class="input" data-ist style="width:auto;flex:none">${Object.entries(IDEA_ST).map(([k, [, lb]]) => `<option value="${k}" ${k === i.status ? 'selected' : ''}>${lb}</option>`).join('')}</select>
          <button type="button" class="btn sm ghost" data-idel title="Supprimer">${icon('trash', 'sm')}</button></div>`; }).join('')}</div>` : '<p class="small faint">Aucune idée pour l\'instant. Ajoutez 3 ou 4 pistes pour lancer les votes.</p>'}
    </div>`;
  const buckets = R.series.map(d => { const dt = new Date(d.day + 'T12:00:00Z'); return { label: dt.toLocaleDateString('fr-FR', { day: '2-digit' }), long: dt.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }), views: d.visitors, downloads: d.sent }; });
  barChart($('#insChart'), buckets, ['Visiteurs', 'Envois']);
  $('#insDays').onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) return; A.ins.days = +b.dataset.d; renderInsights(body); };
  $('#fbFilter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; A.ins.fbFilter = b.dataset.f; renderInsights(body); };
  $('#insWeekly').onclick = async (e) => { const b = e.currentTarget; b.disabled = true; try { const r = await aapi('/weekly', { method: 'POST', body: {} }); toast('Bilan envoyé à ' + r.to, 'success'); } catch (err) { toast(err.message, 'error'); } b.disabled = false; };
  body.querySelectorAll('[data-fb]').forEach(row => {
    const id = row.dataset.fb;
    row.querySelectorAll('[data-st]').forEach(b => b.onclick = async () => { try { await aapi('/feedback/' + id, { method: 'PATCH', body: { status: b.dataset.st } }); renderInsights(body); } catch (err) { toast(err.message, 'error'); } });
    const del = row.querySelector('[data-del]'); if (del) del.onclick = async () => { if (!(await confirmDialog('Supprimer ce message ?', 'Il sera définitivement effacé.', 'Supprimer', true))) return; await aapi('/feedback/' + id, { method: 'DELETE' }); renderInsights(body); };
    const pr = row.querySelector('[data-promote]'); if (pr) pr.onclick = () => ideaForm(body, (F.items.find(x => x.id === id) || {}).text || '', id);
  });
  $('#ideaAdd').onclick = () => ideaForm(body, '');
  body.querySelectorAll('[data-idea]').forEach(row => {
    const id = row.dataset.idea;
    row.querySelector('[data-ist]').onchange = async (e) => { try { await aapi('/ideas/' + id, { method: 'PATCH', body: { status: e.target.value } }); toast('Statut mis à jour', 'success'); } catch (err) { toast(err.message, 'error'); } };
    row.querySelector('[data-idel]').onclick = async () => { if (!(await confirmDialog('Supprimer cette idée ?', 'Les votes seront perdus.', 'Supprimer', true))) return; await aapi('/ideas/' + id, { method: 'DELETE' }); renderInsights(body); };
  });
}
async function ideaForm(body, text, fromFeedback) {
  const r = await modal({ title: 'Idée à soumettre au vote', body: `<div class="stack"><input class="input" id="iT" maxlength="90" placeholder="Titre court (ex. : Envoi programmé)" value="${esc(String(text).slice(0, 90))}"><textarea class="input" id="iD" rows="3" maxlength="400" placeholder="Description en une phrase (facultatif)"></textarea></div>`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Publier', cls: 'primary', handler: (bd) => ({ title: bd.querySelector('#iT').value.trim(), desc: bd.querySelector('#iD').value.trim() }) }] });
  if (!r || !r.title) return;
  try { await aapi('/ideas', { method: 'POST', body: r }); if (fromFeedback) await aapi('/feedback/' + fromFeedback, { method: 'PATCH', body: { status: 'traite' } }); toast('Idée publiée : les visiteurs peuvent voter', 'success'); renderInsights(body); }
  catch (e) { toast(e.message, 'error'); }
}

/* ---------------- Transferts ---------------- */
const STATE = { ready: ['ok', 'Actif'], uploading: ['warn', 'Envoi…'], expired: ['', 'Expiré'], disabled: ['bad', 'Désactivé'], limit: ['warn', 'Limite'] };
const pillOf = (st) => { const [c, l] = STATE[st] || ['', st]; return `<span class="pill ${c}" style="flex:none">${l}</span>`; };

function renderTransfers(body) {
  const L = A.list;
  body.innerHTML = `
    <div class="toolbar">
      <label class="search">${icon('search')}<input class="input" id="tq" placeholder="Titre, identifiant, expéditeur, IP masquée…" value="${esc(L.q)}"></label>
      <select class="input" id="tsort" style="width:auto;min-height:42px">${[['created', 'Plus récents'], ['activity', 'Activité récente'], ['downloads', 'Plus téléchargés'], ['size', 'Plus volumineux'], ['expires', 'Expiration']].map(([v, l]) => `<option value="${v}" ${L.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="chips" id="tstate" style="margin-bottom:14px">${[['', 'Tous'], ['ready', 'Actifs'], ['uploading', 'En cours'], ['disabled', 'Désactivés'], ['limit', 'Limite atteinte'], ['expired', 'Expirés']].map(([v, l]) => `<button type="button" class="chip ${L.state === v ? 'active' : ''}" data-st="${v}">${l}</button>`).join('')}</div>
    <div class="small faint" id="tcount" style="margin-bottom:8px"></div>
    <div class="stack" style="gap:8px" id="tlist"><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div></div>
    <div class="center" style="margin-top:12px"><button type="button" class="btn sm hidden" id="tmore">Afficher plus</button></div>`;
  let deb;
  $('#tq').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { L.q = e.target.value.trim(); loadList(true); }, 250); };
  $('#tsort').onchange = (e) => { L.sort = e.target.value; loadList(true); };
  $('#tstate').onclick = (e) => { const c = e.target.closest('[data-st]'); if (!c) return; L.state = c.dataset.st; $$('#tstate .chip').forEach(x => x.classList.toggle('active', x === c)); loadList(true); };
  $('#tmore').onclick = () => loadList(false);
  $('#tlist').onclick = (e) => { const r = e.target.closest('[data-open]'); if (r) openDetail(r.dataset.open); };
  loadList(true);
}

async function loadList(reset) {
  const L = A.list;
  if (reset) { L.offset = 0; L.items = []; }
  try {
    const r = await aapi(`/transfers?q=${encodeURIComponent(L.q)}&state=${L.state}&sort=${L.sort}&offset=${L.offset}&limit=40${reset ? '&fresh=1' : ''}`);
    L.items = L.items.concat(r.items); L.total = r.total; L.offset += r.items.length;
  } catch (e) { return toast(e.message, 'error'); }
  const list = $('#tlist'); if (!list) return;
  $('#tcount').textContent = `${num(L.total)} transfert(s)`;
  $('#tmore').classList.toggle('hidden', L.items.length >= L.total);
  if (!L.items.length) { list.innerHTML = `<div class="empty"><div class="state-icon">${icon('search')}</div><span class="small">Aucun transfert.</span></div>`; return; }
  list.innerHTML = L.items.map(x => {
    const k = fileKind(x.title);
    return `<button type="button" class="adm-row" data-open="${esc(x.id)}">
      <div class="ficon" style="--c:${k.c}">${icon(x.fileCount > 1 ? 'folder' : k.icon)}</div>
      <div class="fmeta" style="text-align:left"><div class="fname">${esc(x.title)}</div><div class="fsub">${esc(x.id)} · ${x.fileCount} fichier(s) · ${bytes(x.totalSize)} · ${relTime(x.createdAt)}${x.senderName ? ' · ' + esc(x.senderName) : ''}</div></div>
      <div class="adm-cols">
        <span class="t-stats"><span title="Téléchargements">${icon('download')}${num(x.downloads)}</span><span title="Visiteurs uniques">${icon('eye')}${num(x.visitors)}</span>${x.pin ? `<span title="PIN">${icon('lock')}</span>` : ''}${x.reports ? `<span title="Signalements" style="color:var(--rose)">${icon('flag')}${num(x.reports)}</span>` : ''}</span>
        <span class="small faint adm-creator" title="Expéditeur">${x.creator ? `${icon(x.creator.device === 'mobile' ? 'phone' : 'monitor', 'sm')} ${esc(x.creator.ipMasked)}${x.creator.blocked ? ' · <b style="color:var(--rose)">bloqué</b>' : ''}` : '—'}</span>
        ${pillOf(x.state)}
      </div>
    </button>`;
  }).join('');
}

async function openDetail(id) {
  let t;
  try { t = await aapi('/transfers/' + encodeURIComponent(id)); } catch (e) { return toast(e.message, 'error'); }
  const evs = t.events.slice().reverse().slice(0, 40);
  const res = await modal({
    title: t.title, wide: true,
    body: `
      <div class="summary-line" style="margin-bottom:12px">${pillOf(t.state)}<span class="pill">${esc(t.id)}</span><span class="pill info">${icon('cloud')}${bytes(t.totalSize)}</span>${t.pin ? `<span class="pill violet">${icon('lock')}PIN</span>` : ''}${t.maxDownloads ? `<span class="pill warn">${icon('users')}limite ${t.maxDownloads}</span>` : ''}</div>
      <div class="adm-info">
        <div><span>Créé</span><b>${fmtDate(t.createdAt)}</b></div>
        <div><span>Expire</span><b>${t.expiresAt > Date.now() ? 'dans ' + timeLeft(t.expiresAt - Date.now()) : 'expiré'}</b></div>
        <div><span>Téléchargements</span><b>${num(t.downloads)} (${num(t.zipDownloads)} ZIP)</b></div>
        <div><span>Visiteurs uniques</span><b>${num(t.visitors)}</b></div>
        <div><span>Destinataires</span><b>${num(t.recipients)}</b></div>
        <div><span>Données servies</span><b>${bytes(t.bytesOut)}</b></div>
        <div><span>Expéditeur</span><b>${t.senderName ? esc(t.senderName) + ' · ' : ''}${t.creator ? esc(t.creator.ipMasked) + ' · ' + esc(t.creator.device || '') + ' ' + esc(t.creator.browser || '') : '—'}</b></div>
        <div><span>E-mails envoyés</span><b>${t.emails.length ? t.emails.map(e => esc(e.to)).join(', ') : '—'}</b></div>
        <div><span>Offre</span><b>${t.tier === 'free' ? 'Sans compte' : t.tier === 'verified' ? 'Adresse vérifiée' : t.tier === 'deposit' ? 'Dépôt' : t.tier ? 'Complète' : '—'}${t.senderVerified ? ' · expéditeur vérifié' : ''}</b></div>
        <div><span>Signalements</span><b style="${t.reports ? 'color:var(--rose)' : ''}">${t.reports ? num(t.reports) + (t.disabledBy === 'reports' ? ' · suspendu automatiquement' : '') : '—'}</b></div>
      </div>
      ${(t.reportsDetail || []).length ? `<h3 style="margin:16px 0 8px">Motifs signalés</h3><div class="stack" style="gap:6px">${t.reportsDetail.slice().reverse().map(r => `<div class="small"><span class="faint">${relTime(r.at)}</span> · ${esc(r.reason || 'sans motif')}</div>`).join('')}</div>` : ''}
      <h3 style="margin:16px 0 8px">Fichiers</h3>
      <div class="file-list" style="max-height:180px">${t.files.slice(0, 100).map(f => { const k = fileKind(f.name, f.type); return `<div class="file-row"><div class="ficon" style="--c:${k.c};width:32px;height:32px">${icon(k.icon, 'sm')}</div><div class="fmeta"><div class="fname">${esc(f.path || f.name)}</div><div class="fsub">${bytes(f.size)} · ${num(f.downloads)} téléch.${f.done ? '' : ' · incomplet'}</div></div></div>`; }).join('')}</div>
      <h3 style="margin:16px 0 8px">Activité</h3>
      <div class="feed" style="max-height:220px">${evs.length ? evs.map(e => admFeed(e, '')).join('') : '<p class="small faint">Aucune activité.</p>'}</div>`,
    actions: [
      { label: 'Fermer', cls: 'ghost', value: null },
      { label: 'Copier le lien', icon: 'copy', value: 'copy' },
      ...(t.creator ? [{ label: t.creator.blocked ? 'Débloquer l\'expéditeur' : 'Bloquer l\'expéditeur', icon: 'shield', value: t.creator.blocked ? 'unblock' : 'block' }] : []),
      { label: '+7 jours', icon: 'clock', value: 'extend' },
      { label: t.disabled ? 'Réactiver' : 'Désactiver', icon: 'power', value: 'toggle' },
      { label: 'Supprimer', cls: 'danger', icon: 'trash', value: 'delete' }
    ]
  });
  try {
    if (res === 'copy') { await copyText(t.link); toast('Lien copié', 'success'); }
    else if (res === 'extend') { await aapi('/transfers/' + id, { method: 'PATCH', body: { extendMs: 7 * 86400e3 } }); toast('Expiration prolongée de 7 jours', 'success'); }
    else if (res === 'toggle') { await aapi('/transfers/' + id, { method: 'PATCH', body: { disabled: !t.disabled } }); toast(t.disabled ? 'Lien réactivé' : 'Lien désactivé', 'success'); }
    else if (res === 'delete') {
      if (!(await confirmDialog('Supprimer ce transfert ?', 'Les fichiers sont effacés définitivement et le lien cesse de fonctionner.', 'Supprimer', true))) return;
      await aapi('/transfers/' + id, { method: 'DELETE' }); toast('Transfert supprimé', 'success');
    } else if (res === 'block') { await blockCreator(t.creator); }
    else if (res === 'unblock') { await aapi('/blocks/' + t.creator.ipHash, { method: 'DELETE' }); toast('Expéditeur débloqué', 'success'); }
    else return;
    await loadOverview(true);
    if (A.tab === 'transfers') loadList(true); else renderTab();
  } catch (e) { toast(e.message, 'error'); }
}

async function blockCreator(c) {
  const reason = await modal({
    title: 'Bloquer cet expéditeur ?',
    body: `<p class="small muted" style="margin-bottom:10px">La connexion <b>${esc(c.ipMasked)}</b> ne pourra plus créer d'envoi (Cloud ni P2P). Les liens déjà créés restent actifs, sauf si vous les supprimez.</p><input class="input" id="br" maxlength="200" placeholder="Motif (facultatif)">`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Bloquer', cls: 'danger', handler: (bd) => bd.querySelector('#br').value.trim() || 'sans motif' }]
  });
  if (!reason) return false;
  await aapi('/blocks', { method: 'POST', body: { ipHash: c.ipHash, ipMasked: c.ipMasked, reason } });
  toast('Expéditeur bloqué', 'success');
  return true;
}

/* ---------------- Activité ---------------- */
const ADM_EV = {
  created: { ic: 'upload', c: '#00b4d8', txt: 'Nouvel envoi Cloud' },
  deleted: { ic: 'trash', c: '#fb7185', txt: 'Transfert supprimé' },
  p2p_created: { ic: 'bolt', c: '#8b7bff', txt: 'Lien direct P2P créé' },
  p2p_download: { ic: 'download', c: '#8b7bff', txt: 'Téléchargement P2P terminé' },
  request_created: { ic: 'inbox', c: '#06d6a0', txt: 'Nouvelle demande de fichiers' },
  deposit_started: { ic: 'upload', c: '#06d6a0', txt: 'Dépôt en cours' },
  deposit: { ic: 'inbox', c: '#10d49a', txt: 'Dépôt reçu' }
};
function admFeed(e, title, isNew) {
  const m = ADM_EV[e.type];
  if (!m) return feedItem(e, title, isNew);
  const extra = ['created', 'p2p_created', 'deposit_started', 'deposit'].includes(e.type) ? ` — ${e.n || 0} fichier(s), ${bytes(e.size)}` : e.type === 'deleted' ? ` (${e.by === 'admin' ? 'par l\'admin' : e.by === 'expiration' ? 'expiration' : 'par l\'expéditeur'})` : '';
  return `<div class="feed-item ${isNew ? 'new' : ''}"><div class="feed-dot" style="--fc:${m.c}">${icon(m.ic)}</div><div style="min-width:0"><div class="small" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.txt)}${esc(extra)}</div><div class="tiny faint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title || '')}${e.d ? ' · ' + esc(e.d) : ''}${e.b ? ' · ' + esc(e.b) : ''}</div></div><span class="feed-time" data-ts="${e.t}">${relTime(e.t)}</span></div>`;
}

function renderActivity(body) {
  body.innerHTML = `<div class="card"><div class="card-title"><h3>${icon('bolt')}Flux en direct</h3><span class="small faint">Envois, ouvertures, téléchargements, PIN erronés, suppressions</span></div>
    <div class="feed" id="afeed" style="max-height:none">${A.ov.recent.length ? A.ov.recent.map(e => admFeed(e, e.title)).join('') : `<div class="empty"><span class="small">Aucune activité récente.</span></div>`}</div></div>`;
}

/* ---------------- Sécurité ---------------- */
async function renderSecurity(body) {
  let blocks = [];
  try { blocks = (await aapi('/blocks')).items; } catch (e) { toast(e.message, 'error'); }
  const o = A.ov;
  body.innerHTML = `
    <div class="grid-2 adm-grid">
      <div class="stack">
        <div class="card"><div class="card-title"><h3>${icon('shield')}Connexions bloquées</h3><span class="pill ${blocks.length ? 'bad' : ''}">${blocks.length}</span></div>
          ${blocks.length ? `<div class="stack" style="gap:8px">${blocks.map(b => `<div class="receiver-item"><div class="receiver-top"><span><b>${esc(b.ipMasked)}</b><br><span class="tiny faint">${esc(b.reason)} · ${relTime(b.at)}</span></span><button type="button" class="btn sm" data-unblock="${esc(b.ipHash)}">Débloquer</button></div></div>`).join('')}</div>` : '<p class="small faint">Aucune connexion bloquée.</p>'}
        </div>
        <div class="card"><div class="card-title"><h3>${icon('lock')}Codes PIN erronés</h3></div>
          ${o.pinFails.length ? `<div class="feed">${o.pinFails.map(p => `<div class="feed-item"><div class="feed-dot" style="--fc:#fb7185">${icon('lock')}</div><div style="min-width:0"><div class="small" style="font-weight:600">${esc(p.title)}</div><div class="tiny faint">${esc(p.id)}${p.d ? ' · ' + esc(p.d) : ''}</div></div><span class="feed-time" data-ts="${p.t}">${relTime(p.t)}</span></div>`).join('')}</div>` : '<p class="small faint">Aucune tentative suspecte.</p>'}
        </div>
      </div>
      <div class="card"><div class="card-title"><h3>${icon('users')}Expéditeurs les plus actifs</h3></div>
        <p class="tiny faint" style="margin-bottom:10px">Identifiés par une empreinte de connexion : l'adresse IP complète n'est jamais enregistrée.</p>
        ${o.creators.length ? `<div class="stack" style="gap:8px">${o.creators.map(c => `<div class="receiver-item"><div class="receiver-top"><span class="row">${icon(c.device === 'mobile' ? 'phone' : 'monitor', 'sm')}<span><b>${esc(c.ipMasked)}</b> <span class="tiny faint">${esc(c.browser || '')}</span><br><span class="tiny faint">${num(c.count)} envoi(s) · ${bytes(c.volume)} · ${relTime(c.lastAt)}</span></span></span>
          ${c.blocked ? `<button type="button" class="btn sm" data-unblock="${esc(c.ipHash)}">Débloquer</button>` : `<button type="button" class="btn sm danger" data-block="${esc(c.ipHash)}" data-mask="${esc(c.ipMasked)}">Bloquer</button>`}</div></div>`).join('')}</div>` : '<p class="small faint">Pas encore d\'envoi.</p>'}
      </div>
    </div>`;
  body.onclick = async (e) => {
    const u = e.target.closest('[data-unblock]'), b = e.target.closest('[data-block]');
    try {
      if (u) { await aapi('/blocks/' + u.dataset.unblock, { method: 'DELETE' }); toast('Débloqué', 'success'); }
      else if (b) { if (!(await blockCreator({ ipHash: b.dataset.block, ipMasked: b.dataset.mask }))) return; }
      else return;
      await loadOverview(true); renderSecurity(body);
    } catch (err) { toast(err.message, 'error'); }
  };
}

/* ---------------- Système ---------------- */
function renderSystem(body) {
  const s = A.ov.system;
  const up = s.uptime > 86400 ? Math.floor(s.uptime / 86400) + ' j ' + Math.floor(s.uptime % 86400 / 3600) + ' h' : s.uptime > 3600 ? Math.floor(s.uptime / 3600) + ' h ' + Math.floor(s.uptime % 3600 / 60) + ' min' : Math.floor(s.uptime / 60) + ' min';
  const checks = [
    [s.storage === 's3', s.storage === 's3' ? 'ok' : (s.cloudEnabled ? 'warn' : 'bad'), 'Stockage', s.storage === 's3' ? `Cloudflare R2 / S3 · bucket « ${esc(s.bucket || '?')} »` : 'Disque local du serveur' + (s.isRender ? ' — effacé à chaque redémarrage de Render' : '')],
    [s.cloudEnabled, s.cloudEnabled ? 'ok' : 'bad', 'Mode Cloud', s.cloudEnabled ? 'Actif : les liens survivent aux redémarrages' : 'Désactivé tant que R2 n\'est pas configuré (P2P seul)'],
    [s.uploadCode, s.uploadCode ? 'ok' : 'warn', 'Code d\'accès à l\'envoi', s.uploadCode ? 'Actif : seules les personnes qui ont le code peuvent envoyer' : 'Absent : n\'importe qui peut créer des envois (UPLOAD_CODE)'],
    [!!s.publicUrl, s.publicUrl ? 'ok' : 'warn', 'Adresse publique', s.publicUrl ? esc(s.publicUrl) : 'PUBLIC_URL non renseignée'],
    [s.appSecret, s.appSecret ? 'ok' : 'info', 'Secret de signature', s.appSecret ? 'APP_SECRET défini' : 'Généré automatiquement et conservé dans le stockage'],
    [!!s.email, s.email ? 'ok' : 'info', 'E-mail', s.email ? 'Fournisseur : ' + esc(s.email) : 'Non configuré (SendGrid ou SMTP)'],
    [!!s.turn, s.turn ? 'ok' : 'warn', 'Relais TURN (mode Direct)', s.turn === 'cloudflare' ? 'Cloudflare : identifiants éphémères renouvelés automatiquement' : s.turn ? 'Serveur personnalisé (TURN_URL)' : 'Absent : ajoutez CF_TURN_KEY_ID et CF_TURN_API_TOKEN pour fiabiliser le Direct sur 4G/5G'],
    [!!s.adminEmail, s.adminEmail ? 'ok' : 'info', 'Bilan hebdomadaire', s.adminEmail ? 'Envoyé chaque lundi à ADMIN_EMAIL' : 'Renseignez ADMIN_EMAIL pour le recevoir']
  ];
  const ic = { ok: 'check', warn: 'bell', bad: 'x', info: 'sparkles' };
  body.innerHTML = `
    <div class="grid-2 adm-grid">
      <div class="card"><div class="card-title"><h3>${icon('settings')}Configuration</h3></div>
        <div class="controls">${checks.map(([, lvl, t, d]) => `<div class="control"><div class="row" style="align-items:flex-start"><span class="chk ${lvl}">${icon(ic[lvl], 'sm')}</span><div class="control-text"><b>${t}</b><span>${d}</span></div></div></div>`).join('')}</div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-title"><h3>${icon('monitor')}Serveur</h3></div>
          <div class="adm-info">
            <div><span>Version</span><b>Lestha Send ${esc(s.version)}</b></div><div><span>Node.js</span><b>${esc(s.node)}</b></div>
            <div><span>En ligne depuis</span><b>${up}</b></div><div><span>Mémoire</span><b>${s.memoryMb} Mo</b></div>
            <div><span>Hébergement</span><b>${s.isRender ? 'Render' : 'Autre'}</b></div><div><span>Console</span><b>${esc(s.adminPath)}</b></div>
          </div>
        </div>
        <div class="card"><div class="card-title"><h3>${icon('shield')}Diagnostic complet</h3></div>
          <p class="small muted" style="margin-bottom:12px">Vérifie le stockage, puis fait un vrai petit envoi depuis ce navigateur (règle CORS du bucket R2), le télécharge et le supprime.</p>
          <div class="row wrap"><button type="button" class="btn primary" id="runTest">${icon('play')}Lancer le test</button><button type="button" class="btn" id="mailTest">${icon('mail')}E-mail de test</button></div>
          <div class="stack" id="testOut" style="gap:6px;margin-top:14px"></div>
        </div>
      </div>
    </div>
    <div class="stack" style="gap:10px;margin-top:18px">${warningBanners(['bad', 'warn', 'info'])}</div>`;
  $('#runTest').onclick = runFullTest;
  $('#mailTest').onclick = async () => {
    const to = await modal({ title: 'E-mail de test', body: '<input class="input" id="mt" type="email" placeholder="adresse@exemple.com">', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Envoyer', cls: 'primary', handler: (bd) => bd.querySelector('#mt').value.trim() || false }] });
    if (!to) return;
    try { await aapi('/test-email', { method: 'POST', body: { to } }); toast('E-mail envoyé à ' + to, 'success'); } catch (e) { toast(e.message, 'error'); }
  };
}

async function runFullTest() {
  const out = $('#testOut'), btn = $('#runTest');
  btn.disabled = true; out.innerHTML = '';
  const line = (name) => { const el = document.createElement('div'); el.className = 'test-step'; el.innerHTML = `<span class="spinner"></span><span class="grow">${esc(name)}</span><span class="tiny faint"></span>`; out.appendChild(el); return el; };
  const done = (el, ok, detail, ms) => { el.querySelector('.spinner').outerHTML = `<span class="chk ${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'x', 'sm')}</span>`; el.lastElementChild.textContent = (ms != null ? ms + ' ms' : ''); if (detail) el.insertAdjacentHTML('beforeend', `<div class="tiny ${ok ? 'faint' : ''}" style="flex-basis:100%;padding-left:32px;${ok ? '' : 'color:#fda4af'}">${esc(detail)}</div>`); };
  const step = async (name, fn) => { const el = line(name); const t0 = performance.now(); try { const d = await fn(); done(el, true, d, Math.round(performance.now() - t0)); return true; } catch (e) { done(el, false, e.message, Math.round(performance.now() - t0)); return false; } };
  let ok = true;
  try {
    const srv = await aapi('/selftest', { method: 'POST', body: {} });
    srv.steps.forEach(s => { const el = line(s.name); done(el, s.ok, s.detail, s.ms); if (!s.ok) ok = false; });
    if (!A.ov.system.cloudEnabled) { const el = line('Envoi Cloud depuis le navigateur'); done(el, false, 'Mode Cloud désactivé : configurez R2 d\'abord.'); ok = false; return; }
    const payload = crypto.getRandomValues(new Uint8Array(64 * 1024));
    let tr, url;
    const H = { Authorization: 'Bearer ' + A.token };
    ok = ok && await step('Création d\'un transfert de test', async () => { tr = await api('/api/transfers', { method: 'POST', headers: H, body: { title: '__selftest__', ttl: 3600e3, files: [{ name: 'test-transferx.bin', size: payload.length, type: 'application/octet-stream' }] } }); return tr.id; });
    if (!ok) return;
    const fid = tr.files[0].id;
    ok = await step('Envoi direct vers le stockage (règle CORS)', async () => {
      url = (await api(`/api/transfers/${tr.id}/files/${fid}/urls`, { method: 'POST', key: tr.ownerKey, body: { parts: [1] } })).urls[1];
      let r;
      try { r = await fetch(url, { method: 'PUT', body: new Blob([payload]) }); }
      catch (e) { throw new Error(`Bloqué par le navigateur : la règle CORS du bucket R2 n'autorise pas ${location.origin}. Ajoutez cette adresse dans AllowedOrigins (fichier r2-cors.json).`); }
      if (!r.ok) throw new Error('Réponse du stockage : HTTP ' + r.status);
      return new URL(url).host;
    });
    if (ok) ok = await step('Assemblage et activation du lien', async () => {
      await api(`/api/transfers/${tr.id}/files/${fid}/complete`, { method: 'POST', key: tr.ownerKey, body: {} });
      await api(`/api/transfers/${tr.id}/finalize`, { method: 'POST', key: tr.ownerKey, body: {} });
    });
    if (ok) ok = await step('Téléchargement et vérification', async () => {
      let r;
      try { r = await fetch(`/api/public/t/${tr.id}/f/${fid}?v=admin-selftest`); }
      catch (e) { throw new Error('Téléchargement bloqué : ajoutez GET aux AllowedMethods de la règle CORS R2.'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const back = new Uint8Array(await r.arrayBuffer());
      if (back.length !== payload.length || back.some((v, i) => v !== payload[i])) throw new Error('Le fichier reçu ne correspond pas à l\'original');
      return `${bytes(back.length)} identiques à l'octet près`;
    });
    await step('Nettoyage du transfert de test', async () => { await api(`/api/transfers/${tr.id}`, { method: 'DELETE', key: tr.ownerKey }); return 'Transfert de test supprimé'; });
  } catch (e) { const el = line('Diagnostic'); done(el, false, e.message); ok = false; }
  finally {
    btn.disabled = false;
    out.insertAdjacentHTML('beforeend', `<div class="banner ${ok ? 'info' : 'bad'}" style="margin-top:6px">${icon(ok ? 'check' : 'x')}<span>${ok ? 'Tout fonctionne : envois, liens et téléchargements sont opérationnels.' : 'Un point bloque : corrigez l\'étape en rouge puis relancez le test.'}</span></div>`);
  }
}

/* ---------------- Temps réel ---------------- */
let ovTimer = null;
async function connectLive() {
  let sock;
  try { sock = await getSocket(); } catch (e) { return; }
  const badge = $('#admLive');
  badge.classList.remove('hidden');
  const watch = () => sock.emit('admin-watch', A.token, (r) => { if (r && r.ok) { badge.classList.remove('off'); badge.lastChild.textContent = 'En direct'; } });
  sock.on('connect', watch);
  sock.on('disconnect', () => { badge.classList.add('off'); badge.lastChild.textContent = 'Reconnexion…'; });
  if (sock.connected) watch();
  sock.on('admin-feedback', ({ kind, mood }) => {
    toast(kind === 'idee' ? 'Nouvelle idée proposée 💡' : kind === 'probleme' ? 'Nouveau problème signalé' : `Nouvel avis${mood ? ' (' + '★'.repeat(mood) + ')' : ''}`, kind === 'probleme' ? 'warn' : 'info', { action: 'Voir', onAction: () => { A.tab = 'insights'; ss.set('tx_admin_tab', 'insights'); $$('#admTabs .chip').forEach(x => x.classList.toggle('active', x.dataset.tab === 'insights')); renderTab(); } });
  });
  sock.on('admin-event', ({ id, title, event }) => {
    if (!A.ov) return;
    A.ov.recent.unshift(Object.assign({ id, title }, event));
    A.ov.recent.length = Math.min(A.ov.recent.length, 80);
    if (A.tab === 'activity') { const f = $('#afeed'); if (f) { const em = f.querySelector('.empty'); if (em) em.remove(); f.insertAdjacentHTML('afterbegin', admFeed(event, title, true)); } }
    if (event.type === 'created') toast(`Nouvel envoi : ${title} (${bytes(event.size)})`, 'info');
    if (event.type === 'pin_fail') toast(`PIN erroné sur « ${title} »`, 'warn');
    if (event.type === 'report') toast(`Signalement sur « ${title} »`, 'warn');
    clearTimeout(ovTimer);
    ovTimer = setTimeout(async () => { try { await loadOverview(true); if (A.tab === 'overview') renderTab(); } catch (e) { /* ignore */ } }, 4000);
  });
}

/* ---------------- Démarrage ---------------- */
if (A.token) start(); else renderLogin();
