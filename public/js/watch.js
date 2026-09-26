/* TransferX — lien de visionnage : lecture en ligne sans téléchargement */
import { $, esc, icon, bytes, fileKind, ls, ss, api, visitorId, toast, relTime } from './core.js';
import { navigate } from './router.js';

let root = null, id = null, data = null, cur = null, reportTimer = null, wmTimer = null, lastReport = 0;

const token = () => ss.get('tx_tk_' + id);
const q = (extra = '') => `v=${encodeURIComponent(visitorId())}${token() ? '&tk=' + encodeURIComponent(token()) : ''}${extra}`;
const src = (fid) => `/api/public/t/${id}/f/${fid}?${q('&inline=1')}`;
const isMedia = (f) => ['video', 'audio'].includes(fileKind(f.name, f.type).kind);
const fmtT = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

export default {
  async render(r, { match, params }) {
    root = r; id = match[1];
    root.innerHTML = `<section class="narrow"><div class="skeleton" style="height:420px;border-radius:20px"></div></section>`;
    try { data = await api(`/api/public/t/${id}?${q()}`); }
    catch (e) { root.innerHTML = state('Lien introuvable', 'Ce contenu n\'existe plus ou a expiré.'); return; }
    if (data.locked) { navigate('/t/' + id, { replace: true }); return; }       // la page de réception gère le PIN
    if (data.state !== 'ready' && data.state !== 'limit') { root.innerHTML = state('Contenu indisponible', data.state === 'expired' ? 'Ce lien a expiré.' : 'Ce contenu n\'est pas accessible pour le moment.'); return; }
    const media = (data.files || []).filter(isMedia);
    if (!media.length) { navigate('/t/' + id, { replace: true }); return; }
    const wanted = params.get('f');
    cur = media.find(f => f.id === wanted) || media[0];
    renderPage(media);
  },
  destroy() { report(true); clearInterval(reportTimer); clearInterval(wmTimer); root = null; }
};

function state(t, m) {
  return `<section class="narrow"><div class="card"><div class="state-screen"><div class="state-icon warn">${icon('film')}</div><h2>${esc(t)}</h2><p class="muted">${esc(m)}</p><a class="btn" href="/" data-link>${icon('upload')}TransferX</a></div></div></section>`;
}

function subtitlesFor(f) {
  const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
  return (data.files || []).filter(x => /\.(vtt|srt)$/i.test(x.name) && x.name.toLowerCase().startsWith(base));
}

