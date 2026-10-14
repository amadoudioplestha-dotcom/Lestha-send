/* Lestha Send — lecture des documents Office dans le navigateur (3.24).
   Word (.docx), Excel (.xlsx, .ods) et PowerPoint (.pptx) sont des archives ZIP de fichiers XML :
   on les ouvre ici, sans serveur et sans rien installer. Rien n'est exécuté : on ne lit que du texte,
   des nombres, des positions et des images. */

let zipP = null;
/** JSZip (≈ 100 Ko), chargé seulement quand on ouvre un document */
export function loadZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!zipP) zipP = loadScript('/vendor/docx/jszip.min.js').then(() => window.JSZip).catch(e => { zipP = null; throw e; });
  return zipP;
}
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Chargement impossible : ' + src));
    document.head.appendChild(s);
  });
}

export const extOf = (name) => (String(name || '').split('.').pop() || '').toLowerCase();

/* ---------------- petits outils XML ---------------- */
const parser = () => new DOMParser();
export async function xmlOf(zip, path) {
  const f = zip.file(path);
  if (!f) return null;
  const doc = parser().parseFromString(await f.async('string'), 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}
/** Éléments par nom local, quel que soit le préfixe (w:p, a:p, x:row…) */
export const els = (n, name) => (n ? Array.from(n.getElementsByTagNameNS('*', name)) : []);
export const el = (n, name) => (n ? n.getElementsByTagNameNS('*', name)[0] || null : null);
/** Enfants directs portant ce nom local */
export const kids = (n, name) => (n ? Array.from(n.children).filter(c => !name || c.localName === name) : []);
export const kid = (n, name) => kids(n, name)[0] || null;
const attr = (n, name) => {
  if (!n) return null;
  if (n.hasAttribute(name)) return n.getAttribute(name);
  for (const a of Array.from(n.attributes)) if (a.localName === name) return a.value;
  return null;
};
export { attr };
/** Identifiant de relation r:id (un élément peut aussi porter un simple « id », comme p:sldId) */
const rid = (n) => (n && (n.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || n.getAttribute('r:id'))) || null;

/** Cible d'une relation (rels) → chemin dans l'archive */
function resolvePath(base, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/'); parts.pop();
  for (const p of target.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}
async function relsOf(zip, path) {
  const i = path.lastIndexOf('/');
  const doc = await xmlOf(zip, path.slice(0, i + 1) + '_rels/' + path.slice(i + 1) + '.rels');
  const out = new Map();
  for (const r of els(doc, 'Relationship')) {
    if (attr(r, 'TargetMode') === 'External') continue;
    out.set(attr(r, 'Id'), { type: attr(r, 'Type') || '', path: resolvePath(path, attr(r, 'Target')) });
  }
  return out;
}

/* ================================================================== */
/*  Word : premières lignes (pour la vignette)                          */
/* ================================================================== */
export async function docxLines(zip, max = 40) {
  const doc = await xmlOf(zip, 'word/document.xml');
  const out = [];
  for (const p of els(doc, 'p')) {
    const style = attr(el(p, 'pStyle'), 'val') || '';
    const t = els(p, 't').map(x => x.textContent).join('');
    if (!t.trim() && !out.length) continue;
    out.push({ t, h: /heading|titre|title/i.test(style) });
    if (out.length >= max) break;
  }
  return out;
}

/* ================================================================== */
/*  Excel (.xlsx) et OpenDocument (.ods) : tableau des valeurs          */
/* ================================================================== */
const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; };
export const colName = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateCode = (code) => { const c = String(code || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''); return /[dmyhs]/i.test(c) && !/^[#0.,%\s]*$/.test(c); };
const pad = (n) => String(n).padStart(2, '0');
function excelDate(v) {
  const ms = Math.round((v - 25569) * 86400000);   // jours depuis le 30/12/1899
  const d = new Date(ms);
  if (isNaN(d)) return String(v);
  const day = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  const frac = v - Math.floor(v);
  if (v < 1) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return frac > 1e-6 ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day;
}
const fmtNum = (n, pct) => {
  if (!isFinite(n)) return String(n);
  const v = pct ? n * 100 : n;
  const s = Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(4) : (Math.round(v * 1e8) / 1e8).toLocaleString('fr-FR', { maximumFractionDigits: 8 });
  return pct ? s + ' %' : s;
};

/**
 * @returns {Promise<{ sheets: { name, rows: string[][], merges: {r,c,rs,cs}[], cut: boolean, nRows, nCols }[] }>}
 */
export async function readSheets(zip, { maxRows = 1000, maxCols = 60, onlyFirst = false } = {}) {
  if (zip.file('content.xml') && !zip.file('xl/workbook.xml')) return readOds(zip, { maxRows, maxCols, onlyFirst });
  const wb = await xmlOf(zip, 'xl/workbook.xml');
  if (!wb) throw new Error('Classeur illisible');
  const rels = await relsOf(zip, 'xl/workbook.xml');
  const shared = [];
  const ss = await xmlOf(zip, 'xl/sharedStrings.xml');
  for (const si of kids(ss && ss.documentElement, 'si')) shared.push(els(si, 't').filter(t => !t.closest || !t.parentNode || t.parentNode.localName !== 'rPh').map(t => t.textContent).join(''));
  // Formats : dates et pourcentages
  const st = await xmlOf(zip, 'xl/styles.xml');
  const custom = new Map(els(st, 'numFmt').map(n => [Number(attr(n, 'numFmtId')), attr(n, 'formatCode')]));
  const xfs = kids(el(st, 'cellXfs'), 'xf').map(x => {
    const id = Number(attr(x, 'numFmtId') || 0);
    return { date: DATE_IDS.has(id) || (custom.has(id) && isDateCode(custom.get(id))), pct: id === 9 || id === 10 || /%/.test(custom.get(id) || '') };
  });
  const sheets = [];
  for (const s of els(wb, 'sheet')) {
    if (attr(s, 'state') === 'hidden' || attr(s, 'state') === 'veryHidden') continue;
    const r = rels.get(rid(s));
    const doc = r && await xmlOf(zip, r.path);
    const rows = []; let cut = false, nCols = 0, nRows = 0;
    for (const row of els(doc, 'row')) {
      const ri = Number(attr(row, 'r') || rows.length + 1) - 1;
      nRows = Math.max(nRows, ri + 1);
      if (ri >= maxRows) { cut = true; continue; }
      const line = rows[ri] = rows[ri] || [];
      let ci = -1;
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r');
        ci = ref ? colIndex(ref) : ci + 1;
        nCols = Math.max(nCols, ci + 1);
        if (ci >= maxCols) { cut = true; continue; }
        const t = attr(c, 't'), v = kid(c, 'v'), raw = v ? v.textContent : '';
        let val = '';
        if (t === 's') val = shared[Number(raw)] || '';
        else if (t === 'inlineStr') val = els(c, 't').map(x => x.textContent).join('');
        else if (t === 'b') val = raw === '1' ? 'VRAI' : 'FAUX';
        else if (t === 'str' || t === 'e') val = raw;
        else if (raw !== '') {
          const n = Number(raw), xf = xfs[Number(attr(c, 's') || 0)] || {};
          val = xf.date ? excelDate(n) : fmtNum(n, xf.pct);
        }
        line[ci] = val;
      }
    }
    const merges = els(doc, 'mergeCell').map(m => {
      const [a, b] = String(attr(m, 'ref') || '').split(':');
      if (!a || !b) return null;
      const r0 = Number(a.replace(/[A-Z]+/, '')) - 1, r1 = Number(b.replace(/[A-Z]+/, '')) - 1;
      const c0 = colIndex(a), c1 = colIndex(b);
      return { r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 };
    }).filter(m => m && m.r < maxRows && m.c < maxCols);
    sheets.push({ name: attr(s, 'name') || 'Feuille', rows: trimRows(rows), merges, cut, nRows, nCols });
    if (onlyFirst) break;
  }
  return { sheets };
}
/** Retire les lignes et colonnes vides de la fin */
function trimRows(rows) {
  const out = Array.from(rows, r => r || []);
  while (out.length && !out[out.length - 1].some(v => v !== undefined && v !== '')) out.pop();
  return out;
}
async function readOds(zip, { maxRows, maxCols, onlyFirst }) {
  const doc = await xmlOf(zip, 'content.xml');
  if (!doc) throw new Error('Classeur illisible');
  const sheets = [];
  for (const tb of els(doc, 'table')) {
    if (tb.parentNode && tb.parentNode.localName === 'table-cell') continue;
    const rows = []; let cut = false;
    for (const row of els(tb, 'table-row')) {
      const rep = Math.min(Number(attr(row, 'number-rows-repeated') || 1), 50);
      const line = [];
      for (const c of kids(row, null).filter(x => x.localName === 'table-cell' || x.localName === 'covered-table-cell')) {
        const n = Math.min(Number(attr(c, 'number-columns-repeated') || 1), maxCols);
        const type = attr(c, 'value-type');
        let v = els(c, 'p').map(p => p.textContent).join('\n');
        if (!v && (type === 'float' || type === 'percentage' || type === 'currency')) v = fmtNum(Number(attr(c, 'value')), type === 'percentage');
        for (let i = 0; i < n && line.length < maxCols; i++) line.push(v);
        if (line.length >= maxCols) cut = true;
      }
      for (let i = 0; i < rep; i++) { if (rows.length >= maxRows) { cut = true; break; } rows.push(line.slice()); }
      if (rows.length >= maxRows) break;
    }
    const clean = trimRows(rows).map(r => { const x = r.slice(); while (x.length && (x[x.length - 1] === '' || x[x.length - 1] === undefined)) x.pop(); return x; });
    sheets.push({ name: attr(tb, 'name') || 'Feuille', rows: clean, merges: [], cut, nRows: clean.length, nCols: Math.max(0, ...clean.map(r => r.length)) });
    if (onlyFirst) break;
  }
  return { sheets };
}

/** CSV / TSV (début du fichier) → lignes */
export function parseCsv(text, { maxRows = 1000, maxCols = 60 } = {}) {
  const first = text.slice(0, 2000).split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === sep) { if (row.length < maxCols) row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; if (row.length < maxCols) row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

/* ================================================================== */
/*  PowerPoint (.pptx) : diapositives (positions, textes, images)       */
/* ================================================================== */
const EMU = 9525;   // 1 px à 96 ppp
const DEFAULT_THEME = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' };
const SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

function hexToHsl(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b;
  if (s === 0) r = g = b = l; else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
}
/** Couleur d'un élément <a:solidFill> (ou de son contenu), en tenant compte du thème et des nuances */
function colorOf(fill, theme) {
  if (!fill) return null;
  const c = kids(fill, null).find(x => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(x.localName)) || (/^(srgbClr|schemeClr|sysClr)$/.test(fill.localName) ? fill : null);
  if (!c) return null;
  let hex = null;
  if (c.localName === 'srgbClr') hex = attr(c, 'val');
  else if (c.localName === 'sysClr') hex = attr(c, 'lastClr') || (attr(c, 'val') === 'window' ? 'FFFFFF' : '000000');
  else if (c.localName === 'schemeClr') { const v = attr(c, 'val'); hex = theme[SCHEME_ALIAS[v] || v] || null; }
  else if (c.localName === 'prstClr') hex = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', yellow: 'FFFF00', gray: '808080' }[attr(c, 'val')] || null;
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  const mod = (n) => { const x = kid(c, n); return x ? Number(attr(x, 'val')) / 100000 : null; };
  const lm = mod('lumMod'), lo = mod('lumOff'), tint = mod('tint'), shade = mod('shade');
  if (lm != null || lo != null || tint != null || shade != null) {
    let [h, s, l] = hexToHsl(hex);
    if (lm != null) l *= lm;
    if (lo != null) l += lo;
    if (tint != null) l = l + (1 - l) * (1 - tint);
    if (shade != null) l *= shade;
    hex = hslToHex(h, s, Math.max(0, Math.min(1, l)));
  }
  const a = mod('alpha');
  return a != null && a < 1 ? `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${a.toFixed(2)})` : '#' + hex;
}

async function themeOf(zip, masterPath) {
  const t = Object.assign({}, DEFAULT_THEME);
  try {
    const rels = await relsOf(zip, masterPath);
    const r = [...rels.values()].find(x => /\/theme$/.test(x.type));
    const doc = r && await xmlOf(zip, r.path);
    const cs = el(doc, 'clrScheme');
    for (const k of kids(cs, null)) { const v = colorOf(k, DEFAULT_THEME); if (v && v[0] === '#') t[k.localName] = v.slice(1); }
  } catch (e) { /* thème par défaut */ }
  return t;
}

/** Une image de l'archive → URL utilisable dans <img> (les formats Windows EMF/WMF sont ignorés) */
async function mediaUrl(zip, path, cache) {
  if (!path) return null;
  if (cache.has(path)) return cache.get(path);
  const ext = extOf(path);
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
  const f = type && zip.file(path);
  const url = f ? URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type })) : null;
  cache.set(path, url);
  return url;
}

