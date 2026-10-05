/* Lestha Send — lecteur en ligne + revue vidéo professionnelle
 * timecode image par image, raccourcis J/K/L, plages In/Out, annotations dessinées sur l'image,
 * fils de discussion, remarques « traitées », décisions (approuvé / modifications), versions V1→Vn,
 * exports EDL (DaVinci Resolve) / CSV / PDF, lecture des fichiers .TS (MPEG-TS) */
import { $, esc, icon, bytes, fileKind, ls, ss, api, visitorId, toast, relTime } from './core.js';
import { navigate } from './router.js';
import { track } from './ux.js';
import { FPS_LIST, tc, short, contentRect, drawShapes, exportEDL, exportCSV, printReport, exportXMEML, exportFCPXML } from './review-tools.js';
import * as PRO from './review-pro.js';

let root = null, id = null, data = null, cur = null, reportTimer = null, wmTimer = null, pollTimer = null, lastReport = 0;
let player = null, tsPlayer = null, rafId = 0, onKey = null, onResize = null;
let onFullscreenKey = null;
let fps = 25, inPt = null, outPt = null, loop = false, filter = 'all';
let drawMode = false, tool = 'arrow', color = '#f43f5e', shapes = [], shown = null, drawing = null, replyOpen = null;
/* revue « pro » : qualité lue, repères de cadrage, remarque vocale en attente, comparaison */
let X = null, srcSel = null, guide = { aspect: '', safe: false, thirds: false }, voice = null, waits = [], startAt = null;
let pendingSeek = null, onPendingMeta = null, lastSeek = 0, onGuideFs = null, recorder = null, voiceUrl = null, metaSeen = false;

const token = () => ss.get('tx_tk_' + id);
const q = (extra = '') => `v=${encodeURIComponent(visitorId())}${token() ? '&tk=' + encodeURIComponent(token()) : ''}${extra}`;
const src = (fid) => `/api/public/t/${id}/f/${fid}?${q('&inline=1')}`;
const kindOf = (f) => fileKind(f.name, f.type, f.size);
const isMedia = (f) => ['video', 'audio'].includes(kindOf(f).kind);
const rootOf = (f) => f.versionOf || f.id;
const COLORS = ['#f43f5e', '#fbbf24', '#22d3ee', '#a3e635', '#ffffff'];
const TOOLS = [['arrow', 'Flèche', '↗'], ['pen', 'Crayon', '✎'], ['rect', 'Cadre', '▭'], ['circle', 'Cercle', '◯']];

export default {
  async render(r, { match, params }) {
    root = r; id = match[1];
    root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:420px;border-radius:20px"></div></section>`;
    try { data = await api(`/api/public/t/${id}?${q()}`); }
    catch (e) { root.innerHTML = state('Lien introuvable', 'Ce contenu n\'existe plus ou a expiré.'); return; }
    if (data.locked) { navigate('/t/' + id, { replace: true }); return; }
    if (data.state !== 'ready' && data.state !== 'limit') { root.innerHTML = state('Contenu indisponible', data.state === 'expired' ? 'Ce lien a expiré.' : 'Ce contenu n\'est pas accessible pour le moment.'); return; }
    const media = (data.files || []).filter(isMedia);
    if (!media.length) { navigate('/t/' + id, { replace: true }); return; }
    fps = Number(ls.get('tx_fps', 25)) || 25;
    const wanted = params.get('f');
    cur = media.find(f => f.id === wanted) || latestOf(media, rootOf(media[0]));
    if (cur.fps) fps = cur.fps;                     // cadence détectée à l'envoi
    const tq = params.get('t'); startAt = tq != null && tq !== '' && Number(tq) >= 0 ? Number(tq) : null;
    inPt = outPt = null; shapes = []; shown = null; drawMode = false; replyOpen = null; voice = null; waits = []; metaSeen = false; pendingSeek = null; onPendingMeta = null;
    renderPage(media);
  },
  destroy() {
    report(true); clearInterval(reportTimer); clearInterval(wmTimer); clearInterval(pollTimer); cancelAnimationFrame(rafId);
    if (onKey) document.removeEventListener('keydown', onKey);
    if (onFullscreenKey) document.removeEventListener('keydown', onFullscreenKey);
    if (onResize) window.removeEventListener('resize', onResize);
    if (tsPlayer) { try { tsPlayer.destroy(); } catch (e) { /* ignore */ } tsPlayer = null; }
    if (X) { PRO.stopCompare(X); clearInterval(X.wmVTimer); }
    if (onGuideFs) { document.removeEventListener('fullscreenchange', onGuideFs); onGuideFs = null; }
    if (recorder) { recorder.kill(); recorder = null; }
    if (voiceUrl) { URL.revokeObjectURL(voiceUrl); voiceUrl = null; }
    root = null; player = null; X = null;
  }
};

function state(t, m) {
  return `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('film')}</div><h2>${esc(t)}</h2><p class="muted">${esc(m)}</p><a class="btn" href="/" data-link>${icon('upload')}Lestha Send</a></div></div></section>`;
}
function chainOf(media, rid) { return media.filter(f => rootOf(f) === rid).sort((a, b) => (a.v || 1) - (b.v || 1)); }
function latestOf(media, rid) { const c = chainOf(media, rid); return c[c.length - 1]; }
function subtitlesFor(f) {
  const b = f.name.replace(/\.[^.]+$/, '').toLowerCase();
  return (data.files || []).filter(x => /\.(vtt|srt)$/i.test(x.name) && x.name.toLowerCase().startsWith(b));
}
const myComments = () => (data.comments || []).filter(c => c.fid === cur.id);