function renderPage(media) {
  const only = data.playback === 'only';
  const k = fileKind(cur.name, cur.type);
  root.innerHTML = `
  <section class="watch-wrap">
    <div class="watch-main">
      <div class="player-box ${only ? 'protected' : ''}" id="pbox">
        ${k.kind === 'video'
          ? `<video id="player" class="player" controls playsinline preload="metadata" ${only ? 'controlsList="nodownload noremoteplayback" disableRemotePlayback' : ''}></video>`
          : `<div class="audio-art">${icon('music', 'xl')}</div><audio id="player" controls preload="metadata" ${only ? 'controlsList="nodownload"' : ''} style="width:100%"></audio>`}
        ${data.watermark ? `<div class="watermark" id="wm">${esc(data.watermark)}</div>` : ''}
        <div class="player-error hidden" id="perr"></div>
      </div>
      <div class="watch-head">
        <div style="min-width:0">
          <h2 style="font-size:clamp(19px,3.4vw,26px)">${esc(cur.name.replace(/\.[^.]+$/, ''))}</h2>
          <div class="small muted" style="margin-top:4px">${data.senderName ? 'Partagé par ' + esc(data.senderName) + ' · ' : ''}${bytes(cur.size)}${only ? ' · <span style="color:#c4b5fd">visionnage seul</span>' : ''}</div>
        </div>
        <div class="row">
          ${only ? '' : `<a class="btn sm" href="/api/public/t/${id}/f/${cur.id}?${q()}">${icon('download', 'sm')}Télécharger</a>`}
          <a class="btn sm ghost" href="/t/${id}" data-link>${icon('folder', 'sm')}Tous les fichiers</a>
        </div>
      </div>
      ${data.message ? `<div class="message-bubble">${esc(data.message)}</div>` : ''}
    </div>
    <aside class="watch-side stack">
      ${media.length > 1 ? `<div class="card"><div class="card-title"><h3>${icon('film')}Playlist</h3><span class="small faint">${media.length}</span></div><div class="stack" style="gap:6px">${media.map(f => `<a class="dl-row playlist-item ${f.id === cur.id ? 'active' : ''}" href="/w/${id}?f=${f.id}" data-link><div class="ficon" style="--c:${fileKind(f.name, f.type).c};width:36px;height:36px">${icon(fileKind(f.name, f.type).icon, 'sm')}</div><div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fsub">${bytes(f.size)}${ls.get('tx_pos_' + id + f.id) ? ' · reprendre à ' + fmtT(ls.get('tx_pos_' + id + f.id)) : ''}</div></div></a>`).join('')}</div></div>` : ''}
      ${data.allowComments ? `<div class="card"><div class="card-title"><h3>${icon('message')}Commentaires</h3><span class="small faint" id="cCount"></span></div>
        <form id="cForm" class="stack" style="gap:8px">
          <input class="input" id="cName" maxlength="60" placeholder="Votre nom" value="${esc(ls.get('tx_comment_name', ''))}">
          <div class="input-group"><textarea class="input" id="cText" maxlength="500" placeholder="Votre remarque à ce moment précis…" style="min-height:60px"></textarea></div>
          <button class="btn primary sm" type="submit">${icon('message', 'sm')}Commenter à <span id="cAt">0:00</span></button>
        </form>
        <div class="stack comments" id="cList" style="gap:6px;margin-top:12px"></div></div>` : ''}
      <div class="tip">${icon('refresh')}<span>La lecture reprend automatiquement là où vous vous étiez arrêté${only ? '. L\'expéditeur a désactivé le téléchargement de ce contenu' : ''}.</span></div>
    </aside>
  </section>`;
  const player = $('#player');
  player.src = src(cur.id);
  // sous-titres (.vtt directs, .srt convertis à la volée)
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
  player.addEventListener('loadedmetadata', () => { if (saved > 5 && saved < player.duration - 10) { player.currentTime = saved; toast('Reprise à ' + fmtT(saved), 'info'); } }, { once: true });
  player.addEventListener('timeupdate', () => {
    if (Math.abs((ls.get('tx_pos_' + id + cur.id, 0)) - player.currentTime) > 4) ls.set('tx_pos_' + id + cur.id, Math.floor(player.currentTime));
    const at = $('#cAt'); if (at) at.textContent = fmtT(player.currentTime);
    if (Date.now() - lastReport > 15000) report();
  });
  player.addEventListener('pause', () => report(true));
  player.addEventListener('ended', () => { ls.del('tx_pos_' + id + cur.id); report(true, 100); });
  player.addEventListener('error', () => {
    const e = $('#perr');
    e.classList.remove('hidden');
    e.innerHTML = `${icon('x', 'lg')}<b>Lecture impossible dans ce navigateur</b><span class="small">Format probablement non pris en charge (MKV, AVI, H.265…). ${only ? 'Demandez à l\'expéditeur un export MP4 (H.264).' : 'Téléchargez le fichier pour le lire avec VLC, ou demandez un export MP4.'}</span>`;
  });
  if (only) $('#pbox').addEventListener('contextmenu', (e) => e.preventDefault());
  // filigrane mobile (se déplace pour décourager les captures)
  const wm = $('#wm');
  if (wm) { const move = () => { wm.style.left = (8 + Math.random() * 60) + '%'; wm.style.top = (8 + Math.random() * 70) + '%'; }; move(); clearInterval(wmTimer); wmTimer = setInterval(move, 12000); }
  if (data.allowComments) bindComments(player);
  clearInterval(reportTimer);
  reportTimer = setInterval(() => { if (!player.paused) report(); }, 15000);
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

function bindComments(player) {
  const render = () => {
    const list = (data.comments || []).filter(c => c.fid === cur.id).sort((a, b) => a.time - b.time);
    $('#cCount').textContent = list.length || '';
    $('#cList').innerHTML = list.length ? list.map(c => `<button type="button" class="comment" data-t="${c.time}"><span class="c-time">${fmtT(c.time)}</span><span class="c-body"><b>${esc(c.name)}</b> ${esc(c.text)}<small>${relTime(c.at)}</small></span></button>`).join('') : '<p class="small faint">Aucun commentaire. Mettez la vidéo en pause au bon moment et écrivez votre remarque.</p>';
  };
  render();
  $('#cList').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { player.currentTime = Number(b.dataset.t); player.play().catch(() => {}); } };
  $('#cText').addEventListener('focus', () => player.pause());
  $('#cForm').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#cText').value.trim(); if (!text) return;
    const name = $('#cName').value.trim(); ls.set('tx_comment_name', name);
    try {
      const r = await api(`/api/public/t/${id}/comments?${q()}`, { method: 'POST', body: { fid: cur.id, time: player.currentTime, text, name, v: visitorId() } });
      data.comments = r.comments; $('#cText').value = ''; render();
      toast('Commentaire ajouté à ' + fmtT(r.comment.time), 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
}
