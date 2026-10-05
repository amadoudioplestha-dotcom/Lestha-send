/* Lestha Send — qualités légères fabriquées dans le navigateur de l'expéditeur (gratuit, sans serveur de calcul)
 * - 480p, 720p, 1080p (seulement en dessous de la résolution d'origine, jamais d'agrandissement)
 * - une image clé par seconde : la timeline se parcourt image par image sans attendre
 * - planche d'aperçus (survol de la timeline), forme d'onde, cadence d'images détectée
 * Codecs : H.264 + AAC quand le navigateur sait les produire (lecture partout), sinon VP9/AV1 + Opus.
 * L'original reste intact et téléchargeable : rien n'est remplacé. */
import { api, lowMemory, isMobile } from './core.js';
import { Uploader } from './uploader.js';

let MB = null;
const lib = async () => MB || (MB = await import('/vendor/mediabunny.min.mjs'));
export const proxySupported = () => typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoDecoder' in window && 'AudioDecoder' in window;

/** Échelle : petit côté de l'image et débit visé (H.264). Les codecs modernes s'en sortent avec moins. */
const LADDER = [{ h: 480, br: 1.3e6 }, { h: 720, br: 2.8e6 }, { h: 1080, br: 5.5e6 }];
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

/** Lecture des caractéristiques de la vidéo d'origine */
export async function analyse(file) {
  const M = await lib();
  const input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw Object.assign(new Error('Pas de piste vidéo.'), { code: 'novideo' });
  if (!(await video.canDecode())) throw Object.assign(new Error('Ce navigateur ne sait pas lire ce format vidéo.'), { code: 'decode' });
  const audio = await input.getPrimaryAudioTrack();
  const w = await video.getDisplayWidth(), h = await video.getDisplayHeight();
  const duration = await input.computeDuration();
  let fps = 0; try { fps = (await video.computePacketStats(120)).averagePacketRate; } catch (e) { /* ignore */ }
  return { input, video, audio: audio && (await audio.canDecode()) ? audio : null, w, h, duration, fps: snapFps(fps) };
}
/** 29.96 → 29.97, 24.02 → 24… (cadences de tournage usuelles) */
export function snapFps(f) {
  if (!(f > 1)) return 0;
  const std = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
  const best = std.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
  return Math.abs(best - f) / best < 0.02 ? best : Math.round(f * 100) / 100;
}
/** Qualités utiles pour cette vidéo (toujours plus petites que l'original) */
export function ladderFor(w, h, duration = 0) {
  const short = Math.min(w, h);
  let out = LADDER.filter(r => r.h < short * 0.95);
  if (lowMemory || duration > 30 * 60) out = out.filter(r => r.h <= 720);   // appareils modestes, films longs : l'essentiel d'abord
  return out;
}
/** Grosse qualité : écrite sur le disque de l'appareil (OPFS) plutôt qu'en mémoire */
const MEM_LIMIT = () => window.__pxMemLimit || (lowMemory ? 150 : isMobile ? 250 : 400) * 1024 * 1024;   // __pxMemLimit : essais
async function diskTarget(M, name) {
  if (!navigator.storage || !navigator.storage.getDirectory) return null;
  try {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(name, { create: true });
    if (!fh.createWritable) return null;
    const w = await fh.createWritable();
    return { target: new M.StreamTarget(w), file: () => fh.getFile(), drop: () => dir.removeEntry(name).catch(() => {}) };
  } catch (e) { return null; }
}

