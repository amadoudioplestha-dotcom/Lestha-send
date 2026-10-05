/* Lestha Send — Smart Drop (dépôt de fichiers) : décrire son besoin → formulaire → lien/QR → dépôts sans compte → accusé, statuts, export */
import { $, $$, esc, icon, bytes, speed, duration, timeLeft, relTime, fmtDate, fileKind, ls, ss, api, getConfig, toast, modal, confirmDialog, renderQR, confetti, keepAwake, notify, getSocket, visitorId, copyText, isMobile, animateCount, ensureVerified, verifiedEmail, captchaToken } from './core.js';
import { navigate } from './router.js';
import { Uploader } from './uploader.js';
import { pick, bindShare, shareGrid } from './send.js';
import { brandHeader, openHandle } from './profile.js';
import { track, afterSuccess } from './ux.js';

const HOUR = 3600e3, DAY = 24 * HOUR, GB = 1024 ** 3, MB = 1024 ** 2;
const owned = {
  all: () => ls.get('tx_requests', []),
  get: (id) => owned.all().find(x => x.id === id),
  upsert(it) { const l = owned.all().filter(x => x.id !== it.id); l.unshift(Object.assign(owned.get(it.id) || {}, it)); ls.set('tx_requests', l.slice(0, 200)); },
  remove(id) { ls.set('tx_requests', owned.all().filter(x => x.id !== id)); }
};
export const ownedRequests = owned;

/* ====================================================================== */
/*  1. Smart Drop : décrire son besoin → formulaire proposé → espace créé   */
/* ====================================================================== */
let CAT = null;
async function catalog() { if (!CAT) CAT = await api('/api/smartdrop/catalog'); return CAT; }
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const TYPE_L = { text: ['Texte court', 'edit'], email: ['E-mail', 'mail'], tel: ['Téléphone', 'phone'], number: ['Nombre', 'chart'], date: ['Date', 'clock'], select: ['Liste', 'clipboard'], multi: ['Choix multiples', 'check'], textarea: ['Texte long', 'message'], file: ['Un fichier', 'file'], files: ['Plusieurs fichiers', 'folder'] };
const COLORS = ['#00b4d8', '#06d6a0', '#8b7bff', '#f472b6', '#fb923c', '#fbbf24', '#ef4444', '#0f172a'];
const SIZE_STEPS = [[0, 'Sans limite'], [10 * MB, '10 Mo'], [50 * MB, '50 Mo'], [500 * MB, '500 Mo'], [2 * GB, '2 Go'], [10 * GB, '10 Go']];
const EXAMPLES = ['Je veux recevoir des candidatures pour un poste de chargé de communication', 'Je veux récupérer les devoirs de mes étudiants de L2', 'Je veux récupérer les photos du Forum 2026', 'Je veux recevoir les fichiers de mon client pour son site web'];

/** « Assistant » : on choisit le modèle dont les mots-clés correspondent le mieux à la description */
function suggest(need, cat) {
  const t = norm(need);
  let best = null, score = 0;
  for (const tp of cat.templates) {
    const s = tp.words.reduce((n, w) => n + (t.includes(norm(w)) ? (w.length > 6 ? 2 : 1) : 0), 0);
    if (s > score) { score = s; best = tp; }
  }
  const tp = best || cat.templates.find(x => x.id === 'simple');
  // Titre : on reprend ce que la personne a écrit (« … pour un poste de chargé de communication »)
  const m = /(?:poste|stage|emploi)\s+(?:de |d'|d’)?(.+?)[.!]?$/i.exec(need) || /(?:photos?|vid[ée]os?)\s+(?:du |de la |de l'|des |de )(.+?)[.!]?$/i.exec(need) || /(?:devoirs?|rapports?|m[ée]moires?|travaux)\s+(?:de |des |d')?(?:mes |nos )?(.+?)[.!]?$/i.exec(need) || /(?:client|projet)\s+(?:pour |de |du )?(.+?)[.!]?$/i.exec(need);
  const hint = m ? m[1].trim().replace(/^(son|sa|ses|le|la|les|un|une)\s+/i, '') : '';
  const title = tp.title.replace(/\[[^\]]+\]/, hint ? hint.charAt(0).toUpperCase() + hint.slice(1) : '').replace(/\s+—\s*$/, '').replace(/\s+—\s+—/, ' —').replace(/ — \[[^\]]+\]/g, '').trim();
  return { tp, title: title.slice(0, 140), matched: !!best };
}

