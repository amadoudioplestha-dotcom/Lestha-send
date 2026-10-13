/* Lestha Send — Galerie photos et vidéos de la page de réception (3.18)
   Grille de vignettes légères, visionneuse plein écran (balayage, zoom, vidéo intégrée),
   sélection et téléchargement des fichiers choisis. Aucune bibliothèque : défilement natif (scroll-snap). */
import { $, esc, icon, bytes, fileKind, toast, modal, isMobile } from './core.js';
import { pushOverlay, popOverlay } from './router.js';

export const isGalleryFile = (f) => ['image', 'video'].includes(fileKind(f.name, f.type, f.size).kind) && !/svg/i.test(f.type || f.name);

/**
 * @param {HTMLElement} box   conteneur de la galerie
 * @param {object} o
 *   files       fichiers photo/vidéo (déjà filtrés)
 *   url(fid, inline)        URL d'un fichier (original ou aperçu)
 *   zipUrl(ids)             URL du ZIP des fichiers choisis
 *   canDownload             false en « visionnage seul »
 *   onGot(fid)              fichier téléchargé (marque « téléchargé »)
 */
export function mountGallery(box, o) {
  const files = o.files;
  const sel = new Set();
  const kindOf = (f) => fileKind(f.name, f.type, f.size).kind;
  // Vignette légère si l'expéditeur l'a préparée ; sinon version écran, sinon l'original (chargé seulement quand la case devient visible).
  // HEIC (photos d'iPhone) : seul Safari sait l'afficher.
  const safari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Chromium|Android|FxiOS|EdgiOS/.test(navigator.userAgent);
  const thumbOf = (f) => f.thu || (f.th ? o.url(f.th, true) : null) || (f.spv && o.pvUrl ? o.pvUrl(f.id, 'thumb') : null)
    || f.pvu || (f.pv ? o.url(f.pv, true) : null)
    || (kindOf(f) === 'image' && f.size < 25e6 && (safari || !/heic|heif/i.test((f.type || '') + f.name)) ? o.url(f.id, true) : null);
  const nPhotos = files.filter(f => kindOf(f) === 'image').length, nVideos = files.length - nPhotos;
  const label = [nPhotos ? `${nPhotos} photo${nPhotos > 1 ? 's' : ''}` : '', nVideos ? `${nVideos} vidéo${nVideos > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');

  box.innerHTML = `
    <div class="card-title"><h3>${icon('image')}Galerie</h3>
      ${o.canDownload && files.length > 1 ? `<button type="button" class="btn sm ghost" data-gall>${icon('check', 'sm')}<span>Tout choisir</span></button>` : ''}</div>
    <p class="small muted gal-hint"><b>${label}</b> · ${o.canDownload ? 'touchez une photo pour l\'agrandir et faire défiler, cochez celles que vous voulez puis téléchargez.' : 'touchez une photo pour l\'agrandir et faire défiler.'}</p>
    ${o.canDownload && o.bigSave && files.length > 1 ? `<button type="button" class="btn primary block gal-save" data-gsave>${icon('download')}<span>Enregistrer ${nVideos ? 'tout' : 'toutes les photos'} (${files.length})</span></button>` : ''}
    <div class="gal-grid">
      ${files.map((f, i) => {
        const th = thumbOf(f), video = kindOf(f) === 'video';
        return `<div class="gal-tile ${video ? 'is-video' : ''}" data-gi="${i}">
          <button type="button" class="gal-open" data-open="${i}" aria-label="Agrandir ${esc(f.name)}">
            ${th ? `<img src="${th}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
            <span class="gal-ph">${icon(video ? 'video' : 'image')}<small>${esc(f.name)}</small></span>
            ${video ? `<span class="gal-play">${icon('play', 'sm')}</span>` : ''}
          </button>
          ${o.canDownload ? `<button type="button" class="gal-check" data-pick="${i}" role="checkbox" aria-checked="false" aria-label="Choisir ${esc(f.name)}">${icon('check', 'sm')}</button>` : ''}
        </div>`;
      }).join('')}
    </div>
    ${o.canDownload ? `<div class="gal-bar" hidden>
      <button type="button" class="btn sm ghost icon" data-gclear title="Tout désélectionner" aria-label="Tout désélectionner">${icon('x', 'sm')}</button>
      <span class="gal-count grow"></span>
      <button type="button" class="btn primary" data-gdl>${icon('download')}<span>Télécharger</span></button>
    </div>` : ''}`;

  const paintTile = (i) => {
    const b = box.querySelector(`[data-pick="${i}"]`); if (!b) return;
    const on = sel.has(i);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.parentNode.classList.toggle('picked', on);
  };
  const paintSel = (only) => {
    // Une seule case touchée : on ne redessine qu'elle (instantané même sur un petit téléphone)
    if (only != null) paintTile(only); else files.forEach((_, i) => paintTile(i));
    const bar = $('.gal-bar', box);
    if (bar) {
      bar.hidden = !sel.size;
      const size = [...sel].reduce((s, i) => s + (files[i].size || 0), 0);
      $('.gal-count', bar).innerHTML = `<b>${sel.size}</b> choisi${sel.size > 1 ? 's' : ''} · ${bytes(size)}`;
    }
    const all = $('[data-gall] span', box);
    if (all) all.textContent = sel.size === files.length ? 'Tout retirer' : 'Tout choisir';
    if (viewer) viewer.paint();
  };
  const toggle = (i) => { if (sel.has(i)) sel.delete(i); else sel.add(i); paintSel(i); };

  let viewer = null;
  box.onclick = (e) => {
    const pk = e.target.closest('[data-pick]'); if (pk) { toggle(+pk.dataset.pick); return; }
    const op = e.target.closest('[data-open]'); if (op) { viewer = openViewer(+op.dataset.open); return; }
    if (e.target.closest('[data-gall]')) { if (sel.size === files.length) sel.clear(); else files.forEach((_, i) => sel.add(i)); paintSel(); return; }
    if (e.target.closest('[data-gclear]')) { sel.clear(); paintSel(); return; }
    if (e.target.closest('[data-gsave]')) { downloadMany(files.slice()); return; }
    if (e.target.closest('[data-gdl]')) downloadMany([...sel].sort((a, b) => a - b).map(i => files[i]));
  };

  /* ---------------- téléchargement ---------------- */
  const shareFiles = () => isMobile && typeof navigator.canShare === 'function' && typeof File === 'function' && (() => {
    try { return navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }); } catch (e) { return false; }
  })();
  const SHARE_MAX = 150e6;   // tout passe par la mémoire du téléphone : on reste raisonnable

  function clickDownload(f) {
    const a = document.createElement('a');
    a.href = o.url(f.id, false); a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    o.onGot(f.id);
  }
  async function oneByOne(list) {
    if (list.length > 1) toast('Les fichiers arrivent un par un. Autorisez les téléchargements multiples si le navigateur le demande.', 'info', { duration: 6000 });
    for (const [k, f] of list.entries()) { clickDownload(f); if (k < list.length - 1) await new Promise(r => setTimeout(r, 1300)); }
  }
  /** Téléphone : « Enregistrer dans Photos / Galerie » via la feuille de partage du système */
  async function toPhoneGallery(list) {
    const t = toast(`Préparation de ${list.length} fichier${list.length > 1 ? 's' : ''}…`, 'info', { duration: 60000 });
    const got = [];
    try {
      for (const f of list) {
        const r = await fetch(o.url(f.id, false), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        got.push(new File([blob], f.name, { type: f.type || blob.type || 'application/octet-stream' }));
      }
    } catch (e) {
      if (t) t();
      toast('Enregistrement direct impossible ici : téléchargement classique à la place.', 'warn');
      return oneByOne(list);
    }
    if (t) t();
    // Le partage exige un nouveau geste de l'utilisateur après le chargement
    await modal({
      title: 'Prêt à enregistrer',
      body: `<p class="muted">${got.length} fichier${got.length > 1 ? 's' : ''} prêt${got.length > 1 ? 's' : ''}. Choisissez <b>Enregistrer ${got.length > 1 ? 'les images' : 'l\'image'}</b> (iPhone) ou votre application Galerie dans la fenêtre qui s'ouvre.</p>`,
      actions: [{ label: 'Annuler', cls: 'ghost', value: null }, { label: 'Enregistrer', cls: 'primary', icon: 'download', handler: () => {
        navigator.share({ files: got }).then(() => list.forEach(f => o.onGot(f.id))).catch((e) => { if (e && e.name !== 'AbortError') oneByOne(list); });
      } }]
    });
  }
  async function downloadMany(list) {
    if (!list.length) return;
    const total = list.reduce((s, f) => s + (f.size || 0), 0);
    const canShare = shareFiles() && total <= SHARE_MAX;
    if (list.length === 1 && !canShare) return clickDownload(list[0]);
    const acts = [{ label: 'Annuler', cls: 'ghost', value: null }];
    if (list.length > 1) acts.push({ label: 'En un .zip', icon: 'zip', value: 'zip' });
    acts.push({ label: canShare ? 'Dans Téléchargements' : 'Un par un', icon: 'download', cls: canShare ? '' : 'primary', value: 'seq' });
    if (canShare) acts.push({ label: 'Dans la galerie du téléphone', icon: 'image', cls: 'primary', value: 'share' });
    const how = await modal({
      title: `Télécharger ${list.length} fichier${list.length > 1 ? 's' : ''}`,
      body: `<p class="muted">${bytes(total)} au total. ${canShare ? '<b>Galerie du téléphone</b> : les photos et vidéos arrivent directement avec les autres.' : list.length > 1 ? '<b>Un par un</b> garde chaque photo séparée ; le <b>.zip</b> les regroupe en un seul fichier.' : ''}</p>`,
      actions: acts
    });
    if (how === 'zip') { location.href = o.zipUrl(list.map(f => f.id)); list.forEach(f => o.onGot(f.id)); toast('Préparation du ZIP… le téléchargement démarre', 'success'); }
    else if (how === 'seq') oneByOne(list);
    else if (how === 'share') toPhoneGallery(list);
  }

  /* ---------------- visionneuse plein écran ---------------- */
  function openViewer(start) {
    const v = document.createElement('div');
    v.className = 'gal-viewer';
    v.setAttribute('role', 'dialog'); v.setAttribute('aria-modal', 'true'); v.setAttribute('aria-label', 'Galerie');
    v.innerHTML = `
      <div class="gv-top"><span class="gv-n"></span><span class="gv-name"></span><button type="button" class="gv-btn" data-gv="close" aria-label="Fermer">${icon('x')}</button></div>
      <div class="gv-track">${files.map((f, i) => `<div class="gv-slide" data-si="${i}"></div>`).join('')}</div>
      <button type="button" class="gv-nav prev" data-gv="prev" aria-label="Précédente">${icon('arrow-left')}</button>
      <button type="button" class="gv-nav next" data-gv="next" aria-label="Suivante">${icon('arrow-right')}</button>
      <div class="gv-bottom">
        ${o.canDownload ? `<button type="button" class="gv-pill" data-gv="pick">${icon('check', 'sm')}<span>Choisir</span></button>
        <button type="button" class="gv-pill primary" data-gv="dl">${icon('download', 'sm')}<span>Télécharger</span></button>` : ''}
        <span class="gv-sel small"></span>
      </div>`;
    document.body.appendChild(v);
    document.documentElement.classList.add('gal-locked');
    const track = $('.gv-track', v);
    let cur = -1, closed = false;

    const fill = (i) => {
      const s = track.children[i]; if (!s || s.dataset.ready) return;
      const f = files[i]; s.dataset.ready = '1';
      if (kindOf(f) === 'video') {
        const q = (f.q || []).filter(r => r.h <= 720);
        const src = q.length ? o.url(q[q.length - 1].id, true) : o.url(f.id, true);   // qualité légère si l'expéditeur l'a préparée
        s.innerHTML = `<video class="gv-video" controls playsinline preload="metadata" ${f.th ? `poster="${f.thu || o.url(f.th, true)}"` : ''} src="${src}"></video>`;
      } else {
        const full = f.pvu || (f.pv ? o.url(f.pv, true) : f.spv && o.pvUrl ? o.pvUrl(f.id, 'view') : o.url(f.id, true));
        s.innerHTML = `<div class="gv-zoom"><img class="gv-img" alt="${esc(f.name)}" decoding="async" src="${full}"></div><div class="gv-spin"><span class="spinner"></span></div>`;
        const img = $('img', s);
        // La vignette déjà en cache s'affiche tout de suite, floutée, pendant que la version écran arrive
        const th = f.thu || (f.th ? o.url(f.th, true) : null) || (f.spv && o.pvUrl ? o.pvUrl(f.id, 'thumb') : null);
        if (th) s.style.backgroundImage = `url("${th}")`;
        img.onload = () => { s.classList.add('loaded'); s.style.backgroundImage = ''; };
        img.onerror = () => { s.classList.add('loaded'); s.innerHTML = `<div class="gv-fail">${icon('image')}<p>Aperçu indisponible sur cet appareil${/heic|heif/i.test(f.type + f.name) ? ' (format HEIC)' : ''}.</p>${o.canDownload ? `<button type="button" class="btn primary sm" data-gv="dl">${icon('download', 'sm')}Télécharger l'original</button>` : ''}</div>`; };
        bindZoom(s);
      }
    };
    const unfill = (i) => { const s = track.children[i]; if (!s || !s.dataset.ready) return; s.innerHTML = ''; delete s.dataset.ready; s.classList.remove('loaded'); s.style.backgroundImage = ''; };

    const setCur = (i) => {
      if (i === cur) return;
      const prev = cur; cur = i;
      if (prev >= 0) { const pv = track.children[prev] && $('video', track.children[prev]); if (pv) pv.pause(); resetZoom(track.children[prev]); }
      for (let k = 0; k < files.length; k++) { if (Math.abs(k - i) <= 1) fill(k); else if (Math.abs(k - i) > 3) unfill(k); }
      paint();
    };
    const go = (i, smooth = true) => {
      i = Math.max(0, Math.min(files.length - 1, i));
      track.scrollTo({ left: i * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
      setCur(i);
    };
    const paint = () => {
      if (cur < 0) return;
      const f = files[cur];
      $('.gv-n', v).textContent = `${cur + 1} / ${files.length}`;
      $('.gv-name', v).textContent = f.name;
      $('.prev', v).hidden = cur === 0; $('.next', v).hidden = cur === files.length - 1;
      const pk = $('[data-gv="pick"]', v);
      if (pk) { const on = sel.has(cur); pk.classList.toggle('on', on); pk.querySelector('span').textContent = on ? 'Choisie' : 'Choisir'; }
      const gs = $('.gv-sel', v);
      if (gs) gs.innerHTML = sel.size ? `${sel.size} choisie${sel.size > 1 ? 's' : ''} · <button type="button" class="link-btn" data-gv="dlsel">les télécharger</button>` : '';
    };

    let raf = 0;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setCur(Math.round(track.scrollLeft / Math.max(1, track.clientWidth))));
    }, { passive: true });
    const onResize = () => { if (cur >= 0) track.scrollTo({ left: cur * track.clientWidth }); };
    window.addEventListener('resize', onResize);

    const close = (fromBack) => {
      if (closed) return; closed = true;
      v.querySelectorAll('video').forEach(x => x.pause());
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.documentElement.classList.remove('gal-locked');
      v.classList.add('closing');
      setTimeout(() => v.remove(), 180);
      if (!fromBack) popOverlay();
      // Retour sur la vignette regardée en dernier
      const tile = box.querySelector(`[data-gi="${cur}"]`); if (tile) tile.scrollIntoView({ block: 'nearest' });
      viewer = null;
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(cur + 1);
      else if (e.key === 'ArrowLeft') go(cur - 1);
    };
    document.addEventListener('keydown', onKey);
    pushOverlay(() => close(true));

    v.addEventListener('click', (e) => {
      const b = e.target.closest('[data-gv]');
      if (!b) return;
      const a = b.dataset.gv;
      if (a === 'close') close();
      else if (a === 'prev') go(cur - 1);
      else if (a === 'next') go(cur + 1);
      else if (a === 'pick') toggle(cur);
      else if (a === 'dl') downloadMany([files[cur]]);
      else if (a === 'dlsel') downloadMany([...sel].sort((x, y) => x - y).map(i => files[i]));
    });

    /* Zoom des photos : double-toucher (ou double-clic) et pincer ; on déplace la photo agrandie au doigt */
    function resetZoom(s) {
      const z = s && $('.gv-zoom', s); if (!z || !z._z) return;
      z._z.set(1, 0, 0);
    }
    function bindZoom(s) {
      const z = $('.gv-zoom', s); if (!z) return;
      let sc = 1, tx = 0, ty = 0;
      const pts = new Map();
      let pinch = null, pan = null, lastTap = 0, moved = false;
      const apply = (anim) => { z.style.transition = anim ? 'transform .22s ease' : 'none'; z.style.transform = `translate(${tx}px, ${ty}px) scale(${sc})`; };
      const clamp = () => {
        const mx = (z.clientWidth * (sc - 1)) / 2, my = (z.clientHeight * (sc - 1)) / 2;
        tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
      };
      const set = (nsc, ntx, nty, anim = true) => {
        sc = Math.max(1, Math.min(5, nsc)); tx = ntx; ty = nty;
        if (sc <= 1.01) { sc = 1; tx = 0; ty = 0; }
        clamp(); apply(anim);
        const zoomed = sc > 1;
        z.style.touchAction = zoomed ? 'none' : 'pan-x';
        track.classList.toggle('locked', zoomed);
        v.classList.toggle('zoomed', zoomed);
      };
      z._z = { set };
      z.style.touchAction = 'pan-x';
      const zoomAt = (cx, cy) => {
        if (sc > 1) return set(1, 0, 0);
        const r = z.getBoundingClientRect();
        const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
        set(2.5, -px * 1.5, -py * 1.5);
      };
      z.addEventListener('dblclick', (e) => { if (e.pointerType !== 'touch') zoomAt(e.clientX, e.clientY); });
      z.addEventListener('wheel', (e) => {
        if (!e.ctrlKey && sc === 1) return;   // molette simple : rien ; pincer sur pavé tactile = ctrl+molette
        e.preventDefault();
        set(sc * (e.deltaY < 0 ? 1.15 : 0.87), tx, ty, false);
      }, { passive: false });
      z.addEventListener('pointerdown', (e) => {
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), sc, tx, ty, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          pan = null;
        } else if (pts.size === 1 && sc > 1) {
          pan = { x: e.clientX, y: e.clientY, tx, ty };
          try { z.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
      });
      z.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        const p = pts.get(e.pointerId);
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) moved = true;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pts.size === 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          set(pinch.sc * d / pinch.d, pinch.tx + (cx - pinch.cx), pinch.ty + (cy - pinch.cy), false);
        } else if (pan) {
          tx = pan.tx + (e.clientX - pan.x); ty = pan.ty + (e.clientY - pan.y); clamp(); apply(false);
        }
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (pts.size < 2) pinch = null;
        if (!pts.size) pan = null;
        if (e.type === 'pointerup' && e.pointerType === 'touch' && !moved && !pts.size) {
          const now = Date.now();
          if (now - lastTap < 300) { lastTap = 0; zoomAt(e.clientX, e.clientY); }
          else lastTap = now;
        }
      };
      z.addEventListener('pointerup', up);
      z.addEventListener('pointercancel', up);
    }

    requestAnimationFrame(() => go(start, false));
    return { paint, close };
  }

  return { destroy() { if (viewer) viewer.close(); } };
}
