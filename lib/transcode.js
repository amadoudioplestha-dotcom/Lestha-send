'use strict';
/**
 * Lestha Send — qualités vidéo fabriquées par le serveur (3.23).
 * Quand l'appareil de l'expéditeur n'a pas pu les préparer (téléphone fermé trop tôt, navigateur ancien, vidéo envoyée
 * avant la 3.22), le serveur fabrique lui-même 480p et 720p (et 1080p au-dessus), en H.264 + AAC, lisibles partout.
 * - une seule vidéo à la fois, en priorité basse (nice), peu de mémoire : le reste du site reste fluide ;
 * - la vidéo d'origine est décodée une seule fois pour toutes les qualités ;
 * - « faststart » : la lecture démarre sans attendre la fin du fichier.
 * Désactivable avec TRANSCODE=0.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LADDER = [{ h: 480, br: 1100, max: 1500 }, { h: 720, br: 2300, max: 3000 }, { h: 1080, br: 4500, max: 6000 }];   // kbit/s

function findFfmpeg(env) {
  const cands = [env.FFMPEG_PATH, (() => { try { return require('ffmpeg-static'); } catch (e) { return null; } })(), 'ffmpeg'].filter(Boolean);
  for (const c of cands) {
    try { execFileSync(c, ['-hide_banner', '-version'], { stdio: 'ignore', timeout: 8000 }); return c; } catch (e) { /* suivant */ }
  }
  return null;
}
const hasNice = (() => { try { execFileSync('nice', ['-n', '1', 'true'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

/** Infos de la vidéo d'origine, lues dans le texte de ffmpeg (pas besoin de ffprobe) */
function parseInfo(txt) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
  const v = /Stream #\S+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(txt);
  const fps = /Video:[^\n]*?([\d.]+) fps/.exec(txt);
  return {
    duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0,
    w: v ? +v[1] : 0, h: v ? +v[2] : 0,
    audio: /Stream #\S+[^\n]*Audio:/.test(txt),
    fps: fps ? parseFloat(fps[1]) : 0
  };
}

/**
 * Lance ffmpeg. 3.29 : plus de durée maximale stricte (un petit serveur peut être très lent, ce n'est pas une panne) :
 * on n'arrête ffmpeg que s'il ne donne plus aucun signe de vie pendant `stallMs` (blocage réel), ou au-delà de `timeoutMs`.
 */
function run(bin, args, { onLine, timeoutMs, stallMs } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = hasNice ? 'nice' : bin, a = hasNice ? ['-n', '15', bin, ...args] : args;
    const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '', buf = '', why = '';
    const kill = (w) => { why = w; try { p.kill('SIGKILL'); } catch (e) { /* déjà fini */ } };
    const to = timeoutMs ? setTimeout(() => kill('trop long'), timeoutMs) : null;
    let stall = null;
    const alive = () => { if (!stallMs) return; clearTimeout(stall); stall = setTimeout(() => kill('bloqué (aucune progression)'), stallMs); };
    alive();
    p.stderr.on('data', (c) => {
      alive();
      const s = c.toString(); err = (err + s).slice(-20000);
      if (onLine) { buf += s; const parts = buf.split(/[\r\n]/); buf = parts.pop(); parts.forEach(onLine); }
    });
    const done = () => { if (to) clearTimeout(to); clearTimeout(stall); };
    p.on('error', (e) => { done(); reject(e); });
    p.on('close', (code, signal) => { done(); resolve({ code, err, killed: why || (signal ? 'arrêté (' + signal + ')' : '') }); });
  });
}

function createTranscoder({ env = process.env, storage, log = console }) {
  const enabled = env.TRANSCODE !== '0';
  const bin = enabled ? findFfmpeg(env) : null;
  if (enabled && !bin) log.warn('🎞️  ffmpeg introuvable : pas de qualités vidéo fabriquées par le serveur');
  const queue = []; let busy = false;

  /** Source lisible par ffmpeg : lien présigné (R2) ou fichier local */
  async function inputOf(f) {
    if (storage.pathFor) return storage.pathFor(f.key);
    return storage.presignGet(f.key, { filename: 'source', inline: true, contentType: 'application/octet-stream', expiresIn: 12 * 3600 });
  }

  /**
   * Fabrique les qualités manquantes d'une vidéo.
   * onProgress(0..1) ; retourne [{ h, w, file, size }] (fichiers temporaires à supprimer par l'appelant)
   */
  async function make(f, { skip = [], onProgress = () => {}, onRung = () => {}, one = false } = {}) {
    const input = await inputOf(f);
    const probe = await run(bin, ['-hide_banner', '-i', input], { timeoutMs: 120e3 });
    const info = parseInfo(probe.err);
    if (!info.w || !info.h) throw new Error('vidéo illisible');
    const short = Math.min(info.w, info.h);
    let rungs = LADDER.filter(r => r.h < short * 0.95 && !skip.includes(r.h));
    const left = rungs.length;
    // 3.29 : une qualité à la fois, la plus légère d'abord : la 480p est visible bien avant la 720p
    if (one) rungs = rungs.slice(0, 1);
    if (!rungs.length) return { made: [], info, left: 0 };
    onRung(rungs[0].h, info);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsq-'));
    // Le petit côté devient la hauteur visée (vidéos verticales de téléphone comprises)
    const split = rungs.length > 1 ? `[0:v]split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')};` : '';
    const scales = rungs.map((r, i) => `[${rungs.length > 1 ? 's' + i : '0:v'}]scale=w='if(gt(iw,ih),-2,${r.h})':h='if(gt(iw,ih),${r.h},-2)':flags=bicubic,format=yuv420p[o${i}]`).join(';');
    const args = ['-hide_banner', '-nostdin', '-y', '-threads', '2', '-i', input, '-filter_complex', split + scales];
    const outs = rungs.map((r, i) => ({ h: r.h, file: path.join(dir, `q${r.h}.mp4`) }));
    rungs.forEach((r, i) => {
      args.push('-map', `[o${i}]`);
      if (info.audio) args.push('-map', '0:a:0?');
      args.push('-fpsmax', '30', '-c:v', 'libx264', '-preset', 'superfast', '-profile:v', 'main', '-crf', '25',
        '-maxrate', r.max + 'k', '-bufsize', (r.max * 2) + 'k', '-g', '60',
        '-x264-params', 'threads=1:lookahead-threads=1:rc-lookahead=12');
      if (info.audio) args.push('-c:a', 'aac', '-b:a', '96k', '-ac', '2');
      args.push('-movflags', '+faststart', outs[i].file);
    });
    const t0 = Date.now();
    const res = await run(bin, args, {
      // Garde-fou très large : 60 s de calcul par seconde de vidéo (un serveur à 0,1 processeur en demande ~5)
      timeoutMs: Math.max(60 * 60e3, info.duration * 1000 * 60), stallMs: 10 * 60e3,
      onLine: (l) => { const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(l); if (m && info.duration) onProgress(Math.min(0.99, ((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) / info.duration)); }
    });
    if (res.code !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(res.killed ? 'conversion ' + res.killed : 'conversion impossible : ' + res.err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200));
    }
    // Vitesse mesurée (secondes réelles par seconde de vidéo, pour une qualité) : sert aux estimations affichées
    if (info.duration > 5) { const sp = (Date.now() - t0) / 1000 / info.duration / rungs.length; speed = speed ? speed * 0.5 + sp * 0.5 : sp; }
    const made = outs.map(o => {
      const size = fs.statSync(o.file).size;
      const w = Math.round(info.w >= info.h ? (info.w / info.h) * o.h / 2 : o.h / 2) * 2;
      return Object.assign(o, { size, w: info.w >= info.h ? w : o.h, dir });
    });
    return { made, info, dir, left: left - made.length };
  }

  /** front : la vidéo qu'une personne est en train de regarder passe devant les autres */
  function enqueue(job, { front = false } = {}) { if (front) queue.unshift(job); else queue.push(job); pump(); }
  async function pump() {
    if (busy) return; busy = true;
    while (queue.length) { const j = queue.shift(); current = j; try { await j(); } catch (e) { log.warn('qualités vidéo', e.message); } current = null; }
    busy = false;
  }
  let speed = Number(env.TRANSCODE_SPEED) || 0, current = null;
  return {
    enabled: !!bin, bin, make, enqueue,
    unqueue: (job) => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); },
    pending: () => queue.length + (busy ? 1 : 0),
    /** Place d'une tâche dans la file (0 = en cours) */
    position: (job) => (current === job ? 0 : queue.indexOf(job) + 1 || -1),
    speed: () => speed
  };
}

module.exports = { createTranscoder, parseInfo, LADDER };