export const createView = {
  async render(root) {
    const cfg = await getConfig();
    let cat; try { cat = await catalog(); } catch (e) { cat = null; }
    const maxTtl = (cat && cat.limits && cat.limits.maxTtl) || cfg.maxTtl || 7 * DAY;
    const dayStr = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const o = { ttl: 7 * DAY, maxBytes: 5 * GB, maxFileBytes: 0, accept: [], sector: 'autre', color: COLORS[0], fields: [], receipt: true, notifyDepositor: true };
    const apply = (tp) => {
      o.sector = tp.sector; o.accept = tp.accept.slice(); o.fields = JSON.parse(JSON.stringify(tp.fields));
      o.maxFileBytes = tp.maxFileMB ? tp.maxFileMB * MB : 0;
      if (o.maxFileBytes > o.maxBytes) o.maxBytes = [GB, 5 * GB, 20 * GB, 100 * GB].find(v => v >= o.maxFileBytes) || 100 * GB;
    };
    if (cat) apply(cat.templates.find(t => t.id === 'simple'));
    root.innerHTML = `
    <section class="narrow stack sd">
      <div class="hero" style="margin-bottom:6px">
        <span class="eyebrow"><span class="pulse-dot"></span>Smart Drop</span>
        <h1 style="font-size:clamp(30px,5.4vw,46px)">Collectez des fichiers, <span class="grad-text">sans friction.</span></h1>
        <p class="lead">Décrivez votre besoin : Lestha Send prépare le formulaire. Vous partagez un lien ou un QR code, chacun dépose sans créer de compte et reçoit un accusé de réception.</p>
      </div>
      ${cfg.cloudEnabled === false ? `<div class="banner bad">${icon('x')}<span>Le stockage Cloud n'est pas configuré sur ce serveur : le dépôt de fichiers est indisponible.</span></div>` : ''}
      <div class="card glow stack sd-ai">
        <label class="field"><span>${icon('sparkles', 'sm')}Décrivez votre besoin</span><textarea class="input" id="sdNeed" rows="2" maxlength="300" placeholder="Ex. Je veux recevoir des candidatures pour un poste de chargé de communication"></textarea></label>
        <div class="row wrap" style="gap:8px"><button type="button" class="btn primary" id="sdGo">${icon('sparkles', 'sm')}Préparer mon formulaire</button><span class="small muted" id="sdSay" aria-live="polite"></span></div>
        <div class="sd-examples">${EXAMPLES.map(x => `<button type="button" class="chip" data-ex="${esc(x)}">${esc(x.replace(/^Je veux /, '').replace(/^./, c => c.toUpperCase()))}</button>`).join('')}</div>
        ${cat ? `<div class="sd-sectors-t small muted">ou choisissez un secteur</div><div class="sd-sectors" id="sdSectors">${cat.sectors.map(s => `<button type="button" class="sd-sector ${s.id === o.sector ? 'active' : ''}" data-sector="${s.id}">${icon(s.icon, 'sm')}<span>${esc(s.label)}</span></button>`).join('')}</div>` : ''}
      </div>
      <div class="card handle-cta row wrap between">
        <div class="row grow" style="min-width:220px"><div class="ficon" style="--c:#8b7bff;width:46px;height:46px;border-radius:14px">${icon('link')}</div><div class="fmeta"><b>Votre lien personnel permanent</b><div class="small muted">${esc(location.host)}/@votre-nom : une boîte de dépôt toujours ouverte, à mettre dans votre signature ou votre bio.</div></div></div>
        <button type="button" class="btn" id="btnHandle">${icon('link', 'sm')}Mon lien @</button>
      </div>
      <form class="card stack sd-form" id="rf" style="--accent:${o.color}">
        <div class="card-title"><h3>${icon('edit')}Votre espace de dépôt</h3><button type="button" class="btn sm ghost" id="sdPreview">${icon('eye', 'sm')}Aperçu</button></div>
        <label class="field"><span>Nom de l'espace</span><input class="input" id="rTitle" maxlength="140" required placeholder="Ex. Candidature — Chargé de communication"></label>
        <label class="field"><span>Consignes (facultatif)</span><textarea class="input" id="rMsg" maxlength="1500" placeholder="Format attendu, nommage des fichiers, pièces obligatoires…"></textarea></label>
        <div class="field"><span>${icon('clipboard', 'sm')}Formulaire du déposant</span><div class="sd-fields" id="sdFields"></div>
          <div class="sd-add">${Object.entries(TYPE_L).map(([k, [l, ic]]) => `<button type="button" class="chip" data-add="${k}">${icon(ic, 'sm')}${l}</button>`).join('')}</div></div>
        <div class="field"><span>${icon('file', 'sm')}Types de fichiers acceptés</span><div class="chips" id="sdAccept"></div></div>
        <div class="grid-2" style="gap:12px">
          <div class="field"><span>${icon('cloud', 'sm')}Taille max par fichier</span><div class="chips" id="sdFileMax"></div></div>
          <div class="field"><span>${icon('cloud', 'sm')}Taille max par dépôt</span><div class="chips" id="rMax">${[[100 * MB, '100 Mo'], [GB, '1 Go'], [5 * GB, '5 Go'], [20 * GB, '20 Go'], [100 * GB, '100 Go']].map(([v, l]) => `<button type="button" class="chip" data-v="${v}">${l}</button>`).join('')}</div></div>
        </div>
        <div class="grid-2" style="gap:12px">
          <div class="field"><span>${icon('clock', 'sm')}Date limite</span><div class="chips" id="rTtl">${[[DAY, '1 jour'], [3 * DAY, '3 jours'], [7 * DAY, '7 jours'], [14 * DAY, '14 jours'], [30 * DAY, '30 jours']].filter(([v]) => v <= maxTtl).map(([v, l]) => `<button type="button" class="chip ${v === o.ttl ? 'active' : ''}" data-v="${v}">${l}</button>`).join('')}<label class="chip sd-date" title="Choisir une date précise">${icon('clock', 'sm')}<input type="date" id="sdDeadline" min="${dayStr(Date.now() + DAY)}" max="${dayStr(Date.now() + maxTtl)}" aria-label="Date limite précise"></label></div>
            <small class="faint" id="sdTtlHint">Jusqu'à ${Math.round(maxTtl / DAY)} jours. Les fichiers reçus restent disponibles 30 jours après chaque dépôt, puis sont supprimés automatiquement.</small></div>
          <label class="field"><span>${icon('users', 'sm')}Nombre maximal de dépôts</span><input class="input" id="sdMaxDep" inputmode="numeric" maxlength="4" placeholder="Illimité (2000 au plus)"></label>
        </div>
        <details class="sd-more"><summary>${icon('settings', 'sm')}Personnalisation, accès et notifications</summary>
          <div class="stack" style="margin-top:12px">
            <label class="field"><span>Votre nom ou organisation</span><input class="input" id="rName" maxlength="80" value="${esc(ls.get('tx_sender_name', ''))}" placeholder="Affiché aux déposants"></label>
            <div class="field"><span>Couleur de l'espace</span><div class="sd-colors" id="sdColors">${COLORS.map(c => `<button type="button" class="sd-color ${c === o.color ? 'active' : ''}" data-c="${c}" style="--c:${c}" aria-label="Couleur ${c}"></button>`).join('')}</div></div>
            <label class="field"><span>Coordonnées affichées (facultatif)</span><input class="input" id="sdContact" maxlength="160" placeholder="Ex. rh@entreprise.sn · +221 77 000 00 00"></label>
            <label class="field"><span>${icon('lock', 'sm')}Code pour déposer (espace privé)</span><input class="input" id="rPin" inputmode="numeric" maxlength="8" placeholder="6 à 8 chiffres · vide = espace public"></label>
            <label class="switch"><input type="checkbox" id="sdReceipt" checked><span class="track"></span><span class="small">Envoyer un accusé de réception par e-mail au déposant</span></label>
            <label class="switch"><input type="checkbox" id="sdNotifyDep" checked><span class="track"></span><span class="small">Prévenir le déposant quand je change le statut (validé, à compléter…)</span></label>
            ${cfg.email ? `<label class="switch"><input type="checkbox" id="rNotify"><span class="track"></span><span class="small">M'avertir par e-mail à chaque dépôt</span></label>
            <label class="field hidden" id="rMailF"><span>Votre e-mail (confirmé par un code)</span><input class="input" id="rMail" type="email" value="${esc(verifiedEmail() || ls.get('tx_sender_email', ''))}" ${verifiedEmail() ? 'readonly' : ''}></label>` : ''}
          </div>
        </details>
        <button class="btn primary xl block" type="submit" ${cfg.cloudEnabled === false ? 'disabled' : ''}>${icon('inbox')}Créer l'espace de dépôt</button>
      </form>
    </section>`;
    const bh = $('#btnHandle', root); if (bh) bh.onclick = () => openHandle();
    const chipsSel = (sel, key) => $(sel, root).addEventListener('click', (e) => { const c = e.target.closest('[data-v]'); if (!c) return; o[key] = Number(c.dataset.v); $$(sel + ' .chip', root).forEach(x => x.classList.toggle('active', x === c)); });
    chipsSel('#rTtl', 'ttl'); chipsSel('#rMax', 'maxBytes');
    const dl = $('#sdDeadline', root);
    $('#rTtl', root).addEventListener('click', (e) => { if (e.target.closest('[data-v]')) { o.deadline = 0; dl.value = ''; dl.parentElement.classList.remove('active'); } });
    dl.onchange = () => {
      if (!dl.value) { o.deadline = 0; return; }
      o.deadline = new Date(dl.value + 'T23:59:00').getTime();
      $$('#rTtl .chip[data-v]', root).forEach(x => x.classList.remove('active')); dl.parentElement.classList.add('active');
      $('#sdTtlHint', root).textContent = 'Dépôts acceptés jusqu\'au ' + new Date(o.deadline).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + ' à 23 h 59. Fichiers conservés 30 jours après chaque dépôt.';
    };
    const drawRules = () => {
      $('#rMax', root).querySelectorAll('.chip').forEach(c => c.classList.toggle('active', +c.dataset.v === o.maxBytes));
      if (!cat) return;
      $('#sdAccept', root).innerHTML = `<button type="button" class="chip ${o.accept.length ? '' : 'active'}" data-acc="*">Tous</button>` + Object.entries(cat.accept).map(([k, v]) => `<button type="button" class="chip ${o.accept.includes(k) ? 'active' : ''}" data-acc="${k}">${esc(v.label)}</button>`).join('');
      $('#sdFileMax', root).innerHTML = SIZE_STEPS.map(([v, l]) => `<button type="button" class="chip ${v === o.maxFileBytes ? 'active' : ''}" data-fm="${v}">${l}</button>`).join('');
    };
    $('#sdAccept', root).onclick = (e) => { const c = e.target.closest('[data-acc]'); if (!c) return; const k = c.dataset.acc; if (k === '*') o.accept = []; else o.accept = o.accept.includes(k) ? o.accept.filter(x => x !== k) : o.accept.concat(k); drawRules(); };
    $('#sdFileMax', root).onclick = (e) => { const c = e.target.closest('[data-fm]'); if (!c) return; o.maxFileBytes = +c.dataset.fm; if (o.maxFileBytes > o.maxBytes) o.maxBytes = [GB, 5 * GB, 20 * GB, 100 * GB].find(v => v >= o.maxFileBytes) || 100 * GB; drawRules(); };
    /* Éditeur de champs */
    const drawFields = () => {
      const box = $('#sdFields', root);
      box.innerHTML = o.fields.map((f, i) => `<div class="sd-frow" data-i="${i}">
        <span class="sd-fic" title="${esc(TYPE_L[f.type][0])}">${icon(TYPE_L[f.type][1], 'sm')}</span>
        <input class="input sd-flabel" data-k="label" value="${esc(f.label)}" maxlength="80" aria-label="Libellé du champ">
        <select class="input sd-ftype" data-k="type" aria-label="Type">${Object.entries(TYPE_L).map(([k, [l]]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="sd-req" title="Obligatoire"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''}><span>Obligatoire</span></label>
        <span class="sd-fact"><button type="button" class="btn sm icon ghost" data-mv="-1" aria-label="Monter" ${i ? '' : 'disabled'}>↑</button><button type="button" class="btn sm icon ghost" data-mv="1" aria-label="Descendre" ${i < o.fields.length - 1 ? '' : 'disabled'}>↓</button><button type="button" class="btn sm icon ghost" data-del aria-label="Supprimer">${icon('x', 'sm')}</button></span>
        ${f.type === 'select' || f.type === 'multi' ? `<input class="input sd-fopts" data-k="options" value="${esc((f.options || []).join(', '))}" placeholder="Choix séparés par des virgules">` : ''}
      </div>`).join('') || '<p class="small faint">Ajoutez au moins un champ « fichier ».</p>';
    };
    $('#sdFields', root).addEventListener('input', (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return; const f = o.fields[+row.dataset.i], k = e.target.dataset.k;
      if (k === 'label') f.label = e.target.value; else if (k === 'options') f.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean); else if (k === 'required') f.required = e.target.checked;
    });
    $('#sdFields', root).addEventListener('change', (e) => {
      const row = e.target.closest('[data-i]'); if (!row || e.target.dataset.k !== 'type') return;
      const f = o.fields[+row.dataset.i]; f.type = e.target.value; if ((f.type === 'select' || f.type === 'multi') && !f.options) f.options = ['Option 1', 'Option 2']; drawFields();
    });
    $('#sdFields', root).addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return; const i = +row.dataset.i;
      const mv = e.target.closest('[data-mv]'); if (mv) { const j = i + +mv.dataset.mv; [o.fields[i], o.fields[j]] = [o.fields[j], o.fields[i]]; drawFields(); }
      if (e.target.closest('[data-del]')) { o.fields.splice(i, 1); drawFields(); }
    });
    $('.sd-add', root).onclick = (e) => {
      const b = e.target.closest('[data-add]'); if (!b) return; const t = b.dataset.add;
      o.fields.push({ id: t + Date.now().toString(36).slice(-4), type: t, label: TYPE_L[t][0], required: false, options: t === 'select' || t === 'multi' ? ['Option 1', 'Option 2'] : undefined });
      drawFields(); const rows = $$('.sd-frow', root); const last = rows[rows.length - 1]; if (last) { last.querySelector('.sd-flabel').select(); last.classList.add('new'); }
    };
    /* Assistant et secteurs */
    const say = (t) => { $('#sdSay', root).textContent = t; };
    const useTemplate = (tp, title) => {
      apply(tp); drawFields(); drawRules();
      $$('.sd-sector', root).forEach(x => x.classList.toggle('active', x.dataset.sector === o.sector));
      if (title) $('#rTitle', root).value = title;
      if (tp.message && !$('#rMsg', root).value.trim()) $('#rMsg', root).value = tp.message;
      const form = $('#rf', root); form.classList.remove('flash'); void form.offsetWidth; form.classList.add('flash');
    };
    $('#sdGo', root).onclick = () => {
      const need = $('#sdNeed', root).value.trim(); if (!cat) return;
      if (!need) { $('#sdNeed', root).focus(); return toast('Décrivez en une phrase ce que vous voulez recevoir', 'info'); }
      const s = suggest(need, cat), sec = cat.sectors.find(x => x.id === s.tp.sector);
      useTemplate(s.tp, s.title);
      say(s.matched ? `Formulaire « ${sec.label} » prêt : ${s.tp.fields.length} champs. Modifiez-le librement.` : 'Formulaire simple prêt : ajoutez les champs dont vous avez besoin.');
      track('use', { m: 'request' });
      setTimeout(() => $('#rf', root).scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    };
    $('#sdNeed', root).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#sdGo', root).click(); } });
    $('.sd-examples', root).onclick = (e) => { const c = e.target.closest('[data-ex]'); if (!c) return; $('#sdNeed', root).value = c.dataset.ex; $('#sdGo', root).click(); };
    const sc = $('#sdSectors', root); if (sc) sc.onclick = (e) => {
      const b = e.target.closest('[data-sector]'); if (!b) return;
      const tp = cat.templates.find(t => t.sector === b.dataset.sector) || cat.templates.find(t => t.id === 'simple');
      useTemplate(Object.assign({}, tp, { sector: b.dataset.sector }), tp.sector === b.dataset.sector ? tp.title.replace(/ — \[[^\]]+\]/g, '') : '');
      say(`Modèle « ${cat.sectors.find(x => x.id === b.dataset.sector).label} » appliqué.`);
    };
    $('#sdColors', root).onclick = (e) => { const c = e.target.closest('[data-c]'); if (!c) return; o.color = c.dataset.c; $$('.sd-color', root).forEach(x => x.classList.toggle('active', x === c)); $('#rf', root).style.setProperty('--accent', o.color); };
    $('#sdPreview', root).onclick = () => modal({ title: 'Aperçu pour le déposant', wide: true, body: `<div class="sd-preview" style="--accent:${o.color}"><h3>${esc($('#rTitle', root).value || 'Déposez vos fichiers')}</h3>${$('#rMsg', root).value.trim() ? `<div class="message-bubble">${esc($('#rMsg', root).value.trim())}</div>` : ''}${fieldsHtml(o.fields, { acceptLabel: acceptText(o.accept), maxFileBytes: o.maxFileBytes }, {}, {}, true)}</div>`, actions: [{ label: 'Fermer', cls: 'primary' }] });
    drawFields(); drawRules();
    const pin = $('#rPin', root); pin.oninput = () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 8); };
    const md = $('#sdMaxDep', root); md.oninput = () => { md.value = md.value.replace(/\D/g, '').slice(0, 4); if (+md.value > 2000) md.value = '2000'; };
    const nt = $('#rNotify', root); if (nt) nt.onchange = () => $('#rMailF', root).classList.toggle('hidden', !nt.checked);
    function acceptText(acc) { return acc.length && cat ? acc.map(k => cat.accept[k].label).join(', ') : 'Tous les types'; }
    $('#rf', root).onsubmit = async (e) => {
      e.preventDefault();
      if (!o.fields.some(f => f.type === 'file' || f.type === 'files')) return toast('Ajoutez au moins un champ « Un fichier » ou « Plusieurs fichiers »', 'warn');
      if (o.fields.some(f => !String(f.label || '').trim())) return toast('Chaque champ doit avoir un libellé', 'warn');
      const body = { title: $('#rTitle', root).value.trim(), message: $('#rMsg', root).value.trim(), ownerName: $('#rName', root).value.trim(), ttl: o.ttl, maxBytes: o.maxBytes, pin: pin.value || null,
        deadline: o.deadline || 0, sector: o.sector, fields: o.fields, accept: o.accept, maxFileBytes: o.maxFileBytes, maxDeposits: +md.value || 0, color: o.color, contact: $('#sdContact', root).value.trim(),
        receipt: $('#sdReceipt', root).checked, notifyDepositor: $('#sdNotifyDep', root).checked };
      if (body.pin && !/^\d{6,8}$/.test(body.pin)) return toast('Le code contient 6 à 8 chiffres', 'warn');
      if (cfg.tier !== 'full' && !verifiedEmail()) {
        const ok = await ensureVerified('Les espaces de dépôt sont réservés aux adresses e-mail confirmées. C\'est gratuit et prend une minute.');
        if (!ok) return;
      }
      if (nt && nt.checked) { body.notify = true; body.ownerEmail = verifiedEmail() || $('#rMail', root).value.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.ownerEmail)) return toast('E-mail invalide', 'warn'); ls.set('tx_sender_email', body.ownerEmail); }
      ls.set('tx_sender_name', body.ownerName);
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Création…';
      const reset = () => { btn.disabled = false; btn.innerHTML = icon('inbox') + 'Créer l\'espace de dépôt'; };
      let r;
      for (let attempt = 0; ; attempt++) {
        if (cfg.uploadCodeRequired && !ls.get('tx_upload_code', '')) {
          const code = await modal({ title: 'Code d\'accès', body: '<p class="small muted" style="margin-bottom:10px">Saisissez le code d\'accès de cette instance Lestha Send.</p><input class="input" id="upCode" type="password">', actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Valider', cls: 'primary', handler: (bd) => bd.querySelector('#upCode').value.trim() || false }] });
          if (!code) return reset();
          ls.set('tx_upload_code', code);
        }
        const headers = { 'X-Upload-Code': ls.get('tx_upload_code', '') };
        if (cfg.tier !== 'full') { const cap = await captchaToken(); if (cap) headers['X-Turnstile'] = cap; }
        try { r = await api('/api/requests', { method: 'POST', body, headers }); break; }
        catch (err) {
          if (err.status === 401 && err.data && err.data.needCode) { ls.del('tx_upload_code'); cfg.uploadCodeRequired = true; toast('Code d\'accès incorrect', 'warn'); continue; }
          if (attempt < 2 && err.data && err.data.needVerify && await ensureVerified()) continue;
          if (attempt < 2 && err.data && err.data.needCaptcha) continue;
          toast(err.message, 'error'); return reset();
        }
      }
      owned.upsert({ id: r.id, key: r.ownerKey, title: body.title || 'Déposez vos fichiers', createdAt: Date.now(), expiresAt: r.expiresAt });
      success(root, r, body);
    };
  }
};

function success(root, r, body) {
  root.innerHTML = `
  <section class="narrow stack"><div class="card glow stack" style="--accent:${esc(body.color || '#00b4d8')}">
    <div class="center"><div class="success-burst">${icon('check')}</div><h2>Votre espace de dépôt est prêt</h2><p class="muted" style="margin-top:6px">${esc(body.title || 'Déposez vos fichiers')} · ouvert ${timeLeft(r.expiresAt - Date.now())}</p></div>
    <div class="link-box"><input id="shareLink" readonly value="${esc(r.link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
    ${shareGrid()}
    <div class="qr-card"><div class="qr" id="qrBox"></div><div class="stack" style="gap:6px"><h3>Scannez pour déposer</h3><p class="small muted">À afficher à l'accueil, sur une affiche ou à projeter : chacun dépose depuis son téléphone, sans compte.</p><button type="button" class="btn sm" id="qrBig">${icon('fullscreen', 'sm')}Afficher en grand</button></div></div>
    <div class="row wrap"><a class="btn grow" href="/r/${esc(r.id)}" data-link>${icon('inbox')}Voir les dépôts</a><a class="btn ghost grow" href="/demande" data-link id="again">${icon('plus')}Nouvel espace</a></div>
  </div></section>`;
  bindShare(root, r.link, body.title || 'Déposez vos fichiers', null);
  root.querySelectorAll('[data-share]').forEach(b => { const old = b.onclick; b.onclick = () => { if (b.dataset.share !== 'mail') return old(); location.href = `mailto:?subject=${encodeURIComponent(body.title || 'Déposez vos fichiers')}&body=${encodeURIComponent('Déposez vos fichiers ici : ' + r.link)}`; }; });
  renderQR($('#qrBox', root), r.link);
  $('#qrBig', root).onclick = () => bigQr(body.title, r.link);
  $('#again', root).onclick = (e) => { e.preventDefault(); createView.render(root); };
  confetti(40);
}
function bigQr(title, link) {
  modal({ title: title || 'Déposez vos fichiers', wide: true, body: `<div class="qr" id="qrM" style="width:min(70vw,420px);height:min(70vw,420px);margin:6px auto"></div><p class="center" style="font-size:18px;font-weight:700;margin-top:8px">${esc(link.replace(/^https?:\/\//, ''))}</p><p class="center small muted">Scannez avec l'appareil photo du téléphone · aucun compte nécessaire</p>`, actions: [{ label: 'Fermer', cls: 'primary' }], onMount: (m) => renderQR(m.querySelector('#qrM'), link) });
}

/** Rendu du formulaire du déposant (aussi utilisé pour l'aperçu) */
function fieldsHtml(fields, info, answers, files, preview) {
  const lim = [info.acceptLabel && info.acceptLabel !== 'Tous les types' ? info.acceptLabel : '', info.maxFileBytes ? 'max ' + bytes(info.maxFileBytes, 0) + ' par fichier' : ''].filter(Boolean).join(' · ');
  return `<div class="sd-dform">${fields.map(f => {
    const star = f.required ? ' <i class="sd-star">*</i>' : '', v = answers[f.id];
    if (f.type === 'file' || f.type === 'files') {
      const list = files[f.id] || [];
      return `<div class="sd-ff ${list.length ? 'has' : ''}" data-ff="${esc(f.id)}"><div class="sd-ff-head"><b>${esc(f.label)}${star}</b><small>${f.type === 'file' ? 'Un fichier' : 'Un ou plusieurs fichiers'}${lim ? ' · ' + esc(lim) : ''}</small></div>
        ${list.map((it, i) => { const k = fileKind(it.file.name, it.file.type); return `<div class="file-row"><div class="ficon" style="--c:${k.c}">${icon(k.icon)}</div><div class="fmeta"><div class="fname">${esc(it.file.name)}</div><div class="fsub">${bytes(it.file.size)}</div></div><button type="button" class="btn sm icon ghost" data-rmf="${esc(f.id)}:${i}" aria-label="Retirer">${icon('x', 'sm')}</button></div>`; }).join('')}
        ${f.type === 'file' && list.length ? '' : `<button type="button" class="sd-pick" data-pickf="${esc(f.id)}" ${preview ? 'disabled' : ''}>${icon(list.length ? 'plus' : 'upload', 'sm')}<span>${list.length ? 'Ajouter' : isMobile ? 'Choisir un fichier' : 'Choisir ou glisser ici'}</span></button>`}</div>`;
    }
    const attr = `data-a="${esc(f.id)}" ${preview ? 'disabled' : ''}`;
    if (f.type === 'textarea') return `<label class="field"><span>${esc(f.label)}${star}</span><textarea class="input" ${attr} maxlength="2000">${esc(v || '')}</textarea></label>`;
    if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}${star}</span><select class="input" ${attr}><option value="">Choisir…</option>${f.options.map(op => `<option ${v === op ? 'selected' : ''}>${esc(op)}</option>`).join('')}</select></label>`;
    if (f.type === 'multi') return `<div class="field"><span>${esc(f.label)}${star}</span><div class="chips" data-multi="${esc(f.id)}">${f.options.map(op => `<button type="button" class="chip ${(v || []).includes(op) ? 'active' : ''}" data-op="${esc(op)}" ${preview ? 'disabled' : ''}>${esc(op)}</button>`).join('')}</div></div>`;
    const type = { email: 'email', tel: 'tel', number: 'text', date: 'date' }[f.type] || 'text';
    const im = f.type === 'number' ? 'inputmode="decimal"' : f.type === 'tel' ? 'inputmode="tel" autocomplete="tel"' : f.type === 'email' ? 'autocomplete="email"' : '';
    return `<label class="field"><span>${esc(f.label)}${star}</span><input class="input" type="${type}" ${im} ${attr} maxlength="200" value="${esc(v || '')}"></label>`;
  }).join('')}</div>`;
}

/* ====================================================================== */
/*  2. Déposer (page publique) : SCAN → FORMULAIRE → FICHIERS → ENVOI → ACCUSÉ */
/* ====================================================================== */
export const depositView = (() => {
  let root, id, info, answers = {}, files = {}, up = null;
  const token = () => ss.get('tx_dtk_' + id);
  return {
    async render(r, { match }) {
      root = r; id = match[1]; answers = ls.get('tx_dep_answers_' + match[1], {}) || {}; files = {};
      root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:380px;border-radius:20px"></div></section>`;
      await load();
    },
    destroy() { if (up && up.state === 'running') toast('Dépôt en cours : gardez la page ouverte', 'warn'); root = null; }
  };
  async function load() {
    try { info = await api(`/api/public/d/${id}?v=${encodeURIComponent(visitorId())}`, { token: token() }); }
    catch (e) { return screen('bad', 'x', 'Lien introuvable', 'Ce lien de dépôt n\'existe pas ou a expiré.'); }
    if (info.state === 'expired') return screen('warn', 'clock', 'Dépôts terminés', 'La date limite est passée. Contactez la personne qui vous a envoyé ce lien.');
    if (info.state === 'closed') return screen('warn', 'lock', 'Dépôts fermés', 'Les dépôts sont temporairement fermés par l\'organisateur.');
    if (info.state === 'full') return screen('warn', 'users', 'Dépôts complets', 'Cet espace a reçu le nombre maximal de dépôts prévu.');
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
  function allFiles() { return Object.entries(files).flatMap(([fid, list]) => list.map(it => Object.assign({ field: fid }, it))); }
  function total() { return allFiles().reduce((s, it) => s + it.file.size, 0); }
  function form() {
    const t = total(), n = allFiles().length;
    root.innerHTML = `
    <section class="narrow stack">
      <div class="card glow stack sd-deposit" style="--accent:${esc(info.color || '#00b4d8')}">
        ${info.brand ? brandHeader(info.brand, { label: info.permanent ? 'Boîte de dépôt de' : 'Demande de', sub: icon('check', 'sm') + ' Adresse vérifiée' }) : ''}
        <div class="sender-head"><div class="avatar sd-av">${icon('inbox')}</div><div style="min-width:0"><div class="small muted">${info.ownerName ? esc(info.ownerName) + (info.permanent ? ' reçoit vos fichiers ici' : ' vous demande des fichiers') : 'Dépôt de fichiers'}${info.permanent ? (info.handle ? ' · @' + esc(info.handle) : '') : ' · jusqu\'au ' + new Date(info.expiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ' (' + timeLeft(info.expiresAt - Date.now()) + ')'}</div><h2 style="font-size:clamp(20px,4vw,28px)">${esc(info.title)}</h2></div></div>
        ${info.message ? `<div class="message-bubble">${esc(info.message)}</div>` : ''}
        ${info.contact ? `<div class="small muted">${icon('message', 'sm')} ${esc(info.contact)}</div>` : ''}
        ${fieldsHtml(info.fields, info, answers, files, false)}
        <div class="file-summary"><span>${n} fichier(s) · max ${bytes(info.maxBytes, 0)} par dépôt</span><b style="${t > info.maxBytes ? 'color:var(--rose)' : ''}">${bytes(t)}</b></div>
        <button type="button" class="btn primary xl block sd-go" id="dGo">${icon('upload')}Envoyer mon dépôt${n ? ' · ' + bytes(t) : ''}</button>
        <p class="small faint center">${icon('lock', 'sm')} Aucun compte nécessaire. ${info.receipt ? 'Un numéro d\'accusé de réception vous sera remis.' : ''}<br>Vos réponses et fichiers sont transmis uniquement à ${esc(info.ownerName || 'l\'organisateur')} et supprimés automatiquement au plus tard 30 jours après votre dépôt.</p>
      </div>
    </section>`;
    root.querySelectorAll('[data-a]').forEach(el => el.addEventListener('input', () => { answers[el.dataset.a] = el.value; save(); }));
    root.querySelectorAll('[data-multi]').forEach(box => box.onclick = (e) => { const c = e.target.closest('[data-op]'); if (!c) return; const k = box.dataset.multi, cur = answers[k] || []; answers[k] = cur.includes(c.dataset.op) ? cur.filter(x => x !== c.dataset.op) : cur.concat(c.dataset.op); c.classList.toggle('active'); save(); });
    root.querySelectorAll('[data-pickf]').forEach(b => b.onclick = () => pickFor(b.dataset.pickf));
    root.querySelectorAll('[data-rmf]').forEach(b => b.onclick = () => { const [fid, i] = b.dataset.rmf.split(':'); files[fid].splice(+i, 1); form(); });
    root.querySelectorAll('[data-ff]').forEach(box => {
      box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
      box.addEventListener('dragleave', () => box.classList.remove('drag'));
      box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); addTo(box.dataset.ff, [...e.dataTransfer.files]); });
    });
    $('#dGo', root).onclick = start;
  }
  function save() { try { const keep = {}; info.fields.forEach(f => { if (f.type !== 'file' && f.type !== 'files' && answers[f.id]) keep[f.id] = answers[f.id]; }); ls.set('tx_dep_answers_' + id, keep); } catch (e) { /* ignore */ } }
  function pickFor(fid) {
    const f = info.fields.find(x => x.id === fid); if (!f) return;
    const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = f.type === 'files';
    if (info.acceptExt && info.acceptExt.length) inp.accept = info.acceptExt.map(e => '.' + e).join(',');
    inp.onchange = () => addTo(fid, [...(inp.files || [])]);
    inp.click();
  }
  function addTo(fid, list) {
    const f = info.fields.find(x => x.id === fid); if (!f || !list.length) return;
    const ok = [];
    for (const file of list) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (info.acceptExt && info.acceptExt.length && !info.acceptExt.includes(ext)) { toast(`« ${file.name} » n'est pas accepté ici (${info.acceptLabel}).`, 'warn', { duration: 6000 }); continue; }
      if (info.maxFileBytes && file.size > info.maxFileBytes) { toast(`« ${file.name} » dépasse ${bytes(info.maxFileBytes, 0)}.`, 'warn', { duration: 6000 }); continue; }
      if (!file.size) { toast(`« ${file.name} » est vide.`, 'warn'); continue; }
      ok.push({ file });
    }
    if (!ok.length) return;
    files[fid] = f.type === 'file' ? ok.slice(0, 1) : (files[fid] || []).concat(ok);
    form();
  }
  function problem() {
    for (const f of info.fields) {
      const v = answers[f.id];
      if (f.type === 'file' || f.type === 'files') { if (f.required && !(files[f.id] || []).length) return [f, `Ajoutez un fichier pour « ${f.label} ».`]; continue; }
      const empty = Array.isArray(v) ? !v.length : !String(v || '').trim();
      if (f.required && empty) return [f, `« ${f.label} » est obligatoire.`];
      if (!empty && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return [f, `« ${f.label} » : adresse e-mail invalide.`];
      if (!empty && f.type === 'tel' && !/^[+0-9 ().-]{6,24}$/.test(v)) return [f, `« ${f.label} » : numéro de téléphone invalide.`];
    }
    if (!allFiles().length) return [null, 'Ajoutez au moins un fichier.'];
    if (total() > info.maxBytes) return [null, `Le dépôt dépasse ${bytes(info.maxBytes, 0)}.`];
    return null;
  }
  async function start() {
    const p = problem();
    if (p) {
      toast(p[1], 'warn');
      const el = p[0] && (root.querySelector(`[data-a="${p[0].id}"]`) || root.querySelector(`[data-ff="${p[0].id}"]`) || root.querySelector(`[data-multi="${p[0].id}"]`));
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('sd-bad'); setTimeout(() => el.classList.remove('sd-bad'), 1600); if (el.focus) el.focus({ preventScroll: true }); }
      return;
    }
    const list = allFiles();
    const btn = $('#dGo', root); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Préparation…';
    let r;
    try {
      const capTok = await captchaToken();
      r = await api(`/api/public/d/${id}/deposit`, { method: 'POST', token: token(), headers: capTok ? { 'X-Turnstile': capTok } : {}, body: { answers, files: list.map(it => ({ name: it.file.name, size: it.file.size, type: it.file.type, lastModified: it.file.lastModified, field: it.field })) } });
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.innerHTML = icon('upload') + 'Envoyer mon dépôt'; return; }
    const sum = total();
    up = new Uploader({ id: r.transferId, key: r.uploadKey, items: list.map((it, i) => ({ file: it.file, meta: r.files[i] })) });
    const C = 2 * Math.PI * 104;
    root.innerHTML = `<section class="narrow"><div class="card glow sd-deposit" style="--accent:${esc(info.color || '#00b4d8')}"><div class="progress-hero">
      <span class="eyebrow"><span class="pulse-dot"></span><span id="st">Dépôt en cours</span></span><h2>${esc(info.title)}</h2>
      <div class="ring" id="ring"><svg viewBox="0 0 240 240"><circle class="glow" cx="120" cy="120" r="104"/><circle class="track" cx="120" cy="120" r="104"/><circle class="bar" id="bar" cx="120" cy="120" r="104" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
      <div class="ring-center"><div class="ring-pct"><span id="pc">0</span><small>%</small></div><div class="ring-sub" id="by">0 o / ${bytes(sum)}</div></div></div>
      <div class="metrics"><div class="metric"><b id="sp">—</b><span>Vitesse</span></div><div class="metric"><b id="eta">—</b><span>Restant</span></div><div class="metric"><b>${list.length}</b><span>Fichiers</span></div></div>
      <div class="row wrap" style="justify-content:center;gap:8px"><button type="button" class="btn sm" id="upPause">${icon('pause', 'sm')}Pause</button><button type="button" class="btn sm ghost" id="upCancel">${icon('x', 'sm')}Annuler</button></div>
      <div id="ban"></div>
      <p class="small faint">Gardez cette page ouverte jusqu'à la fin. En cas de coupure, l'envoi reprend tout seul.</p>
    </div></div></section>`;
    keepAwake(true);
    const pb = $('#upPause', root);
    pb.onclick = () => { if (up.state === 'paused') { up.resumeUpload(); pb.innerHTML = icon('pause', 'sm') + 'Pause'; } else { up.pause(); pb.innerHTML = icon('play', 'sm') + 'Reprendre'; } };
    $('#upCancel', root).onclick = async () => { if (!(await confirmDialog('Annuler le dépôt ?', 'Les fichiers déjà envoyés seront supprimés.', 'Annuler le dépôt', true))) return; const u = up; up = null; keepAwake(false); try { await u.cancel(); } catch (e) { /* ignore */ } toast('Dépôt annulé', 'info'); form(); };
    up.addEventListener('progress', (e) => {
      const d = e.detail; if (!root) return; const bar = $('#bar', root); if (!bar) return;
      const pr = d.total ? d.loaded / d.total : 1;
      bar.style.strokeDashoffset = String(C * (1 - pr));
      $('#pc', root).textContent = Math.floor(pr * 100); $('#by', root).textContent = bytes(d.loaded) + ' / ' + bytes(d.total);
      const waiting = d.phase === 'confirming' || d.phase === 'assembling';
      $('#sp', root).textContent = d.speed >= 1 && !waiting ? speed(d.speed) : '—'; $('#eta', root).textContent = d.speed >= 1 && !waiting ? duration(d.eta) : '—';
      const stEl = $('#st', root); if (stEl && up.state === 'running') stEl.textContent = d.phase === 'assembling' ? 'Assemblage…' : d.phase === 'confirming' ? 'Derniers octets en route…' : 'Dépôt en cours';
    });
    up.addEventListener('state', () => { const b = root && $('#ban', root); if (b) b.innerHTML = up && up.state === 'offline' ? `<div class="banner warn">${icon('wifi-off')}<span>Connexion perdue : reprise automatique au retour du réseau.</span></div>` : ''; });
    up.addEventListener('stalled', (e) => { const b = root && $('#ban', root); if (!b) return; const msg = e.detail.kind === 'cors' ? 'L\'envoi n\'arrive pas à démarrer : le stockage refuse la connexion depuis ce site. Prévenez l\'organisateur. La page continue d\'essayer.' : 'Fichiers envoyés, mais l\'assemblage échoue (« ' + e.detail.message + ' »). La page réessaie automatiquement.'; b.innerHTML = `<div class="banner bad">${icon('shield')}<span>${esc(msg)}</span></div>`; });
    up.addEventListener('error', (e) => { keepAwake(false); toast('Dépôt interrompu : ' + e.detail.message, 'error'); });
    /* Validation finale : l'accusé n'est affiché que si le serveur a bien enregistré le dépôt */
    const finalize = async () => {
      for (const wait of [0, 1500, 3000, 5000, 8000, 12000]) {
        if (wait) await new Promise(res => setTimeout(res, wait));
        try { await api(`/api/transfers/${r.transferId}/finalize`, { method: 'POST', key: r.uploadKey, body: {} }); return true; } catch (e) { if (e.status === 404 || e.status === 403) return false; }
      }
      return false;
    };
    const notSaved = () => {
      if (!root) return toast('Le dépôt n\'a pas pu être validé. Rouvrez la page pour réessayer.', 'error', { duration: 8000 });
      const box = $('#st', root); if (box) box.textContent = 'Fichiers envoyés, validation en attente';
      const b = $('#ban', root); if (!b) return;
      b.innerHTML = `<div class="banner warn">${icon('wifi-off')}<span>Vos fichiers sont arrivés, mais la validation du dépôt n'a pas abouti (réseau ou serveur). <b>Aucun accusé n'a encore été délivré.</b></span><button type="button" class="btn sm" id="dRetry">Réessayer</button></div>`;
      $('#dRetry', root).onclick = async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Validation…'; if (await finalize()) ok(); else { ev.target.disabled = false; ev.target.textContent = 'Réessayer'; toast('Toujours impossible. Vérifiez votre connexion puis réessayez.', 'warn'); } };
    };
    const ok = () => {
      try { ls.del('tx_dep_answers_' + id); } catch (e) { /* ignore */ }
      if (!root) return toast('Dépôt terminé ✅ · n° ' + r.receipt.no, 'success');
      receipt(r.receipt, list, sum);
      track('sent', { m: 'request', b: sum }); afterSuccess('request');
      confetti(50);
    };
    up.addEventListener('done', async () => {
      const done = await finalize();
      keepAwake(false); up = null;
      if (!done) return notSaved();
      return ok();
    });
    up.start();
  }
  function receipt(rc, list, sum) {
    const when = new Date(rc.at);
    root.innerHTML = `<section class="narrow"><div class="card glow sd-receipt" id="rcpt" style="--accent:${esc(info.color || '#00b4d8')}">
      <div class="center"><div class="success-burst">${icon('check')}</div><h2>Dépôt reçu</h2><p class="muted">Merci ${esc(rc.name)}, ${esc(info.ownerName || 'l\'organisateur')} a bien reçu vos fichiers.</p></div>
      <div class="sd-no"><span>Numéro de dépôt</span><b>${esc(rc.no)}</b></div>
      <dl class="sd-rc-grid">
        <div><dt>Espace</dt><dd>${esc(info.title)}</dd></div>
        <div><dt>Date et heure</dt><dd>${when.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} à ${when.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</dd></div>
        <div><dt>Déposant</dt><dd>${esc(rc.name)}</dd></div>
        <div><dt>Contenu</dt><dd>${list.length} fichier(s) · ${bytes(sum)}</dd></div>
      </dl>
      <ul class="sd-rc-files">${list.map(it => `<li>${icon(fileKind(it.file.name, it.file.type).icon, 'sm')}<span>${esc((info.fields.find(f => f.id === it.field) || {}).label || '')} · ${esc(it.file.name)}</span></li>`).join('')}</ul>
      ${rc.email ? `<p class="small muted center">${icon('mail', 'sm')} Un accusé de réception a été envoyé à ${esc(rc.email)}.</p>` : ''}
      <div class="row wrap no-print" style="justify-content:center;gap:8px"><button type="button" class="btn primary" id="rcPrint">${icon('download', 'sm')}Enregistrer l'accusé (PDF)</button><button type="button" class="btn" id="again">${icon('plus', 'sm')}Nouveau dépôt</button></div>
      <p class="tiny faint center">Lestha Send · conservez ce numéro pour tout échange</p>
    </div></section>`;
    $('#rcPrint', root).onclick = () => { document.body.classList.add('print-receipt'); setTimeout(() => { window.print(); setTimeout(() => document.body.classList.remove('print-receipt'), 500); }, 50); };
    $('#again', root).onclick = () => { files = {}; form(); };
  }
})();

