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
  // 3.29.2 : le débit vraiment mesuré pendant les dernières lectures passe avant celui annoncé par le navigateur
  // (Chrome annonce souvent 10 Mbit/s sur une 4G qui en tient 2 : la 720p saccadait).
  const seen = measured();
  // Marge de 30 à 40 % : la 4G varie d'une seconde à l'autre, mieux vaut un cran en dessous qu'une vidéo qui s'arrête
  const budget = save || slow ? 1.5 : seen ? seen * 0.7 : isMobile ? 2 : dl ? dl * 0.6 : 7;
  return rungs.filter(s => rungBr(s.h) <= budget).pop() || rungs[0];
}
/** Débit mesuré récemment (Mbit/s), retenu 6 h sur cet appareil */
function measured() { const m = ls.get('tx_bw', null); return m && m.mbps > 0 && Date.now() - m.at < 6 * 3600e3 ? m.mbps : 0; }
function remember(mbps) { if (mbps > 0) ls.set('tx_bw', { mbps: Math.round(mbps * 100) / 100, at: Date.now() }); }

/**
 * Mesure du débit réel pendant la lecture : secondes de vidéo chargées par seconde × poids de la qualité.
 * On ne compte que quand le navigateur charge vraiment, pas quand il attend, tampon plein.
 * Retourne une fonction d'arrêt ; onRate(Mbit/s) est appelé toutes les 2 s.
 */