/* ============================== page ============================== */
function renderPage(media) {
  const only = data.playback === 'only';
  const review = !!data.allowComments;
  const k = kindOf(cur);
  const isVideo = k.kind === 'video';
  const chain = chainOf(media, rootOf(cur));
  const roots = [...new Set(media.map(rootOf))];
  root.innerHTML = `
  <section class="watch-wrap">
    <div class="watch-main" data-back-slot>
      <div class="player-box ${only ? 'protected' : ''}" id="pbox">
        ${isVideo
          ? `<video id="player" class="player" controls playsinline preload="metadata" ${only ? 'controlsList="nodownload noremoteplayback" disableRemotePlayback' : ''}></video>`
          : `<div class="audio-art">${icon('music', 'xl')}</div><audio id="player" controls preload="metadata" ${only ? 'controlsList="nodownload"' : ''} style="width:100%"></audio>`}
        ${isVideo ? '<canvas class="guides-layer" id="rvGuides"></canvas><canvas class="draw-layer" id="draw"></canvas>' : ''}
        <div class="player-toolbar">
          ${isVideo ? '<span class="q-badge" id="qBadge"></span>' : ''}
          <button type="button" class="btn sm fullscreen-btn" id="fullscreen" aria-label="Passer en plein écran" title="Plein écran (F)">${icon('fullscreen', 'sm')}<span>Plein écran</span></button>
        </div>
        ${data.wmViewer ? `<div class="wm-gate hidden" id="wmGate"><form class="card stack" id="wmForm" style="gap:10px;max-width:340px"><b>${icon('shield', 'sm')} Visionnage protégé</b><span class="small muted">Votre nom s'affichera en filigrane sur l'image.</span><input class="input" id="wmName" maxlength="60" placeholder="Votre nom" required value="${esc(ls.get('tx_comment_name', ''))}"><button class="btn primary" type="submit">${icon('play', 'sm')}Regarder</button></form></div>` : ''}
        ${data.watermark ? `<div class="watermark" id="wm">${esc(data.watermark)}</div>` : ''}
        <div class="player-error hidden" id="perr"></div>
      </div>
      ${isVideo ? `
      <div class="rv-bar">
        <div class="rv-heat hidden" id="rvHeat"></div>
        <div class="rv-track" id="track" title="Cliquez pour aller à ce moment"><div class="rv-range hidden" id="trRange"></div><div class="rv-head" id="trHead"></div><div id="trReacts" class="rv-reacts-line"></div><div id="trMarks"></div></div>
        <div class="rv-ctrl">
          <button type="button" class="btn sm icon ghost" id="bBack" title="Image précédente (←)">‹</button>
          <button type="button" class="btn sm icon" id="bPlay" title="Lecture / pause (espace ou K)">${icon('play', 'sm')}</button>
          <button type="button" class="btn sm icon ghost" id="bFwd" title="Image suivante (→)">›</button>
          <span class="rv-tc" id="tc">00:00:00:00</span>
          <select class="input rv-sel" id="selFps" title="Images par seconde">${FPS_LIST.map(f => `<option value="${f}" ${f === fps ? 'selected' : ''}>${f} i/s</option>`).join('')}</select>
          <select class="input rv-sel" id="selQ" title="Qualité de lecture"></select>
          <select class="input rv-sel" id="selRate" title="Vitesse">${[0.25, 0.5, 1, 1.5, 2].map(r => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${r}×</option>`).join('')}</select>
          <span class="grow"></span>
          <button type="button" class="btn sm ghost" id="bIn" title="Début de plage (I)">I</button>
          <button type="button" class="btn sm ghost" id="bOut" title="Fin de plage (O)">O</button>
          <button type="button" class="btn sm ghost ${loop ? 'active' : ''}" id="bLoop" title="Boucler la plage">${icon('refresh', 'sm')}</button>
          ${review ? `<button type="button" class="btn sm ${drawMode ? 'primary' : 'ghost'}" id="bDraw" title="Dessiner sur l'image (D)">${icon('edit', 'sm')}Dessiner</button>` : ''}
        </div>
        <div class="rv-tools ${drawMode ? '' : 'hidden'}" id="drawTools">
          ${TOOLS.map(([t, l, g]) => `<button type="button" class="chip ${tool === t ? 'active' : ''}" data-tool="${t}" title="${l}">${g} ${l}</button>`).join('')}
          <span class="rv-colors">${COLORS.map(c => `<button type="button" class="rv-color ${color === c ? 'active' : ''}" data-color="${c}" style="--c:${c}" aria-label="Couleur"></button>`).join('')}</span>
          <button type="button" class="btn sm ghost" id="bUndo">Annuler</button><button type="button" class="btn sm ghost" id="bClear">Effacer</button>
        </div>
        <div class="rv-pro">
          <select class="input rv-sel" id="selGuide" title="Repères de cadrage">${PRO.GUIDES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          <button type="button" class="btn sm ghost" id="bSafe" title="Zones de sécurité action 93 % / titres 90 % (Z)">Zones</button>
          <button type="button" class="btn sm ghost" id="bThirds" title="Grille des tiers">Tiers</button>
          <button type="button" class="btn sm ghost" id="bShot" title="Capture PNG en pleine résolution avec timecode (P)">${icon('image', 'sm')}Capture</button>
          ${chain.length > 1 ? `<button type="button" class="btn sm ghost" id="bCmp" title="Comparer deux versions">${icon('layout', 'sm')}Comparer</button>` : ''}
          <button type="button" class="btn sm ghost" id="bShare" title="Copier un lien qui ouvre la vidéo à cet instant">${icon('link', 'sm')}Cet instant</button>
          ${review ? `<span class="grow"></span><span class="rv-emojis" id="rvEmojis" title="Réagir à ce moment">${['👍', '❤️', '🔥', '👏', '😂', '😮', '⚠️'].map(e => `<button type="button" class="rv-emo" data-emo="${e}">${e}</button>`).join('')}</span>` : ''}
        </div>
        <div class="rv-cmpbar hidden" id="cmpBar"></div>
        <div class="tiny faint rv-keys">Raccourcis : <b>espace/K</b> lecture · <b>J</b> −5 s · <b>L</b> avance rapide · <b>← →</b> image par image · <b>⇧ ← →</b> 1 s · <b>I / O</b> plage · <b>D</b> dessiner · <b>C</b> commenter · <b>P</b> capture · <b>Z</b> zones</div>
      </div>` : ''}
      <div class="watch-head">
        <div style="min-width:0">
          <h2 style="font-size:clamp(19px,3.4vw,26px)">${esc(cur.name.replace(/\.[^.]+$/, ''))}</h2>
          <div class="small muted" style="margin-top:4px">${data.senderName ? 'Partagé par ' + esc(data.senderName) + ' · ' : ''}${bytes(cur.size)}${only ? ' · <span style="color:#c4b5fd">visionnage seul</span>' : ''}</div>
          ${chain.length > 1 ? `<div class="chips" style="margin-top:10px">${chain.map(f => `<a class="chip ${f.id === cur.id ? 'active' : ''}" href="/w/${id}?f=${f.id}" data-link>V${f.v || 1}${f.id === chain[chain.length - 1].id ? ' · dernière' : ''}</a>`).join('')}</div>` : ''}
        </div>
        <div class="row">
          ${only ? '' : `<a class="btn sm" href="/api/public/t/${id}/f/${cur.id}?${q()}">${icon('download', 'sm')}Télécharger</a>`}
          <a class="btn sm ghost" href="/t/${id}" data-link>${icon('folder', 'sm')}Tous les fichiers</a>
        </div>
      </div>
      ${data.message ? `<div class="message-bubble">${esc(data.message)}</div>` : ''}
    </div>
    <aside class="watch-side stack">
      ${review ? `<div class="card" id="decCard"></div>` : ''}
      ${roots.length > 1 ? `<div class="card"><div class="card-title"><h3>${icon('film')}Playlist</h3><span class="small faint">${roots.length}</span></div><div class="stack" style="gap:6px">${roots.map(rid => { const f = latestOf(media, rid); const kk = kindOf(f); return `<a class="dl-row playlist-item ${rootOf(cur) === rid ? 'active' : ''}" href="/w/${id}?f=${f.id}" data-link><div class="ficon" style="--c:${kk.c};width:36px;height:36px">${icon(kk.icon, 'sm')}</div><div class="fmeta"><div class="fname">${f.v ? `<span class="pill violet" style="padding:1px 7px;margin-right:6px">V${f.v}</span>` : ''}${esc(f.name)}</div><div class="fsub">${bytes(f.size)}${ls.get('tx_pos_' + id + f.id) ? ' · reprendre à ' + short(ls.get('tx_pos_' + id + f.id)) : ''}</div></div></a>`; }).join('')}</div></div>` : ''}
      ${review ? `<div class="card"><div class="card-title"><h3>${icon('message')}Remarques</h3><span class="small faint" id="cCount"></span></div>
        <form id="cForm" class="stack" style="gap:8px">
          <input class="input" id="cName" maxlength="60" placeholder="Votre nom" value="${esc(ls.get('tx_comment_name', ''))}">
          <textarea class="input" id="cText" maxlength="500" placeholder="Votre remarque à ce moment précis… (C)" style="min-height:64px"></textarea>
          <div class="small faint" id="cMeta"></div>
          <div class="rv-voice hidden" id="cVoice"></div>
          <div class="row" style="gap:6px"><button type="button" class="btn sm ghost icon" id="cMic" title="Remarque vocale (90 s au plus)" aria-label="Remarque vocale">${icon('mic', 'sm')}</button><button class="btn primary sm grow" type="submit">${icon('message', 'sm')}Commenter à <span id="cAt">0:00</span></button></div>
        </form>
        <div class="row" style="justify-content:space-between;margin-top:12px;gap:6px;flex-wrap:wrap">
          <div class="chips" id="cFilter">${[['all', 'Toutes'], ['open', 'À traiter'], ['done', 'Traitées']].map(([v, l]) => `<button type="button" class="chip ${filter === v ? 'active' : ''}" data-f="${v}">${l}</button>`).join('')}</div>
          <div class="row" style="gap:4px;flex-wrap:wrap"><button type="button" class="btn sm ghost" id="xEdl" title="Marqueurs pour DaVinci Resolve">EDL</button><button type="button" class="btn sm ghost" id="xPr" title="Marqueurs pour Adobe Premiere Pro (XML)">Premiere</button><button type="button" class="btn sm ghost" id="xFc" title="Marqueurs pour Final Cut Pro et DaVinci Resolve (FCPXML)">Final Cut</button><button type="button" class="btn sm ghost" id="xCsv" title="Tableau Excel / Sheets">CSV</button><button type="button" class="btn sm ghost" id="xPdf" title="Rapport imprimable / PDF">PDF</button></div>
        </div>
        <div class="stack comments" id="cList" style="gap:6px;margin-top:10px"></div></div>` : ''}
      <div class="tip">${icon('refresh')}<span>La lecture reprend automatiquement là où vous vous étiez arrêté${only ? '. L\'expéditeur a désactivé le téléchargement de ce contenu' : ''}.</span></div>
    </aside>
  </section>`;
  player = $('#player');
  X = { id, data, cur, player, src, fps: () => fps, curLabel: 'V' + (cur.v || 1), originalSrc: k.ts ? null : src(cur.id), wmVTimer: null, compare: null };
  srcSel = isVideo ? chooseSource(ls.get('tx_q', 'auto')) : null;
  attachSource(k);
  const fullscreenButton = $('#fullscreen', root);
  const playerBox = $('#pbox', root);
  fullscreenButton.disabled = !playerBox.requestFullscreen && !(isVideo && player.webkitEnterFullscreen);
  fullscreenButton.onclick = () => togglePlayerFullscreen(playerBox, player);
  onFullscreenKey = (e) => {
    if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') ||
        document.activeElement?.isContentEditable) return;
    e.preventDefault();
    togglePlayerFullscreen(playerBox, player);
  };
  document.addEventListener('keydown', onFullscreenKey);
  subtitlesFor(cur).forEach(async (s, i) => {
    try {
      let txt = await (await fetch(src(s.id))).text();
      if (/\.srt$/i.test(s.name)) txt = 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = (s.name.match(/\.([a-z]{2,3})\.(srt|vtt)$/i) || [, 'Sous-titres'])[1].toUpperCase(); tr.srclang = 'fr';
      tr.src = URL.createObjectURL(new Blob([txt], { type: 'text/vtt' }));
      if (i === 0) tr.default = true;
      player.appendChild(tr);
    } catch (e) { /* ignore */ }
  });
  const saved = Number(ls.get('tx_pos_' + id + cur.id, 0));
  player.addEventListener('loadedmetadata', () => {
    if (startAt != null && startAt < player.duration) { player.currentTime = startAt; toast('Ouvert à ' + tc(startAt, fps), 'info'); }
    else if (saved > 5 && saved < player.duration - 10) { player.currentTime = saved; toast('Reprise à ' + short(saved), 'info'); }
    metaSeen = true; paintMarks(); sizeCanvas(); proPaint();
  }, { once: true });
  player.addEventListener('timeupdate', () => {
    if (Math.abs((ls.get('tx_pos_' + id + cur.id, 0)) - player.currentTime) > 4) ls.set('tx_pos_' + id + cur.id, Math.floor(player.currentTime));
    if (loop && inPt != null && outPt != null && player.currentTime >= outPt) player.currentTime = inPt;
    if (Date.now() - lastReport > 15000) report();
  });
  player.addEventListener('play', () => { shown = null; if (!drawMode) redraw(); syncPlayBtn(); });
  player.addEventListener('pause', () => { report(true); syncPlayBtn(); });
  player.addEventListener('ended', () => { ls.del('tx_pos_' + id + cur.id); report(true, 100); });
  player.addEventListener('error', () => { if (!tsPlayer && (!srcSel || srcSel.original)) showError(); });
  if (only) $('#pbox').addEventListener('contextmenu', (e) => e.preventDefault());
  const wm = $('#wm');
  if (wm) { const move = () => { wm.style.left = (8 + Math.random() * 60) + '%'; wm.style.top = (8 + Math.random() * 70) + '%'; }; move(); clearInterval(wmTimer); wmTimer = setInterval(move, 12000); }
  if (isVideo) { bindReviewBar(review); bindPro(review, chain); }
  if (review) { bindComments(); renderDecision(); startPolling(); }
  if (data.wmViewer) bindViewerWatermark();
  clearInterval(reportTimer);
  reportTimer = setInterval(() => { if (player && !player.paused) report(); }, 15000);
  cancelAnimationFrame(rafId);
  const tick = () => { if (!root || !player) return; updateClock(); rafId = requestAnimationFrame(tick); };
  rafId = requestAnimationFrame(tick);
}

function showError(extra) {
  const e = $('#perr'); if (!e) return;
  e.classList.remove('hidden');
  const only = data.playback === 'only';
  e.innerHTML = `${icon('x', 'lg')}<b>Lecture impossible dans ce navigateur</b><span class="small">${extra || 'Format probablement non pris en charge (MKV, AVI, H.265…).'} ${only ? 'Demandez à l\'expéditeur un export MP4 (H.264).' : 'Téléchargez le fichier pour le lire avec VLC, ou demandez un export MP4.'}</span>`;
}

async function togglePlayerFullscreen(box, media) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (box.requestFullscreen) await box.requestFullscreen();
    else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
  } catch (e) {
    toast('Impossible d’activer le plein écran dans ce navigateur.', 'warn');
  }
}

/** Source : lecture native, ou MPEG-TS (.ts / .m2ts) via mpegts.js (Media Source Extensions) */
async function attachSource(k) {
  const sel = srcSel || { id: cur.id, original: true };
  if (!k.ts || !sel.original) { player.src = src(sel.id); return; }
  try {
    if (!window.mpegts) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/mpegts.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    const m = window.mpegts;
    if (!m || !m.isSupported()) return showError(window.MediaSource || window.ManagedMediaSource ? 'Ce navigateur ne décode pas la vidéo H.264 des fichiers .TS : essayez Chrome, Edge ou Safari.' : 'Les fichiers .TS se lisent sur ordinateur et Android, mais pas sur iPhone/iPad.');
    tsPlayer = m.createPlayer({ type: 'mpegts', isLive: false, url: location.origin + src(cur.id) }, { enableWorker: true, seekType: 'range', lazyLoad: false });
    tsPlayer.on(m.Events.ERROR, () => showError('Ce fichier .TS utilise un codec non pris en charge par le navigateur (H.264 + AAC requis).'));
    tsPlayer.attachMediaElement(player);
    tsPlayer.load();
  } catch (e) { showError('Le lecteur .TS n\'a pas pu démarrer.'); }
}

/* ============================== revue « pro » ============================== */
function chooseSource(pref) {
  const list = PRO.sourcesOf(cur);
  if (pref === 'auto' || pref == null) return Object.assign({ auto: true }, PRO.autoPick(list));
  const want = Number(pref);
  return list.filter(s => s.h <= want).pop() || list[0];
}
function paintQ() {
  const list = PRO.sourcesOf(cur), pref = ls.get('tx_q', 'auto');
  const sel = $('#selQ'), badge = $('#qBadge');
  if (sel) {
    sel.classList.toggle('hidden', list.length < 2);
    sel.innerHTML = `<option value="auto" ${pref === 'auto' ? 'selected' : ''}>Auto${srcSel && srcSel.auto ? ' · ' + srcSel.label.replace('Original · ', '') : ''}</option>` + list.slice().reverse().map(s => `<option value="${s.original ? 'orig' : s.h}" ${pref !== 'auto' && srcSel && srcSel.id === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  }
  if (badge) { badge.textContent = srcSel ? srcSel.label.replace('Original · ', 'Original ') : ''; badge.classList.toggle('hidden', !srcSel || list.length < 2); }
}
function switchSource(next, why) {
  if (!next || !player) return;
  if (srcSel && next.id === srcSel.id) { srcSel = next; paintQ(); return; }
  // Avant le tout premier chargement, la reprise (instant demandé, position sauvegardée) s'en charge déjà
  if (!metaSeen) { srcSel = next; if (tsPlayer) { try { tsPlayer.destroy(); } catch (e) { /* ignore */ } tsPlayer = null; } attachSource(kindOf(cur)); paintQ(); if (why) toast(why, 'info', { duration: 3500 }); return; }
  // Deux changements rapprochés : on garde la position d'avant le premier (la vidéo n'a pas encore rechargé)
  if (!pendingSeek) pendingSeek = { t: player.currentTime, playing: !player.paused, rate: player.playbackRate };
  srcSel = next;
  if (tsPlayer) { try { tsPlayer.destroy(); } catch (e) { /* ignore */ } tsPlayer = null; }
  if (onPendingMeta) player.removeEventListener('loadedmetadata', onPendingMeta);
  onPendingMeta = () => {
    const ps = pendingSeek; pendingSeek = null; onPendingMeta = null; if (!ps || !player) return;
    player.currentTime = ps.t; player.playbackRate = ps.rate; if (ps.playing) player.play().catch(() => {}); sizeCanvas(); proPaint();
  };
  player.addEventListener('loadedmetadata', onPendingMeta, { once: true });
  attachSource(kindOf(cur));
  paintQ();
  if (why) toast(why, 'info', { duration: 3500 });
}
/** Saccades répétées en mode Auto : on descend d'une qualité pour rester fluide */
function onWaiting() {
  if (!srcSel || !srcSel.auto || player.paused || player.seeking || player.currentTime < 1 || Date.now() - lastSeek < 2500) return;
  const now = Date.now(); waits = waits.filter(x => now - x < 30000); waits.push(now);
  if (waits.length < 3) return;
  waits = [];
  const list = PRO.sourcesOf(cur), i = list.findIndex(s => s.id === srcSel.id);
  if (i > 0) switchSource(Object.assign({ auto: true }, list[i - 1]), `Connexion lente : passage en ${list[i - 1].label} pour rester fluide`);
}
function proPaint() {
  if (!X || !player || !player.duration) return;
  PRO.drawWave(X); PRO.drawGuides(X, guide);
  PRO.paintReacts(X, (data.reacts || []).filter(r => r.fid === cur.id));
  PRO.drawHeat(X, myComments(), (data.reacts || []).filter(r => r.fid === cur.id));
}
function bindPro(review, chain) {
  paintQ();
  $('#selQ').onchange = (e) => {
    const v = e.target.value; ls.set('tx_q', v === 'orig' ? '99999' : v);
    switchSource(chooseSource(v === 'orig' ? 99999 : v));
  };
  player.addEventListener('waiting', onWaiting);
  player.addEventListener('seeking', () => { lastSeek = Date.now(); });
  // Qualité illisible par ce navigateur (codec) : retour automatique à l'original
  player.addEventListener('error', () => { if (srcSel && !srcSel.original) { const o = PRO.sourcesOf(cur).pop(); switchSource(Object.assign({ auto: srcSel.auto }, o), 'Cette qualité ne se lit pas ici : lecture de l\'original'); } });
  PRO.bindHoverPreview(X);
  const g = () => PRO.drawGuides(X, guide);
  $('#selGuide').onchange = (e) => { guide.aspect = e.target.value; g(); };
  const tog = (btn, k) => { guide[k] = !guide[k]; btn.classList.toggle('active', guide[k]); g(); };
  $('#bSafe').onclick = (e) => tog(e.currentTarget, 'safe');
  $('#bThirds').onclick = (e) => tog(e.currentTarget, 'thirds');
  if (onGuideFs) document.removeEventListener('fullscreenchange', onGuideFs);
  onGuideFs = g; document.addEventListener('fullscreenchange', g);
  if (data.playback === 'only') { const bs = $('#bShot'); if (bs) bs.remove(); }   // visionnage seul : pas d'export d'image
  const bsh = $('#bShot'); if (bsh) bsh.onclick = shot;
  $('#bShare').onclick = () => PRO.shareMoment(X);
  const bc = $('#bCmp'); if (bc) bc.onclick = () => openCompare(chain);
  const emo = $('#rvEmojis');
  if (emo) emo.onclick = async (e) => {
    const b = e.target.closest('[data-emo]'); if (!b) return;
    PRO.burstReact(b.dataset.emo);
    try { const r = await api(`/api/public/t/${id}/react?${q()}`, { method: 'POST', body: { fid: cur.id, time: player.currentTime, e: b.dataset.emo, v: visitorId() } }); data.reacts = r.reacts; proPaint(); }
    catch (err) { toast(err.message, 'warn'); }
  };
}
async function shot() {
  if (!X || data.playback === 'only' || !$('#bShot')) return;
  toast('Capture en cours…', 'info', { duration: 1500 });
  try { const r = await PRO.captureFrame(X, { shapes: drawMode || shapes.length ? shapes : (shown || []), wmText: data.wmViewer ? PRO.savedName() : '', staticWm: data.watermark || '' }); toast(`Image ${r.W} × ${r.H} enregistrée`, 'success'); track('use', { m: 'capture' }); }
  catch (e) { toast('Capture impossible : le stockage n\'autorise pas la lecture de l\'image depuis ce site (règle CORS « GET » du bucket R2).', 'error', { duration: 8000 }); }
}
function openCompare(chain) {
  const bar = $('#cmpBar'); if (!bar) return;
  if (X.compare) { PRO.stopCompare(X); bar.classList.add('hidden'); $('#bCmp').classList.remove('active'); return; }
  const others = chain.filter(f => f.id !== cur.id);
  let other = others.filter(f => (f.v || 1) < (cur.v || 1)).pop() || others[0], mode = 'wipe';
  const start = () => {
    const h = srcSel ? srcSel.h : 10000, os = PRO.sourcesOf(other), pick = os.filter(s => s.h <= h).pop() || os[0];
    PRO.startCompare(X, { srcId: pick.id, label: 'V' + (other.v || 1) }, mode);
    bar.innerHTML = `<span class="small muted">Comparer V${cur.v || 1} avec</span>${others.map(f => `<button type="button" class="chip ${f.id === other.id ? 'active' : ''}" data-cv="${f.id}">V${f.v || 1}</button>`).join('')}
      <span class="grow"></span><span class="chips"><button type="button" class="chip ${mode === 'wipe' ? 'active' : ''}" data-cm="wipe">Rideau</button><button type="button" class="chip ${mode === 'side' ? 'active' : ''}" data-cm="side">Côte à côte</button></span>
      <button type="button" class="btn sm ghost" data-cx>${icon('x', 'sm')}Fermer</button>`;
  };
  bar.classList.remove('hidden'); $('#bCmp').classList.add('active');
  bar.onclick = (e) => {
    const v = e.target.closest('[data-cv]'), m = e.target.closest('[data-cm]'), x = e.target.closest('[data-cx]');
    if (v) { other = chain.find(f => f.id === v.dataset.cv); start(); }
    if (m) { mode = m.dataset.cm; start(); }
    if (x) openCompare(chain);
  };
  start();
}
function bindViewerWatermark() {
  const gate = $('#wmGate'), name = PRO.savedName();
  const go = (n) => { gate && gate.classList.add('hidden'); PRO.viewerWatermark(X, n); };
  if (name) return go(name);
  gate.classList.remove('hidden');
  player.addEventListener('play', () => { if (!gate.classList.contains('hidden')) player.pause(); });
  $('#wmForm').onsubmit = (e) => {
    e.preventDefault(); const n = $('#wmName').value.trim(); if (!n) return;
    ls.set('tx_comment_name', n); const c = $('#cName'); if (c) c.value = n; go(n); player.play().catch(() => {});
  };
}

/* ============================== barre de revue ============================== */
function updateClock() {
  const t = player.currentTime || 0;
  const el = $('#tc'); if (el) el.textContent = tc(t, fps);
  const at = $('#cAt'); if (at) at.textContent = inPt != null && outPt != null ? short(inPt) + ' → ' + short(outPt) : tc(t, fps);
  const head = $('#trHead'); if (head && player.duration) head.style.left = (t / player.duration * 100) + '%';
}
function syncPlayBtn() { const b = $('#bPlay'); if (b) b.innerHTML = icon(player.paused ? 'play' : 'pause', 'sm'); }
function step(frames) { player.pause(); player.currentTime = Math.max(0, Math.min((player.duration || 1e9) - 0.001, player.currentTime + frames / fps + 0.0001)); }
function setIn() { inPt = player.currentTime; if (outPt != null && outPt <= inPt) outPt = null; paintRange(); updateMeta(); }
function setOut() { outPt = player.currentTime; if (inPt == null || inPt >= outPt) inPt = Math.max(0, outPt - 2); paintRange(); updateMeta(); }
function clearRange() { inPt = outPt = null; paintRange(); updateMeta(); }
function paintRange() {
  const r = $('#trRange'); if (!r || !player.duration) return;
  if (inPt == null || outPt == null) { r.classList.add('hidden'); return; }
  r.classList.remove('hidden'); r.style.left = (inPt / player.duration * 100) + '%'; r.style.width = ((outPt - inPt) / player.duration * 100) + '%';
}
function paintMarks() {
  const box = $('#trMarks'); if (!box || !player || !player.duration) return;
  box.innerHTML = myComments().filter(c => !c.parent).map(c => {
    const l = c.time / player.duration * 100, w = c.end ? Math.max(0.6, (c.end - c.time) / player.duration * 100) : 0;
    return `<button type="button" class="rv-mark ${c.resolved ? 'done' : ''} ${w ? 'span' : ''}" data-cid="${c.id}" style="left:${l}%;${w ? 'width:' + w + '%' : ''}" title="${esc(short(c.time) + ' · ' + c.name + ' : ' + c.text)}"></button>`;
  }).join('');
}
function updateMeta() {
  const m = $('#cMeta'); if (!m) return;
  const parts = [];
  if (inPt != null && outPt != null) parts.push(`Plage ${tc(inPt, fps)} → ${tc(outPt, fps)} <a href="#" id="clrRange">retirer</a>`);
  if (shapes.length) parts.push(`${shapes.length} annotation(s) dessinée(s) <a href="#" id="clrDraw">effacer</a>`);
  m.innerHTML = parts.join(' · ');
  const a = $('#clrRange'); if (a) a.onclick = (e) => { e.preventDefault(); clearRange(); };
  const b = $('#clrDraw'); if (b) b.onclick = (e) => { e.preventDefault(); shapes = []; redraw(); updateMeta(); };
}

function bindReviewBar(review) {
  $('#bPlay').onclick = () => (player.paused ? player.play().catch(() => {}) : player.pause());
  $('#bBack').onclick = () => step(-1);
  $('#bFwd').onclick = () => step(1);
  $('#selFps').onchange = (e) => { fps = Number(e.target.value); ls.set('tx_fps', fps); };
  $('#selRate').onchange = (e) => { player.playbackRate = Number(e.target.value); };
  $('#bIn').onclick = setIn; $('#bOut').onclick = setOut;
  $('#bLoop').onclick = (e) => { loop = !loop; e.currentTarget.classList.toggle('active', loop); toast(loop ? 'Boucle sur la plage I → O' : 'Boucle désactivée', 'info'); };
  $('#track').onclick = (e) => {
    const mk = e.target.closest('[data-cid]');
    if (mk) return openComment(mk.dataset.cid);
    const r = e.currentTarget.getBoundingClientRect();
    if (player.duration) player.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * player.duration;
  };
  if (review) {
    $('#bDraw').onclick = () => toggleDraw();
    $('#drawTools').onclick = (e) => {
      const t = e.target.closest('[data-tool]'), c = e.target.closest('[data-color]');
      if (t) { tool = t.dataset.tool; $('#drawTools').querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b === t)); }
      if (c) { color = c.dataset.color; $('#drawTools').querySelectorAll('[data-color]').forEach(b => b.classList.toggle('active', b === c)); }
    };
    $('#bUndo').onclick = () => { shapes.pop(); redraw(); updateMeta(); };
    $('#bClear').onclick = () => { shapes = []; redraw(); updateMeta(); };
    bindCanvas();
  }
  onResize = () => { sizeCanvas(); proPaint(); };
  window.addEventListener('resize', onResize);
  onKey = (e) => {
    if (!root || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    const k = e.key.toLowerCase();
    const act = {
      ' ': () => (player.paused ? player.play().catch(() => {}) : player.pause()),
      k: () => { player.pause(); player.playbackRate = 1; },
      j: () => { player.currentTime = Math.max(0, player.currentTime - 5); },
      l: () => { if (player.paused) { player.playbackRate = 1; player.play().catch(() => {}); } else player.playbackRate = Math.min(4, player.playbackRate * 2); toast('Vitesse ' + player.playbackRate + '×', 'info', { duration: 900 }); },
      arrowleft: () => (e.shiftKey ? (player.currentTime = Math.max(0, player.currentTime - 1)) : step(-1)),
      arrowright: () => (e.shiftKey ? (player.currentTime = player.currentTime + 1) : step(1)),
      i: setIn, o: setOut,
      d: () => { if (data.allowComments) toggleDraw(); },
      c: () => { const t = $('#cText'); if (t) { player.pause(); t.focus(); } },
      p: () => shot(),
      z: () => { const b = $('#bSafe'); if (b) b.click(); },
      escape: () => { if (drawMode) toggleDraw(false); else clearRange(); }
    }[k];
    if (act) { e.preventDefault(); act(); }
  };
  document.addEventListener('keydown', onKey);
}