const PH_SIZE = { ctrTitle: 44, title: 36, subTitle: 24, body: 22 };
function phOf(sp) { const ph = el(kid(sp, 'nvSpPr') || kid(sp, 'nvPicPr') || sp, 'ph'); return ph ? { type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx') } : null; }
function xfrmOf(spPr) {
  const x = kid(spPr, 'xfrm'); if (!x) return null;
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return { x: Number(attr(off, 'x')) / EMU, y: Number(attr(off, 'y')) / EMU, w: Number(attr(ext, 'cx')) / EMU, h: Number(attr(ext, 'cy')) / EMU, rot: Number(attr(x, 'rot') || 0) / 60000, flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1' };
}
/** Forme correspondante (même espace réservé) dans la disposition ou le masque */
function findPh(tree, ph) {
  if (!tree || !ph) return null;
  const all = els(tree, 'sp');
  const same = (p) => p && ((ph.idx != null && p.idx === ph.idx) || (p.type === ph.type));
  return all.find(sp => { const p = phOf(sp); return p && ph.idx != null && p.idx === ph.idx; })
    || all.find(sp => { const p = phOf(sp); return p && p.type === ph.type; })
    || all.find(sp => same(phOf(sp)) || (['title', 'ctrTitle'].includes(ph.type) && phOf(sp) && ['title', 'ctrTitle'].includes(phOf(sp).type)))
    || null;
}

function textOf(txBody, theme, ph, inherit) {
  if (!txBody) return null;
  const bp = kid(txBody, 'bodyPr');
  const fit = el(bp, 'normAutofit');
  const scale = fit && attr(fit, 'fontScale') ? Number(attr(fit, 'fontScale')) / 100000 : 1;
  const anchor = attr(bp, 'anchor') || (inherit && inherit.anchor) || (ph && (ph.type === 'title' || ph.type === 'ctrTitle') ? 'ctr' : 't');
  const base = (ph && PH_SIZE[ph.type]) || (ph ? 20 : 18);
  const paras = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = Number(attr(pPr, 'lvl') || 0);
    const algn = attr(pPr, 'algn') || (inherit && inherit.algn) || (ph && ph.type === 'ctrTitle' ? 'ctr' : ph && ph.type === 'subTitle' ? 'ctr' : 'l');
    const runs = [];
    for (const r of kids(p, null)) {
      if (r.localName === 'br') { runs.push({ br: true }); continue; }
      if (r.localName !== 'r' && r.localName !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      const sz = attr(rPr, 'sz') ? Number(attr(rPr, 'sz')) / 100 : (inherit && inherit.sz) || base - lvl * 2;
      runs.push({
        t: (kid(r, 't') || {}).textContent || '',
        sz: sz * scale, b: attr(rPr, 'b') === '1' || (attr(rPr, 'b') == null && inherit && inherit.b), i: attr(rPr, 'i') === '1', u: !!attr(rPr, 'u') && attr(rPr, 'u') !== 'none',
        color: colorOf(kid(rPr, 'solidFill'), theme) || (inherit && inherit.color) || null
      });
    }
    const endSz = attr(kid(p, 'endParaRPr'), 'sz');
    const bullet = !el(pPr, 'buNone') && (el(pPr, 'buChar') || el(pPr, 'buAutoNum') || (ph && ph.type === 'body' && runs.some(x => x.t && x.t.trim())));
    paras.push({ lvl, algn, runs, bullet: bullet ? (attr(el(pPr, 'buChar'), 'char') || '•') : null, empty: !runs.some(x => x.t), sz: (endSz ? Number(endSz) / 100 : base - lvl * 2) * scale });
  }
  return { paras, anchor };
}
/** Style de texte hérité de la disposition (taille, couleur, alignement) */
function inheritOf(sp, theme) {
  if (!sp) return null;
  const lst = el(sp, 'lvl1pPr');
  const def = el(lst, 'defRPr');
  const bp = el(sp, 'bodyPr');
  return { sz: attr(def, 'sz') ? Number(attr(def, 'sz')) / 100 : null, b: attr(def, 'b') === '1', color: colorOf(kid(def, 'solidFill'), theme), algn: attr(lst, 'algn'), anchor: attr(bp, 'anchor') };
}

function fillOf(spPr, theme) {
  if (!spPr) return null;
  const s = kid(spPr, 'solidFill'); if (s) return colorOf(s, theme);
  const g = kid(spPr, 'gradFill');
  if (g) { const stops = els(g, 'gs').map(x => colorOf(x, theme)).filter(Boolean); if (stops.length) return stops.length > 1 ? `linear-gradient(${stops.join(',')})` : stops[0]; }
  return null;
}
function lineOf(spPr, theme) {
  const ln = kid(spPr, 'ln');
  if (!ln || kid(ln, 'noFill')) return null;
  const c = colorOf(kid(ln, 'solidFill'), theme);
  return c ? { color: c, w: Math.max(1, Number(attr(ln, 'w') || 12700) / EMU) } : null;
}

async function shapesOf(zip, tree, ctx, { skipPh = false, layoutTree = null, masterTree = null } = {}, group = null) {
  const items = [];
  if (!tree) return items;
  const map = (b) => {
    if (!b || !group) return b;
    const sx = group.chW ? group.w / group.chW : 1, sy = group.chH ? group.h / group.chH : 1;
    return Object.assign({}, b, { x: group.x + (b.x - group.chX) * sx, y: group.y + (b.y - group.chY) * sy, w: b.w * sx, h: b.h * sy });
  };
  for (const n of kids(tree, null)) {
    if (n.localName === 'sp') {
      const ph = phOf(n);
      if (ph && skipPh) continue;
      const spPr = kid(n, 'spPr');
      let box = xfrmOf(spPr);
      let inherit = null;
      if (ph) {
        const lay = findPh(layoutTree, ph), mas = findPh(masterTree, ph);
        if (!box) box = xfrmOf(kid(lay, 'spPr')) || xfrmOf(kid(mas, 'spPr'));
        inherit = inheritOf(lay, ctx.theme) || inheritOf(mas, ctx.theme);
        if (inherit && !inherit.sz) { const m = inheritOf(mas, ctx.theme); if (m) inherit.sz = m.sz; }
      }
      if (!box) continue;
      const text = textOf(kid(n, 'txBody'), ctx.theme, ph, inherit);
      const geom = attr(kid(spPr, 'prstGeom'), 'prst');
      const fill = fillOf(spPr, ctx.theme);
      const line = lineOf(spPr, ctx.theme);
      if (!fill && !line && !(text && text.paras.some(p => !p.empty))) continue;
      items.push(Object.assign(map(box), { kind: 'sp', fill, line, geom, text, ph: !!ph }));
    } else if (n.localName === 'pic') {
      const box = map(xfrmOf(kid(n, 'spPr')));
      const blip = el(n, 'blip');
      const rel = blip && ctx.rels.get(attr(blip, 'embed'));
      const src = rel && await mediaUrl(zip, rel.path, ctx.media);
      if (box && src) items.push(Object.assign(box, { kind: 'pic', src }));
    } else if (n.localName === 'grpSp') {
      const x = kid(kid(n, 'grpSpPr'), 'xfrm');
      const off = kid(x, 'off'), ext = kid(x, 'ext'), cho = kid(x, 'chOff'), che = kid(x, 'chExt');
      const g = off && ext ? map({ x: Number(attr(off, 'x')) / EMU, y: Number(attr(off, 'y')) / EMU, w: Number(attr(ext, 'cx')) / EMU, h: Number(attr(ext, 'cy')) / EMU }) : null;
      const sub = g ? Object.assign(g, { chX: cho ? Number(attr(cho, 'x')) / EMU : g.x, chY: cho ? Number(attr(cho, 'y')) / EMU : g.y, chW: che ? Number(attr(che, 'cx')) / EMU : g.w, chH: che ? Number(attr(che, 'cy')) / EMU : g.h }) : group;
      items.push(...await shapesOf(zip, n, ctx, { skipPh, layoutTree, masterTree }, sub));
    } else if (n.localName === 'graphicFrame') {
      const box = map(xfrmOf(n));   // p:graphicFrame porte son p:xfrm directement
      const tbl = el(n, 'tbl');
      if (box && tbl) items.push(Object.assign(box, { kind: 'table', rows: kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(tc => els(tc, 't').map(t => t.textContent).join(''))) }));
    }
  }
  return items;
}
function bgOf(doc, theme) {
  const bg = el(doc, 'bg');
  if (!bg) return null;
  const pr = kid(bg, 'bgPr');
  if (pr) return { fill: fillOf(pr, theme), blip: el(pr, 'blip') };
  const ref = kid(bg, 'bgRef');
  return ref ? { fill: colorOf(ref, theme) } : null;
}

/**
 * @returns {Promise<{ w, h, slides: { bg, bgImg, items }[], total, close() }>}
 */
export async function readSlides(zip, { max = 120, from = 0 } = {}) {
  const pres = await xmlOf(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('Présentation illisible');
  const sz = el(pres, 'sldSz');
  const W = sz ? Number(attr(sz, 'cx')) / EMU : 1280, H = sz ? Number(attr(sz, 'cy')) / EMU : 720;
  const prels = await relsOf(zip, 'ppt/presentation.xml');
  const ids = els(pres, 'sldId').map(s => prels.get(rid(s))).filter(Boolean);
  const media = new Map();
  const cacheTree = new Map();
  const tree = async (path) => { if (!cacheTree.has(path)) cacheTree.set(path, await xmlOf(zip, path)); return cacheTree.get(path); };
  const themes = new Map();
  const slides = [];
  for (const r of ids.slice(from, from + max)) {
    const doc = await tree(r.path);
    if (!doc) { slides.push({ items: [], bg: '#fff' }); continue; }
    const rels = await relsOf(zip, r.path);
    const lay = [...rels.values()].find(x => /\/slideLayout$/.test(x.type));
    const layDoc = lay && await tree(lay.path);
    const layRels = lay ? await relsOf(zip, lay.path) : new Map();
    const mas = [...layRels.values()].find(x => /\/slideMaster$/.test(x.type));
    const masDoc = mas && await tree(mas.path);
    const masRels = mas ? await relsOf(zip, mas.path) : new Map();
    if (mas && !themes.has(mas.path)) themes.set(mas.path, await themeOf(zip, mas.path));
    const theme = (mas && themes.get(mas.path)) || DEFAULT_THEME;
    // Fond : diapositive, sinon disposition, sinon masque
    let bg = null, bgImg = null;
    for (const [d, rr] of [[doc, rels], [layDoc, layRels], [masDoc, masRels]]) {
      const b = d && bgOf(d, theme);
      if (!b) continue;
      if (b.blip) { const rel = rr.get(attr(b.blip, 'embed')); bgImg = rel && await mediaUrl(zip, rel.path, media); }
      bg = b.fill || null;
      if (bg || bgImg) break;
    }
    const spTree = (d) => el(el(d, 'cSld'), 'spTree');
    const items = [];
    // Décor du masque et de la disposition (logos, bandeaux), sauf si la diapositive le masque
    if (attr(doc.documentElement, 'showMasterSp') !== '0') {
      if (masDoc && attr(layDoc && layDoc.documentElement, 'showMasterSp') !== '0') items.push(...await shapesOf(zip, spTree(masDoc), { theme, rels: masRels, media }, { skipPh: true }));
      if (layDoc) items.push(...await shapesOf(zip, spTree(layDoc), { theme, rels: layRels, media }, { skipPh: true }));
    }
    items.push(...await shapesOf(zip, spTree(doc), { theme, rels, media }, { layoutTree: spTree(layDoc), masterTree: spTree(masDoc) }));
    slides.push({ bg: bg || '#ffffff', bgImg, items, dark: theme.dk1 });
  }
  return { w: W, h: H, slides, total: ids.length, close: () => media.forEach(u => u && URL.revokeObjectURL(u)) };
}

/** Dessine une diapositive dans un élément (positions en pixels de la diapositive d'origine) */
export function slideHtml(s, W, H, esc) {
  const px = (v) => (Math.round(v * 10) / 10) + 'px';
  const parts = s.items.map(it => {
    const tr = [it.rot ? `rotate(${it.rot}deg)` : '', it.flipH ? 'scaleX(-1)' : '', it.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
    const pos = `left:${px(it.x)};top:${px(it.y)};width:${px(it.w)};height:${px(it.h)};${tr ? 'transform:' + tr + ';' : ''}`;
    if (it.kind === 'pic') return `<img class="sl-pic" style="${pos}" src="${it.src}" alt="" draggable="false">`;
    if (it.kind === 'table') return `<div class="sl-tbl" style="${pos}"><table>${it.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
    const deco = `${it.fill ? `background:${it.fill};` : ''}${it.line ? `border:${px(it.line.w)} solid ${it.line.color};` : ''}${it.geom === 'ellipse' ? 'border-radius:50%;' : it.geom === 'roundRect' ? 'border-radius:8%;' : ''}`;
    const t = it.text;
    const txt = t ? t.paras.map(p => {
      const runs = p.runs.map(r => r.br ? '<br>' : `<span style="font-size:${px(r.sz * 96 / 72)};${r.b ? 'font-weight:700;' : ''}${r.i ? 'font-style:italic;' : ''}${r.u ? 'text-decoration:underline;' : ''}${r.color ? 'color:' + r.color + ';' : ''}">${esc(r.t)}</span>`).join('');
      const al = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[p.algn] || 'left';
      return `<p style="text-align:${al};${p.lvl ? 'margin-left:' + px(p.lvl * 28) + ';' : ''}${p.empty ? 'height:' + px(p.sz * 96 / 72 * 1.1) + ';' : ''}">${p.bullet ? `<span class="sl-bu">${esc(p.bullet)}</span>` : ''}${runs}</p>`;
    }).join('') : '';
    const just = t ? ({ ctr: 'center', b: 'flex-end' }[t.anchor] || 'flex-start') : 'flex-start';
    return `<div class="sl-sp" style="${pos}${deco}justify-content:${just};${s.dark ? 'color:#' + s.dark + ';' : ''}">${txt}</div>`;
  }).join('');
  return `<div class="sl" style="width:${px(W)};height:${px(H)};background:${s.bg}${s.bgImg ? ` url('${s.bgImg}') center/cover no-repeat` : ''}">${parts}</div>`;
}
