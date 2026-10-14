/* Lestha Send — vignette d'un document (3.24), fabriquée sur l'appareil de l'expéditeur.
   PDF : la première page. Word, Excel, PowerPoint : l'image d'aperçu enregistrée dans le fichier,
   sinon un petit dessin de la première page (texte, tableau ou diapositive). Le destinataire voit ainsi
   le document d'un coup d'œil, comme une photo, sans rien télécharger. */
import { loadZip, extOf, docxLines, readSheets, readSlides } from './doc-office.js';

const W = 300;                    // largeur de la vignette
const PDFJS = '/vendor/pdfjs/';
let pdfjsP = null;
const pdfjs = () => (pdfjsP = pdfjsP || import(PDFJS + 'pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; }).catch(e => { pdfjsP = null; throw e; }));

/** Ordinateur avec assez de mémoire : il peut préparer l'aperçu de très gros PDF (banderoles, affiches, plans) */
const strong = () => !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) && (navigator.deviceMemory || 8) >= 4;
export const pdfMax = () => (strong() ? 300e6 : 60e6);
export const isPdfLike = (f) => /pdf/i.test(f.type || '') || /\.(pdf|ai)$/i.test(f.name || '');   // .ai d'Illustrator : lisible comme un PDF s'il a été enregistré « compatible PDF »

export const isDocFile = (f) => /pdf/i.test(f.type || '') || /\.(pdf|ai|docx|docm|dotx|odt|xlsx|xlsm|ods|csv|tsv|pptx|ppsx|odp|txt|md)$/i.test(f.name || '');

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); return [c, g]; };
const jpeg = (c, q = 0.72) => new Promise(res => c.toBlob(res, 'image/jpeg', q));

/** @returns {Promise<{ blob: Blob, w: number, h: number } | null>} */
export async function makeDocThumb(file) {
  const ext = extOf(file.name);
  if (isPdfLike(file)) return file.size < pdfMax() ? pdfThumb(file) : null;
  if (/^(txt|md|csv|tsv)$/.test(ext)) return textThumb(await file.slice(0, 6000).text(), ext);
  if (file.size > 40e6) return null;
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(file);
  // 1. image d'aperçu enregistrée par PowerPoint ou LibreOffice (celle de Word et Excel est souvent un modèle vide)
  const saved = /^(pptx|ppsx)$/.test(ext) ? ['docProps/thumbnail.jpeg', 'docProps/thumbnail.jpg', 'docProps/thumbnail.png'] : ['Thumbnails/thumbnail.png'];
  for (const p of saved) {
    const z = zip.file(p);
    if (!z) continue;
    try {
      const bm = await createImageBitmap(new Blob([await z.async('arraybuffer')]));
      if (bm.width >= 64 && bm.height >= 64 && !isBlank(bm)) return draw(bm, bm.width, bm.height);
    } catch (e) { /* format non lisible : on dessine nous-mêmes */ }
  }
  // 2. petit dessin de la première page
  if (/^(docx|docm|dotx)$/.test(ext)) return pageThumb(await docxLines(zip, 40));
  if (/^(xlsx|xlsm|ods)$/.test(ext)) { const { sheets } = await readSheets(zip, { maxRows: 24, maxCols: 8, onlyFirst: true }); return gridThumb(sheets[0] ? sheets[0].rows : []); }
  if (/^(pptx|ppsx)$/.test(ext)) { const d = await readSlides(zip, { max: 1 }); try { return d.slides[0] ? await slideThumb(d.slides[0], d.w, d.h) : null; } finally { d.close(); } }
  return null;
}

/** Image presque unie (aperçu vide d'un modèle) ? */
function isBlank(src) {
  const [c, g] = canvas(24, 24);
  g.drawImage(src, 0, 0, 24, 24);
  const d = g.getImageData(0, 0, 24, 24).data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; if (l < min) min = l; if (l > max) max = l; }
  c.width = 0;
  return max - min < 18;
}
function draw(src, sw, sh) {
  const h = Math.round(W * sh / sw);
  const [c, g] = canvas(W, Math.min(h, W * 2));
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, sw, Math.min(sh, sw * 2), 0, 0, W, Math.min(h, W * 2));
  return jpeg(c).then(blob => ({ blob, w: sw, h: sh }));
}

async function pdfThumb(file) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' }).promise;
  try {
    const page = await pdf.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (W * 1.5) / v1.width });
    const [c, g] = canvas(Math.round(vp.width), Math.round(vp.height));
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return draw(c, c.width, c.height).then(r => Object.assign(r, { w: Math.round(v1.width), h: Math.round(v1.height), pages: pdf.numPages }));
  } finally { pdf.destroy(); }
}

/**
 * Pages d'un PDF en images (3.25) : les premières pages, dessinées une fois ici, s'affichent ensuite chez
 * chaque destinataire aussi vite qu'une photo, sans charger le lecteur PDF.
 * @param {File} file
 * @param {(p: { i: number, blob: Blob, total: number, w: number, h: number }) => Promise<void>} onPage
 */