/* ============================== dessin ============================== */
function sizeCanvas() {
  const cv = $('#draw'), box = $('#pbox'); if (!cv || !box) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = box.clientWidth * dpr; cv.height = box.clientHeight * dpr;
  redraw();
}
function redraw() {
  const cv = $('#draw'), box = $('#pbox'); if (!cv || !player) return;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height);
  const rect = contentRect(player, box), dpr = cv.width / (box.clientWidth || 1);
  if (shown) drawShapes(ctx, shown, rect, dpr);
  if (drawMode || shapes.length) drawShapes(ctx, shapes, rect, dpr);
  if (drawing) drawShapes(ctx, [drawing], rect, dpr);
}
function toggleDraw(on) {
  drawMode = on == null ? !drawMode : on;
  if (drawMode) { player.pause(); shown = null; }
  $('#draw').classList.toggle('active', drawMode);
  $('#drawTools').classList.toggle('hidden', !drawMode);
  const b = $('#bDraw'); b.classList.toggle('primary', drawMode); b.classList.toggle('ghost', !drawMode);
  if (drawMode) toast('Dessinez sur l\'image, puis écrivez votre remarque', 'info');
  redraw();
}
function bindCanvas() {
  const cv = $('#draw'), box = $('#pbox');
  const pos = (e) => { const r = contentRect(player, box), b = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - b.left - r.x) / r.w)), Math.max(0, Math.min(1, (e.clientY - b.top - r.y) / r.h))]; };
  cv.addEventListener('pointerdown', (e) => {
    if (!drawMode) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    drawing = { t: tool, c: color, p: tool === 'pen' ? [x, y, x, y] : [x, y, x, y] };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const [x, y] = pos(e);
    if (drawing.t === 'pen') { const n = drawing.p.length; if (Math.hypot(x - drawing.p[n - 2], y - drawing.p[n - 1]) > 0.004 && n < 600) drawing.p.push(x, y); }
    else { drawing.p[2] = x; drawing.p[3] = y; }
    redraw();
  });
  const end = () => {
    if (!drawing) return;
    const p = drawing.p, big = drawing.t === 'pen' ? p.length > 4 : Math.hypot(p[2] - p[0], p[3] - p[1]) > 0.01;
    if (big && shapes.length < 30) shapes.push(drawing);
    drawing = null; redraw(); updateMeta();
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
}

