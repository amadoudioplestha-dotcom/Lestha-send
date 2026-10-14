/* Lestha Send — Aperçu des documents (3.24).
   PDF, Word, Excel, PowerPoint, CSV et texte s'ouvrent dans la page, avant tout téléchargement.
   - PDF : seules les pages regardées sont chargées (lecture par morceaux), affichées au fil du défilement ;
   - Word, Excel, PowerPoint : lus par le navigateur, sans passer par le serveur ;
   - texte / CSV : seulement le début du fichier ;
   - anciens formats (.doc, .xls, .ppt, OpenDocument) : version PDF préparée par le serveur, s'il en est capable. */
import { esc, icon, bytes, toast } from './core.js';
import { pushOverlay, popOverlay } from './router.js';
import { loadZip, loadScript, extOf, readSheets, parseCsv, readSlides, slideHtml, colName } from './doc-office.js';
import { openRangeZip, canRangeZip, isLightPart } from './zip-range.js';

const PDFJS = '/vendor/pdfjs/';
const TEXT_MAX = 256 * 1024;      // début d'un fichier texte affiché
const FULL_MAX = 30 * 1024 * 1024; // Word / Excel / PowerPoint lus en entier : au-delà, trop lourd pour un téléphone

const KINDS = {
  pdf: /^(pdf)$/, docx: /^(docx|docm|dotx)$/, sheet: /^(xlsx|xlsm|ods)$/, pptx: /^(pptx|ppsx)$/,
  csv: /^(csv|tsv)$/, text: /^(txt|md|json|xml|log)$/, legacy: /^(doc|xls|ppt|pps|odt|odp|rtf)$/
};
/** Type d'aperçu d'un fichier, ou null */
export function docKind(f) {
  const ext = extOf(f.name);
  if (/pdf/i.test(f.type || '')) return 'pdf';
  for (const [k, re] of Object.entries(KINDS)) if (re.test(ext)) return k;
  return null;
}
export const canPreviewDoc = (f) => !!docKind(f) && f.size > 0 && f.size <= 60 * 1024 * 1024;
export const DOC_LABEL = { pdf: 'PDF', docx: 'Word', sheet: 'Excel', pptx: 'PowerPoint', csv: 'Tableau', text: 'Texte', legacy: 'Document' };

let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) pdfjsP = import(PDFJS + 'pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; }).catch(e => { pdfjsP = null; throw e; });
  return pdfjsP;
}

/** 3.25 : préparation au toucher du bouton « Aperçu » (avant même que le doigt se lève) */
export function warmDoc(f, pageUrl) {
  const k = docKind(f);
  if (k === 'pdf' && f.pg && f.pg.n) { for (let i = 1; i <= Math.min(2, f.pg.n); i++) { const im = new Image(); im.decoding = 'async'; im.src = pageUrl(i); } return; }
  if (k === 'pdf' || k === 'legacy') pdfjs().catch(() => {});
  else if (k === 'docx' || k === 'sheet' || k === 'pptx') loadZip().catch(() => {});
}

