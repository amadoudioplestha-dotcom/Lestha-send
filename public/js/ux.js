/* Lestha Send — mesure d'usage anonyme + avis et idées des utilisateurs.
   Aucun nom de fichier, aucun contenu, aucune adresse IP : seulement des compteurs.
   « Ne pas me suivre » (Do Not Track / Global Privacy Control) coupe la mesure. */
const LS_AID = 'tx_aid', LS_ASKED = 'tx_fb_asked', LS_DONE = 'tx_fb_done', LS_OK = 'tx_ok_count';

const optedOut = (() => { try { return navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true; } catch (e) { return false; } })();
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

export function aid() {
  let a = lsGet(LS_AID);
  if (!a || !/^[a-z0-9]{16,40}$/.test(a)) {
    const b = new Uint8Array(12); (crypto.getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; }));
    a = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    lsSet(LS_AID, a);
  }
  return a;
}

let queue = [], qTimer = null;
function flush() {
  qTimer = null;
  if (!queue.length) return;
  const body = JSON.stringify(queue.splice(0, 20));
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/ux', new Blob([body], { type: 'text/plain' }))) return;
  } catch (e) { /* ignore */ }
  fetch('/api/ux', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => {});
}
/** e : visit | page | pick | sent | open | got | use | err | p2p */
export function track(e, data = {}) {
  if (optedOut || /^\/(admin|console)/.test(location.pathname)) return;
  queue.push(Object.assign({ e, aid: aid() }, data));
  if (queue.length >= 10) flush();
  else if (!qTimer) qTimer = setTimeout(flush, 1500);
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

/* Visite : une fois par session, avec la provenance (?src=, utm_source, ou site d'origine) */
try {
  if (!sessionStorage.getItem('tx_v')) {
    sessionStorage.setItem('tx_v', '1');
    const q = new URLSearchParams(location.search);
    let src = q.get('utm_source') || q.get('src') || q.get('ref') || '';
    if (!src && document.referrer) { try { const h = new URL(document.referrer).hostname; if (h !== location.hostname) src = h; } catch (e) { /* ignore */ } }
    track('visit', { src });
  }
} catch (e) { /* ignore */ }

/* Problèmes affichés à l'écran (messages d'erreur, sans données personnelles) */
addEventListener('tx:err', (ev) => track('err', { msg: String(ev.detail || '').slice(0, 200) }));

/* Pages par mode (navigation) */
const PAGE_OF = [[/^\/recevoir/, 'receive-code'], [/^\/proximite/, 'nearby'], [/^\/classe/, 'classe'], [/^\/(direct|live\/)/, 'live'], [/^\/demande/, 'request'], [/^\/[dr]\//, 'request'], [/^\/w\//, 'review'], [/^\/t\//, 'receive'], [/^\/dashboard|^\/m\//, 'dashboard'], [/^\/@/, 'profile'], [/^\/(a-propos|securite|faq|conditions|confidentialite)/, 'infos']];
let lastPage = '';
export function trackPage() {
  const p = location.pathname, room = new URLSearchParams(location.search).get('room');
  let name = room ? 'receive-direct' : 'home';
  for (const [re, n] of PAGE_OF) if (re.test(p)) { name = n; break; }
  if (name === lastPage) return;
  lastPage = name;
  track('page', { p: name });
}

/* ======================================================================
   AVIS ET IDÉES
   ====================================================================== */
let core = null;
const getCore = async () => (core = core || await import('./core.js'));

const MOODS = [[1, '😞', 'Décevant'], [2, '🙁', 'Bof'], [3, '😐', 'Correct'], [4, '🙂', 'Bien'], [5, '🤩', 'Excellent']];
const HEARD = [['tiktok', 'TikTok'], ['whatsapp', 'WhatsApp'], ['linkedin', 'LinkedIn'], ['facebook', 'Facebook'], ['instagram', 'Instagram'], ['google', 'Google'], ['ami', 'Un proche'], ['ecole', 'École / travail'], ['autre', 'Autre']];
const USES = [['etudes', 'Études'], ['enseignement', 'Enseignement'], ['travail', 'Travail'], ['creation', 'Création (vidéo, photo…)'], ['perso', 'Personnel'], ['autre', 'Autre']];

/** Fenêtre « Votre avis » : note, message, questionnaire express, idées à voter */
export async function openFeedback({ m = '', kind = 'avis', mood = 0 } = {}) {
  const { modal, esc, api, toast } = await getCore();
  const firstTime = !lsGet(LS_DONE);
  let chosen = mood, ideas = [];
  try { ideas = (await api('/api/ideas?aid=' + aid())).items || []; } catch (e) { ideas = []; }
  const ideaRow = (i) => `<button type="button" class="fb-idea ${i.voted ? 'on' : ''}" data-idea="${esc(i.id)}" aria-pressed="${i.voted}">
      <span class="fb-vote"><b>▲</b><span>${i.votes}</span></span>
      <span class="fb-idea-t"><strong>${esc(i.title)}</strong>${i.status === 'planned' ? ' <span class="pill info" style="font-size:.7rem">Prévu</span>' : i.status === 'done' ? ' <span class="pill ok" style="font-size:.7rem">Disponible</span>' : ''}${i.desc ? `<span class="small muted">${esc(i.desc)}</span>` : ''}</span></button>`;
  const body = `
    <div class="fb">
      <div class="chips fb-kinds" role="tablist">
        <button type="button" class="chip ${kind === 'avis' ? 'active' : ''}" data-kind="avis">Mon avis</button>
        <button type="button" class="chip ${kind === 'idee' ? 'active' : ''}" data-kind="idee">Proposer une idée</button>
        <button type="button" class="chip ${kind === 'probleme' ? 'active' : ''}" data-kind="probleme">Signaler un problème</button>
      </div>
      <p class="small muted fb-q" style="margin:10px 0 6px">Comment trouvez-vous Lestha Send ?</p>
      <div class="fb-moods" role="radiogroup" aria-label="Note">${MOODS.map(([v, e, l]) => `<button type="button" class="fb-mood ${chosen === v ? 'on' : ''}" data-mood="${v}" role="radio" aria-checked="${chosen === v}" title="${l}"><span>${e}</span><small>${l}</small></button>`).join('')}</div>
      <textarea class="input" id="fbText" rows="3" maxlength="1500" placeholder="Ce qui vous plaît, ce qui vous manque, ce qui vous a bloqué…" style="margin-top:10px"></textarea>
      ${firstTime ? `<div class="grid-2" style="gap:8px;margin-top:8px">
        <select class="input" id="fbHeard" aria-label="Comment nous avez-vous connus ?"><option value="">Comment nous avez-vous connus ?</option>${HEARD.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select class="input" id="fbUse" aria-label="Vous l'utilisez surtout pour…"><option value="">Vous l'utilisez surtout pour…</option>${USES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      </div>` : ''}
      <input class="input" id="fbEmail" type="email" maxlength="200" placeholder="E-mail (facultatif, seulement si vous voulez une réponse)" style="margin-top:8px">
      ${ideas.length ? `<div class="fb-ideas"><p class="small" style="font-weight:700;margin:14px 0 6px">Votez pour les prochaines nouveautés</p>${ideas.slice(0, 8).map(ideaRow).join('')}</div>` : ''}
      <p class="small faint" style="margin-top:10px">Anonyme : aucun fichier ni adresse IP n'est associé à votre avis.</p>
    </div>`;
  let closeFn = null, busy = false;
  async function doSend(bd) {
    if (busy) return;
    const root = bd.querySelector('.modal') || bd;
    const payload = { kind, mood: kind === 'avis' ? chosen : 0, text: root.querySelector('#fbText').value.trim(), email: root.querySelector('#fbEmail').value.trim(), heard: root.querySelector('#fbHeard')?.value || '', use: root.querySelector('#fbUse')?.value || '', m, page: location.pathname.split('/')[1] || 'accueil', aid: aid() };
    if (!payload.mood && !payload.text && !payload.heard && !payload.use) { toast('Choisissez une note ou écrivez quelques mots 🙂', 'warn'); return; }
    busy = true;
    try { await api('/api/feedback', { method: 'POST', body: payload }); lsSet(LS_DONE, String(Date.now())); toast('Merci ! Votre avis aide à améliorer Lestha Send 💙', 'success'); closeFn && closeFn(true); }
    catch (e) { toast(e.message, 'error'); }
    busy = false;
  }
  return modal({
    title: 'Votre avis compte', body,
    actions: [{ label: 'Plus tard', cls: 'ghost', value: false }, { label: 'Envoyer', cls: 'primary', icon: 'check', handler: (bd) => { doSend(bd); return false; } }],
    onMount(root, close) {
      root.querySelectorAll('.fb-mood').forEach(b => b.onclick = () => { chosen = +b.dataset.mood; root.querySelectorAll('.fb-mood').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); });
      root.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
        kind = b.dataset.kind; root.querySelectorAll('[data-kind]').forEach(x => x.classList.toggle('active', x === b));
        const t = root.querySelector('#fbText');
        t.placeholder = kind === 'idee' ? 'Votre idée : quelle fonctionnalité vous ferait gagner du temps ?' : kind === 'probleme' ? 'Que s\'est-il passé ? (appareil, mode utilisé, message affiché…)' : 'Ce qui vous plaît, ce qui vous manque, ce qui vous a bloqué…';
        root.querySelector('.fb-moods').style.display = kind === 'avis' ? '' : 'none';
        root.querySelector('.fb-q').style.display = kind === 'avis' ? '' : 'none';
        t.focus();
      });
      root.querySelectorAll('[data-idea]').forEach(b => b.onclick = async () => {
        try {
          const r = await api(`/api/ideas/${b.dataset.idea}/vote`, { method: 'POST', body: { aid: aid() } });
          b.classList.toggle('on', r.voted); b.setAttribute('aria-pressed', r.voted); b.querySelector('.fb-vote span').textContent = r.votes;
        } catch (e) { toast(e.message, 'warn'); }
      });
      closeFn = close;
    }
  });
}

/** Après une réussite : une petite invitation discrète (au plus une fois tous les 20 jours, jamais au tout premier envoi) */
export async function afterSuccess(m) {
  const n = (+lsGet(LS_OK) || 0) + 1; lsSet(LS_OK, String(n));
  const asked = +lsGet(LS_ASKED) || 0, done = +lsGet(LS_DONE) || 0;
  if (n < 2 || Date.now() - Math.max(asked, done) < 20 * 86400e3) return;
  lsSet(LS_ASKED, String(Date.now()));
  const { toast } = await getCore();
  setTimeout(() => toast('Ça s\'est bien passé ? Donnez votre avis en 10 secondes', 'info', { action: 'Mon avis', onAction: () => openFeedback({ m }), duration: 12000 }), 2500);
}