/* ============================== remarques ============================== */
function openComment(cid) {
  const c = (data.comments || []).find(x => x.id === cid); if (!c) return;
  player.pause(); player.currentTime = c.time;
  if (c.end) { inPt = c.time; outPt = c.end; paintRange(); }
  shown = c.draw || null; if (drawMode) toggleDraw(false); else redraw();
  const el = $(`[data-c="${cid}"]`); if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}

function renderList() {
  const box = $('#cList'); if (!box) return;
  const all = myComments(), tops = all.filter(c => !c.parent).sort((a, b) => a.time - b.time);
  const open = tops.filter(c => !c.resolved).length;
  $('#cCount').textContent = tops.length ? `${open} à traiter / ${tops.length}` : '';
  const list = tops.filter(c => filter === 'all' || (filter === 'open' ? !c.resolved : c.resolved));
  const others = (data.files || []).filter(f => f.id !== cur.id && rootOf(f) === rootOf(cur)).map(f => ({ v: f.v || 1, n: (data.comments || []).filter(c => c.fid === f.id && !c.parent).length })).filter(x => x.n);
  box.innerHTML = (list.length ? list.map(c => {
    const reps = all.filter(r => r.parent === c.id).sort((a, b) => a.at - b.at);
    return `<div class="rv-comment ${c.resolved ? 'done' : ''}" data-c="${c.id}">
      <div class="row" style="gap:8px;align-items:flex-start">
        <button type="button" class="c-time" data-open="${c.id}" title="Aller à ce moment">${tc(c.time, fps)}${c.end ? '<br>→ ' + tc(c.end, fps) : ''}</button>
        <div class="grow" style="min-width:0"><b>${esc(c.name)}</b> <span class="tiny faint">${relTime(c.at)}</span>${c.draw ? ` <button type="button" class="rv-pill" data-open="${c.id}">${icon('edit', 'sm')}dessin</button>` : ''}<div class="c-text">${esc(c.text)}</div>${c.voice ? `<audio class="rv-audio" controls preload="none" src="/api/public/t/${id}/voice/${c.id}?${q()}"></audio>` : ''}</div>
        <label class="rv-check" title="${c.resolved ? 'Traité' + (c.resolvedBy ? ' par ' + esc(c.resolvedBy) : '') : 'Marquer comme traité'}"><input type="checkbox" data-res="${c.id}" ${c.resolved ? 'checked' : ''}><span>${icon('check', 'sm')}</span></label>
      </div>
      ${reps.map(r => `<div class="rv-reply"><b>${esc(r.name)}</b> ${esc(r.text)} <span class="tiny faint">${relTime(r.at)}</span></div>`).join('')}
      ${replyOpen === c.id ? `<form class="rv-replyform" data-rf="${c.id}"><input class="input" maxlength="500" placeholder="Votre réponse…" autofocus><button class="btn sm primary" type="submit">Répondre</button></form>` : `<button type="button" class="linkish tiny" data-reply="${c.id}">Répondre${reps.length ? ' · ' + reps.length : ''}</button>`}
    </div>`;
  }).join('') : `<p class="small faint">${tops.length ? 'Aucune remarque dans ce filtre.' : 'Aucune remarque. Mettez en pause au bon moment (ou marquez une plage avec I et O), dessinez si besoin, puis écrivez.'}</p>`)
    + (others.length ? `<p class="tiny faint" style="margin-top:6px">Autres versions : ${others.map(o => `V${o.v} · ${o.n} remarque(s)`).join(' · ')}</p>` : '');
  paintMarks(); proPaint();
  const rf = box.querySelector('.rv-replyform input'); if (rf) rf.focus();
}

