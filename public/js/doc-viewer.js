/* Lestha Send — Aperçu des documents (3.24).
   PDF, Word, Excel, PowerPoint, CSV et texte s'ouvrent dans la page, avant tout téléchargement.
   - PDF : seules les pages regardées sont chargées (lecture par morceaux), affichées au fil du défilement ;
   - Word, Excel, PowerPoint : lus par le navigateur, sans passer par le serveur ;
   - texte / CSV : seulement le début du fichier ;
   - anciens formats (.doc, .xls, .ppt, OpenDocument) : version PDF préparée par le serveur, s'il en est capable. */
import { esc, icon, bytes, toast } from './core.js';
import { pushOverlay, popOverlay } from './router.js';
import { loadZip, loadScript, extOf, readSheets, parseCsv, readSlides, slideHtml, colName } from './doc-office.js';

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
 * @param {object} o.file           { id, name, size, type }
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
    <div class="dv-body" tabindex="-1"><div class="dv-wait"><span class="spinner lg"></span><p class="dv-msg">Ouverture du document…</p><div class="dv-bar"><i></i></div></div></div>
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

  (async () => {
    try {
      const info = await o.info(false);
      const src = info.url || o.rawUrl();
      const size = info.size || f.size;
      if (kind === 'pdf') return await showPdf(src, size);
      if (kind === 'text' || kind === 'csv') return await showText(src, size, kind);
      if (kind === 'legacy') return await showConverted(info);
      if (size > FULL_MAX) return fail(`Ce document est trop lourd pour l'aperçu sur téléphone (${bytes(size)}).`);
      const buf = await getAll(src, size, ctl.signal, progress);
      if (kind === 'docx') return await showDocx(buf);
      if (kind === 'sheet') return await showSheets(buf);
      if (kind === 'pptx') return await showSlides(buf);
    } catch (e) {
      if (ctl.signal.aborted) return;
      console.warn('aperçu', e);
      fail(e && e.name === 'PasswordException' ? 'Ce document est protégé par un mot de passe.' : 'Impossible d\'afficher l\'aperçu de ce document sur cet appareil.');
    }
  })();

  /* ---------- PDF : pages chargées et dessinées à la demande ---------- */
  async function showPdf(url, size) {
    const lib = await pdfjs();
    let task;
    const opts = { cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/', isEvalSupported: false, enableXfa: false };
    // Petit PDF : une seule requête (le plus rapide en 4G). Gros PDF : seulement les morceaux utiles.
    const first = size <= 4 * 1024 * 1024 ? { buf: new Uint8Array(await getAll(url, size, ctl.signal, progress)), full: true } : await getRange(url, 0, 128 * 1024 - 1, ctl.signal);
    if (first.full || first.buf.length >= size) task = lib.getDocument(Object.assign({ data: first.buf }, opts));
    else {
      const tr = new lib.PDFDataRangeTransport(size, first.buf);
      let loaded = first.buf.length;
      tr.requestDataRange = (begin, end) => {
        getRange(url, begin, end - 1, ctl.signal).then(r => {
          loaded += r.buf.length;
          tr.onDataRange(begin, r.full ? r.buf.subarray(begin, end) : r.buf);
        }).catch(() => { /* page manquante : pdf.js redemandera */ });
      };
      task = lib.getDocument(Object.assign({ range: tr, rangeChunkSize: 16 * 1024,   // petits morceaux : pdf.js lit chaque page de l'index, souvent dispersées dans le fichier
        disableAutoFetch: true, disableStream: true }, opts));
    }
    const pdf = await task.promise;
    cleanups.push(() => pdf.destroy());
    const n = Math.min(pdf.numPages, 500);
    const p1 = await pdf.getPage(1), vp1 = p1.getViewport({ scale: 1 });
    body.innerHTML = `<div class="dv-pages">${Array.from({ length: n }, (_, i) => `<div class="dv-page" data-p="${i + 1}" style="aspect-ratio:${vp1.width}/${vp1.height}"><span class="dv-pn">${i + 1}</span></div>`).join('')}</div>${pdf.numPages > n ? `<p class="dv-note">Aperçu limité aux ${n} premières pages sur ${pdf.numPages}.</p>` : ''}`;
    const pages = body.querySelector('.dv-pages');
    foot.hidden = false;
    const drawn = new Map();   // page → largeur dessinée
    const busy = new Set();
    let current = 1;
    async function draw(el) {
      const i = Number(el.dataset.p);
      const want = Math.round(el.clientWidth * Math.min(2, window.devicePixelRatio || 1));
      if (busy.has(i) || (drawn.get(i) || 0) >= want * 0.95) return;
      busy.add(i);
      try {
        const page = await pdf.getPage(i);
        const v1 = page.getViewport({ scale: 1 });
        el.style.aspectRatio = `${v1.width}/${v1.height}`;
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
        // Mémoire des téléphones : on oublie les pages loin de celle qu'on lit
        if (drawn.size > 14) for (const [j] of [...drawn].sort((a, b) => Math.abs(b[0] - current) - Math.abs(a[0] - current)).slice(0, drawn.size - 14)) {
          const pe = pages.children[j - 1]; const cv = pe && pe.querySelector('canvas');
          if (cv) { cv.width = cv.height = 0; cv.remove(); pe.classList.remove('ok'); } drawn.delete(j);
        }
      } catch (e) { /* la page sera retentée en revenant dessus */ } finally { busy.delete(i); }
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) draw(e.target);
    }, { root: body, rootMargin: '900px 0px' });
    Array.from(pages.children).forEach(p => io.observe(p));
    cleanups.push(() => io.disconnect());
    const counter = () => {
      const mid = body.scrollTop + body.clientHeight / 3;
      let i = 1; for (const p of pages.children) { if (p.offsetTop <= mid) i = Number(p.dataset.p); else break; }
      current = i; foot.textContent = `Page ${i} / ${pdf.numPages}`;
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
  async function showSheets(buf) {
    msg('Lecture du classeur…');
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(buf);
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

  /* ---------- PowerPoint (.pptx) ---------- */
  async function showSlides(buf) {
    msg('Préparation des diapositives…');
    const JSZip = await loadZip();
    const zip = await JSZip.loadAsync(buf);
    const deck = await readSlides(zip, { max: 150 });
    cleanups.push(() => deck.close());
    if (!deck.slides.length) return fail('Cette présentation ne contient aucune diapositive.');
    body.innerHTML = `<div class="dv-slides">${deck.slides.map((s, i) => `<div class="dv-slide" data-n="${i + 1}"><div class="dv-slide-in">${slideHtml(s, deck.w, deck.h, esc)}</div></div>`).join('')}</div>${deck.total > deck.slides.length ? `<p class="dv-note">Aperçu limité aux ${deck.slides.length} premières diapositives sur ${deck.total}.</p>` : ''}<p class="dv-note">Aperçu simplifié : animations, graphiques et certaines polices ne sont pas reproduits.</p>`;
    const list = body.querySelector('.dv-slides');
    // Sur ordinateur, une diapositive entière tient dans la hauteur de l'écran
    list.style.maxWidth = Math.max(320, Math.min(1100, (innerHeight - 90) * deck.w / deck.h)) + 'px';
    const fit = () => {
      const w = list.clientWidth;
      list.querySelectorAll('.dv-slide').forEach(el => {
        const k = w / deck.w;
        el.style.height = (deck.h * k) + 'px';
        el.firstElementChild.style.transform = `scale(${k})`;
      });
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(body); cleanups.push(() => ro.disconnect());
    foot.hidden = false;
    const counter = () => {
      const mid = body.scrollTop + body.clientHeight / 3; let i = 1;
      for (const s of list.children) { if (s.offsetTop <= mid) i = Number(s.dataset.n); else break; }
      foot.textContent = `Diapositive ${i} / ${deck.total}`;
    };
    body.addEventListener('scroll', counter, { passive: true }); counter();
    enableZoom((z) => { if (z > 1) list.style.maxWidth = 'none'; list.style.width = (z * 100) + '%'; fit(); });
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