/* ====================================================================== */
/*  3. Gérer une demande et ses dépôts                                      */
/* ====================================================================== */
export const manageView = (() => {
  let root, id, key, q, sock, onEv, onConn, reloadT;
  const REV = { received: ['info', 'Reçu'], review: ['violet', 'En cours d\'analyse'], incomplete: ['warn', 'À compléter'], validated: ['ok', 'Validé'], refused: ['bad', 'Refusé'], archived: ['', 'Archivé'] };
  let filt = 'all', search = '';
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
    const st = { open: ['ok', 'Ouvert'], closed: ['bad', 'Fermé'], expired: ['', 'Terminé'], full: ['warn', 'Complet'] }[q.state] || ['', q.state];
    const kq = encodeURIComponent(key);
    root.innerHTML = `
    <section class="stack sd-manage" style="--accent:${esc(q.color || '#06d6a0')}">
      <a href="/dashboard" data-link class="btn ghost sm" style="align-self:flex-start">${icon('arrow-left', 'sm')}Tableau de bord</a>
      <div class="card glow stack">
        <div class="row wrap between"><div class="row grow" style="min-width:240px"><div class="ficon sd-av" style="--c:var(--accent);width:52px;height:52px;border-radius:16px">${icon('inbox', 'lg')}</div><div class="fmeta"><h2 style="font-size:clamp(20px,3.6vw,28px)">${esc(q.title)}</h2><div class="small muted">${q.permanent ? `Lien personnel @${esc(q.handle || '')} · toujours ouvert` : `Smart Drop · créé le ${fmtDate(q.createdAt)} · ${q.state === 'expired' ? 'terminé' : 'jusqu\'au ' + new Date(q.expiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`}${q.maxDeposits ? ` · ${ready.length}/${q.maxDeposits} dépôts` : ''}</div></div></div><span class="pill ${st[0]}" style="font-size:13px">${st[1]}</span></div>
        <div class="link-box"><input id="shareLink" readonly value="${esc(q.link)}"><button type="button" class="btn primary sm" id="btnCopy">${icon('copy', 'sm')}Copier</button></div>
        ${shareGrid()}
        <div class="row wrap sd-actions">
          <a class="btn" href="/api/requests/${esc(id)}/zip?key=${kq}" ${ready.length ? '' : 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"'}>${icon('zip', 'sm')}Tout télécharger</a>
          <a class="btn" href="/api/requests/${esc(id)}/export.csv?key=${kq}" ${ready.length ? '' : 'aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"'}>${icon('clipboard', 'sm')}Exporter (Excel)</a>
          <button type="button" class="btn" id="cQr2">${icon('qr', 'sm')}QR code</button>
          <button type="button" class="btn ghost" id="cMgmt" title="Pour gérer cet espace depuis un autre appareil">${icon('lock', 'sm')}Lien de gestion (privé)</button>
          <a class="btn ghost" href="/reunion?title=${encodeURIComponent(q.title)}" data-link>${icon('call', 'sm')}Organiser une réunion</a>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi" style="--kc:#06d6a0"><div class="kpi-top">Dépôts reçus<span class="kpi-icon">${icon('inbox')}</span></div><div class="kpi-value" id="r1">0</div><div class="kpi-foot">${q.deposits.length - ready.length} en cours d'envoi</div></div>
        <div class="kpi" style="--kc:#fbbf24"><div class="kpi-top">Volume reçu<span class="kpi-icon">${icon('cloud')}</span></div><div class="kpi-value" id="r2">0 o</div><div class="kpi-foot">max ${bytes(q.maxBytes, 0)} par dépôt</div></div>
        <div class="kpi" style="--kc:#00b4d8"><div class="kpi-top">Visiteurs<span class="kpi-icon">${icon('eye')}</span></div><div class="kpi-value" id="r3">0</div><div class="kpi-foot">personnes ayant ouvert le lien</div></div>
        <div class="kpi" style="--kc:#8b7bff"><div class="kpi-top">Validés<span class="kpi-icon">${icon('check')}</span></div><div class="kpi-value" id="r4">0</div><div class="kpi-foot">${(q.reviews || {}).incomplete || 0} à compléter · ${(q.reviews || {}).refused || 0} refusé(s)</div></div>
      </div>
      <div class="grid-2 sd-mgrid">
        <div class="card"><div class="card-title"><h3>${icon('inbox')}Dépôts</h3><span class="live-badge off" id="rLive"><i></i><span>…</span></span></div>
          <div class="sd-tools"><input class="input" id="dSearch" placeholder="Rechercher un nom, un numéro, une réponse…" value="${esc(search)}"><div class="chips" id="dFilt">${[['all', 'Tous', ready.length], ...Object.entries(REV).map(([k, [, l]]) => [k, l, (q.reviews || {})[k] || 0])].map(([k, l, n]) => `<button type="button" class="chip ${filt === k ? 'active' : ''}" data-f="${k}">${l}${n ? ` <b>${n}</b>` : ''}</button>`).join('')}</div></div>
          <div class="stack" style="gap:10px" id="dList"></div></div>
        <div class="card"><div class="card-title"><h3>${icon('settings')}Contrôles</h3></div><div class="controls">
          <div class="control"><div class="control-text"><b>Dépôts ouverts</b><span>Fermez pour ne plus rien recevoir</span></div><label class="switch"><input type="checkbox" id="cOpen" ${q.closed ? '' : 'checked'}><span class="track"></span></label></div>
          ${q.permanent ? '' : `<div class="control"><div class="control-text"><b>Date limite</b><span>Actuellement le ${new Date(q.expiresAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} · jusqu'à ${q.deadlineMaxDays || 30} jours à partir d'aujourd'hui</span></div><div class="chips"><button type="button" class="chip" data-ext="${7 * DAY}">+7 j</button><label class="chip sd-date" title="Choisir une date">${icon('clock', 'sm')}<input type="date" id="cDeadline" aria-label="Nouvelle date limite"></label></div></div>`}
          <div class="control"><div class="control-text"><b>Code pour déposer</b><span>${q.pinEnabled ? 'Espace privé' : 'Espace public'}</span></div><div class="row"><button type="button" class="btn sm" id="cPin">${icon('lock', 'sm')}${q.pinEnabled ? 'Changer' : 'Définir'}</button>${q.pinEnabled ? '<button type="button" class="btn sm ghost" id="cPinOff">Retirer</button>' : ''}</div></div>
          <div class="control"><div class="control-text"><b>Taille max par dépôt</b><span>${bytes(q.maxBytes, 0)}</span></div><div class="chips">${[[GB, '1 Go'], [5 * GB, '5 Go'], [20 * GB, '20 Go']].map(([v, l]) => `<button type="button" class="chip ${q.maxBytes === v ? 'active' : ''}" data-max="${v}">${l}</button>`).join('')}</div></div>
          ${q.smart ? `<div class="control"><div class="control-text"><b>Accusé par e-mail</b><span>Envoyé au déposant après son dépôt</span></div><label class="switch"><input type="checkbox" id="cRcpt" ${q.receipt ? 'checked' : ''}><span class="track"></span></label></div>
          <div class="control"><div class="control-text"><b>Prévenir du statut</b><span>E-mail au déposant quand vous validez ou demandez un complément</span></div><label class="switch"><input type="checkbox" id="cNDep" ${q.notifyDepositor ? 'checked' : ''}><span class="track"></span></label></div>` : ''}
          <div class="control"><div class="control-text"><b>${q.permanent ? 'Supprimer mon lien @' + esc(q.handle || '') : 'Supprimer l\'espace'}</b><span>${q.permanent ? 'Libère le nom et efface tous les dépôts' : 'Efface aussi tous les dépôts'}</span></div><button type="button" class="btn sm danger" id="cDel">${icon('trash', 'sm')}Supprimer</button></div>
        </div></div>
      </div>
    </section>`;
    bindShare(root, q.link, q.title, null);
    animateCount($('#r1', root), ready.length); animateCount($('#r2', root), vol, v => bytes(v)); animateCount($('#r3', root), q.stats.visitors); animateCount($('#r4', root), (q.reviews || {}).validated || 0);
    $('#dFilt', root).onclick = (e) => { const c = e.target.closest('[data-f]'); if (!c) return; filt = c.dataset.f; $$('#dFilt .chip', root).forEach(x => x.classList.toggle('active', x === c)); renderDeposits(); };
    $('#dSearch', root).oninput = (e) => { search = e.target.value; renderDeposits(); };
    $('#cQr2', root).onclick = () => bigQr(q.title, q.link);
    $('#cMgmt', root).onclick = () => { copyText(location.origin + '/r/' + id + '#' + key); toast('Lien de gestion copié. Gardez-le pour vous : il donne accès aux dépôts.', 'warn', { duration: 6000 }); };
    renderDeposits();
    bindControls();
  }
  function renderDeposits() {
    const box = $('#dList', root);
    const fields = (q.fields || []).filter(f => f.type !== 'file' && f.type !== 'files');
    const s = search.trim().toLowerCase();
    const list = q.deposits.filter(d => (filt === 'all' || (d.status === 'ready' && (d.review || 'received') === filt)) && (!s || [d.no, d.name, d.email, d.note, ...Object.values(d.answers || {}).flat()].join(' ').toLowerCase().includes(s)));
    if (!q.deposits.length) { box.innerHTML = `<div class="empty" style="padding:24px"><div class="state-icon info">${icon('inbox')}</div><span class="small">Aucun dépôt pour l'instant. Partagez le lien ou affichez le QR code !</span></div>`; return; }
    if (!list.length) { box.innerHTML = `<p class="small faint center" style="padding:18px">Aucun dépôt ne correspond.</p>`; return; }
    box.innerHTML = list.map(d => {
      const rv = REV[d.review || 'received'] || REV.received, live = d.status === 'ready' && d.state !== 'deleted' && d.state !== 'expired';
      const ans = fields.map(f => [f.label, (d.answers || {})[f.id]]).filter(([, v]) => v && (!Array.isArray(v) || v.length));
      return `<div class="receiver-item sd-dep" data-id="${esc(d.id)}">
      <div class="receiver-top"><span class="row"><span class="avatar" style="width:38px;height:38px;border-radius:12px;font-size:15px">${esc((d.name || '?').charAt(0).toUpperCase())}</span><span><b>${esc(d.name)}</b>${d.no ? ` <span class="sd-dno">${esc(d.no)}</span>` : ''}<br><span class="tiny faint">${relTime(d.at)} · ${(d.files && d.files.length) || 0} fichier(s) · ${bytes(d.size)}</span></span></span>
      ${d.status !== 'ready' ? '<span class="pill warn">Envoi en cours…</span>' : d.state === 'deleted' ? '<span class="pill">Supprimé</span>' : d.state === 'expired' ? '<span class="pill">Expiré</span>' : `<select class="input sd-rev ${rv[0]}" data-rev aria-label="Statut">${Object.entries(REV).map(([k, [, l]]) => `<option value="${k}" ${k === (d.review || 'received') ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</div>
      ${ans.length ? `<dl class="sd-ans">${ans.map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}</dd></div>`).join('')}</dl>` : d.message ? `<div class="message-bubble small" style="margin:6px 0">${esc(d.message)}</div>` : ''}
      ${d.files && d.files.length ? `<div class="tiny muted sd-flist">${d.files.slice(0, 8).map(f => esc(f.path || f.name)).join(' · ')}${d.files.length > 8 ? ' …' : ''}</div>` : ''}
      ${live ? `<div class="row wrap" style="margin-top:8px;gap:6px"><a class="btn sm" href="/t/${esc(d.id)}" data-link>${icon('external', 'sm')}Ouvrir</a>${d.files.length > 1 ? `<a class="btn sm" href="/api/public/t/${esc(d.id)}/zip?v=owner">${icon('zip', 'sm')}ZIP</a>` : `<a class="btn sm" href="/api/public/t/${esc(d.id)}/f/${esc(d.files[0] && d.files[0].id)}?v=owner">${icon('download', 'sm')}Télécharger</a>`}<input class="input sd-note" data-note placeholder="Note interne ou message au déposant…" value="${esc(d.note || '')}" maxlength="1000"><button type="button" class="btn sm ghost" data-deld="${esc(d.id)}" aria-label="Supprimer">${icon('trash', 'sm')}</button></div>` : ''}
    </div>`; }).join('');
    box.onchange = async (e) => {
      const it = e.target.closest('[data-id]'); if (!it) return;
      const did = it.dataset.id, d = q.deposits.find(x => x.id === did);
      const body = e.target.matches('[data-rev]') ? { review: e.target.value } : e.target.matches('[data-note]') ? { note: e.target.value } : null; if (!body) return;
      try {
        const r = await api(`/api/requests/${id}/deposits/${did}`, { method: 'PATCH', key, body });
        Object.assign(d, r);
        if (body.review) { e.target.className = 'input sd-rev ' + REV[r.review][0]; toast(`${d.no || d.name} : ${REV[r.review][1]}${q.notifyDepositor && d.email && ['incomplete', 'validated', 'refused', 'review'].includes(r.review) ? ' · le déposant est prévenu' : ''}`, 'success'); clearTimeout(reloadT); reloadT = setTimeout(load, 900); }
        else toast('Note enregistrée', 'success', { duration: 1500 });
      } catch (err) { toast(err.message, 'error'); }
    };
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
    const cd = $('#cDeadline', root);
    if (cd) { const z = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }; cd.min = z(Date.now() + DAY); cd.max = z(Date.now() + (q.deadlineMaxDays || 30) * DAY); cd.onchange = () => { if (cd.value) patch({ expiresAt: new Date(cd.value + 'T23:59:00').getTime() }, 'Date limite : ' + new Date(cd.value + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })); }; }
    const rc = $('#cRcpt', root); if (rc) rc.onchange = (e) => patch({ receipt: e.target.checked }, e.target.checked ? 'Accusés de réception activés' : 'Accusés de réception désactivés');
    const nd = $('#cNDep', root); if (nd) nd.onchange = (e) => patch({ notifyDepositor: e.target.checked }, e.target.checked ? 'Les déposants seront prévenus' : 'Les déposants ne seront plus prévenus');
    $('#cDel', root).onclick = async () => {
      if (!(await confirmDialog('Supprimer cet espace de dépôt ?', 'Le lien cessera de fonctionner et TOUS les fichiers déposés seront effacés.', 'Tout supprimer', true))) return;
      try { await api(`/api/requests/${id}`, { method: 'DELETE', key }); owned.remove(id); toast('Espace supprimé', 'success'); navigate('/dashboard'); } catch (e) { toast(e.message, 'error'); }
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
