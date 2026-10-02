/* Lestha Send — profil de l'expéditeur vérifié et lien personnel @nom
 *  - openProfile() : nom affiché, couleur, site web et logo qui habillent la page de téléchargement
 *  - openHandle()  : réserver ou retrouver son lien personnel lestha-send.com/@nom
 */
import { $, esc, icon, api, toast, modal, ensureVerified, verifiedEmail, getConfig, ls, copyText, captchaToken } from './core.js';
import { navigate } from './router.js';

export const BRAND_COLORS = ['#00b4d8', '#06d6a0', '#8b7bff', '#f59e0b', '#f43f5e', '#ec4899', '#0ea5e9', '#16a34a'];

/** Petit aperçu de l'en-tête tel que le verra le destinataire */
export function brandHeader(brand, { label = 'Envoyé par', sub = '' } = {}) {
  if (!brand) return '';
  const name = brand.displayName || 'Expéditeur vérifié';
  const initials = name.split(/\s+/).map(w => w.charAt(0)).join('').slice(0, 2).toUpperCase() || '?';
  let host = '';
  try { host = brand.website ? new URL(brand.website).hostname.replace(/^www\./, '') : ''; } catch (e) { host = ''; }
  return `<div class="brand-head" style="${brand.color ? `--bc:${esc(brand.color)}` : ''}">
    <div class="brand-logo">${brand.logo ? `<img src="${esc(brand.logo)}" alt="" loading="lazy">` : `<span>${esc(initials)}</span>`}</div>
    <div class="brand-text"><span class="tiny muted">${esc(label)}</span><b>${esc(name)}</b>${sub ? `<span class="tiny faint">${sub}</span>` : ''}</div>
    ${host ? `<a class="btn sm ghost brand-site" href="${esc(brand.website)}" target="_blank" rel="noopener nofollow ugc">${icon('external', 'sm')}${esc(host)}</a>` : ''}
  </div>`;
}

async function needVerified(reason) {
  const cfg = await getConfig();
  if (verifiedEmail()) return true;
  if (cfg.tier === 'full' && !verifiedEmail()) { toast('Confirmez une adresse e-mail pour rattacher votre profil (même en mode administrateur).', 'info'); }
  return ensureVerified(reason);
}