function bindComments() {
  renderList(); updateMeta();
  $('#cFilter').onclick = (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; $('#cFilter').querySelectorAll('[data-f]').forEach(x => x.classList.toggle('active', x === b)); renderList(); };
  $('#cList').onclick = async (e) => {
    const o = e.target.closest('[data-open]'); if (o) return openComment(o.dataset.open);
    const rp = e.target.closest('[data-reply]'); if (rp) { replyOpen = rp.dataset.reply; renderList(); return; }
  };
  $('#cList').onchange = async (e) => {
    const cb = e.target.closest('[data-res]'); if (!cb) return;
    try {
      const r = await api(`/api/public/t/${id}/comments/${cb.dataset.res}/resolve?${q()}`, { method: 'POST', body: { resolved: cb.checked, name: nameVal() } });
      data.comments = r.comments; renderList(); toast(cb.checked ? 'Remarque traitée ✅' : 'Remarque rouverte', 'success');
    } catch (err) { toast(err.message, 'error'); cb.checked = !cb.checked; }
  };
  $('#cList').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.closest('[data-rf]'); if (!f) return;
    const text = f.querySelector('input').value.trim(); if (!text) return;
    try {
      const r = await api(`/api/public/t/${id}/comments?${q()}`, { method: 'POST', body: { fid: cur.id, parent: f.dataset.rf, text, name: nameVal(), v: visitorId() } });
      data.comments = r.comments; replyOpen = null; renderList();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#cText').addEventListener('focus', () => player && player.pause());
  const vbox = $('#cVoice');
  const rec = recorder = PRO.voiceRecorder($('#cMic'), (blob, dur) => {
    voice = blob ? { blob, dur } : null;
    if (voiceUrl) { URL.revokeObjectURL(voiceUrl); voiceUrl = null; }
    if (!voice) { vbox.classList.add('hidden'); vbox.innerHTML = ''; return; }
    if (player) player.pause();
    vbox.classList.remove('hidden');
    voiceUrl = URL.createObjectURL(blob);
    vbox.innerHTML = `<audio controls src="${voiceUrl}"></audio><button type="button" class="btn sm ghost" id="cVoiceX">${icon('trash', 'sm')}</button>`;
    $('#cVoiceX').onclick = () => rec.clear();
  });
  $('#cForm').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#cText').value.trim(); if (!text && !voice) return;
    const hasRange = inPt != null && outPt != null;
    const body = { fid: cur.id, time: hasRange ? inPt : player.currentTime, text, name: nameVal(), v: visitorId() };
    if (voice) { body.voice = await PRO.blobToB64(voice.blob); body.voiceType = voice.blob.type; body.voiceDur = voice.dur; }
    if (hasRange) body.end = outPt;
    if (shapes.length) body.draw = shapes;
    try {
      const r = await api(`/api/public/t/${id}/comments?${q()}`, { method: 'POST', body });
      data.comments = r.comments; $('#cText').value = ''; track('use', { m: voice ? 'voice' : 'review' });
      if (voice) rec.clear();
      shapes = []; if (drawMode) toggleDraw(false); clearRange(); redraw(); renderList();
      toast('Remarque ajoutée à ' + tc(r.comment.time, fps), 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  const fileForExport = () => ({ name: cur.name, v: cur.v });
  $('#xEdl').onclick = () => { exportEDL(fileForExport(), myComments(), fps, 1); toast('EDL téléchargé : dans DaVinci Resolve, clic droit sur la timeline › Timelines › Import › Timeline Markers from EDL', 'info', { duration: 9000 }); };
  $('#xCsv').onclick = () => exportCSV(fileForExport(), myComments(), fps);
  const info = () => ({ duration: player && player.duration, vw: cur.vw || (player && player.videoWidth), vh: cur.vh || (player && player.videoHeight) });
  $('#xPr').onclick = () => { exportXMEML(fileForExport(), myComments(), fps, info()); toast('Dans Premiere Pro : Fichier › Importer, choisissez le fichier .xml : une séquence avec les marqueurs apparaît', 'info', { duration: 9000 }); };
  $('#xFc').onclick = () => { exportFCPXML(fileForExport(), myComments(), fps, info()); toast('Dans Final Cut Pro ou DaVinci Resolve : Fichier › Importer › XML', 'info', { duration: 9000 }); };
  $('#xPdf').onclick = () => { if (!printReport(fileForExport(), myComments(), fps, (data.reviews || {})[cur.id] || [])) toast('Autorisez les fenêtres pop-up pour imprimer le rapport', 'error'); };
}
function nameVal() { const n = ($('#cName')?.value || '').trim(); ls.set('tx_comment_name', n); return n; }

/* ============================== décision ============================== */
function renderDecision() {
  const box = $('#decCard'); if (!box) return;
  const list = (data.reviews || {})[cur.id] || [];
  const mine = list.find(r => r.name && r.name === ls.get('tx_comment_name', ''));
  const label = { approved: ['ok', 'Approuvé', 'check'], changes: ['warn', 'Modifications demandées', 'edit'] };
  box.innerHTML = `<div class="card-title"><h3>${icon('shield')}Validation${cur.v ? ' · V' + cur.v : ''}</h3></div>
    <div class="rv-decide">
      <button type="button" class="btn sm ${mine?.status === 'approved' ? 'primary' : ''}" data-dec="approved">${icon('check', 'sm')}Approuver</button>
      <button type="button" class="btn sm ${mine?.status === 'changes' ? 'danger' : ''}" data-dec="changes">${icon('edit', 'sm')}Demander des modifs</button>
    </div>
    ${list.length ? `<div class="stack" style="gap:6px;margin-top:10px">${list.map(r => `<div class="rv-verdict ${label[r.status]?.[0] || ''}">${icon(label[r.status]?.[2] || 'clock', 'sm')}<b>${esc(r.name)}</b><span>${label[r.status]?.[1] || ''}</span><span class="tiny faint" style="margin-left:auto">${relTime(r.at)}</span></div>`).join('')}</div>` : '<p class="tiny faint" style="margin-top:8px">Donnez votre verdict une fois vos remarques faites : l\'auteur est prévenu.</p>'}`;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-dec]'); if (!b) return;
    const name = nameVal();
    if (!name) { toast('Indiquez votre nom dans « Remarques » d\'abord', 'error'); $('#cName')?.focus(); return; }
    const status = mine?.status === b.dataset.dec ? 'pending' : b.dataset.dec;
    try {
      const r = await api(`/api/public/t/${id}/review?${q()}`, { method: 'POST', body: { fid: cur.id, status, name, v: visitorId() } });
      data.reviews = r.reviews; renderDecision();
      toast(status === 'approved' ? 'Version approuvée ✅' : status === 'changes' ? 'Demande de modifications envoyée' : 'Décision retirée', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
}

/** Rafraîchit remarques et décisions des autres relecteurs toutes les 15 s */
function startPolling() {
  clearInterval(pollTimer);
  let sig = '';
  const sign = () => JSON.stringify([(data.comments || []).map(c => c.id + (c.resolved ? 1 : 0)), data.reviews, (data.reacts || []).length]);
  sig = sign();
  pollTimer = setInterval(async () => {
    if (!root || document.hidden) return;
    try {
      const r = await api(`/api/public/t/${id}/review?${q()}`);
      data.comments = r.comments; data.reviews = r.reviews; if (r.reacts) data.reacts = r.reacts;
      if (r.files) { const had = new Set((data.files || []).map(f => f.id)); const nv = r.files.filter(f => !had.has(f.id)); if (nv.length) { data.files = r.files; if (nv.some(f => rootOf(f) === rootOf(cur))) toast('Nouvelle version disponible : V' + Math.max(...nv.map(f => f.v || 1)), 'info', { action: 'Ouvrir', onAction: () => navigate(`/w/${id}?f=${nv[nv.length - 1].id}`) }); } }
      const s = sign();
      if (s !== sig) { sig = s; const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#cList'); if (!typing) renderList(); renderDecision(); }
    } catch (e) { /* hors ligne : on réessaiera */ }
  }, 15000);
}

function report(force, pctOverride) {
  const p = $('#player'); if (!p || !cur || !p.duration || !isFinite(p.duration)) return;
  if (!force && Date.now() - lastReport < 14000) return;
  lastReport = Date.now();
  const pct = pctOverride != null ? pctOverride : Math.round(p.currentTime / p.duration * 100);
  if (pct < 1 && !force) return;
  const body = JSON.stringify({ fid: cur.id, pct, v: visitorId() });
  fetch(`/api/public/t/${id}/watch?${q()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