/* ---------------- réseau ---------------- */
async function getRange(url, start, end, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal, credentials: 'omit' });
  if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { buf, full: r.status === 200 };
}
async function getAll(url, size, signal, onProgress) {
  const r = await fetch(url, { signal, credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (!r.body || !r.body.getReader) return r.arrayBuffer();
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, size);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

/**
 * Ouvre l'aperçu d'un document.
 * @param {object} o
 * @param {object} o.file           { id, name, size, type, pg?, pgu?, thu? }
 * @param {Function} [o.pageUrl]    (i) => lien de l'image de la page i (3.25)
 * @param {string} [o.thumb]        vignette déjà affichée dans la liste : montrée tout de suite
 * @param {Function} o.info         (convert) => Promise<{ url, size, office, pdfUrl, pdfSize, conv }>
 * @param {Function} o.rawUrl       lien de secours (même site) quand le stockage n'offre pas de lien direct
 * @param {Function} [o.onDownload] bouton « Télécharger » (absent = pas de bouton)
 */
export function openDoc(o) {
  const f = o.file, kind = docKind(f);
  const ctl = new AbortController();
  const cleanups = [];
  const box = document.createElement('div');
  box.className = 'dv';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Aperçu de ' + f.name);
  box.innerHTML = `
    <div class="dv-top">
      <button type="button" class="dv-btn" data-close aria-label="Fermer">${icon('x')}</button>
      <div class="dv-title"><b>${esc(f.name)}</b><span>${DOC_LABEL[kind] || 'Document'} · ${bytes(f.size)}</span></div>
      <div class="dv-zoom" hidden><button type="button" class="dv-btn" data-z="-1" aria-label="Réduire">−</button><button type="button" class="dv-btn" data-z="1" aria-label="Agrandir">+</button></div>
      ${o.onDownload ? `<button type="button" class="btn sm primary dv-dl" data-dl>${icon('download', 'sm')}<span>Télécharger</span></button>` : ''}
    </div>
    <div class="dv-body" tabindex="-1"><div class="dv-wait">${o.thumb ? `<img class="dv-wait-th" src="${esc(o.thumb)}" alt="">` : ''}<span class="spinner lg"></span><p class="dv-msg">Ouverture du document…</p><div class="dv-bar"><i></i></div></div></div>
    <div class="dv-foot" hidden></div>`;
  document.body.appendChild(box);
  document.documentElement.classList.add('dv-open');
  const body = box.querySelector('.dv-body'), foot = box.querySelector('.dv-foot');
  requestAnimationFrame(() => box.classList.add('in'));

  let zoom = 1, onZoom = null, closed = false;
  const close = (fromBack) => {
    if (closed) return; closed = true;
    ctl.abort();
    cleanups.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('dv-open');
    box.classList.remove('in'); setTimeout(() => box.remove(), 200);
    if (!fromBack) popOverlay();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  pushOverlay(() => close(true));   // bouton Retour du téléphone : ferme l'aperçu au lieu de quitter la page

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return close();
    if (e.target.closest('[data-dl]')) return o.onDownload && o.onDownload();
    const z = e.target.closest('[data-z]');
    if (z && onZoom) { zoom = Math.max(0.5, Math.min(3, zoom * (Number(z.dataset.z) > 0 ? 1.25 : 0.8))); onZoom(zoom); }
  });

  const msg = (t) => { const m = box.querySelector('.dv-msg'); if (m) m.textContent = t; };
  const progress = (got, total) => {
    const b = box.querySelector('.dv-bar i'); if (b && total) b.style.width = Math.min(100, got / total * 100) + '%';
    msg(`Chargement… ${bytes(got)}${total ? ' / ' + bytes(total) : ''}`);
  };
  const fail = (text) => {
    body.innerHTML = `<div class="dv-fail">${icon('doc')}<p>${esc(text)}</p>${o.onDownload ? `<button type="button" class="btn primary" data-dl>${icon('download')}Télécharger le fichier</button>` : ''}</div>`;
  };
  const enableZoom = (fn) => { onZoom = fn; box.querySelector('.dv-zoom').hidden = false; };

  let infoP = null;
  const getInfo = () => (infoP = infoP || o.info(false).catch(e => { infoP = null; throw e; }));
  const getSrc = () => getInfo().then(i => i.url || o.rawUrl());

  (async () => {
    try {
      // 3.25 : PDF dont les premières pages existent en images → affichées tout de suite, comme des photos
      if (kind === 'pdf' && f.pg && f.pg.n) return await showPdf(getSrc, f.size, f.pg);
      const info = await getInfo();
      const src = info.url || o.rawUrl();
      const size = info.size || f.size;
      if (kind === 'pdf') return await showPdf(() => Promise.resolve(src), size, null);
      if (kind === 'text' || kind === 'csv') return await showText(src, size, kind);
      if (kind === 'legacy') return await showConverted(info);
      // Excel et PowerPoint : seulement les parties utiles du fichier (3.25), sinon le fichier entier
      if ((kind === 'sheet' || kind === 'pptx') && size > 1.5 * 1024 * 1024 && canRangeZip()) {   // petit fichier : une seule requête reste le plus rapide
        let zip = null;
        try {
          msg('Ouverture du document…');
          zip = await openRangeZip(src, size, ctl.signal);
          await zip.prefetch(isLightPart);
        } catch (e) { if (ctl.signal.aborted) return; console.info('lecture partielle impossible, fichier entier', e && e.message); zip = null; }
        if (zip) return kind === 'sheet' ? await showSheets(zip) : await showSlides(zip);
      }
      if (size > FULL_MAX) return fail(`Ce document est trop lourd pour l'aperçu sur téléphone (${bytes(size)}).`);
      const buf = await getAll(src, size, ctl.signal, progress);
      if (kind === 'docx') return await showDocx(buf);
      const JSZip = await loadZip();
      const zip = await JSZip.loadAsync(buf);
      if (kind === 'sheet') return await showSheets(zip);
      if (kind === 'pptx') return await showSlides(zip);
    } catch (e) {
      if (ctl.signal.aborted) return;
      console.warn('aperçu', e);
      fail(e && e.name === 'PasswordException' ? 'Ce document est protégé par un mot de passe.' : 'Impossible d\'afficher l\'aperçu de ce document sur cet appareil.');
    }
  })();

  /* ---------- PDF : pages chargées et dessinées à la demande ----------
     3.25 : les premières pages arrivent en images légères (dessinées par l'expéditeur) et s'affichent
     tout de suite ; le lecteur PDF n'est chargé que pour les pages suivantes, le zoom ou un grand écran. */
  async function showPdf(getUrl, size0, pg) {
    let pdf = null, pdfP = null, pdfFailed = false;
    const openPdf = () => pdfP || (pdfP = (async () => {
      const lib = await pdfjs();
      const url = await getUrl();
      const info = infoP ? await infoP.catch(() => null) : null;
      const size = (info && info.size) || size0;
      let task;
      const opts = { cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/', isEvalSupported: false, enableXfa: false };
      // Petit PDF : une seule requête (le plus rapide en 4G). Gros PDF : seulement les morceaux utiles.
      const first = size <= 4 * 1024 * 1024 ? { buf: new Uint8Array(await getAll(url, size, ctl.signal, pg ? () => {} : progress)), full: true } : await getRange(url, 0, 128 * 1024 - 1, ctl.signal);
      if (first.full || first.buf.length >= size) task = lib.getDocument(Object.assign({ data: first.buf }, opts));
      else {
        const tr = new lib.PDFDataRangeTransport(size, first.buf);
        tr.requestDataRange = (begin, end) => {
          getRange(url, begin, end - 1, ctl.signal).then(r => {
            tr.onDataRange(begin, r.full ? r.buf.subarray(begin, end) : r.buf);
          }).catch(() => { /* page manquante : pdf.js redemandera */ });
        };
        task = lib.getDocument(Object.assign({ range: tr, rangeChunkSize: 16 * 1024,   // petits morceaux : pdf.js lit chaque page de l'index, souvent dispersées dans le fichier
          disableAutoFetch: true, disableStream: true }, opts));
      }
      const doc = await task.promise;
      if (ctl.signal.aborted) { doc.destroy(); throw new Error('fermé'); }
      cleanups.push(() => doc.destroy());
      return (pdf = doc);
    })().catch(e => { pdfFailed = true; throw e; }));

    let total, ratio;
    if (pg) { total = pg.total || pg.n; ratio = pg.w && pg.h ? `${pg.w}/${pg.h}` : '210/297'; }
    else {
      await openPdf();
      total = pdf.numPages;
      const v = (await pdf.getPage(1)).getViewport({ scale: 1 });
      ratio = `${v.width}/${v.height}`;
    }
    const n = Math.min(total, 500), nImg = pg ? Math.min(pg.n, n) : 0;
    const imgSrc = (i) => (f.pgu && f.pgu[i - 1]) || (o.pageUrl && o.pageUrl(i)) || '';
    body.innerHTML = `<div class="dv-pages">${Array.from({ length: n }, (_, k) => {
      const i = k + 1, img = i <= nImg ? imgSrc(i) : '';
      // Page 1 : la vignette déjà en cache s'affiche immédiatement, l'image nette la remplace dès qu'elle arrive
      const ph = i === 1 && o.thumb ? ` style="aspect-ratio:${ratio};background:#fff url('${esc(o.thumb)}') center/100% no-repeat"` : ` style="aspect-ratio:${ratio}"`;
      return `<div class="dv-page${img ? ' im' : ''}" data-p="${i}"${ph}><span class="dv-pn">${i}</span>${img ? `<img class="dv-img" alt="" decoding="async" ${i <= 2 ? `src="${esc(img)}" fetchpriority="high"` : `data-src="${esc(img)}"`}>` : ''}</div>`;
    }).join('')}</div>${total > n ? `<p class="dv-note">Aperçu limité aux ${n} premières pages sur ${total}.</p>` : ''}`;
    const pages = body.querySelector('.dv-pages');
    pages.querySelectorAll('img.dv-img').forEach(im => {
      const pe = im.parentNode;
      im.onload = () => { pe.classList.add('ok'); pe.style.backgroundImage = ''; };
      im.onerror = () => { im.remove(); pe.classList.remove('im'); draw(pe); };   // image absente : le lecteur PDF dessine la page
    });
    foot.hidden = false;
    const drawn = new Map();   // page → largeur dessinée
    const busy = new Set();
    let current = 1;
    async function draw(el) {
      const i = Number(el.dataset.p);
      const want = Math.round(el.clientWidth * Math.min(2, window.devicePixelRatio || 1));
      const im = el.querySelector('img.dv-img');
      if (im) {
        if (!im.getAttribute('src')) im.src = im.dataset.src;
        // L'image suffit (téléphone, pas de zoom) : pas besoin du lecteur PDF
        if ((im.naturalWidth || 1000) >= want * 0.8) return;
      }
      if (busy.has(i) || (drawn.get(i) || 0) >= want * 0.95) return;
      busy.add(i);
      try {
        if (!pdf) {
          if (pdfFailed) { if (!im) el.querySelector('.dv-pn').textContent = 'Téléchargez le fichier pour voir cette page'; return; }
          await openPdf();
        }
        const page = await pdf.getPage(i);
        const v1 = page.getViewport({ scale: 1 });
        if (!im) el.style.aspectRatio = `${v1.width}/${v1.height}`;
        const k = Math.min(want / v1.width, Math.sqrt(8e6 / (v1.width * v1.height)));
        const vp = page.getViewport({ scale: k });
        const c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: cx, viewport: vp }).promise;
        page.cleanup();
        if (ctl.signal.aborted) return;
        el.querySelector('canvas') && el.querySelector('canvas').remove();
        el.appendChild(c); el.classList.add('ok');
        drawn.set(i, want);
        // Mémoire des téléphones : on oublie les pages loin de celle qu'on lit (l'image légère, elle, reste)
        if (drawn.size > 14) for (const [j] of [...drawn].sort((a, b) => Math.abs(b[0] - current) - Math.abs(a[0] - current)).slice(0, drawn.size - 14)) {
          const pe = pages.children[j - 1]; const cv = pe && pe.querySelector('canvas');
          if (cv) { cv.width = cv.height = 0; cv.remove(); if (!pe.querySelector('img.dv-img')) pe.classList.remove('ok'); } drawn.delete(j);
        }
      } catch (e) {
        if (pdfFailed && !im) { const pn = el.querySelector('.dv-pn'); if (pn) pn.textContent = 'Téléchargez le fichier pour voir cette page'; }
        /* sinon la page sera retentée en revenant dessus */
      } finally { busy.delete(i); }
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) draw(e.target);
    }, { root: body, rootMargin: '900px 0px' });
    Array.from(pages.children).forEach(p => io.observe(p));
    cleanups.push(() => io.disconnect());
    const counter = () => {
      const mid = body.scrollTop + body.clientHeight / 3;
      let i = 1; for (const p of pages.children) { if (p.offsetTop <= mid) i = Number(p.dataset.p); else break; }
      current = i; foot.textContent = `Page ${i} / ${total}`;
    };
    body.addEventListener('scroll', counter, { passive: true }); counter();
    enableZoom((z) => {
      const ratio = body.scrollTop / Math.max(1, body.scrollHeight);
      pages.style.width = (z * 100) + '%';
      body.scrollTop = ratio * body.scrollHeight;
      requestAnimationFrame(() => Array.from(pages.children).forEach(p => { const r = p.getBoundingClientRect(); if (r.bottom > -900 && r.top < innerHeight + 900) draw(p); }));
    });
  }

  /* ---------- Texte et CSV : le début du fichier ---------- */
  async function showText(url, size, k) {
    const r = await getRange(url, 0, Math.min(size, TEXT_MAX) - 1, ctl.signal);
    const buf = r.full ? r.buf.subarray(0, TEXT_MAX) : r.buf;
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (/�/.test(text.slice(0, 4000))) try { text = new TextDecoder('windows-1252').decode(buf); } catch (e) { /* garde l'UTF-8 */ }
    const cut = size > TEXT_MAX;
    if (k === 'csv') {
      const rows = parseCsv(cut ? text.slice(0, text.lastIndexOf('\n')) : text);
      body.innerHTML = sheetTable(rows, [], 0) + (cut ? `<p class="dv-note">Aperçu du début du fichier (${bytes(TEXT_MAX)} sur ${bytes(size)}).</p>` : '');
      return;
    }
    if (/\.json$/i.test(f.name)) try { if (!cut) text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* tel quel */ }
    body.innerHTML = `<pre class="dv-text">${esc(text)}</pre>${cut ? `<p class="dv-note">Aperçu du début du fichier (${bytes(TEXT_MAX)} sur ${bytes(size)}).</p>` : ''}`;
    let z = 1; enableZoom((v) => { z = v; body.querySelector('.dv-text').style.fontSize = (13 * z) + 'px'; });
  }

  /* ---------- Word (.docx) ---------- */
  async function showDocx(buf) {
    msg('Mise en page du document…');
    await loadZip();
    if (!window.docx) await loadScript('/vendor/docx/docx-preview.min.js');
    const wrap = document.createElement('div'); wrap.className = 'dv-docx';
    const style = document.createElement('div');
    await window.docx.renderAsync(buf, wrap, style, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: false,
      renderAltChunks: false, renderComments: false, renderChanges: false, useBase64URL: false, renderHeaders: true, renderFooters: true
    });
    // Aucun lien dangereux : seulement http(s) et e-mail, ouverts à part
    wrap.querySelectorAll('a[href]').forEach(a => { if (!/^(https?:|mailto:|#)/i.test(a.getAttribute('href') || '')) a.removeAttribute('href'); else if (!a.getAttribute('href').startsWith('#')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } });
    wrap.querySelectorAll('iframe, script, object, embed').forEach(x => x.remove());
    body.innerHTML = ''; body.append(style, wrap);
    const fit = () => {
      const page = wrap.querySelector('section.docx') || wrap.firstElementChild;
      if (!page) return;
      wrap.style.zoom = 1;
      const pw = page.offsetWidth + 24;
      const base = Math.min(1, body.clientWidth / pw);
      wrap.style.zoom = String(base * zoom);
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(body); cleanups.push(() => ro.disconnect());
    enableZoom(fit);
  }

  /* ---------- Excel (.xlsx, .ods) ---------- */
  async function showSheets(zip) {
    msg('Lecture du classeur…');
    const { sheets } = await readSheets(zip, { maxRows: 1000, maxCols: 60 });
    if (!sheets.length) return fail('Ce classeur ne contient aucune feuille visible.');
    body.innerHTML = `${sheets.length > 1 ? `<div class="dv-tabs" role="tablist">${sheets.map((s, i) => `<button type="button" class="dv-tab${i ? '' : ' on'}" data-sh="${i}" role="tab">${esc(s.name)}</button>`).join('')}</div>` : ''}<div class="dv-sheet"></div>`;
    const show = (i) => {
      const s = sheets[i];
      body.querySelectorAll('.dv-tab').forEach(t => t.classList.toggle('on', Number(t.dataset.sh) === i));
      body.querySelector('.dv-sheet').innerHTML = s.rows.length ? sheetTable(s.rows, s.merges, i) + (s.cut ? `<p class="dv-note">Aperçu limité aux 1000 premières lignes et 60 colonnes (la feuille compte ${s.nRows} lignes).</p>` : '') : '<p class="dv-note">Feuille vide.</p>';
    };
    body.addEventListener('click', (e) => { const t = e.target.closest('[data-sh]'); if (t) show(Number(t.dataset.sh)); });
    show(0);
    enableZoom((z) => { body.querySelector('.dv-sheet').style.fontSize = (13 * z) + 'px'; });
  }

  /* ---------- PowerPoint (.pptx) ----------
     3.25 : diapositives préparées par petits paquets, au fil du défilement ; avec la lecture partielle,
     les images d'une diapositive ne sont chargées qu'en arrivant dessus. */
  async function showSlides(zip) {
    msg('Préparation des diapositives…');
    const MAX = 150, BATCH = 3;
    const decks = [];
    cleanups.push(() => decks.forEach(d => d.close()));
    const first = await readSlides(zip, { max: BATCH, lazyMedia: true });
    decks.push(first);
    if (!first.total) return fail('Cette présentation ne contient aucune diapositive.');
    const W = first.w, H = first.h, total = first.total, upto = Math.min(total, MAX);
    body.innerHTML = `<div class="dv-slides"></div><div class="dv-more" hidden><span class="spinner"></span></div>${total > upto ? `<p class="dv-note">Aperçu limité aux ${upto} premières diapositives sur ${total}.</p>` : ''}<p class="dv-note">Aperçu simplifié : animations, graphiques et certaines polices ne sont pas reproduits.</p>`;
    const list = body.querySelector('.dv-slides'), more = body.querySelector('.dv-more');
    // Sur ordinateur, une diapositive entière tient dans la hauteur de l'écran
    list.style.maxWidth = Math.max(320, Math.min(1100, (innerHeight - 90) * W / H)) + 'px';
    const fitOne = (el) => { const k = list.clientWidth / W; el.style.height = (H * k) + 'px'; el.firstElementChild.style.transform = `scale(${k})`; };
    const fit = () => list.querySelectorAll('.dv-slide').forEach(fitOne);
    let shown = 0;
    // Images : chargées seulement pour les diapositives proches de l'écran, deux à la fois
    const urls = new Map(), queue = [];
    let running = 0;
    cleanups.push(() => urls.forEach(p => p.then(u => u && URL.revokeObjectURL(u))));
    const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
    const mediaOf = (path) => {
      if (!urls.has(path)) urls.set(path, new Promise((resolve) => { queue.push({ path, resolve }); pump(); }));
      return urls.get(path);
    };
    const pump = () => {
      while (running < 2 && queue.length && !ctl.signal.aborted) {
        const { path, resolve } = queue.pop(); running++;   // la dernière diapositive atteinte passe en premier
        const z = zip.file(path);
        (z ? z.async('arraybuffer').then(b => URL.createObjectURL(new Blob([b], { type: TYPES[extOf(path)] || 'application/octet-stream' }))) : Promise.resolve(null))
          .catch(() => null).then(u => { running--; resolve(u); pump(); });
      }
    };
    const fillMedia = (slide) => {
      if (slide.dataset.m) return; slide.dataset.m = '1';
      slide.querySelectorAll('img[data-zp]').forEach(im => mediaOf(im.dataset.zp).then(u => { if (u) im.src = u; }));
      const bg = slide.querySelector('[data-zbg]');
      if (bg) mediaOf(bg.dataset.zbg).then(u => { if (u) bg.style.background = `${bg.style.backgroundColor || '#fff'} url('${u}') center/cover no-repeat`; });
    };
    const mio = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) fillMedia(e.target); }, { root: body, rootMargin: '700px 0px' });
    cleanups.push(() => mio.disconnect());
    const add = (deck) => {
      const html = deck.slides.map((sl, k) => `<div class="dv-slide" data-n="${shown + k + 1}"><div class="dv-slide-in">${slideHtml(sl, W, H, esc)}</div></div>`).join('');
      list.insertAdjacentHTML('beforeend', html);
      Array.from(list.children).slice(shown).forEach(el => { fitOne(el); mio.observe(el); });
      shown += deck.slides.length;
    };
    add(first);
    const ro = new ResizeObserver(fit); ro.observe(body); cleanups.push(() => ro.disconnect());
    foot.hidden = false;
    const counter = () => {
      const mid = body.scrollTop + body.clientHeight / 3; let i = 1;
      for (const sl of list.children) { if (sl.offsetTop <= mid) i = Number(sl.dataset.n); else break; }
      foot.textContent = `Diapositive ${i} / ${total}`;
    };
    body.addEventListener('scroll', counter, { passive: true }); counter();
    enableZoom((z) => { if (z > 1) list.style.maxWidth = 'none'; list.style.width = (z * 100) + '%'; fit(); });
    // Diapositives suivantes : préparées quand on approche de la fin de celles déjà affichées
    let loading = false;
    const next = async () => {
      if (loading || shown >= upto || ctl.signal.aborted) return;
      loading = true; more.hidden = false;
      try {
        const d = await readSlides(zip, { from: shown, max: Math.min(shown < 9 ? BATCH : 6, upto - shown), lazyMedia: true });
        if (ctl.signal.aborted) return d.close();
        decks.push(d); add(d); counter();
      } catch (e) { console.warn('diapositives', e); shown = upto; }
      finally { loading = false; more.hidden = shown >= upto; if (shown < upto) requestAnimationFrame(check); }
    };
    const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) next(); }, { root: body, rootMargin: '1200px 0px' });
    io.observe(more); cleanups.push(() => io.disconnect());
    const check = () => { const r = more.getBoundingClientRect(); if (r.top < innerHeight + 1200) next(); };
    more.hidden = shown >= upto;
    if (!more.hidden) next();
  }

  /* ---------- .doc, .xls, .ppt, OpenDocument : version PDF du serveur ---------- */
  async function showConverted(info0) {
    let info = info0;
    if (!info.pdfUrl && !info.pdf) {
      if (!info.office) return fail(`L'aperçu des fichiers .${extOf(f.name)} n'est pas encore disponible. Téléchargez le fichier pour l'ouvrir.`);
      msg('Conversion du document pour l\'aperçu…');
      for (let n = 0; n < 8 && !ctl.signal.aborted; n++) {
        info = await o.info(true);
        if (info.pdf || info.conv === 'fail' || info.conv === 'none') break;
      }
    }
    if (!info.pdf) return fail('Ce document n\'a pas pu être préparé pour l\'aperçu. Téléchargez-le pour l\'ouvrir.');
    return showPdf(info.pdfUrl || o.rawUrl(info.pdf), info.pdfSize);
  }

  return { close: () => close() };
}

/** Tableau HTML d'une feuille (en-têtes A, B, C… et numéros de ligne) */
function sheetTable(rows, merges, key) {
  const nCols = Math.max(1, ...rows.map(r => r.length));
  const span = new Map(), hidden = new Set();
  for (const m of merges || []) {
    span.set(m.r + ':' + m.c, m);
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) hidden.add(r + ':' + c);
  }
  let h = `<div class="dv-grid" data-k="${key}"><table><thead><tr><th></th>${Array.from({ length: nCols }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r, ri) => {
    h += `<tr><th>${ri + 1}</th>`;
    for (let c = 0; c < nCols; c++) {
      if (hidden.has(ri + ':' + c)) continue;
      const m = span.get(ri + ':' + c), v = r[c] == null ? '' : String(r[c]);
      const num = /^-?[\d\s  ]+([,.]\d+)?( %)?$/.test(v);
      h += `<td${m ? ` rowspan="${m.rs}" colspan="${m.cs}"` : ''}${num ? ' class="n"' : ''}>${esc(v)}</td>`;
    }
    h += '</tr>';
  });
  return h + '</tbody></table></div>';
}
