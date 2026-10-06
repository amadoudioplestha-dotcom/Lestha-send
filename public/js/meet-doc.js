/* Lestha Send — Réunion : « Présenter » (3.15)
 *  - Partager l'écran, avec ou sans le son (case à cocher, mémorisée)
 *  - Présenter un fichier sans quitter la réunion : PDF, PowerPoint / Word (convertis par le serveur
 *    s'il en est capable), images. Le navigateur de l'enseignant transforme chaque page en image :
 *    tout le monde reçoit des pages nettes et légères, même sur un téléphone et un petit réseau.
 *  - Annotations rangées page par page, vignettes, flèches du clavier, balayage sur téléphone,
 *    navigation libre pour les élèves (avec « Revenir à la page de l'enseignant »), support téléchargeable. */
import { $, esc, icon, ls, toast, modal } from './core.js';
import * as T from './meet-teach.js';

let X = null;                                       // accès à la réunion (fourni par meet.js)
export function docInit(ctx) { X = ctx; }
const S = () => X.S;
const staff = () => X.isStaff();

const PDFJS = '/vendor/pdfjs/';
const OFFICE = /\.(pptx?|ppsx?|odp|docx?|odt|rtf|xlsx?|ods)$/i;
const MAX_W = 1920;                                 // largeur des pages envoyées (net sur un vidéoprojecteur)
const D = {
  view: null,                                       // page regardée par un élève en navigation libre
  local: new Map(),                                 // pages rendues sur l'appareil de l'enseignant (affichage immédiat)
  missing: new Set(),                               // pages pas encore arrivées sur le serveur
  job: null,                                        // envoi en cours (enseignant)
  thumbs: false, sheet: null, swipe: null
};

/* ---------------- état ---------------- */
export const doc = () => { const s = S(); return (s && s.meeting && s.meeting.doc) || null; };
export const docOn = () => !!doc();
/** Page affichée sur cet appareil : celle de l'enseignant, ou celle choisie en navigation libre */
export const shownPage = () => { const d = doc(); if (!d) return 0; return D.view != null && d.free && !staff() ? D.view : d.page; };
export const onLivePage = () => { const d = doc(); return !d || shownPage() === d.page; };
export const docAspect = () => { const d = doc(); if (!d) return null; const r = d.dims[shownPage()] || [16, 9]; return [r[0], r[1]]; };
const pageUrl = (d, n) => (D.job && D.job.id === d.id && D.local.get(n)) || `/api/meet/${S().id}/doc/${d.id}/${n}`;
/** Image de la page affichée, une fois chargée (pour l'enregistrement de la réunion) */
export function docImage() { const im = $('#mtDocImg'); return im && im.complete && im.naturalWidth && !im.classList.contains('wait') ? im : null; }