export function trackThroughput(v, mbpsOf, onRate) {
  let last = null, ema = 0;
  const loaded = () => { let n = 0; const b = v.buffered; for (let i = 0; i < b.length; i++) n += b.end(i) - b.start(i); return n; };
  const ahead = () => { const b = v.buffered; for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) return b.end(i) - v.currentTime; return 0; };
  const iv = setInterval(() => {
    if (!v.isConnected) { clearInterval(iv); return; }
    const now = performance.now(), n = loaded(), a = ahead();
    // NETWORK_LOADING (2) : le navigateur télécharge vraiment ; tampon plein, il se met en pause et la mesure attend
    const busy = v.networkState === 2;
    if (last && last.busy && busy && !v.seeking && v.readyState >= 1 && (v.duration || 0) - v.currentTime - a > 1) {
      const rate = ((n - last.n) / ((now - last.t) / 1000)) * mbpsOf();
      if (rate >= 0) { ema = ema ? ema * 0.6 + rate * 0.4 : rate; remember(ema); }
    }
    // Tampon plein, le navigateur ne charge plus : on garde la dernière mesure (utile pour monter d'un cran)
    if (ema && onRate) onRate(ema, a);
    last = { t: now, n, busy };
  }, 2000);
  return () => clearInterval(iv);
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
      let v = root.querySelector('video');
      const bar = root.querySelector('.vq-bar');
      if (!v || !bar) return;
      const paint = () => { bar.innerHTML = '<span class="vq-label">Qualité</span>' + chips(); };
      const idx = () => list.findIndex(x => x.id === sel.id);
      // Changement net (choix de la personne, ou vidéo déjà arrêtée) : même instant, même état de lecture
      const hardSwitch = (next) => {
        sel = next; paint();
        const t = v.currentTime, playing = !v.paused || v.autoplay;
        v.src = o.url(sel.id);
        v.addEventListener('loadedmetadata', () => { try { v.currentTime = t; } catch (x) { /* ignore */ } if (playing) v.play().catch(() => {}); }, { once: true });
      };
      // Montée de qualité sans coupure : la nouvelle qualité se charge en coulisse, puis prend la place au même instant
      let swapping = false;
      const smoothSwitch = (next) => {
        if (swapping) return; swapping = true;
        const v2 = v.cloneNode(false);
        v2.removeAttribute('autoplay'); v2.preload = 'auto'; v2.muted = true; v2.src = o.url(next.id);
        v2.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
        v.after(v2);
        const give = () => { swapping = false; v2.remove(); };
        const timer = setTimeout(give, 20000);
        // Point de jonction quelques secondes plus loin : la nouvelle qualité a le temps d'en charger un bon morceau
        let ahead = 0; const b = v.buffered;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
        const lead = Math.max(2, Math.min(6, ahead - 1));
        v2.addEventListener('loadedmetadata', () => { try { v2.currentTime = v.currentTime + lead; } catch (x) { give(); } }, { once: true });
        v2.addEventListener('canplay', function ready() {
          // On attend que la lecture rattrape le point préparé (moins d'une seconde), puis on échange les deux vidéos
          const go = () => {
            if (!v.isConnected || v.paused || v.seeking) { clearTimeout(timer); return give(); }
            if (v.currentTime < v2.currentTime - 0.05) return requestAnimationFrame(go);
            clearTimeout(timer);
            v2.removeAttribute('style'); v2.muted = v.muted; v2.volume = v.volume; v2.preload = 'metadata';
            v2.currentTime = v.currentTime;
            v2.play().catch(() => {});
            v.pause(); v.removeAttribute('src'); v.load(); v.replaceWith(v2);
            v = v2; sel = next; swapping = false; paint(); watch();
          };
          go();
        }, { once: true });
        v2.addEventListener('error', () => { clearTimeout(timer); give(); }, { once: true });
      };
      bar.onclick = (e) => {
        const b = e.target.closest('[data-vq]'); if (!b) return;
        const pref = b.dataset.vq; ls.set('tx_q', pref);
        const next = pickSource(f, pref);
        if (next.id === sel.id) { sel = next; return paint(); }
        hardSwitch(next);
      };
      // Auto, comme YouTube : un cran en dessous dès que ça saccade, un cran au-dessus quand la connexion le permet
      const origBr = f.size && f.dur ? f.size * 8 / f.dur / 1e6 : 8;   // Mbit/s de l'original
      let stopTrack = null, waits = [], lastSeek = 0, lastUp = Date.now(), waitAt = 0, longWait = null;
      const down = () => {
        const i = idx(); if (!sel.auto || i <= 0) return;
        waits = []; remember(Math.min(measured() || 99, rungBr(list[i - 1].h) * 1.1));
        hardSwitch(Object.assign({ auto: true }, list[i - 1]));
      };
      function watch() {
        if (stopTrack) stopTrack();
        v.addEventListener('seeking', () => { lastSeek = Date.now(); });
        v.addEventListener('waiting', () => {
          if (!sel.auto || v.paused || v.currentTime < 0.5 || Date.now() - lastSeek < 2500) return;
          const now = Date.now(); waitAt = now; waits = waits.filter(x => now - x < 20000); waits.push(now);
          if (waits.length >= 2) return down();
          clearTimeout(longWait); longWait = setTimeout(() => { if (waitAt === now && v.readyState < 3 && !v.paused) down(); }, 2500);   // une seule attente, mais longue
        });
        v.addEventListener('playing', () => { waitAt = 0; clearTimeout(longWait); });
        // Qualité illisible ici (codec) : retour à l'original
        v.addEventListener('error', () => { if (!sel.original) { sel = Object.assign({}, list[list.length - 1]); v.src = o.url(sel.id); paint(); } });
        stopTrack = trackThroughput(v, () => (sel.original ? origBr : rungBr(sel.h)), (rate, ahead) => {
          if (!sel.auto || v.paused || swapping) return;
          const i = idx(), next = list[i + 1];
          // La connexion ne suit plus et la réserve fond : on passe un cran en dessous avant que l'image ne s'arrête
          if (i > 0 && !sel.original && ahead < 12 && rate < rungBr(sel.h) * 0.85 && Date.now() - lastSeek > 5000) { lastUp = Date.now(); return smoothSwitch(Object.assign({ auto: true }, list[i - 1])); }
          if (sel.original && i > 0 && ahead < 12 && rate < origBr * 0.85) return smoothSwitch(Object.assign({ auto: true }, list[i - 1]));
          if (!next || next.original || Date.now() - lastUp < 30000 || waits.some(x => Date.now() - x < 60000) || Date.now() - lastSeek < 5000) return;
          if (ahead >= 10 && rate * 0.7 >= rungBr(next.h)) { lastUp = Date.now(); smoothSwitch(Object.assign({ auto: true }, next)); }
        });
      }
      watch();
    }
  };
}