/* ---------------------------------------------------------------------- */
/*  Personnaliser sa page                                                  */
/* ---------------------------------------------------------------------- */
export async function openProfile() {
  if (!(await needVerified('Personnalisez votre page de téléchargement avec votre nom et votre logo. Il suffit de confirmer votre adresse e-mail.'))) return;
  let p;
  try { p = await api('/api/profile'); } catch (e) { return toast(e.message, 'error'); }
  const state = { color: p.color || '', logo: p.logo };
  const preview = (bd) => {
    const box = bd.querySelector('#pfPreview');
    box.innerHTML = brandHeader({ displayName: bd.querySelector('#pfName').value.trim() || 'Votre nom', color: state.color, website: bd.querySelector('#pfSite').value.trim() ? safeUrl(bd.querySelector('#pfSite').value.trim()) : '', logo: state.logo }, { sub: 'Expéditeur vérifié' });
  };
  await modal({
    title: 'Personnaliser ma page',
    body: `<p class="small muted" style="margin-bottom:12px">Vos destinataires verront votre nom et votre logo en haut de la page de téléchargement, ainsi que sur votre lien personnel @nom.</p>
      <div id="pfPreview" style="margin-bottom:14px"></div>
      <div class="stack" style="gap:12px">
        <label class="field"><span>Nom affiché</span><input class="input" id="pfName" maxlength="60" value="${esc(p.displayName || '')}" placeholder="Ex. Studio Ndiaye, Amadou Diop"></label>
        <label class="field"><span>Site web ou page (facultatif)</span><input class="input" id="pfSite" maxlength="200" value="${esc(p.website || '')}" placeholder="exemple.sn ou linkedin.com/in/…" inputmode="url"></label>
        <div class="field"><span>Couleur</span><div class="swatches" id="pfColors">${['', ...BRAND_COLORS].map(c => `<button type="button" class="swatch ${c === state.color ? 'active' : ''}" data-c="${c}" style="${c ? `--sw:${c}` : ''}" aria-label="${c || 'Couleur Lestha Send'}">${c ? '' : icon('sparkles', 'sm')}</button>`).join('')}</div></div>
        <div class="field"><span>Logo ou photo (PNG, JPEG ou WebP, 300 Ko max.)</span>
          <div class="row wrap"><button type="button" class="btn sm" id="pfLogo">${icon('image', 'sm')}Choisir une image</button><button type="button" class="btn sm ghost ${state.logo ? '' : 'hidden'}" id="pfLogoDel">${icon('trash', 'sm')}Retirer</button></div>
          <input type="file" id="pfFile" accept="image/png,image/jpeg,image/webp" class="hidden"></div>
      </div>`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, {
      label: 'Enregistrer', cls: 'primary', handler: (bd) => {
        const body = { displayName: bd.querySelector('#pfName').value.trim(), website: bd.querySelector('#pfSite').value.trim(), color: state.color };
        api('/api/profile', { method: 'PUT', body }).then(() => toast('Page personnalisée ✅ Vos prochains envois l\'afficheront.', 'success')).catch(e => toast(e.message, 'error'));
      }
    }],
    onMount: (m) => {
      const bd = m.parentElement;
      preview(bd);
      bd.querySelector('#pfName').oninput = () => preview(bd);
      bd.querySelector('#pfSite').oninput = () => preview(bd);
      bd.querySelector('#pfColors').onclick = (e) => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        state.color = b.dataset.c;
        bd.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x === b));
        preview(bd);
      };
      const file = bd.querySelector('#pfFile');
      bd.querySelector('#pfLogo').onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0]; file.value = '';
        if (!f) return;
        if (f.size > 300 * 1024) return toast('Image trop lourde : 300 Ko maximum. Réduisez-la avant de l\'envoyer.', 'warn');
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
        try { const r = await api('/api/profile/logo', { method: 'POST', body: { data } }); state.logo = r.logo; bd.querySelector('#pfLogoDel').classList.remove('hidden'); preview(bd); toast('Logo enregistré', 'success'); }
        catch (e) { toast(e.message, 'error'); }
      };
      bd.querySelector('#pfLogoDel').onclick = async () => {
        try { await api('/api/profile/logo', { method: 'DELETE' }); state.logo = null; bd.querySelector('#pfLogoDel').classList.add('hidden'); preview(bd); }
        catch (e) { toast(e.message, 'error'); }
      };
    }
  });
}
function safeUrl(s) { try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).href; } catch (e) { return ''; } }

/* ---------------------------------------------------------------------- */
/*  Lien personnel @nom                                                    */
/* ---------------------------------------------------------------------- */
const ownedReq = {
  all: () => ls.get('tx_requests', []),
  upsert(it) { const l = ownedReq.all().filter(x => x.id !== it.id); l.unshift(Object.assign(ownedReq.all().find(x => x.id === it.id) || {}, it)); ls.set('tx_requests', l.slice(0, 200)); }
};

/** Ouvre la gestion de son lien personnel (clé récupérée grâce à l'adresse vérifiée si besoin) */
async function manageHandle(mine) {
  const has = ownedReq.all().find(x => x.id === mine.id);
  if (!has) {
    try { const r = await api('/api/handles/recover', { method: 'POST', body: {} }); ownedReq.upsert({ id: r.id, key: r.ownerKey, title: '@' + r.name, createdAt: Date.now() }); }
    catch (e) { return toast(e.message, 'error'); }
  }
  navigate('/r/' + mine.id);
}

