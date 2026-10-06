/* Lestha Send — Compte enseignant sans mot de passe (3.17)
   On se connecte avec son e-mail et un code à 6 chiffres. Le serveur garde un coffre chiffré avec
   les clés de gestion de tout ce que l'on a créé : transferts, espaces Smart Drop, réunions, directs.
   Sur un nouveau téléphone, on se connecte et tout revient. Synchronisation automatique, sans bouton. */
import { $, esc, icon, ls, owned, api, toast, modal, verifiedEmail, ensureVerified, forgetSender, onStoreChange, getConfig } from './core.js';

const MEET_HOST = 'tx_meet_host_';
const gone = () => new Set(ls.get('tx_gone', []));

/** Tout ce que cet appareil pilote (aussi utilisé pour la sauvegarde manuelle du Tableau de bord) */
export function backupData() {
  const meetings = ls.get('tx_meet_mine', []);
  const hostKeys = {};
  (Array.isArray(meetings) ? meetings : []).forEach(m => { const k = m && m.id && ls.get(MEET_HOST + m.id, null); if (k) hostKeys[m.id] = k; });
  return { app: 'Lestha Send', version: 5, exportedAt: new Date().toISOString(), owned: owned.all(), requests: ls.get('tx_requests', []), meetings, meetHostKeys: hostKeys, lives: ls.get('tx_lives', []), p2pHistory: ls.get('transferx_history', []), gone: [...gone()].slice(-1000) };
}

/** Ajoute ce que contient une sauvegarde (ou le coffre du compte) ; rien n'est effacé ni écrasé */
export function restoreData(j) {
  const n = { t: 0, r: 0, m: 0, l: 0 };
  if (!j) return n;
  const skip = gone();
  // Éléments supprimés sur un autre appareil : on les retire ici aussi
  const far = new Set(Array.isArray(j.gone) ? j.gone.filter(x => typeof x === 'string') : []);
  if (far.size) {
    const keep = (list) => list.filter(x => !(x && far.has(x.id)));
    const o = owned.all(); if (keep(o).length !== o.length) ls.set('tx_owned', keep(o));
    const rq = ls.get('tx_requests', []); if (Array.isArray(rq) && keep(rq).length !== rq.length) ls.set('tx_requests', keep(rq));
    const lv = ls.get('tx_lives', []); if (Array.isArray(lv) && keep(lv).length !== lv.length) ls.set('tx_lives', keep(lv));
    const mm = ls.get('tx_meet_mine', []); if (Array.isArray(mm) && keep(mm).length !== mm.length) ls.set('tx_meet_mine', keep(mm));
    const g = gone(); far.forEach(id => g.add(id)); ls.set('tx_gone', [...g].slice(-1000));
    far.forEach(id => skip.add(id));
  }
  // Transferts (tx_owned) et espaces Smart Drop (tx_requests) : ajoutés sans rien écraser, triés par date
  const merge = (key, incoming, max) => {
    const cur = ls.get(key, []), list = Array.isArray(cur) ? cur : [], ids = new Set(list.map(x => x && x.id));
    const add = (Array.isArray(incoming) ? incoming : []).filter(o => o && o.id && o.key && !ids.has(o.id) && !skip.has(o.id));
    if (add.length) ls.set(key, list.concat(add).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, max));
    return add.length;
  };
  if (!Array.isArray(j)) { n.t = merge('tx_owned', j.owned, 300); n.r = merge('tx_requests', j.requests, 200); }
  if (Array.isArray(j.meetings) && j.meetings.length) {
    const cur = ls.get('tx_meet_mine', []), ids = new Set((Array.isArray(cur) ? cur : []).map(x => x.id));
    const add = j.meetings.filter(x => x && x.id && !ids.has(x.id) && !skip.has(x.id) && x.exp > Date.now());
    if (add.length) ls.set('tx_meet_mine', add.concat(Array.isArray(cur) ? cur : []).slice(0, 12));
    n.m = add.length;
    Object.entries(j.meetHostKeys || {}).forEach(([id, k]) => { if (/^[A-Za-z0-9]+$/.test(id) && k && !ls.get(MEET_HOST + id, null)) ls.set(MEET_HOST + id, k); });
  }
  if (Array.isArray(j.lives) && j.lives.length) {
    const cur = ls.get('tx_lives', []), ids = new Set(cur.map(x => x.id));
    const add = j.lives.filter(x => x && x.id && !ids.has(x.id) && !skip.has(x.id));
    if (add.length) ls.set('tx_lives', add.concat(cur).slice(0, 50));
    n.l = add.length;
  }
  const hist = Array.isArray(j) ? j : (j.p2pHistory || []);
  if (hist.length) { const cur = ls.get('transferx_history', []); const ids = new Set(cur.map(h => h.roomId)); const add = hist.filter(h => h && h.roomId && !ids.has(h.roomId)); if (add.length) ls.set('transferx_history', cur.concat(add).slice(0, 200)); }
  return n;
}

/* ---------------- Synchronisation ---------------- */
const A = { busy: false, again: false, timer: 0, pulled: false, last: '' };

