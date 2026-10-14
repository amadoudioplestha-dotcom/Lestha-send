/* Lestha Send — lecture partielle d'un fichier Word / Excel / PowerPoint à distance (3.25).
   Ces fichiers sont des archives ZIP : leur sommaire est à la fin du fichier. On lit ce sommaire, puis
   seulement les parties utiles (le texte, la mise en page), par petits morceaux. Les images d'une
   diapositive ne sont chargées que lorsqu'on arrive dessus. Un PowerPoint de 25 Mo s'ouvre ainsi
   après quelques centaines de Ko au lieu de 25 Mo.
   Même interface que JSZip pour ce dont l'aperçu a besoin : zip.file(nom).async('string' | 'arraybuffer'). */

const SPAN_GAP = 48 * 1024;      // deux parties séparées de moins que ça : une seule requête
const SPAN_MAX = 3 * 1024 * 1024;

/** Le navigateur sait-il décompresser lui-même ? (Chrome 103+, Safari 16.4+, Firefox 113+) ; sinon : fichier entier */
export const canRangeZip = () => { try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; } };

async function range(url, start, end, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal, credentials: 'omit' });
  if (r.status !== 206) throw new Error('Lecture par morceaux impossible (HTTP ' + r.status + ')');
  return new Uint8Array(await r.arrayBuffer());
}
async function inflate(data, method) {
  if (method === 0) return data;
  if (method !== 8) throw new Error('Compression non prise en charge');
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}

/**
 * Ouvre une archive distante. Échoue (et l'appelant télécharge le fichier entier) si le serveur ne sait
 * pas répondre par morceaux, si l'archive est au format ZIP64 ou chiffrée.
 * @returns {Promise<{ file(name): { async(type): Promise<any> } | null, prefetch(test): Promise<void>, loaded(): number }>}
 */
export async function openRangeZip(url, size, signal) {
  const tailLen = Math.min(size, 66 * 1024);
  const tail = await range(url, size - tailLen, size - 1, signal);
  let loaded = tail.length;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Archive illisible');
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff || cdOff + cdSize > size) throw new Error('ZIP64');
  let cd;
  const tailStart = size - tailLen;
  if (cdOff >= tailStart) cd = tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize);
  else { cd = await range(url, cdOff, cdOff + cdSize - 1, signal); loaded += cd.length; }
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const utf8 = new TextDecoder('utf-8');
  const entries = new Map();
  for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50;) {
    const n = cv.getUint16(p + 28, true), e = cv.getUint16(p + 30, true), c = cv.getUint16(p + 32, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + n));
    entries.set(name, { name, flags: cv.getUint16(p + 8, true), method: cv.getUint16(p + 10, true), csize: cv.getUint32(p + 20, true), off: cv.getUint32(p + 42, true), n, e });
    p += 46 + n + e + c;
  }
  if (!entries.size) throw new Error('Archive vide');

  const raw = new Map();       // nom → données compressées déjà reçues
  const pending = new Map();   // nom → promesse en cours
  /** Données compressées d'une partie, à partir d'un morceau qui commence à l'octet `base` */
  const cut = (en, buf, base) => {
    const at = en.off - base;
    if (at < 0 || at + 30 > buf.length) return null;
    const v = new DataView(buf.buffer, buf.byteOffset + at, 30);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Archive illisible');
    const start = at + 30 + v.getUint16(26, true) + v.getUint16(28, true);
    return start + en.csize <= buf.length ? buf.subarray(start, start + en.csize) : null;
  };
  async function fetchOne(en) {
    const buf = await range(url, en.off, Math.min(size - 1, en.off + 30 + en.n + en.e + 256 + en.csize), signal);
    loaded += buf.length;
    let d = cut(en, buf, en.off);
    if (!d) {   // en-tête local plus long que prévu : on relit exactement
      const v = new DataView(buf.buffer, buf.byteOffset, 30);
      const start = en.off + 30 + v.getUint16(26, true) + v.getUint16(28, true);
      d = await range(url, start, start + en.csize - 1, signal); loaded += d.length;
    }
    raw.set(en.name, d);
  }
  function load(en) {
    if (raw.has(en.name)) return Promise.resolve();
    if (!pending.has(en.name)) pending.set(en.name, fetchOne(en).finally(() => pending.delete(en.name)));
    return pending.get(en.name);
  }

  const zip = {
    file(name) {
      const en = entries.get(name);
      if (!en || en.name.endsWith('/')) return null;
      return {
        name,
        async async(type) {
          if (en.flags & 1) throw new Error('Document protégé');
          await load(en);
          const out = await inflate(raw.get(en.name), en.method);
          if (type === 'string') return utf8.decode(out);
          if (type === 'uint8array') return out;
          return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer;
        }
      };
    },
    /** Charge d'avance, en quelques grosses requêtes parallèles, toutes les parties qui passent le test */
    async prefetch(test) {
      const list = [...entries.values()].filter(en => !en.name.endsWith('/') && !raw.has(en.name) && test(en.name)).sort((a, b) => a.off - b.off);
      const spans = [];
      for (const en of list) {
        const end = en.off + 30 + en.n + en.e + 256 + en.csize;
        const s = spans[spans.length - 1];
        if (s && en.off - s.end < SPAN_GAP && end - s.start < SPAN_MAX) { s.end = Math.max(s.end, end); s.list.push(en); }
        else spans.push({ start: en.off, end, list: [en] });
      }
      await Promise.all(spans.map(async (s) => {
        const buf = await range(url, s.start, Math.min(size - 1, s.end), signal);
        loaded += buf.length;
        for (const en of s.list) { const d = cut(en, buf, s.start); if (d) raw.set(en.name, d); }
      }));
    },
    loaded: () => loaded,
    names: () => [...entries.keys()]
  };
  return zip;
}

/** Parties « légères » d'un document Office : tout sauf les images, vidéos et objets incorporés */
export const isLightPart = (name) => !/^(ppt|word|xl)\/(media|embeddings)\//.test(name) && !/^Pictures\//.test(name) && !/\.(bin|vml)$/i.test(name);
