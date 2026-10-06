/* Lestha Send — lecteur de replay de cours (3.16)
   Script autonome (sans import) : recopié dans chaque fichier replay .html, et utilisé par la page /replay.
   A besoin des fonctions de dessin de /js/ink-draw.js (drawStroke, drawLaser) déjà chargées.
   Les données : { title, host, date, dur, audio (data: MP3), imgs { clé: data:JPEG }, ev [[t, type, ...]] } */
(function () {
  'use strict';
  const CSS = `
.lr{--bg:#070b16;--card:#0f1829;--line:rgba(148,163,184,.16);--tx:#e8eef8;--mut:#8ea2bf;--c1:#00b4d8;--c2:#06d6a0;
  color:var(--tx);font:15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:1180px;margin:0 auto;padding:14px 14px 28px;box-sizing:border-box}
.lr *{box-sizing:border-box}
.lr-head{display:flex;align-items:center;gap:12px;margin:2px 2px 14px}
.lr-logo{width:40px;height:40px;border-radius:12px;flex:none;display:grid;place-items:center;background:linear-gradient(135deg,var(--c1),var(--c2));color:#04121a;font-weight:800;font-size:19px;box-shadow:0 6px 22px rgba(0,180,216,.35)}
.lr-ttl{min-width:0}
.lr-ttl h1{font-size:clamp(17px,2.6vw,22px);margin:0;line-height:1.2;font-weight:750;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.lr-ttl p{margin:3px 0 0;color:var(--mut);font-size:13px}
.lr-tag{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:99px;background:rgba(6,214,160,.12);color:var(--c2);font-weight:650;font-size:11.5px;letter-spacing:.02em;margin-right:6px;vertical-align:1px}
.lr-main{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start}
@media (max-width:900px){.lr-main{grid-template-columns:1fr}}
.lr-player{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.lr-stage{position:relative;aspect-ratio:16/9;background:radial-gradient(120% 90% at 50% 0%,#14213b 0%,#070b16 70%);touch-action:manipulation;cursor:pointer;user-select:none;-webkit-user-select:none}
.lr-player:fullscreen{border-radius:0;display:flex;flex-direction:column;background:#000}
.lr-player:fullscreen .lr-stage{flex:1;aspect-ratio:auto}
.lr-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.lr-chip{position:absolute;display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:99px;background:rgba(7,11,22,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#fff;font-size:12.5px;font-weight:600;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .25s;pointer-events:none}
.lr-spk{left:12px;bottom:12px}.lr-spk i{width:8px;height:8px;border-radius:50%;background:var(--c2);box-shadow:0 0 0 0 rgba(6,214,160,.6);animation:lrp 1.2s infinite;flex:none}
@keyframes lrp{70%{box-shadow:0 0 0 8px rgba(6,214,160,0)}100%{box-shadow:0 0 0 0 rgba(6,214,160,0)}}
.lr-pg{right:12px;top:12px}
.lr-chip.off{opacity:0}
.lr-big{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:78px;height:78px;border-radius:50%;border:0;background:linear-gradient(135deg,var(--c1),var(--c2));color:#04121a;display:grid;place-items:center;cursor:pointer;box-shadow:0 10px 40px rgba(0,180,216,.5);transition:transform .2s,opacity .2s}
.lr-big:hover{transform:translate(-50%,-50%) scale(1.06)}
.lr-big.off{opacity:0;pointer-events:none;transform:translate(-50%,-50%) scale(.8)}
.lr-big svg{width:34px;height:34px;margin-left:5px}
.lr-flash{position:absolute;top:50%;transform:translateY(-50%);padding:10px 14px;border-radius:14px;background:rgba(7,11,22,.7);color:#fff;font-weight:700;opacity:0;transition:opacity .3s;pointer-events:none}
.lr-flash.l{left:8%}.lr-flash.r{right:8%}.lr-flash.on{opacity:1;transition:none}
.lr-ctl{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}
.lr-seek{position:relative;height:22px;display:flex;align-items:center}
.lr-seek input{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:99px;margin:0;background:linear-gradient(90deg,var(--c1),var(--c2)) 0/var(--p,0%) 100% no-repeat,rgba(148,163,184,.22);outline:none;cursor:pointer}
.lr-seek input::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;border:3px solid var(--c2);box-shadow:0 2px 8px rgba(0,0,0,.4)}
.lr-seek input::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--c2)}
.lr-ticks{position:absolute;left:0;right:0;top:50%;height:0;pointer-events:none}
.lr-ticks b{position:absolute;top:-6px;width:2px;height:12px;border-radius:2px;background:rgba(255,255,255,.55);transform:translateX(-1px)}
.lr-row{display:flex;align-items:center;gap:6px}
.lr-btn{border:0;background:transparent;color:var(--tx);height:40px;min-width:40px;border-radius:12px;display:inline-grid;place-items:center;cursor:pointer;font:inherit;font-weight:650;padding:0 8px}
.lr-btn:hover{background:rgba(148,163,184,.12)}
.lr-btn svg{width:22px;height:22px}
.lr-btn.pp{background:linear-gradient(135deg,var(--c1),var(--c2));color:#04121a;width:46px;height:46px;border-radius:50%}
.lr-btn.pp svg{width:22px;height:22px}
.lr-time{font-variant-numeric:tabular-nums;color:var(--mut);font-size:13px;margin-left:4px;white-space:nowrap}
.lr-time b{color:var(--tx);font-weight:650}
.lr-sp{margin-left:auto}
.lr-side{background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;max-height:min(78vh,720px)}
@media (max-width:900px){.lr-side{max-height:none}}
.lr-tabs{display:flex;gap:4px;padding:8px;border-bottom:1px solid var(--line)}
.lr-tab{flex:1;border:0;background:transparent;color:var(--mut);padding:9px 8px;border-radius:12px;font:inherit;font-weight:650;font-size:14px;cursor:pointer}
.lr-tab.on{background:rgba(0,180,216,.14);color:var(--tx)}
.lr-list{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px;-webkit-overflow-scrolling:touch}
.lr-ch{display:flex;gap:10px;align-items:center;border:1px solid transparent;background:rgba(148,163,184,.06);border-radius:14px;padding:7px;color:inherit;text-align:left;cursor:pointer;font:inherit;width:100%}
.lr-ch:hover{border-color:var(--line)}
.lr-ch.on{border-color:rgba(6,214,160,.55);background:rgba(6,214,160,.1)}
.lr-ch .th{width:84px;aspect-ratio:16/10;border-radius:9px;flex:none;background:#fff center/contain no-repeat;display:grid;place-items:center;font-size:22px;overflow:hidden}
.lr-ch .th.dk{background-color:#14213b}
.lr-ch b{display:block;font-size:14px;font-weight:650;line-height:1.25}
.lr-ch small{color:var(--mut);font-size:12.5px;font-variant-numeric:tabular-nums}
.lr-msg{padding:8px 10px;border-radius:12px;background:rgba(148,163,184,.06);cursor:pointer;transition:opacity .2s}
.lr-msg.fut{opacity:.38}
.lr-msg .who{font-weight:650;font-size:13px}.lr-msg .who small{color:var(--mut);font-weight:500;margin-left:6px;font-variant-numeric:tabular-nums}
.lr-msg p{margin:2px 0 0;font-size:14px;white-space:pre-wrap;word-wrap:break-word}
.lr-empty{color:var(--mut);text-align:center;padding:26px 10px;font-size:14px}
.lr-foot{margin-top:18px;text-align:center;color:var(--mut);font-size:12.5px}
.lr-foot a{color:var(--c2);font-weight:650;text-decoration:none}
.lr-err{margin:40px auto;max-width:520px;text-align:center;padding:26px;border-radius:18px;background:var(--card);border:1px solid var(--line)}
@media (max-width:560px){.lr{padding:10px 0 24px}.lr-head{margin:2px 12px 12px}.lr-player,.lr-side{border-radius:0;border-left:0;border-right:0}.lr-main{gap:10px}.lr-hide-s{display:none}}
@media (prefers-reduced-motion:reduce){.lr-spk i{animation:none}}`;

  const SVG = (p) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${p}</svg>`;
  const IC = {
    play: SVG('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>'),
    pause: SVG('<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4h4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text></svg>',
    fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
  };
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* lecture privée */ } } };

  function dataToBlob(url) {
    const i = url.indexOf(','), type = (url.slice(5, i).split(';')[0]) || 'audio/mpeg', b = atob(url.slice(i + 1));
    const out = new Uint8Array(b.length);
    for (let k = 0; k < b.length; k++) out[k] = b.charCodeAt(k);
    return new Blob([out], { type });
  }

  /* Le fichier peut venir de n'importe où (page /replay) : on ne garde que des valeurs sûres */
  const IMG_OK = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, AUDIO_OK = /^data:audio\/(mpeg|mp4|webm|ogg)(;[a-z0-9=.-]+)*;base64,[A-Za-z0-9+/=]+$/i;
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  function clean(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.ev)) return null;
    const imgs = {};
    if (d.imgs && typeof d.imgs === 'object') Object.keys(d.imgs).forEach(k => { if (typeof d.imgs[k] === 'string' && IMG_OK.test(d.imgs[k])) imgs[k] = d.imgs[k]; });
    const txt = (v, n) => String(v == null ? '' : v).slice(0, n);
    const ev = [];
    d.ev.forEach(e => {
      if (!Array.isArray(e)) return;
      const t = Math.max(0, num(e[0])), k = e[1];
      if (k === 'view' && e[2] && typeof e[2] === 'object') {
        const v = e[2], asp = Array.isArray(v.asp) && num(v.asp[0]) > 0 && num(v.asp[1]) > 0 ? [num(v.asp[0]), num(v.asp[1])] : [16, 9];
        ev.push([t, k, { k: ['doc', 'board', 'screen'].includes(v.k) ? v.k : 'none', img: typeof v.img === 'string' ? v.img : null, asp, name: txt(v.name, 200), page: Math.round(num(v.page)), n: Math.round(num(v.n)) }]);
      } else if ((k === 'set' && Array.isArray(e[2])) || (k === 'add' && e[2] && typeof e[2] === 'object')) {
        const st = (s) => ({ id: txt(s.id, 80), tool: txt(s.tool, 20), c: /^#[0-9a-f]{6}$/i.test(s.c) ? s.c : '#ef4444', w: num(s.w) || 4, pts: Array.isArray(s.pts) ? s.pts.slice(0, 40000).map(num) : [], t: s.t == null ? undefined : txt(s.t, 2000) });
        ev.push([t, k, k === 'set' ? e[2].filter(s => s && typeof s === 'object').map(st) : st(e[2])]);
      } else if (k === 'del' && Array.isArray(e[2])) ev.push([t, k, e[2].map(x => txt(x, 80))]);
      else if (k === 'las') ev.push([t, k, Array.isArray(e[2]) ? [num(e[2][0]), num(e[2][1]), /^#[0-9a-f]{6}$/i.test(e[2][2]) ? e[2][2] : '#ef4444'] : 0]);
      else if (k === 'spk') ev.push([t, k, txt(e[2], 140)]);
      else if (k === 'chat') ev.push([t, k, txt(e[2], 60), txt(e[3], 1000)]);
    });
    ev.sort((a, b) => a[0] - b[0]);
    return { title: txt(d.title, 200), host: txt(d.host, 80), date: txt(d.date, 40), dur: Math.max(0, num(d.dur)), audio: typeof d.audio === 'string' && AUDIO_OK.test(d.audio) ? d.audio : '', imgs, ev };
  }

  function mount(raw, root) {
    const data = clean(raw);
    if (!document.getElementById('lrCss')) { const st = document.createElement('style'); st.id = 'lrCss'; st.textContent = CSS; document.head.appendChild(st); }
    if (!data || !Array.isArray(data.ev)) { root.innerHTML = '<div class="lr"><div class="lr-err"><b>Ce fichier de replay est illisible.</b><p>Demandez à l’enseignant de vous le renvoyer.</p></div></div>'; return null; }
    document.documentElement.style.background = '#070b16';
    const ev = data.ev, DUR = Math.max(1000, data.dur || (ev.length ? ev[ev.length - 1][0] : 1000));
    const d0 = data.date ? new Date(data.date) : null;
    const when = d0 && !isNaN(d0) ? d0.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';

    /* Images (pages, captures d'écran) décodées à la demande */
    const IMG = new Map();
    const img = (k) => { if (!k || !data.imgs || !data.imgs[k]) return null; let im = IMG.get(k); if (!im) { im = new Image(); im.onload = () => draw(); im.src = data.imgs[k]; IMG.set(k, im); } return im.complete && im.naturalWidth ? im : null; };

    /* Plan du cours : un chapitre à chaque nouvelle page / nouveau support */
    const chapters = [];
    let lastLabel = '';
    ev.forEach(e => {
      if (e[1] !== 'view') return;
      const v = e[2]; let label, sub = '', key = null, ico = '';
      if (v.k === 'doc') { label = 'Page ' + v.page; sub = v.name || ''; key = v.img; }
      else if (v.k === 'board') { label = 'Tableau blanc'; ico = '✏️'; }
      else if (v.k === 'screen') { label = 'Partage d’écran'; ico = '🖥️'; key = v.img; }
      else return;
      const id = v.k === 'screen' ? 'screen' : label + '|' + sub;
      if (id === lastLabel) return;
      lastLabel = id;
      if (chapters.length && e[0] - chapters[chapters.length - 1].t < 1200) chapters.pop();   // pages feuilletées très vite
      chapters.push({ t: e[0], label, sub, key, ico });
    });
    const chats = ev.filter(e => e[1] === 'chat');

    root.innerHTML = `<div class="lr">
      <header class="lr-head"><div class="lr-logo" aria-hidden="true">L</div>
        <div class="lr-ttl"><h1>${esc(data.title || 'Cours')}</h1><p><span class="lr-tag">● REPLAY</span>${esc(data.host ? data.host + ' · ' : '')}${esc(when)}${when ? ' · ' : ''}${clock(DUR)}</p></div></header>
      <div class="lr-main">
        <section class="lr-player" aria-label="Lecteur du cours">
          <div class="lr-stage" data-r="stage"><canvas data-r="cv"></canvas>
            <span class="lr-chip lr-pg off" data-r="pg"></span>
            <span class="lr-chip lr-spk off" data-r="spk"><i></i><span></span></span>
            <span class="lr-flash l" data-r="fl">−10 s</span><span class="lr-flash r" data-r="fr">+10 s</span>
            <button type="button" class="lr-big" data-r="big" aria-label="Lire le cours">${IC.play}</button>
          </div>
          <div class="lr-ctl">
            <div class="lr-seek"><input type="range" min="0" max="${DUR}" step="100" value="0" data-r="seek" aria-label="Position dans le cours"><div class="lr-ticks">${chapters.slice(1).map(c => `<b style="left:${(c.t / DUR * 100).toFixed(3)}%"></b>`).join('')}</div></div>
            <div class="lr-row">
              <button type="button" class="lr-btn pp" data-r="pp" aria-label="Lecture">${IC.play}</button>
              <button type="button" class="lr-btn" data-r="b10" aria-label="Reculer de 10 secondes">${IC.back}</button>
              <button type="button" class="lr-btn" data-r="f10" aria-label="Avancer de 10 secondes">${IC.fwd}</button>
              <span class="lr-time"><b data-r="now">0:00</b> / ${clock(DUR)}</span>
              <span class="lr-sp"></span>
              <button type="button" class="lr-btn" data-r="speed" aria-label="Vitesse de lecture">1×</button>
              ${(document.fullscreenEnabled || document.webkitFullscreenEnabled) ? `<button type="button" class="lr-btn lr-hide-s" data-r="full" aria-label="Plein écran">${IC.full}</button>` : ''}
            </div>
          </div>
        </section>
        <aside class="lr-side">
          <div class="lr-tabs" role="tablist"><button type="button" class="lr-tab on" data-tab="plan" role="tab">Plan du cours (${chapters.length})</button><button type="button" class="lr-tab" data-tab="chat" role="tab">Discussion (${chats.length})</button></div>
          <div class="lr-list" data-r="list"></div>
        </aside>
      </div>
      <p class="lr-foot">Replay créé avec <a href="https://lestha-send.com" target="_blank" rel="noopener">Lestha Send</a> · se lit sans connexion</p>
    </div>`;
    const $ = (r) => root.querySelector(`[data-r="${r}"]`);
    const cv = $('cv'), cx = cv.getContext('2d'), stage = $('stage'), seek = $('seek');

    /* Son */
    const au = new Audio();
    au.preload = 'auto';
    let audioOk = false;
    try { if (data.audio) { au.src = URL.createObjectURL(dataToBlob(data.audio)); audioOk = true; } } catch (e) { audioOk = false; }
    // Sans son (fichier abîmé) : une horloge simple fait avancer le replay
    const clk = { at: 0, base: 0, on: false, rate: 1 };
    const timeNow = () => audioOk ? au.currentTime * 1000 : (clk.on ? clk.base + (performance.now() - clk.at) * clk.rate : clk.base);
    const playing = () => audioOk ? !au.paused && !au.ended : clk.on;
    function setTime(ms) {
      ms = Math.max(0, Math.min(DUR, ms));
      if (audioOk) au.currentTime = ms / 1000; else { clk.base = ms; clk.at = performance.now(); }
      draw(); ui();
    }
    function play() {
      if (timeNow() >= DUR - 200) setTime(0);
      if (audioOk) au.play().catch(() => { audioOk = false; clk.on = true; clk.at = performance.now(); loop(); });
      else { clk.on = true; clk.at = performance.now(); }
      loop(); ui();
    }
    function pause() { if (audioOk) au.pause(); else { clk.base = timeNow(); clk.on = false; } ui(); draw(); }
    const toggle = () => playing() ? pause() : play();
    au.addEventListener('play', ui); au.addEventListener('pause', () => { ui(); draw(); saveAt(); }); au.addEventListener('ended', () => { ui(); store.set(memKey, '0'); });

    /* État du cours à l'instant t : on rejoue les événements (en avançant pas à pas pendant la lecture) */
    const Z = { i: 0, t: -1, view: { k: 'none' }, strokes: new Map(), las: null, lasPrev: null, spk: '' };
    function reset() { Z.i = 0; Z.t = -1; Z.view = { k: 'none' }; Z.strokes = new Map(); Z.las = null; Z.lasPrev = null; Z.spk = ''; }
    function advance(t) {
      if (t < Z.t) reset();
      while (Z.i < ev.length && ev[Z.i][0] <= t) {
        const e = ev[Z.i++], at = e[0];
        switch (e[1]) {
          case 'view': Z.view = e[2]; break;
          case 'set': Z.strokes = new Map(e[2].map(s => [s.id, { s: Object.assign({}, s, s.tool === 'fade' ? { done: at } : {}), at, anim: 0 }])); break;
          case 'add': { const s = e[2], anim = Math.min(900, 120 + (s.pts ? s.pts.length : 0) * 5); Z.strokes.set(s.id, { s: Object.assign({}, s, s.tool === 'fade' ? { done: at + anim } : {}), at, anim }); break; }
          case 'del': e[2].forEach(id => Z.strokes.delete(id)); break;
          case 'las': Z.lasPrev = Z.las; Z.las = e[2] ? { x: e[2][0], y: e[2][1], c: e[2][2], t: at } : null; break;
          case 'spk': Z.spk = e[2]; break;
        }
      }
      Z.t = t;
    }

    /* Dessin */
    function fit() {
      const W = stage.clientWidth, H = stage.clientHeight, d = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
      cx.setTransform(d, 0, 0, d, 0, 0);
      return [W, H];
    }
    function draw() {
      const t = timeNow(); advance(t);
      const [W, H] = fit(); cx.clearRect(0, 0, W, H);
      const v = Z.view;
      if (v.k === 'none') return drawVoice(W, H, t);
      const asp = v.asp || [16, 9], k = Math.min(W / asp[0], H / asp[1]);
      const r = { w: asp[0] * k, h: asp[1] * k }; r.x = (W - r.w) / 2; r.y = (H - r.h) / 2;
      cx.save(); cx.shadowColor = 'rgba(0,0,0,.45)'; cx.shadowBlur = 24; cx.fillStyle = v.k === 'screen' ? '#000' : '#fbfbf8'; cx.fillRect(r.x, r.y, r.w, r.h); cx.restore();
      const im = img(v.img); if (im) cx.drawImage(im, r.x, r.y, r.w, r.h);
      Z.strokes.forEach(o => {
        if (o.anim && t - o.at < o.anim && o.s.pts && o.s.pts.length > 4 && ['pen', 'hl', 'fade'].includes(o.s.tool)) {
          const f = (t - o.at) / o.anim, n = Math.max(2, Math.round(o.s.pts.length / 2 * f)) * 2;
          drawStroke(cx, Object.assign({}, o.s, { pts: o.s.pts.slice(0, n) }), r, t);
        } else {
          if (o.anim && t - o.at < 250) { cx.save(); cx.globalAlpha = (t - o.at) / 250; drawStroke(cx, o.s, r, t); cx.restore(); }
          else drawStroke(cx, o.s, r, t);
        }
      });
      if (Z.las) {
        const p = Z.lasPrev && t - Z.las.t < 200 ? Math.max(0, Math.min(1, (t - Z.las.t) / 200)) : 1;
        const x = Z.lasPrev ? Z.lasPrev.x + (Z.las.x - Z.lasPrev.x) * p : Z.las.x, y = Z.lasPrev ? Z.lasPrev.y + (Z.las.y - Z.lasPrev.y) * p : Z.las.y;
        drawLaser(cx, { x, y, c: Z.las.c, at: t, trail: [] }, r, t);
      }
    }
    /* Aucun support à l'écran : la voix du cours, joliment */
    function drawVoice(W, H, t) {
      const name = Z.spk || data.host || data.title || '';
      const ini = (Z.spk || data.host || 'L').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'L';
      const R = Math.min(W, H) * 0.16, cxp = W / 2, cyp = H / 2 - 10;
      const on = !!Z.spk && playing();
      for (let i = 0; i < 3 && on; i++) {
        const ph = ((t / 1400) + i / 3) % 1;
        cx.beginPath(); cx.arc(cxp, cyp, R * (1 + ph * 0.9), 0, 6.2832); cx.strokeStyle = `rgba(6,214,160,${0.45 * (1 - ph)})`; cx.lineWidth = 2; cx.stroke();
      }
      const g = cx.createLinearGradient(cxp - R, cyp - R, cxp + R, cyp + R); g.addColorStop(0, '#00b4d8'); g.addColorStop(1, '#06d6a0');
      cx.fillStyle = g; cx.beginPath(); cx.arc(cxp, cyp, R, 0, 6.2832); cx.fill();
      cx.fillStyle = '#04121a'; cx.font = `800 ${Math.round(R * 0.75)}px Inter,system-ui,sans-serif`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(ini, cxp, cyp + 2);
      cx.fillStyle = '#e8eef8'; cx.font = `650 ${Math.max(13, Math.round(R * 0.32))}px Inter,system-ui,sans-serif`; cx.fillText(name.slice(0, 48), cxp, cyp + R + Math.max(22, R * 0.45));
      cx.textAlign = 'left'; cx.textBaseline = 'alphabetic';
    }

    /* Interface */
    let tab = 'plan', lastCh = -2, lastChat = -2;
    const chIndex = (t) => { let k = -1; for (let i = 0; i < chapters.length; i++) if (chapters[i].t <= t + 50) k = i; return k; };
    function list() {
      const L = $('list');
      if (tab === 'plan') {
        L.innerHTML = chapters.length ? chapters.map((c, i) => `<button type="button" class="lr-ch" data-t="${c.t}" data-i="${i}"><span class="th ${c.key ? '' : 'dk'}" ${c.key && data.imgs[c.key] ? `style="background-image:url('${data.imgs[c.key]}')"` : ''}>${c.key ? '' : c.ico}</span><span><b>${esc(c.label)}</b><small>${clock(c.t)}${c.sub ? ' · ' + esc(c.sub.slice(0, 40)) : ''}</small></span></button>`).join('')
          : '<p class="lr-empty">Ce cours a été donné à l’oral, sans support à l’écran.</p>';
      } else {
        L.innerHTML = chats.length ? chats.map((e, i) => `<div class="lr-msg" data-t="${e[0]}" data-i="${i}"><div class="who">${esc(e[2])}<small>${clock(e[0])}</small></div><p>${esc(e[3])}</p></div>`).join('')
          : '<p class="lr-empty">Aucun message pendant le cours.</p>';
      }
      lastCh = lastChat = -2; mark(true);
    }
    function mark(force) {
      const t = timeNow(), L = $('list');
      if (tab === 'plan') {
        const k = chIndex(t); if (k === lastCh && !force) return; lastCh = k;
        L.querySelectorAll('.lr-ch').forEach(b => b.classList.toggle('on', +b.dataset.i === k));
        const on = L.querySelector('.lr-ch.on'); if (on && playing()) on.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        let k = -1; chats.forEach((e, i) => { if (e[0] <= t) k = i; }); if (k === lastChat && !force) return; lastChat = k;
        L.querySelectorAll('.lr-msg').forEach(m => m.classList.toggle('fut', +m.dataset.i > k));
      }
    }
    function ui() {
      const t = timeNow(), p = playing();
      $('pp').innerHTML = p ? IC.pause : IC.play; $('pp').setAttribute('aria-label', p ? 'Pause' : 'Lecture');
      $('big').classList.toggle('off', p || t > 300);
      if (!seek.matches(':active')) seek.value = Math.round(t);
      seek.style.setProperty('--p', (t / DUR * 100).toFixed(2) + '%');
      $('now').textContent = clock(t);
      const v = Z.view, pg = $('pg');
      pg.classList.toggle('off', v.k !== 'doc'); if (v.k === 'doc') pg.textContent = `Page ${v.page} / ${v.n}`;
      const spk = $('spk'); spk.classList.toggle('off', !Z.spk || v.k === 'none'); spk.lastElementChild.textContent = Z.spk;
      mark();
      if ('mediaSession' in navigator) try { navigator.mediaSession.playbackState = p ? 'playing' : 'paused'; } catch (e) { /* ignore */ }
    }
    let raf = 0;
    function loop() {
      cancelAnimationFrame(raf);
      const step = () => { draw(); ui(); if (playing()) raf = requestAnimationFrame(step); else if (!audioOk && timeNow() >= DUR) { clk.on = false; clk.base = DUR; ui(); } };
      raf = requestAnimationFrame(step);
    }

    /* Commandes */
    const flash = (el) => { el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 350); };
    const jump = (s) => { setTime(timeNow() + s * 1000); flash($(s < 0 ? 'fl' : 'fr')); };
    $('pp').onclick = toggle; $('big').onclick = (e) => { e.stopPropagation(); play(); };
    $('b10').onclick = () => jump(-10); $('f10').onclick = () => jump(10);
    let taps = 0, tapT = 0;
    stage.addEventListener('click', (e) => {
      // Double appui à gauche / à droite : ±10 s (comme sur YouTube) ; appui simple : lecture / pause
      const now = performance.now(), left = e.offsetX < stage.clientWidth / 2;
      if (now - tapT < 300) { clearTimeout(taps); jump(left ? -10 : 10); tapT = 0; return; }
      tapT = now; taps = setTimeout(toggle, 300);
    });
    seek.addEventListener('input', () => { setTime(+seek.value); });
    let sp = 0;
    $('speed').onclick = () => { sp = (sp + 1) % SPEEDS.length; const r = SPEEDS[sp]; au.playbackRate = r; if (!audioOk) { clk.base = timeNow(); clk.at = performance.now(); clk.rate = r; } $('speed').textContent = String(r).replace('.', ',') + '×'; };
    const full = $('full');
    if (full) full.onclick = () => { const el = root.querySelector('.lr-player'); const fs = document.fullscreenElement || document.webkitFullscreenElement; if (fs) (document.exitFullscreen || document.webkitExitFullscreen).call(document); else (el.requestFullscreen || el.webkitRequestFullscreen).call(el); };
    root.querySelector('.lr-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; root.querySelectorAll('.lr-tab').forEach(x => x.classList.toggle('on', x === b)); list(); });
    $('list').addEventListener('click', (e) => { const it = e.target.closest('[data-t]'); if (!it) return; setTime(+it.dataset.t); if (!playing()) play(); });
    const onKey = (e) => {
      if (e.target.closest && e.target.closest('input,textarea') && e.target !== seek) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft' || e.key === 'j') { e.preventDefault(); jump(-10); }
      else if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); jump(10); }
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => draw());

    /* Écran verrouillé du téléphone : titre et boutons du cours */
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: data.title || 'Cours', artist: data.host || 'Lestha Send', album: 'Replay · Lestha Send' });
        navigator.mediaSession.setActionHandler('play', play); navigator.mediaSession.setActionHandler('pause', pause);
        navigator.mediaSession.setActionHandler('seekbackward', () => jump(-10)); navigator.mediaSession.setActionHandler('seekforward', () => jump(10));
      } catch (e) { /* ignore */ }
    }

    /* Reprendre là où on s'était arrêté */
    const memKey = 'lsr:' + (data.date || '') + ':' + String(data.title || '').slice(0, 40);
    const saveAt = () => { const t = timeNow(); store.set(memKey, String(t > 5000 && t < DUR - 5000 ? Math.round(t) : 0)); };
    setInterval(() => { if (playing()) saveAt(); }, 5000);
    const back = +store.get(memKey) || 0;
    const start = () => { if (back > 0) setTime(back); else draw(); ui(); };
    if (audioOk && au.readyState < 1) au.addEventListener('loadedmetadata', start, { once: true }); else start();
    list(); draw(); ui();
    return { play, pause, setTime, time: timeNow, playing, destroy() { pause(); document.removeEventListener('keydown', onKey); cancelAnimationFrame(raf); } };
  }

  window.LSReplay = { mount };
  const el = document.getElementById('lsReplayData');
  if (el) {
    const root = document.getElementById('lsReplay') || document.body;
    document.body.style.margin = '0'; document.body.style.background = '#070b16';
    let data = null; try { data = JSON.parse(el.textContent); } catch (e) { data = null; }
    window.LSReplay.player = mount(data, root);
  }
})();