/* ---------------- fenêtre « Présenter » ---------------- */
export function presentSheet({ canShare, share }) {
  closeSheet();
  const sound = ls.get('tx_share_sound', false) === true;
  const el = document.createElement('div');
  el.className = 'ps-wrap'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Présenter');
  el.innerHTML = `<div class="ps-card">
    <div class="ps-head"><b>Présenter</b><button type="button" class="icon-btn" data-x aria-label="Fermer">${icon('x')}</button></div>
    ${canShare ? `<button type="button" class="ps-opt" id="psScreen"><span class="ps-ico">${icon('screen')}</span><span class="ps-txt"><b>Partager mon écran</b><small>Un onglet, une fenêtre ou tout l'écran</small></span>${icon('arrow-right', 'sm')}</button>
    <label class="ps-sound"><input type="checkbox" id="psSound" ${sound ? 'checked' : ''}><span class="ps-check" aria-hidden="true"></span><span><b>🔊 Partager aussi le son</b><small>Vidéo, musique, extrait audio. Choisissez un onglet Chrome, ou l'écran entier sous Windows.</small></span></label>` : ''}
    ${staff() ? `<button type="button" class="ps-opt hot" id="psFile"><span class="ps-ico">${icon('doc')}</span><span class="ps-txt"><b>Présenter un fichier <em>Nouveau</em></b><small>PDF, PowerPoint, Word ou images : affiché net chez tout le monde, sans quitter la réunion</small></span>${icon('arrow-right', 'sm')}</button>
    <input type="file" id="psInput" hidden multiple accept=".pdf,application/pdf,.ppt,.pptx,.pps,.ppsx,.odp,.doc,.docx,.odt,.rtf,image/*">
    <div class="ps-drop" id="psDrop">${icon('upload', 'sm')}ou glissez le fichier ici</div>` : ''}
    ${docOn() && staff() ? `<p class="ps-tip">${icon('doc', 'sm')}<span>« ${esc(doc().name)} » est déjà présenté : un nouveau fichier le remplacera.</span></p>` : ''}
  </div>`;
  document.body.appendChild(el); D.sheet = el;
  requestAnimationFrame(() => el.classList.add('open'));
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-x]')) closeSheet(); });
  const k = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', k); el._k = k;
  const sc = $('#psScreen', el);
  if (sc) sc.onclick = () => { const w = $('#psSound', el).checked; ls.set('tx_share_sound', w); closeSheet(); share(w); };
  const f = $('#psFile', el), inp = $('#psInput', el);
  if (f) {
    f.onclick = () => inp.click();
    inp.onchange = () => { const files = [...inp.files]; closeSheet(); if (files.length) presentFiles(files); };
    const dz = $('#psDrop', el);
    ['dragover', 'dragenter'].forEach(ev => el.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('on'); }));
    el.addEventListener('dragleave', (e) => { if (e.target === el) dz.classList.remove('on'); });
    el.addEventListener('drop', (e) => { e.preventDefault(); const files = [...(e.dataTransfer && e.dataTransfer.files || [])]; closeSheet(); if (files.length) presentFiles(files); });
  }
  setTimeout(() => (sc || f || el).focus && (sc || f).focus(), 60);
}
function closeSheet() {
  const el = D.sheet; if (!el) return; D.sheet = null;
  document.removeEventListener('keydown', el._k);
  el.classList.remove('open'); setTimeout(() => el.remove(), 220);
}

/* ---------------- préparation du fichier (enseignant) ---------------- */
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) pdfjsP = import(PDFJS + 'pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; }).catch(e => { pdfjsP = null; throw e; });
  return pdfjsP;
}
const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isImg = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);

/** Petit panneau de progression, en bas de l'écran, pendant la préparation */
function progress(text, pct) {
  let el = $('#docProg');
  if (text == null) { if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 400); } return; }
  if (!el) { el = document.createElement('div'); el.id = 'docProg'; el.className = 'doc-prog'; el.setAttribute('role', 'status'); el.innerHTML = '<span class="doc-spin"></span><span class="doc-prog-t"></span><i><b></b></i>'; document.body.appendChild(el); }
  el.querySelector('.doc-prog-t').textContent = text;
  el.querySelector('b').style.width = Math.round((pct || 0) * 100) + '%';
}

export async function presentFiles(files) {
  if (!staff()) return toast('Seul l\'enseignant peut présenter un fichier.', 'warn');
  const f0 = files[0];
  let src = null;                                   // { n, dims, render(i) → Blob, name, file }
  try {
    if (files.length > 1 || isImg(f0)) {
      const imgs = files.filter(isImg).slice(0, 200);
      if (!imgs.length) return toast('Choisissez un PDF, un PowerPoint ou des images.', 'warn');
      progress('Lecture des images…', 0);
      src = await fromImages(imgs);
    } else if (isPdf(f0)) {
      progress('Ouverture du PDF…', 0);
      src = await fromPdf(await f0.arrayBuffer(), f0.name, f0);
    } else if (OFFICE.test(f0.name)) {
      progress('Conversion de « ' + f0.name + ' »…', 0.05);
      const pdf = await convert(f0);
      if (!pdf) { progress(null); return; }
      progress('Ouverture du document…', 0.1);
      src = await fromPdf(pdf, f0.name, f0);
    } else { return toast('Format non pris en charge : PDF, PowerPoint, Word ou images.', 'warn'); }
  } catch (e) {
    progress(null);
    return toast(e && e.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe.' : 'Impossible de lire ce fichier. ' + (e && e.message ? '(' + e.message + ')' : ''), 'error', { duration: 7000 });
  }
  if (src.n > 200) toast('Seules les 200 premières pages seront présentées.', 'info');
  src.n = Math.min(src.n, 200);
  await start(src);
}

async function fromPdf(data, name, file) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(data), cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/', isEvalSupported: false }).promise;
  const n = Math.min(pdf.numPages, 200), dims = [];
  for (let i = 1; i <= n; i++) { const vp = (await pdf.getPage(i)).getViewport({ scale: 1 }); dims.push([Math.round(vp.width), Math.round(vp.height)]); }
  return {
    n, dims, name: name.replace(/\.[^.]+$/, ''), file, close: () => pdf.destroy(),
    async render(i) {
      const page = await pdf.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const k = Math.min(MAX_W / vp1.width, 2400 / vp1.height, 4);
      const vp = page.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      page.cleanup();
      return toJpeg(c);
    }
  };
}
async function fromImages(files) {
  const bms = [];
  for (const f of files) {
    try { bms.push(await createImageBitmap(f)); }
    catch (e) { toast('Image illisible ignorée : ' + f.name + (/hei[cf]$/i.test(f.name) ? ' (HEIC : envoyez-la en JPEG)' : ''), 'warn'); }
  }
  if (!bms.length) throw new Error('aucune image lisible');
  return {
    n: bms.length, dims: bms.map(b => [b.width, b.height]), name: files.length > 1 ? files.length + ' images' : files[0].name.replace(/\.[^.]+$/, ''), file: files.length === 1 ? files[0] : null,
    close: () => bms.forEach(b => b.close && b.close()),
    async render(i) {
      const b = bms[i], k = Math.min(1, MAX_W / b.width, 2400 / b.height);
      const c = document.createElement('canvas'); c.width = Math.round(b.width * k); c.height = Math.round(b.height * k);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(b, 0, 0, c.width, c.height);
      return toJpeg(c);
    }
  };
}
const toJpeg = (c) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', 0.86));

/** PowerPoint, Word… : le serveur le convertit en PDF (s'il a LibreOffice) */
async function convert(file) {
  if (file.size > 60 * 1024 * 1024) { toast('Fichier trop lourd (60 Mo au maximum).', 'warn'); return null; }
  let r;
  try { r = await fetch(`/api/meet/${S().id}/convert`, { method: 'POST', headers: { 'X-Meet-Token': S().token, 'X-File-Ext': file.name.split('.').pop(), 'Content-Type': 'application/octet-stream' }, body: file }); }
  catch (e) { toast('Connexion impossible. Vérifiez votre réseau.', 'error'); return null; }
  if (r.ok) return r.arrayBuffer();
  const j = await r.json().catch(() => ({}));
  progress(null);
  const ppt = /\.(pptx?|ppsx?|odp)$/i.test(file.name);
  await modal({
    title: ppt ? 'Présenter un PowerPoint' : 'Présenter ce document',
    body: `<p class="muted">${j.code === 'no_office' ? 'Ce serveur ne sait pas encore ouvrir ' + (ppt ? 'les PowerPoint' : 'ce format') + ' directement.' : 'Ce fichier n\'a pas pu être converti.'} Il suffit de l'enregistrer en <b>PDF</b> (10 secondes) :</p>
      <ol class="doc-howto"><li>Dans ${ppt ? 'PowerPoint' : 'Word'} : <b>Fichier › Enregistrer sous</b> (ou <b>Exporter</b>)</li><li>Choisissez le type <b>PDF</b></li><li>Revenez ici : <b>Présenter › Présenter un fichier</b> et choisissez le PDF</li></ol>
      <p class="small faint">Sur téléphone : ouvrez le fichier, puis <b>Partager › Imprimer › Enregistrer en PDF</b>.</p>`,
    actions: [{ label: 'Compris', cls: 'primary', value: true }]
  });
  return null;
}

/** Création du fichier sur le serveur puis envoi des pages, la page affichée en priorité */
async function start(src) {
  const s = S();
  if (D.job) stopJob();
  let r;
  try {
    const res = await fetch(`/api/meet/${s.id}/doc`, { method: 'POST', headers: { 'X-Meet-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: src.name, n: src.n, dims: src.dims }) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'Envoi impossible');
  } catch (e) { progress(null); src.close && src.close(); return toast(e.message, 'error'); }
  D.local.forEach(u => URL.revokeObjectURL(u)); D.local.clear(); D.missing.clear(); D.view = null;
  const job = D.job = { id: r.id, src, done: new Set(), want: 0, stop: false, fails: 0 };
  X.track && X.track('use', { m: 'meet-doc' });
  progress(`Préparation de la page 1 sur ${src.n}…`, 0);
  while (!job.stop && job.done.size < src.n) {
    const d = doc(), cur = d && d.id === job.id ? d.page : 0;
    let i = -1;
    for (let k = 0; k < src.n; k++) { const c = (cur + k) % src.n; if (!job.done.has(c)) { i = c; break; } }
    if (i < 0) break;
    try {
      const blob = await src.render(i);
      if (job.stop) break;
      D.local.set(i, URL.createObjectURL(blob));
      const up = await fetch(`/api/meet/${s.id}/doc/${job.id}/${i}`, { method: 'PUT', headers: { 'X-Meet-Token': s.token, 'Content-Type': 'image/jpeg' }, body: blob });
      if (up.status === 409) break;                 // remplacé par un autre fichier
      if (!up.ok) { const j = await up.json().catch(() => ({})); throw new Error(j.error || 'Envoi de la page ' + (i + 1) + ' impossible'); }
      job.done.add(i); job.fails = 0;
      if (job.done.size === 1) { toast(`📄 « ${src.name} » est à l'écran pour tout le monde`, 'success', { duration: 3500 }); setTimeout(() => T.inkOpen(true), 400); }
      progress(job.done.size < src.n ? `Envoi des pages : ${job.done.size} sur ${src.n}` : 'Toutes les pages sont prêtes', job.done.size / src.n);
      docDraw();
    } catch (e) {
      if (++job.fails > 3) { toast(e.message || 'Envoi interrompu', 'error', { duration: 7000 }); break; }
      await new Promise(res => setTimeout(res, 1500 * job.fails));
    }
  }
  setTimeout(() => progress(null), 900);
  src.close && src.close();
  // Fichier d'origine : les élèves pourront le télécharger si l'enseignant l'autorise
  if (!job.stop && src.file && src.file.size <= 60 * 1024 * 1024 && D.job === job) {
    fetch(`/api/meet/${s.id}/doc/${job.id}/file`, { method: 'PUT', headers: { 'X-Meet-Token': s.token, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(src.file.name) }, body: src.file }).catch(() => {});
  }
}
function stopJob() { if (D.job) { D.job.stop = true; D.job = null; } }