/** Planche d'aperçus : jusqu'à 100 vignettes réparties sur la durée */
async function makeSprite(a) {
  const M = await lib();
  const n = Math.max(2, Math.min(100, Math.ceil(a.duration)));
  const step = a.duration / n;
  const tw = 160, th = even(160 * a.h / a.w), cols = 10, rows = Math.ceil(n / cols);
  const sheet = document.createElement('canvas'); sheet.width = cols * tw; sheet.height = rows * th;
  const g = sheet.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, sheet.width, sheet.height);
  const sink = new M.CanvasSink(a.video, { width: tw, height: th, fit: 'cover', poolSize: 2 });
  const times = Array.from({ length: n }, (_, i) => Math.min(a.duration - 0.05, i * step + step / 2));
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) { if (wc) g.drawImage(wc.canvas, (i % cols) * tw, Math.floor(i / cols) * th); i++; }
  const blob = await new Promise(res => sheet.toBlob(res, 'image/jpeg', 0.72));
  return { data: b64(new Uint8Array(await blob.arrayBuffer())), meta: { cols, rows, n, tw, th, step } };
}
/** Forme d'onde : 1 200 valeurs de 0 à 255 (crête par tranche de temps) */
async function makePeaks(a) {
  if (!a.audio) return null;
  const M = await lib();
  const N = 1200, peaks = new Uint8Array(N);
  const sink = new M.AudioBufferSink(a.audio);
  for await (const { buffer, timestamp } of sink.buffers()) {
    const ch = buffer.getChannelData(0), sr = buffer.sampleRate;
    for (let k = 0; k < ch.length; k += 64) {
      const v = Math.abs(ch[k]); const idx = Math.min(N - 1, Math.floor((timestamp + k / sr) / a.duration * N));
      const q = Math.min(255, Math.round(Math.sqrt(v) * 255)); if (q > peaks[idx]) peaks[idx] = q;
    }
  }
  return b64(peaks);
}

/** Une qualité : conversion en mémoire, puis envoi vers le Cloud sur le même lien */
async function makeRendition(file, a, rung, onProgress, signal) {
  const M = await lib();
  // Débit plafonné par celui de l'original (une capture d'écran légère reste légère)
  const srcBr = a.duration > 0 ? file.size * 8 / a.duration : rung.br;
  const br = Math.round(Math.min(rung.br, srcBr * 0.8));
  if (br < 150e3 || (br + 128e3) * a.duration / 8 > file.size * 0.9) throw Object.assign(new Error('Original déjà léger'), { code: 'light', skip: true });
  rung = Object.assign({}, rung, { br });
  const portrait = a.h > a.w;
  const short = rung.h, long = even(short * Math.max(a.w, a.h) / Math.min(a.w, a.h));
  const width = portrait ? short : long, height = portrait ? long : short;
  const vcodec = await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height, bitrate: rung.br });
  if (!vcodec) throw Object.assign(new Error('Ce navigateur ne sait pas encoder de vidéo.'), { code: 'encode' });
  const acodec = a.audio ? await M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: 48000, bitrate: 128e3 }) : null;
  const est = (rung.br + 128e3) * a.duration / 8 * 1.15;
  const disk = est > MEM_LIMIT() ? await diskTarget(M, `lestha-${Date.now()}-${rung.h}.mp4`) : null;
  if (est > MEM_LIMIT() && !disk) throw Object.assign(new Error(`Vidéo trop longue pour fabriquer la ${rung.h}p sur ce navigateur.`), { code: 'memory', skip: true });
  const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: disk ? false : 'in-memory' }), target: disk ? disk.target : new M.BufferTarget() });
  let conv;
  try { conv = await M.Conversion.init({
    input: new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS }), output,
    video: { width, height, fit: 'contain', codec: vcodec, bitrate: vcodec === 'avc' ? rung.br : Math.round(rung.br * 0.7), keyFrameInterval: 1, forceTranscode: true },
    audio: acodec ? { codec: acodec, bitrate: 128e3, numberOfChannels: 2, sampleRate: 48000 } : { discard: true }
  }); } catch (e) { if (disk) disk.drop(); throw e; }
  if (!conv.isValid) { if (disk) disk.drop(); throw Object.assign(new Error('Conversion impossible pour cette vidéo.'), { code: 'invalid' }); }
  conv.onProgress = (p) => onProgress(p);
  const stop = () => conv.cancel().catch(() => {});
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try { await conv.execute(); }
  catch (e) { if (disk) disk.drop(); throw e; }           // pas de fichier temporaire oublié sur le disque
  finally { if (signal) signal.removeEventListener('abort', stop); }
  let mime = ''; try { mime = await output.getMimeType(); } catch (e) { /* ignore */ }
  if (disk) { const f = await disk.file(); return { blob: f, size: f.size, width, height, vcodec, acodec, mime, drop: disk.drop }; }
  const buf = output.target.buffer;
  return { blob: new Blob([buf], { type: 'video/mp4' }), size: buf.byteLength, width, height, vcodec, acodec, mime, drop: () => {} };
}
function upload(id, key, meta, blob, name, onProgress) {
  return new Promise((resolve, reject) => {
    const up = new Uploader({ id, key, items: [{ file: new File([blob], name, { type: 'video/mp4' }), meta }], concurrency: isMobile ? 2 : 3 });
    up.addEventListener('progress', (e) => onProgress(e.detail.total ? e.detail.loaded / e.detail.total : 1));
    up.addEventListener('done', resolve);
    up.addEventListener('error', (e) => reject(new Error(e.detail.message)));
    up.addEventListener('stalled', (e) => { if (e.detail.kind === 'cors') reject(new Error('Le stockage refuse l\'envoi (règle CORS).')); });
    up.start();
  });
}

