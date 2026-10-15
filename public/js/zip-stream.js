/* Lestha Send — ZIP fabriqué dans le navigateur (3.26).
   Les fichiers viennent directement du stockage Cloudflare : rien ne passe par le serveur de l'application
   (dont la bande passante est comptée). Le ZIP est écrit au fil de l'eau :
   - Chrome, Edge, Firefox, Android : flux servi par le Service Worker → le téléchargement démarre tout de suite,
     sans rien garder en mémoire ;
   - Safari (iPhone, Mac) : ZIP assemblé sur l'appareil puis enregistré (jusqu'à 400 Mo).
   Sinon (ou en cas d'échec avant le début), l'appelant utilise le ZIP du serveur. */

const SAFARI = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
const BLOB_MAX = 400 * 1024 * 1024;
const ZIP32_MAX = 3.9 * 1024 * 1024 * 1024;

/* ---------- CRC-32 ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(crc, buf) { crc = ~crc; for (let i = 0; i < buf.length; i++) crc = CRC[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; }

const enc = new TextEncoder();
function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [t, day];
}
function localHeader(name, [t, d]) {
  const b = new Uint8Array(30 + name.length), v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0808, true);   // données suivies d'un descripteur, noms en UTF-8
  v.setUint16(8, 0, true); v.setUint16(10, t, true); v.setUint16(12, d, true);
  v.setUint16(26, name.length, true); b.set(name, 30);
  return b;
}
function descriptor(crc, size) {
  const b = new Uint8Array(16), v = new DataView(b.buffer);
  v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true); v.setUint32(8, size, true); v.setUint32(12, size, true);
  return b;
}
function centralEntry(e) {
  const b = new Uint8Array(46 + e.name.length), v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0808, true);
  v.setUint16(10, 0, true); v.setUint16(12, e.time[0], true); v.setUint16(14, e.time[1], true);
  v.setUint32(16, e.crc, true); v.setUint32(20, e.size, true); v.setUint32(24, e.size, true);
  v.setUint16(28, e.name.length, true); v.setUint32(42, e.offset, true); b.set(e.name, 46);
  return b;
}
function endRecord(n, cdSize, cdOffset) {
  const b = new Uint8Array(22), v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, n, true); v.setUint16(10, n, true);
  v.setUint32(12, cdSize, true); v.setUint32(16, cdOffset, true);
  return b;
}
/** Taille exacte du ZIP (le navigateur affiche ainsi une vraie progression) */
const zipSize = (items) => items.reduce((s, it) => s + 30 + it.bname.length + it.size + 16 + 46 + it.bname.length, 0) + 22;

/** Noms uniques, dossiers conservés */
function prepare(files) {
  const used = new Set();
  return files.map(f => {
    let name = String(f.name || 'fichier').replace(/\\/g, '/').replace(/^\/+|(^|\/)\.\.(?=\/|$)/g, '').replace(/[\u0000-\u001f]/g, '') || 'fichier';
    while (used.has(name.toLowerCase())) name = name.replace(/(\.[^./]+)?$/, (m) => ' (2)' + (m || ''));
    used.add(name.toLowerCase());
    return Object.assign({}, f, { bname: enc.encode(name), time: dosTime(f.date ? new Date(f.date) : new Date()) });
  });
}

/** Écrit le ZIP en appelant write(chunk) (qui peut attendre) ; renvoie quand tout est écrit */
async function writeZip(items, write, { signal, onProgress }) {
  let offset = 0, done = 0;
  const total = items.reduce((s, it) => s + it.size, 0);
  const entries = [];
  const put = async (c) => { offset += c.length; await write(c); };
  for (const it of items) {
    const start = offset;
    await put(localHeader(it.bname, it.time));
    const r = await fetch(it.url, { signal, credentials: 'omit' });
    if (!r.ok || !r.body) throw new Error('Fichier indisponible (HTTP ' + r.status + ')');
    const reader = r.body.getReader();
    let crc = 0, size = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      crc = crc32(crc, value); size += value.length; done += value.length;
      await put(value);
      onProgress && onProgress(done, total);
    }
    if (size !== it.size) throw new Error('Fichier incomplet');
    await put(descriptor(crc, size));
    entries.push({ name: it.bname, time: it.time, crc, size, offset: start });
  }
  const cdStart = offset;
  for (const e of entries) await put(centralEntry(e));
  await put(endRecord(entries.length, offset - cdStart, cdStart));
}

/** Le ZIP peut-il être fait dans ce navigateur ? */
export function canClientZip(totalSize) {
  if (totalSize > ZIP32_MAX || typeof ReadableStream !== 'function' || !self.fetch) return false;
  if (SAFARI) return totalSize <= BLOB_MAX;
  return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
}

/**
 * @param {{ name: string, files: { name, size, url, date? }[], onProgress?: (done, total) => void, signal?: AbortSignal }} o
 * @returns {Promise<void>} résolue quand le ZIP est entièrement écrit
 */
export async function clientZip(o) {
  const items = prepare(o.files);
  const fileName = (o.name || 'fichiers').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) + '.zip';
  if (SAFARI) {
    const parts = [];
    await writeZip(items, (c) => { parts.push(c); }, o);
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120e3);
    return;
  }
  // Flux via le Service Worker : le navigateur enregistre au fur et à mesure
  const sw = navigator.serviceWorker.controller;
  const ch = new MessageChannel();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let credits = 0, wake = null, cancelled = false;
  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Le téléchargement n\'a pas démarré')), 15000);
    ch.port1.onmessage = (e) => {
      if (e.data === 'start') { clearTimeout(to); resolve(); }
      else if (e.data === 'pull') credits++;
      else if (e.data === 'cancel') cancelled = true;
      if (wake) { const w = wake; wake = null; w(); }
    };
  });
  sw.postMessage({ type: 'zip-stream', id, name: fileName, size: zipSize(items) }, [ch.port2]);
  const frame = document.createElement('iframe');
  frame.hidden = true; frame.src = `/__zip__/${id}/${encodeURIComponent(fileName)}`;
  document.body.appendChild(frame);
  try { await ready; }
  catch (e) { frame.remove(); throw Object.assign(e, { started: false }); }   // Service Worker muet : l'appelant passe au ZIP du serveur
  try {
    // Le navigateur réclame les morceaux (« pull ») au rythme où il les enregistre : jamais tout en mémoire
    await writeZip(items, async (c) => {
      while (!credits && !cancelled) await new Promise(r => { wake = r; });
      if (cancelled) throw Object.assign(new Error('Téléchargement annulé'), { name: 'AbortError' });
      credits--;
      const out = c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice();
      ch.port1.postMessage(out, [out.buffer]);
    }, o);
    ch.port1.postMessage('end');
  } catch (e) {
    try { ch.port1.postMessage({ error: String(e && e.message || e) }); } catch (x) { /* déjà fermé */ }
    throw Object.assign(e, { started: true });
  } finally { setTimeout(() => frame.remove(), 60e3); }
}