/* ---------------- navigation ---------------- */
export function go(n) {
  const d = doc(); if (!d) return;
  n = Math.max(0, Math.min(d.n - 1, n));
  if (staff()) { if (n !== d.page) S().socket.emit('meet-host', { action: 'docPage', value: n }); d.page = n; D.view = null; }
  else if (d.free) { D.view = n === d.page ? null : n; }
  else return;
  docDraw(); T.inkRefresh();
}
const step = (k) => go(shownPage() + k);
function backToLive() { D.view = null; docDraw(); T.inkRefresh(); }

/* ---------------- affichage dans la scène ---------------- */
export function docDraw() {
  const st = $('#mtStage'); if (!st) return;
  const d = doc();
  st.classList.toggle('doc', !!d);
  let bar = $('#mtDocBar');
  const board = $('#mtBoard');
  if (!d) {
    if (bar) bar.remove();
    const im = $('#mtDocImg'); if (im) im.remove();
    closeThumbs(); D.view = null;
    return;
  }
  if (D.view != null && (!d.free || D.view >= d.n)) D.view = null;
  const n = shownPage();
  // Image de la page, posée dans le cadre du tableau blanc (même place que les annotations)
  if (board) {
    let im = $('#mtDocImg');
    if (!im) { im = document.createElement('img'); im.id = 'mtDocImg'; im.className = 'doc-img'; im.alt = ''; im.decoding = 'async'; im.draggable = false; board.appendChild(im); im.onload = () => { im.classList.remove('wait'); T.inkRefresh(); }; im.onerror = () => { im.classList.add('wait'); D.missing.add(im.dataset.key); }; }
    const key = d.id + '/' + n, url = pageUrl(d, n);
    if (im.dataset.key !== key || (im.classList.contains('wait') && !D.missing.has(key))) { im.dataset.key = key; im.classList.add('wait'); im.src = url; }
    // Pages voisines chargées d'avance : la suivante s'affiche sans attendre
    [n + 1, n + 2, n - 1].forEach(k => { if (k >= 0 && k < d.n && !(D.job && D.local.get(k))) { const p = new Image(); p.src = pageUrl(d, k); } });
  }
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'mtDocBar'; bar.className = 'doc-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Pages du fichier présenté');
    st.appendChild(bar);
    bar.addEventListener('click', onBar);
    bindSwipe(st);
  }
  const me = staff(), nav = me || d.free, live = n === d.page;
  const b = (id, ic, label, cls = '') => `<button type="button" class="db ${cls}" data-a="${id}" aria-label="${esc(label)}" title="${esc(label)}">${ic}</button>`;
  bar.innerHTML = `
    ${nav ? b('prev', icon('arrow-left', 'sm'), 'Page précédente', n <= 0 ? 'dis' : '') : ''}
    <button type="button" class="db-page" data-a="thumbs" title="Toutes les pages">${me || d.free ? '' : '<span class="db-lock">Page </span>'}<b>${n + 1}</b><span>/ ${d.n}</span></button>
    ${nav ? b('next', icon('arrow-right', 'sm'), 'Page suivante', n >= d.n - 1 ? 'dis' : '') : ''}
    ${!me && d.free && !live ? `<button type="button" class="db-live" data-a="live">${icon('refresh', 'sm')}Revenir à la page ${d.page + 1} de l'enseignant</button>` : ''}
    ${me ? `<i class="db-sep"></i>
      ${b('free', T.svg('free'), d.free ? 'Navigation libre : activée (les élèves tournent les pages eux-mêmes)' : 'Laisser les élèves tourner les pages', d.free ? 'on' : '')}
      ${d.file ? b('dl', icon('download', 'sm'), d.dl ? 'Support téléchargeable : activé' : 'Autoriser le téléchargement du support', d.dl ? 'on' : '') : ''}
      ${b('close', icon('x', 'sm'), 'Arrêter la présentation du fichier', 'stop')}` : ''}
    ${!me && d.dl ? `<a class="db dl" href="/api/meet/${S().id}/doc/${d.id}/file" download title="Télécharger le support du cours" aria-label="Télécharger le support du cours">${icon('download', 'sm')}</a>` : ''}`;
  if (D.thumbs) drawThumbs();
  const lbl = $('#mtStageL'); if (lbl && !st.classList.contains('hidden')) lbl.innerHTML = `${icon('doc', 'sm')} ${esc(d.name)}${!live ? ' <em class="db-free">lecture libre</em>' : ''}`;
}
async function onBar(e) {
  const t = e.target.closest('[data-a]'); if (!t) return;
  const d = doc(); if (!d) return;
  const a = t.dataset.a;
  if (a === 'prev') step(-1);
  else if (a === 'next') step(1);
  else if (a === 'live') backToLive();
  else if (a === 'thumbs') { D.thumbs ? closeThumbs() : openThumbs(); }
  else if (a === 'free') { S().socket.emit('meet-host', { action: 'docFree', value: !d.free }); toast(!d.free ? '📖 Les élèves peuvent feuilleter le fichier ; un bouton les ramène à votre page.' : 'Tout le monde suit à nouveau votre page', 'info', { duration: 3500 }); }
  else if (a === 'dl') { S().socket.emit('meet-host', { action: 'docDl', value: !d.dl }); toast(!d.dl ? '⬇️ Les élèves peuvent télécharger le support' : 'Téléchargement du support désactivé', 'info', { duration: 3000 }); }
  else if (a === 'close') {
    if (!(await modal({ title: 'Arrêter la présentation ?', body: `<p class="muted">« ${esc(d.name)} » disparaîtra de l'écran de tout le monde, avec ses annotations.</p>`, actions: [{ label: 'Annuler', cls: 'ghost', value: false }, { label: 'Arrêter', cls: 'danger', value: true }] }))) return;
    stopJob(); progress(null);
    S().socket.emit('meet-host', { action: 'docClose' });
  }
}

