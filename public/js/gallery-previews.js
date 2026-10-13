/* Lestha Send — Galerie (3.18) : vignettes et versions écran fabriquées sur l'appareil de l'expéditeur.
   Une photo de téléphone pèse 3 à 6 Mo ; sa vignette ≈ 25 Ko et sa version écran ≈ 300 Ko.
   Les destinataires parcourent la galerie en 4G sans télécharger les originaux, qui restent intacts. */
import { api } from './core.js';

const THUMB = 360;          // plus petit côté de la vignette (grille 3 colonnes, écran x3)
const THUMB_MAX = 720;      // plus grand côté, borné
const VIEW = 1400;          // plus grand côté de la version écran (net sur téléphone, léger en 4G)
const MAX_PIXELS = 60e6;    // au-delà, on laisse tomber (mémoire des petits téléphones)

export const isImageFile = (f) => /^image\/(jpeg|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.type || '') || /\.(jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i.test(f.name || '');
export const isVideoFile = (f) => /^video\//.test(f.type || '') || /\.(mp4|mov|m4v|webm)$/i.test(f.name || '');
export const wantsPreview = (f) => (isImageFile(f) && f.size < 60e6 && !/svg/i.test(f.type || '')) || isVideoFile(f);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible sur cet appareil'));
    img.src = url;
  });
}

function videoFrame(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const fail = () => { clearTimeout(to); reject(new Error('Vidéo illisible sur cet appareil')); };
    const to = setTimeout(fail, 10000);
    v.onerror = fail;
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) * 0.1); };
    v.onseeked = () => { clearTimeout(to); resolve(v); };
    v.src = url;
  });
}

function toJpeg(src, sw, sh, w, h, quality) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);          // PNG transparents : fond blanc plutôt que noir
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

const b64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Fabrique { thumb, view, w, h } (JPEG en base64) pour une photo ou une vidéo */
export async function makePreviews(file) {
  const url = URL.createObjectURL(file);
  try {
    const video = isVideoFile(file) && !isImageFile(file);
    const src = video ? await videoFrame(url) : await loadImage(url);
    const sw = video ? src.videoWidth : src.naturalWidth, sh = video ? src.videoHeight : src.naturalHeight;
    if (!sw || !sh || sw * sh > MAX_PIXELS) return null;
    const ts = Math.min(1, THUMB / Math.min(sw, sh), THUMB_MAX / Math.max(sw, sh));
    const thumb = await toJpeg(src, sw, sh, Math.round(sw * ts), Math.round(sh * ts), 0.72);
    let view = null;
    // Version écran seulement si elle allège vraiment (grande photo ou format non affichable partout, comme HEIC)
    const heavy = file.size > 700e3 || Math.max(sw, sh) > 2000 || /heic|heif/i.test((file.type || '') + file.name);
    if (!video && heavy) {
      const vs = Math.min(1, VIEW / Math.max(sw, sh));
      const w = Math.round(sw * vs), h = Math.round(sh * vs);
      view = await toJpeg(src, sw, sh, w, h, 0.76);
      if (view && view.size > 880e3) view = await toJpeg(src, sw, sh, w, h, 0.62);
      if (view && view.size > 880e3) view = null;
    }
    return {
      thumb: thumb && thumb.size < 118e3 ? await b64(thumb) : null,
      view: view ? await b64(view) : null,
      w: sw, h: sh
    };
  } finally { URL.revokeObjectURL(url); }
}

/** Fabrique puis envoie les aperçus de tous les fichiers photo/vidéo d'un envoi, un par un, sans bloquer */
export async function sendPreviews({ id, key, items, onProgress = () => {} }) {
  const list = items.filter(it => it.meta && wantsPreview(it.file));
  let done = 0;
  for (const it of list) {
    try {
      const p = await makePreviews(it.file);
      if (p && (p.thumb || p.view)) await api(`/api/transfers/${id}/files/${it.meta.id}/previews`, { method: 'POST', key, body: p });
    } catch (e) { /* un aperçu manquant n'empêche rien : la galerie affichera l'original */ }
    onProgress(++done, list.length);
  }
  return done;
}
