'use strict';
/* Galerie (3.18) : aperçus légers des photos, ZIP des fichiers choisis */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startServer(extra = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lestha-gal-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), STORAGE_DRIVER: 'local', DATA_DIR: dir, PUBLIC_URL: `http://127.0.0.1:${port}`,
    RENDER: '', RENDER_SERVICE_ID: '', SENDGRID_API_KEY: '', SMTP_HOST: '', UPLOAD_CODE: '', ORIGIN_SECRET: '',
    TURNSTILE_SECRET: '', TURNSTILE_SITE_KEY: '', ADMIN_PASSWORD: '', NODE_ENV: 'test'
  }, extra);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch (e) { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error('Serveur non démarré :\n' + log);
  }
  const stop = () => new Promise((resolve) => { child.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); }); child.kill('SIGTERM'); });
  return { base, stop };
}
async function call(base, p, { method = 'GET', body, key } = {}) {
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.90' };
  if (key) h['x-owner-key'] = key;
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);

test('galerie : aperçus JPEG enregistrés, servis en ligne et ZIP limité aux fichiers choisis', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const photoA = jpeg(5000), photoB = jpeg(3000);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [
    { name: 'a.jpg', size: photoA.length, type: 'image/jpeg' }, { name: 'b.jpg', size: photoB.length, type: 'image/jpeg' }, { name: 'notes.txt', size: 10, type: 'text/plain' }
  ] } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const { id, ownerKey: key } = c.data;
  const bodies = [photoA, photoB, Buffer.from('0123456789')];
  for (const [i, f] of c.data.files.entries()) {
    const u = await call(srv.base, `/api/transfers/${id}/files/${f.id}/urls`, { method: 'POST', key, body: { parts: [1] } });
    assert.equal((await fetch(u.data.urls[1], { method: 'PUT', body: bodies[i] })).status, 200);
    assert.equal((await call(srv.base, `/api/transfers/${id}/files/${f.id}/complete`, { method: 'POST', key })).status, 200);
  }
  assert.equal((await call(srv.base, `/api/transfers/${id}/finalize`, { method: 'POST', key, body: {} })).status, 200);
  const [fa, fb, ft] = c.data.files;

  // Refus : pas un JPEG, mauvaise clé, fichier qui n'est ni photo ni vidéo
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fa.id}/previews`, { method: 'POST', key, body: { thumb: Buffer.from('<svg>' + 'x'.repeat(80)).toString('base64') } })).status, 400);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fa.id}/previews`, { method: 'POST', key: 'mauvaise', body: { thumb: jpeg(100).toString('base64') } })).status, 403);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${ft.id}/previews`, { method: 'POST', key, body: { thumb: jpeg(100).toString('base64') } })).status, 404);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fa.id}/previews`, { method: 'POST', key, body: { thumb: jpeg(130e3).toString('base64') } })).status, 413);

  // Vignette acceptée ; version écran plus lourde que l'original ignorée
  const ok = await call(srv.base, `/api/transfers/${id}/files/${fa.id}/previews`, { method: 'POST', key, body: { thumb: jpeg(300).toString('base64'), view: jpeg(9000).toString('base64'), w: 4000, h: 3000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.file.th);
  assert.equal(ok.data.file.pv, undefined);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fa.id}/previews`, { method: 'POST', key, body: { view: jpeg(1000).toString('base64') } })).status, 200);

  const pub = await call(srv.base, `/api/public/t/${id}?v=visiteur-galerie`);
  const pa = pub.data.files.find(f => f.id === fa.id);
  assert.equal(pa.th, fa.id + 't'); assert.equal(pa.pv, fa.id + 'p'); assert.equal(pa.iw, 4000);

  const th = await fetch(`${srv.base}/api/public/t/${id}/f/${pa.th}?v=visiteur-galerie&inline=1`);
  assert.equal(th.status, 200);
  assert.equal(th.headers.get('content-type'), 'image/jpeg');
  assert.match(th.headers.get('cache-control'), /max-age=3600/);
  assert.match(th.headers.get('content-disposition'), /^inline/);
  assert.equal((await th.arrayBuffer()).byteLength, 304);
  const before = (await call(srv.base, `/api/transfers/${id}`, { key })).data.stats.downloads;
  assert.equal(before, 0, 'regarder la galerie ne compte pas de téléchargement');

  // ZIP des fichiers choisis seulement
  const z = await fetch(`${srv.base}/api/public/t/${id}/zip?v=visiteur-galerie&only=${fa.id},${fb.id}`);
  assert.equal(z.status, 200);
  const zip = Buffer.from(await z.arrayBuffer());
  assert.ok(zip.includes(Buffer.from('a.jpg')) && zip.includes(Buffer.from('b.jpg')));
  assert.ok(!zip.includes(Buffer.from('notes.txt')));

  // Aperçu WhatsApp (3.19) : titre parlant et première photo
  const page = await (await fetch(`${srv.base}/t/${id}`)).text();
  assert.match(page, /<meta property="og:title" content="2 photos · 1 fichier">/);
  assert.match(page, new RegExp(`og:image" content="[^"]*/api/public/t/${id}/cover\\.jpg"`));
  const cover = await fetch(`${srv.base}/api/public/t/${id}/cover.jpg`);
  assert.equal(cover.status, 200); assert.equal(cover.headers.get('content-type'), 'image/jpeg');

  // Relecture par l'expéditeur pour préparer les vignettes d'un ancien lien
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/files/${fb.id}/raw`)).status, 403);
  const raw = await fetch(`${srv.base}/api/transfers/${id}/files/${fb.id}/raw?key=${encodeURIComponent(key)}`);
  assert.equal(raw.status, 200); assert.equal((await raw.arrayBuffer()).byteLength, photoB.length);
  assert.equal((await fetch(`${srv.base}/api/transfers/${id}/files/${ft.id}/raw?key=${encodeURIComponent(key)}`)).status, 404);
});