/** Récupère le coffre, l'ajoute à cet appareil, puis renvoie l'ensemble. Renvoie ce qui a été ajouté. */
export async function syncNow() {
  if (!verifiedEmail()) return null;
  if (A.busy) { A.again = true; return null; }
  A.busy = true;
  let added = null;
  try {
    const r = await api('/api/account/vault');
    if (r.vault) added = withoutHook(() => restoreData(r.vault));
    A.pulled = true;
    const body = backupData(), sig = JSON.stringify([body.owned, body.requests, body.meetings, body.meetHostKeys, body.lives, body.gone]);
    if (sig !== A.last || !r.vault) { await api('/api/account/vault', { method: 'PUT', body: { vault: body } }); A.last = sig; }
    ls.set('tx_acct_sync', Date.now());
  } catch (e) {
    if (e.status === 401) { await forgetSender(); drawButton(); }
  } finally {
    A.busy = false;
    if (A.again) { A.again = false; schedule(); }
  }
  if (added && (added.t || added.r || added.m || added.l)) window.dispatchEvent(new CustomEvent('tx:account', { detail: added }));
  return added;
}
let muted = false;
function withoutHook(fn) { muted = true; try { return fn(); } finally { muted = false; } }
function schedule(ms = 2500) { clearTimeout(A.timer); A.timer = setTimeout(syncNow, ms); }

/* ---------------- Connexion / déconnexion ---------------- */
export async function signIn() {
  const cfg = await getConfig();
  if (!cfg.email) return toast('La connexion par e-mail n\'est pas encore activée sur ce serveur.', 'warn', { duration: 6000 });
  const email = await ensureVerified('Connectez-vous pour retrouver vos transferts, espaces Smart Drop, réunions et directs sur tous vos appareils. Pas de mot de passe : un code vous est envoyé.');
  if (!email) return;
  const added = await syncNow();
  const parts = added ? [[added.t, 'transfert(s)'], [added.r, 'espace(s) Smart Drop'], [added.m, 'réunion(s)'], [added.l, 'direct(s)']].filter(([x]) => x).map(([x, w]) => x + ' ' + w) : [];
  toast(parts.length ? 'Connecté. Retrouvé sur cet appareil : ' + parts.join(', ') + '.' : 'Connecté : ' + email + '. Vos espaces seront retrouvés sur tous vos appareils.', 'success', { duration: 7000 });
  drawButton();
}

async function accountMenu() {
  const email = verifiedEmail();
  if (!email) return signIn();
  const at = ls.get('tx_acct_sync', 0);
  const n = owned.all().length + (ls.get('tx_requests', []) || []).length + (ls.get('tx_meet_mine', []) || []).length + (ls.get('tx_lives', []) || []).length;
  const r = await modal({
    title: 'Mon compte',
    body: `<div class="acct-card"><span class="acct-av">${esc(email.charAt(0).toUpperCase())}</span><span><b>${esc(email)}</b><small>${n} élément(s) · ${at ? 'synchronisé ' + new Date(at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'synchronisation en cours'}</small></span></div>
      <p class="small muted" style="margin-top:12px">Vos transferts, espaces Smart Drop, réunions et directs sont gardés dans votre compte. Sur un autre téléphone ou ordinateur, connectez-vous avec la même adresse : tout revient.</p>`,
    actions: [{ label: 'Se déconnecter', cls: 'ghost', value: 'out' }, { label: 'Synchroniser', icon: 'refresh', value: 'sync' }, { label: 'Fermer', cls: 'primary', value: null }]
  });
  if (r === 'sync') { await syncNow(); toast('Compte à jour', 'success', { duration: 2000 }); }
  if (r === 'out') {
    const wipe = await modal({
      title: 'Se déconnecter',
      body: '<p class="small muted">Vos espaces restent dans votre compte. Sur un appareil partagé (cybercafé, salle informatique), effacez-les aussi de cet appareil.</p>',
      actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Garder sur cet appareil', value: 'keep' }, { label: 'Effacer de cet appareil', cls: 'danger', value: 'wipe' }]
    });
    if (!wipe) return;
    await syncNow();
    withoutHook(() => {
      if (wipe === 'wipe') {
        (ls.get('tx_meet_mine', []) || []).forEach(m => m && m.id && ls.del(MEET_HOST + m.id));
        ['tx_owned', 'tx_requests', 'tx_meet_mine', 'tx_lives', 'tx_gone', 'transferx_history', 'tx_acct_sync'].forEach(k => ls.del(k));
      }
    });
    await forgetSender(); A.last = '';
    toast(wipe === 'wipe' ? 'Déconnecté. Cet appareil ne garde plus rien.' : 'Déconnecté.', 'success');
    drawButton();
    if (wipe === 'wipe') location.reload();
  }
}

/* ---------------- Bouton du bandeau ---------------- */
function drawButton() {
  const box = document.querySelector('.topbar-actions'); if (!box) return;
  let b = $('#btnAccount');
  if (!A.enabled && !verifiedEmail()) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('button'); b.id = 'btnAccount'; b.type = 'button'; box.insertBefore(b, box.firstChild); b.onclick = accountMenu; }
  const email = verifiedEmail();
  b.className = 'acct-btn' + (email ? ' on' : '');
  b.title = email ? 'Mon compte : ' + email : 'Se connecter pour retrouver vos espaces sur tous vos appareils';
  b.setAttribute('aria-label', email ? 'Mon compte' : 'Se connecter');
  b.innerHTML = email ? `<span class="acct-av">${esc(email.charAt(0).toUpperCase())}</span>` : `${icon('users', 'sm')}<span>Connexion</span>`;
}

export function accountInit() {
  onStoreChange((k) => {
    if (muted) return;
    if (k === 'tx_sender_token') { drawButton(); if (verifiedEmail()) schedule(300); return; }
    if (verifiedEmail()) schedule();
  });
  // Bouton affiché seulement si le serveur sait envoyer le code par e-mail
  getConfig().then(cfg => { A.enabled = !!cfg.email; drawButton(); }).catch(() => {});
  if (verifiedEmail()) syncNow();
  // Retour sur l'onglet : on récupère ce qui a été créé sur un autre appareil
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && verifiedEmail() && Date.now() - ls.get('tx_acct_sync', 0) > 60e3) syncNow(); });
}