export async function openHandle() {
  if (!(await needVerified('Réservez votre lien personnel, par exemple lestha-send.com/@votre-nom : il suffit de confirmer votre adresse e-mail.'))) return;
  let mine;
  try { mine = await api('/api/handles/mine'); } catch (e) { return toast(e.message, 'error'); }
  if (mine.name) {
    const v = await modal({
      title: 'Mon lien personnel',
      body: `<p class="small muted" style="margin-bottom:12px">Partagez ce lien : n'importe qui peut vous y déposer des fichiers, à tout moment. Vous êtes prévenu par e-mail à chaque dépôt.</p>
        <div class="link-box"><input readonly value="${esc(mine.link)}"><button type="button" class="btn primary sm" id="hCopy">${icon('copy', 'sm')}Copier</button></div>`,
      actions: [{ label: 'Fermer', cls: 'ghost', value: null }, { label: 'Voir les dépôts', cls: 'primary', icon: 'inbox', value: 'manage' }],
      onMount: (m) => { m.querySelector('#hCopy').onclick = () => copyText(mine.link).then(() => toast('Lien copié', 'success')); }
    });
    if (v === 'manage') manageHandle(mine);
    return;
  }
  const origin = location.origin.replace(/^https?:\/\//, '');
  const suggest = (verifiedEmail() || '').split('@')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  let checkT = null;
  const r = await modal({
    title: 'Réserver mon lien personnel',
    body: `<p class="small muted" style="margin-bottom:12px">Un lien à vous, permanent, où vos clients, élèves ou collègues déposent leurs fichiers. Choisissez-le bien : il ne pourra pas être changé.</p>
      <label class="field"><span>Votre lien</span><div class="handle-input"><span>${esc(origin)}/@</span><input class="input" id="hName" maxlength="30" value="${esc(suggest)}" autocomplete="off" autocapitalize="none" spellcheck="false"></div></label>
      <p class="small" id="hState" style="min-height:20px;margin-top:6px"></p>
      <label class="field" style="margin-top:8px"><span>Titre affiché aux déposants</span><input class="input" id="hTitle" maxlength="140" placeholder="Déposez-moi vos fichiers"></label>
      <label class="field" style="margin-top:8px"><span>Votre nom</span><input class="input" id="hOwner" maxlength="80" value="${esc(ls.get('tx_sender_name', ''))}" placeholder="Affiché sur la page"></label>`,
    actions: [{ label: 'Annuler', cls: 'ghost', value: null }, {
      label: 'Réserver', cls: 'primary', icon: 'sparkles', handler: (bd) => {
        const name = bd.querySelector('#hName').value.trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(name)) { toast('3 à 30 caractères : lettres minuscules, chiffres et tirets', 'warn'); return false; }
        return { name, title: bd.querySelector('#hTitle').value.trim(), ownerName: bd.querySelector('#hOwner').value.trim() };
      }
    }],
    onMount: (m) => {
      const inp = m.querySelector('#hName'), st = m.querySelector('#hState');
      const check = () => {
        inp.value = inp.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
        clearTimeout(checkT);
        const v = inp.value;
        if (v.length < 3) { st.textContent = ''; return; }
        checkT = setTimeout(async () => {
          try { const c = await api('/api/handles/check/' + encodeURIComponent(v)); if (inp.value !== v) return; st.innerHTML = c.available ? `<span style="color:var(--ok)">${icon('check', 'sm')} Disponible</span>` : `<span style="color:var(--rose)">${esc(c.reason || 'Indisponible')}</span>`; }
          catch (e) { st.textContent = ''; }
        }, 350);
      };
      inp.oninput = check; check();
    }
  });
  if (!r) return;
  if (r.ownerName) ls.set('tx_sender_name', r.ownerName);
  try {
    const cap = await captchaToken();
    const out = await api('/api/handles', { method: 'POST', body: r, headers: cap ? { 'X-Turnstile': cap } : {} });
    ownedReq.upsert({ id: out.id, key: out.ownerKey, title: '@' + out.name, createdAt: Date.now() });
    toast(`Votre lien est prêt : ${out.link.replace(/^https?:\/\//, '')} 🎉`, 'success');
    openHandle();
  } catch (e) { toast(e.message, 'error'); }
}
