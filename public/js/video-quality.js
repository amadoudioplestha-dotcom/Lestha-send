/* Lestha Send — qualité de lecture des vidéos, comme YouTube (3.29)
 * Liste des qualités disponibles (480p, 720p… fabriquées à l'envoi ou par le serveur, + l'original),
 * choix automatique selon la connexion, et petit sélecteur sous la vidéo pour l'aperçu de la page de réception.
 * Partagé avec le lecteur de revue (review-pro.js). */
import { esc, ls, isMobile } from './core.js';

let probe = null;
/** Le navigateur sait-il lire ce format ? (une qualité VP9/AV1 n'est pas lisible partout) */
const playable = (mime) => { if (!mime) return true; try { probe = probe || document.createElement('video'); return !!probe.canPlayType(mime); } catch (e) { return true; } };
const resName = (h) => (h >= 2100 ? '4K' : h >= 1400 ? '2K' : h + 'p');

/** Sources disponibles pour un fichier : les qualités légères (de la plus légère à la plus lourde), puis l'original */
export function sourcesOf(f) {
  const oh = f.vw && f.vh ? Math.min(f.vw, f.vh) : 0;
  const list = (f.q || []).filter(r => playable(r.mime)).map(r => ({ id: r.id, h: r.h, label: r.h + 'p' }));
  list.push({ id: f.id, h: oh || 10000, label: 'Original' + (oh ? ' · ' + resName(oh) : ''), original: true });
  return list;
}
/** Choix automatique (3.22), comme YouTube : la qualité la plus haute que la connexion tient sans saccades.
    L'original d'un téléphone pèse souvent 15 à 20 Mbit/s : en Auto, on ne le prend que si aucune qualité légère n'existe
    (Chrome plafonne le débit annoncé à 10 Mbit/s : on ne peut pas savoir si la connexion tiendrait l'original). */
const NOMINAL = { 360: 0.8, 480: 1.3, 720: 2.8, 1080: 5.5, 1440: 9 };   // Mbit/s visés par les qualités fabriquées
export const rungBr = (h) => NOMINAL[h] || h * h / 2e5;
export function autoPick(list) {
  const rungs = list.filter(s => !s.original);
  if (!rungs.length) return list[list.length - 1];
  const c = navigator.connection || {};
  const dl = Number(c.downlink) || 0, save = !!c.saveData, slow = /(^|-)(2g|3g)$/.test(c.effectiveType || '');
  // Marge de 40 % : la 4G varie d'une seconde à l'autre, mieux vaut un cran en dessous qu'une vidéo qui s'arrête
  const budget = save || slow ? 1.5 : dl ? dl * 0.6 : (isMobile ? 3.5 : 7);
  return rungs.filter(s => rungBr(s.h) <= budget).pop() || rungs[0];
}
/** Source choisie : préférence enregistrée (« auto », une hauteur, ou 99999 pour l'original) */
export function pickSource(f, pref = ls.get('tx_q', 'auto')) {
  const list = sourcesOf(f);
  if (pref === 'auto' || pref == null) return Object.assign({ auto: true }, autoPick(list));
  return list.filter(s => s.h <= Number(pref)).pop() || list[0];
}

/**
 * Vidéo avec sélecteur de qualité (aperçu de la page de réception).
 * @param {{ f: object, url: (id) => string, cls?: string, autoplay?: boolean, poster?: string }} o
 * @returns {{ html: string, bind: (root: Element) => void }}
 */
export function qualityVideo(o) {
  const { f } = o;
  const list = sourcesOf(f);
  let sel = pickSource(f);
  const video = `<video class="${o.cls || 'preview-media'}" src="${o.url(sel.id)}" controls ${o.autoplay ? 'autoplay' : ''} playsinline preload="metadata" ${o.poster ? `poster="${o.poster}"` : ''}></video>`;
  if (list.length === 1) {
    const note = f.sq ? (f.sq.s === 'run' ? `Qualité ${f.sq.h || 480}p en préparation : ${f.sq.p || 0} %${f.sq.eta != null ? ' · environ ' + Math.max(1, f.sq.eta) + ' min' : ''}` : 'Qualités 480p et 720p en préparation') : '';
    return { html: video + (note ? `<p class="vq-note">${esc(note)}. Elles s'ajouteront ici toutes seules à la prochaine ouverture.</p>` : ''), bind() {} };
  }
  const chips = () => `<button type="button" class="vq-chip ${sel.auto ? 'on' : ''}" data-vq="auto">Auto${sel.auto ? ' · ' + esc(sel.original ? 'Original' : sel.label) : ''}</button>`
    + list.slice().reverse().map(s => `<button type="button" class="vq-chip ${!sel.auto && sel.id === s.id ? 'on' : ''}" data-vq="${s.original ? 99999 : s.h}">${esc(s.original ? 'Original' : s.label)}</button>`).join('');
  return {
    html: `<div class="vq">${video}<div class="vq-bar" role="group" aria-label="Qualité de lecture"><span class="vq-label">Qualité</span>${chips()}</div></div>`,
    bind(root) {
      const v = root.querySelector('video'), bar = root.querySelector('.vq-bar');
      if (!v || !bar) return;
      bar.onclick = (e) => {
        const b = e.target.closest('[data-vq]'); if (!b) return;
        const pref = b.dataset.vq; ls.set('tx_q', pref);
        const next = pickSource(f, pref);
        const same = next.id === sel.id; sel = next;
        bar.innerHTML = '<span class="vq-label">Qualité</span>' + chips();
        if (same) return;
        // Changement de qualité au même instant, sans perdre la lecture
        const t = v.currentTime, playing = !v.paused;
        v.src = o.url(sel.id);
        v.addEventListener('loadedmetadata', () => { try { v.currentTime = t; } catch (x) { /* ignore */ } if (playing) v.play().catch(() => {}); }, { once: true });
      };
      // Qualité illisible ici (codec) : retour à l'original
      v.addEventListener('error', () => { if (!sel.original) { sel = Object.assign({}, list[list.length - 1]); v.src = o.url(sel.id); bar.innerHTML = '<span class="vq-label">Qualité</span>' + chips(); } });
    }
  };
}