test('aperçu WhatsApp : rien de révélé pour un lien protégé par PIN', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [{ name: 'secret.jpg', size: 100, type: 'image/jpeg' }], pin: '135790' } });
  const f = c.data.files[0];
  const u = await call(srv.base, `/api/transfers/${c.data.id}/files/${f.id}/urls`, { method: 'POST', key: c.data.ownerKey, body: { parts: [1] } });
  await fetch(u.data.urls[1], { method: 'PUT', body: jpeg(96) });
  await call(srv.base, `/api/transfers/${c.data.id}/files/${f.id}/complete`, { method: 'POST', key: c.data.ownerKey });
  await call(srv.base, `/api/transfers/${c.data.id}/finalize`, { method: 'POST', key: c.data.ownerKey, body: {} });
  await call(srv.base, `/api/transfers/${c.data.id}/files/${f.id}/previews`, { method: 'POST', key: c.data.ownerKey, body: { thumb: jpeg(50).toString('base64') } });
  const page = await (await fetch(`${srv.base}/t/${c.data.id}`)).text();
  assert.doesNotMatch(page, /secret|photo ·|cover\.jpg/);
  assert.equal((await fetch(`${srv.base}/api/public/t/${c.data.id}/cover.jpg`)).status, 404);
});

test('galerie : le serveur compresse lui-même une photo arrivée sans aperçu', async (t) => {
  const sharp = require('sharp');
  const srv = await startServer();
  t.after(srv.stop);
  const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a7' } }).jpeg({ quality: 95 }).toBuffer();
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [{ name: 'classe.jpg', size: big.length, type: 'image/jpeg' }] } });
  const { id, ownerKey: key } = c.data; const f = c.data.files[0];
  const u = await call(srv.base, `/api/transfers/${id}/files/${f.id}/urls`, { method: 'POST', key, body: { parts: [1] } });
  await fetch(u.data.urls[1], { method: 'PUT', body: big });
  await call(srv.base, `/api/transfers/${id}/files/${f.id}/complete`, { method: 'POST', key });
  await call(srv.base, `/api/transfers/${id}/finalize`, { method: 'POST', key, body: {} });

  const pub = await call(srv.base, `/api/public/t/${id}?v=visiteur`);
  assert.equal(pub.data.files[0].spv, 1);
  const th = await fetch(`${srv.base}/api/public/t/${id}/pv/${f.id}/thumb?v=visiteur`);
  assert.equal(th.status, 200);
  assert.equal(th.headers.get('content-type'), 'image/jpeg');
  const tb = Buffer.from(await th.arrayBuffer());
  const m = await sharp(tb).metadata();
  assert.equal(Math.min(m.width, m.height), 300);
  const view = await fetch(`${srv.base}/api/public/t/${id}/pv/${f.id}/view?v=visiteur`);
  const vm = await sharp(Buffer.from(await view.arrayBuffer())).metadata();
  assert.equal(Math.max(vm.width, vm.height), 1400);
  const again = await call(srv.base, `/api/public/t/${id}?v=visiteur`);
  assert.ok(again.data.files[0].th && again.data.files[0].pv && !again.data.files[0].spv);
  assert.equal(again.data.files[0].iw, 3000);
  // 3.21 : aperçu flou minuscule directement dans la réponse
  assert.match(again.data.files[0].lq, /^data:image\/jpeg;base64,/);
  assert.ok(again.data.files[0].lq.length < 2800);
});