/* Vignettes de toutes les pages */
function openThumbs() { D.thumbs = true; drawThumbs(); }
function closeThumbs() { D.thumbs = false; const el = $('#mtThumbs'); if (el) el.remove(); }
function drawThumbs() {
  const d = doc(), st = $('#mtStage'); if (!d || !st) return closeThumbs();
  let el = $('#mtThumbs');
  if (!el) {
    el = document.createElement('div'); el.id = 'mtThumbs'; el.className = 'doc-thumbs';
    el.addEventListener('click', (e) => { const t = e.target.closest('[data-n]'); if (t) { go(+t.dataset.n); closeThumbs(); } else if (e.target === el || e.target.closest('[data-x]')) closeThumbs(); });
    st.appendChild(el);
  }
  const n = shownPage(), nav = staff() || d.free;
  if (el.dataset.k === d.id + '/' + n + '/' + nav) return;
  el.dataset.k = d.id + '/' + n + '/' + nav;
  el.innerHTML = `<div class="dt-head"><b>${esc(d.name)}</b><span>${d.n} page${d.n > 1 ? 's' : ''}</span><button type="button" class="icon-btn" data-x aria-label="Fermer">${icon('x')}</button></div>
    <div class="dt-grid">${Array.from({ length: d.n }, (_, i) => `<button type="button" class="dt ${i === n ? 'cur' : ''} ${i === d.page ? 'live' : ''}" ${nav ? `data-n="${i}"` : 'disabled'} style="aspect-ratio:${d.dims[i][0]} / ${d.dims[i][1]}"><img loading="lazy" alt="" src="${pageUrl(d, i)}" onerror="this.style.visibility='hidden'"><span>${i + 1}</span></button>`).join('')}</div>`;
  const cur = el.querySelector('.dt.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
}

/* Clavier (flèches, Page suivante / précédente) et balayage sur téléphone */
document.addEventListener('keydown', (e) => {
  const d = doc(); if (!d || !(staff() || d.free) || e.ctrlKey || e.metaKey || e.altKey) return;
  const tg = e.target; if (tg && (/input|textarea|select/i.test(tg.tagName) || tg.isContentEditable)) return;
  const st = $('#mtStage'); if (!st || st.classList.contains('hidden') || D.sheet) return;
  if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && staff())) { e.preventDefault(); step(1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); step(-1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(d.n - 1); }
});
function bindSwipe(st) {
  if (st._swipe) return; st._swipe = true;
  st.addEventListener('touchstart', (e) => { if (e.touches.length === 1 && !T.inkIsOpen()) D.swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; else D.swipe = null; }, { passive: true });
  st.addEventListener('touchend', (e) => {
    const s = D.swipe; D.swipe = null; const d = doc();
    if (!s || !d || !(staff() || d.free) || T.inkIsOpen() || Date.now() - s.t > 700) return;
    const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ---------------- messages du serveur ---------------- */
/** Une page vient d'arriver sur le serveur : on recharge celle qui attendait */
export function onReady({ id, n }) {
  const d = doc(); if (!d || d.id !== id) return;
  d.ready = Math.max(d.ready || 0, n + 1);
  D.missing.delete(id + '/' + n);
  if (n === shownPage()) { const im = $('#mtDocImg'); if (im && im.classList.contains('wait')) { im.dataset.key = ''; docDraw(); } }
  if (D.thumbs) { const el = $('#mtThumbs'); if (el) { el.dataset.k = ''; drawThumbs(); } }
}
/** Nouvel état du fichier (page, navigation libre, téléchargement) : vrai si l'affichage doit changer */
export function onInfo(prev, cur) {
  const a = prev && prev.doc, b = cur && cur.doc;
  if (!a && !b) return false;
  if (a && b && a.id === b.id && a.page === b.page && a.free === b.free && a.dl === b.dl && a.file === b.file) return false;
  if (a && b && a.id === b.id && a.page !== b.page && D.view === b.page) D.view = null;
  if (a && b && a.id === b.id && !staff() && b.free && !a.free) toast('📖 Vous pouvez feuilleter le fichier vous-même', 'info', { duration: 3500 });
  if (a && b && a.id === b.id && !staff() && b.dl && !a.dl) toast('⬇️ Le support du cours est téléchargeable', 'info', { duration: 4000, action: 'Télécharger', onAction: () => { const l = document.createElement('a'); l.href = `/api/meet/${S().id}/doc/${b.id}/file`; l.download = ''; document.body.appendChild(l); l.click(); l.remove(); } });
  if (!b && a && D.job && D.job.id === a.id) { stopJob(); progress(null); }
  if (!a || !b || a.id !== b.id) { D.view = null; D.missing.clear(); closeThumbs(); }
  return true;
}
export function docReset() { stopJob(); progress(null); closeSheet(); closeThumbs(); D.view = null; D.local.forEach(u => URL.revokeObjectURL(u)); D.local.clear(); }