/**
 * Fabrique et met en ligne les qualités d'une vidéo déjà envoyée.
 * onStep({ label, pct }) : progression globale 0..1 · retourne la liste des qualités créées
 */
export async function buildProxies(file, { id, key, fid, onStep = () => {}, signal, skip = [] } = {}) {
  if (!proxySupported()) throw Object.assign(new Error('Navigateur trop ancien pour fabriquer les qualités (Chrome, Edge ou Safari récent).'), { code: 'support' });
  onStep({ label: 'Analyse de la vidéo…', pct: 0 });
  const a = await analyse(file);
  const rungs = ladderFor(a.w, a.h, a.duration).filter(r => !skip.includes(r.h));
  const weight = 0.06 + rungs.length;   // aperçus ≈ 6 % du travail
  let done = 0;
  const step = (label, p) => onStep({ label, pct: Math.min(0.999, (done + p) / weight) });
  // 1. Aperçus et forme d'onde (rapides, très utiles aux relecteurs)
  step('Aperçus de la timeline…', 0);
  try {
    const [sprite, peaks] = await Promise.all([makeSprite(a).catch(() => null), makePeaks(a).catch(() => null)]);
    await api(`/api/transfers/${id}/files/${fid}/assets`, { method: 'POST', key, body: { sprite: sprite && sprite.data, spriteMeta: sprite && sprite.meta, peaks, vw: a.w, vh: a.h, fps: a.fps } });
  } catch (e) { /* les qualités restent prioritaires */ }
  done += 0.06;
  // 2. Qualités, de la plus légère à la plus haute (la 480p est disponible au plus vite)
  const made = [];
  const srcBr = a.duration > 0 ? file.size * 8 / a.duration : 0;
  let budget = file.size * 1.5, lastBr = 0;
  for (const r of rungs) {
    const br = srcBr ? Math.min(r.br, srcBr * 0.8) : r.br, est = (br + 128e3) * a.duration / 8 * 1.1;
    // Qualité supérieure au même débit que la précédente, ou budget dépassé : rien à gagner, on s'arrête là
    if (est > budget || (lastBr && br <= lastBr * 1.05)) { done += 1; continue; }
    budget -= est; lastBr = br;
    if (signal && signal.aborted) break;
    const label = r.h + 'p';
    let out;
    try { out = await makeRendition(file, a, r, (p) => step(`Fabrication ${label}…`, p * 0.75), signal); }
    catch (e) { if (e.skip) { done += 1; continue; } throw e; }
    if (signal && signal.aborted) { out.drop(); break; }
    try {
      const reg = await api(`/api/transfers/${id}/files/${fid}/renditions`, { method: 'POST', key, body: { h: r.h, w: out.width, size: out.size, mime: out.mime, vw: a.w, vh: a.h, fps: a.fps } });
      await upload(id, key, reg.file, out.blob, file.name.replace(/\.[^.]+$/, '') + '_' + label + '.mp4', (p) => step(`Mise en ligne ${label}…`, 0.75 + p * 0.25));
    } catch (e) {
      if (e.data && e.data.skip) { done += 1; continue; }    // inutile ou déjà là : on passe à la suivante
      throw e;
    } finally { out.drop(); }
    made.push({ h: r.h, codec: out.vcodec, size: out.size });
    done += 1;
  }
  onStep({ label: made.length ? 'Qualités prêtes : ' + made.map(m => m.h + 'p').join(', ') : 'Aucune qualité à fabriquer (vidéo déjà légère)', pct: 1 });
  return { made, info: { w: a.w, h: a.h, fps: a.fps, duration: a.duration } };
}

/** Les vidéos d'un envoi qui méritent des qualités légères */
export const isVideoFile = (f) => /^video\//.test(f.type || '') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name || '');