test('galerie : une photo illisible par le serveur ne bloque rien (deux essais, puis l\'original)', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const bad = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 7)]);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [{ name: 'abimee.jpg', size: bad.length, type: 'image/jpeg' }] } });
  const { id, ownerKey: key } = c.data; const f = c.data.files[0];
  const u = await call(srv.base, `/api/transfers/${id}/files/${f.id}/urls`, { method: 'POST', key, body: { parts: [1] } });
  await fetch(u.data.urls[1], { method: 'PUT', body: bad });
  await call(srv.base, `/api/transfers/${id}/files/${f.id}/complete`, { method: 'POST', key });
  await call(srv.base, `/api/transfers/${id}/finalize`, { method: 'POST', key, body: {} });
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${srv.base}/api/public/t/${id}/pv/${f.id}/thumb?v=visiteur&r=${i}`);
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(await r.arrayBuffer()).length, bad.length);   // l'original, faute de mieux
  }
  const pub = await call(srv.base, `/api/public/t/${id}?v=visiteur`);
  assert.ok(!pub.data.files[0].spv);   // abandon après deux essais : plus de file d'attente pour rien
});

test('vidéo : le serveur fabrique lui-même 480p et 720p quand l\'expéditeur ne l\'a pas fait', { timeout: 120e3 }, async (t) => {
  const { execFileSync } = require('child_process');
  let ff; try { ff = require('ffmpeg-static'); execFileSync(ff, ['-version'], { stdio: 'ignore' }); } catch (e) { t.skip('ffmpeg absent'); return; }
  const srv = await startServer({ TRANSCODE_DELAY_MS: '0' });
  t.after(srv.stop);
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lestha-vid-')), 'cours.mp4');
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-c:a', 'aac', '-shortest', src]);
  const big = fs.readFileSync(src);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [{ name: 'cours.mp4', size: big.length, type: 'video/mp4' }] } });
  const { id, ownerKey: key } = c.data; const f = c.data.files[0];
  const u = await call(srv.base, `/api/transfers/${id}/files/${f.id}/urls`, { method: 'POST', key, body: { parts: [1] } });
  await fetch(u.data.urls[1], { method: 'PUT', body: big });
  await call(srv.base, `/api/transfers/${id}/files/${f.id}/complete`, { method: 'POST', key });
  await call(srv.base, `/api/transfers/${id}/finalize`, { method: 'POST', key, body: {} });
  let pub;
  for (let i = 0; i < 120; i++) {
    pub = await call(srv.base, `/api/public/t/${id}?v=visiteur`);
    if ((pub.data.files[0].q || []).length >= 2) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const q = pub.data.files[0].q || [];
  assert.deepEqual(q.map(x => x.h), [480, 720]);
  assert.match(q[0].mime, /avc1/);
  assert.ok(!pub.data.files[0].sq);
  const r = await fetch(`${srv.base}/api/public/t/${id}/f/${q[0].id}?v=visiteur&inline=1`);
  assert.equal(r.status, 200);
  const out = path.join(path.dirname(src), 'q.mp4');
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  const info = (() => { try { execFileSync(ff, ['-hide_banner', '-i', out], { stdio: 'pipe' }); } catch (e) { return String(e.stderr); } })();
  assert.match(info, /854x480/);
});
