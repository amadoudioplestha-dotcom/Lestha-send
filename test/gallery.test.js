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

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lestha-gal-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), STORAGE_DRIVER: 'local', DATA_DIR: dir, PUBLIC_URL: `http://127.0.0.1:${port}`,
    RENDER: '', RENDER_SERVICE_ID: '', SENDGRID_API_KEY: '', SMTP_HOST: '', UPLOAD_CODE: '', ORIGIN_SECRET: '',
    TURNSTILE_SECRET: '', TURNSTILE_SITE_KEY: '', ADMIN_PASSWORD: '', NODE_ENV: 'test'
  });
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
});