export async function pdfPages(file, onPage, { max = 10, width = 1000, onThumb = null, pages = true } = {}) {
  if (file.size > pdfMax()) return 0;   // mémoire : 60 Mo sur téléphone, 300 Mo sur ordinateur   // mémoire des petits téléphones de l'expéditeur
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' }).promise;
  let done = 0;
  try {
    for (let i = 1; i <= Math.min(pages ? max : 1, pdf.numPages); i++) {
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      // Banderole (très large ou très haute) : plus de détails sur le grand côté ; toujours ≤ 4 millions de pixels
      const ar = v1.width / v1.height, banner = ar > 1.6 || ar < 0.6;
      const k = Math.min(banner ? 2400 / Math.max(v1.width, v1.height) : width / v1.width, Math.sqrt(4e6 / (v1.width * v1.height)));
      const vp = page.getViewport({ scale: k });
      const [c, g] = canvas(Math.round(vp.width), Math.round(vp.height));
      await page.render({ canvasContext: g, viewport: vp }).promise;
      page.cleanup();
      if (i === 1 && onThumb) { const t = await draw(c, c.width, c.height); await onThumb(Object.assign(t, { w: Math.round(v1.width), h: Math.round(v1.height) })); }   // vignette tirée de la même page : le PDF n'est lu qu'une fois
      if (!pages) { c.width = c.height = 0; break; }
      let blob = await jpeg(c, 0.72);
      if (blob && blob.size > 640e3) blob = await jpeg(c, 0.55);
      if (blob && blob.size > 640e3) blob = await jpeg(c, 0.4);
      c.width = c.height = 0;
      if (!blob || blob.size > 640e3) break;   // page trop chargée : le lecteur PDF prendra le relais à partir d'ici
      await onPage({ i, blob, total: pdf.numPages, w: Math.round(v1.width), h: Math.round(v1.height) });
      done = i;
    }
  } finally { pdf.destroy(); }
  return done;
}

/** Retour à la ligne simple pour le dessin */
function wrap(g, text, max) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/)) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
function pageThumb(lines) {
  const H = Math.round(W * 1.414), m = 22;
  const [c, g] = canvas(W, H);
  let y = m + 6;
  for (const l of lines) {
    if (y > H - m) break;
    g.fillStyle = l.h ? '#111827' : '#374151';
    g.font = l.h ? 'bold 13px system-ui, sans-serif' : '9px system-ui, sans-serif';
    if (!l.t.trim()) { y += 6; continue; }
    for (const ln of wrap(g, l.t, W - 2 * m)) { if (y > H - m) break; g.fillText(ln, m, y); y += l.h ? 17 : 12; }
    y += 3;
  }
  return jpeg(c).then(blob => ({ blob, w: 794, h: 1123 }));
}
function textThumb(text, ext) {
  if (/^(csv|tsv)$/.test(ext)) {
    const sep = (text.split('\n')[0].match(/[;\t,]/g) || [','])[0];
    return gridThumb(text.split(/\r?\n/).slice(0, 24).map(r => r.split(sep).map(x => x.replace(/^"|"$/g, ''))));
  }
  const H = Math.round(W * 1.414), m = 18;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#374151'; g.font = '9px ui-monospace, Menlo, monospace';
  let y = m + 4;
  for (const l of text.split(/\r?\n/)) { if (y > H - m) break; g.fillText(l.slice(0, 60), m, y); y += 11; }
  return jpeg(c).then(blob => ({ blob, w: 794, h: 1123 }));
}
function gridThumb(rows) {
  const H = Math.round(W * 0.9), cw = 64, rh = 16, x0 = 22, y0 = 16;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#f1f5f9'; g.fillRect(0, 0, W, y0); g.fillRect(0, 0, x0, H);
  g.strokeStyle = '#d1d5db'; g.lineWidth = 1;
  for (let x = x0; x < W; x += cw) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = y0; y < H; y += rh) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  g.font = '9px system-ui, sans-serif';
  rows.slice(0, Math.floor((H - y0) / rh)).forEach((r, ri) => {
    (r || []).slice(0, Math.ceil((W - x0) / cw)).forEach((v, ci) => {
      if (v == null || v === '') return;
      g.fillStyle = ri === 0 ? '#111827' : '#374151';
      g.font = (ri === 0 ? 'bold ' : '') + '9px system-ui, sans-serif';
      let s = String(v); while (s.length > 1 && g.measureText(s).width > cw - 6) s = s.slice(0, -1);
      g.fillText(s, x0 + ci * cw + 3, y0 + ri * rh + 11);
    });
  });
  return jpeg(c).then(blob => ({ blob, w: 1000, h: 900 }));
}
async function slideThumb(s, SW, SH) {
  const k = W / SW, H = Math.round(SH * k);
  const [c, g] = canvas(W, H);
  if (s.bg && s.bg[0] === '#') { g.fillStyle = s.bg; g.fillRect(0, 0, W, H); }
  const img = (src) => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  if (s.bgImg) { const i = await img(s.bgImg); if (i) g.drawImage(i, 0, 0, W, H); }
  for (const it of s.items) {
    const x = it.x * k, y = it.y * k, w = it.w * k, h = it.h * k;
    if (it.kind === 'pic') { const i = await img(it.src); if (i) try { g.drawImage(i, x, y, w, h); } catch (e) { /* image illisible */ } continue; }
    if (it.kind !== 'sp') continue;
    if (it.fill && it.fill[0] === '#') { g.fillStyle = it.fill; g.fillRect(x, y, w, h); }
    if (!it.text) continue;
    let ty = y + 2;
    for (const p of it.text.paras) {
      const r0 = p.runs.find(r => r.t) || {};
      const fs = Math.max(5, (r0.sz || p.sz || 18) * 96 / 72 * k);
      g.font = `${r0.b ? 'bold ' : ''}${fs}px system-ui, sans-serif`;
      g.fillStyle = r0.color && r0.color[0] === '#' ? r0.color : (s.dark ? '#' + s.dark : '#111');
      const text = p.runs.map(r => r.t || '').join('');
      for (const ln of wrap(g, text, w)) {
        ty += fs * 1.15; if (ty > y + h + fs) break;
        const lw = g.measureText(ln).width;
        g.fillText(ln, p.algn === 'ctr' ? x + (w - lw) / 2 : p.algn === 'r' ? x + w - lw : x, ty);
      }
    }
  }
  return jpeg(c, 0.78).then(blob => ({ blob, w: Math.round(SW), h: Math.round(SH) }));
}
