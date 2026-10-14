'use strict';
/* Aperçu des documents (3.24) : vignettes, lien de lecture, lecture par morceaux sans compter de téléchargement */
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


test('documents : vignette de la première page, lien d\'aperçu et lecture par morceaux', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(5000)), docx = Buffer.alloc(3000, 3), bin = Buffer.alloc(100, 1);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [
    { name: 'cours.pdf', size: pdf.length, type: 'application/pdf' }, { name: 'notes.docx', size: docx.length, type: '' }, { name: 'setup.exe', size: bin.length, type: '' }
  ], downloadLimit: 1 } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const { id, ownerKey: key } = c.data;
  for (const [i, f] of c.data.files.entries()) {
    const u = await call(srv.base, `/api/transfers/${id}/files/${f.id}/urls`, { method: 'POST', key, body: { parts: [1] } });
    assert.equal((await fetch(u.data.urls[1], { method: 'PUT', body: [pdf, docx, bin][i] })).status, 200);
    assert.equal((await call(srv.base, `/api/transfers/${id}/files/${f.id}/complete`, { method: 'POST', key })).status, 200);
  }
  assert.equal((await call(srv.base, `/api/transfers/${id}/finalize`, { method: 'POST', key, body: {} })).status, 200);
  const [fp, fd, fx] = c.data.files;

  // Vignette d'un document acceptée (pas de version écran) ; refusée pour un programme
  const ok = await call(srv.base, `/api/transfers/${id}/files/${fd.id}/previews`, { method: 'POST', key, body: { thumb: jpeg(400).toString('base64'), view: jpeg(800).toString('base64'), w: 794, h: 1123 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.file.th); assert.equal(ok.data.file.pv, undefined);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fx.id}/previews`, { method: 'POST', key, body: { thumb: jpeg(400).toString('base64') } })).status, 404);
  const th = await fetch(`${srv.base}/api/public/t/${id}/pv/${fd.id}/thumb?v=lecteur`);
  assert.equal(th.status, 200); assert.equal(th.headers.get('content-type'), 'image/jpeg');

  // Lien d'aperçu : stockage local → pas de lien direct, le navigateur lit /f/…?pv=1
  const info = await call(srv.base, `/api/public/t/${id}/doc/${fp.id}?v=lecteur`);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  assert.equal(info.data.size, pdf.length); assert.equal(info.data.url, null); assert.equal(info.data.office, false);
  assert.equal((await call(srv.base, `/api/public/t/${id}/doc/${fx.id}?v=lecteur`)).status, 404);

  // Lecture par morceaux (Range) d'un Word : 206, et ce n'est pas un téléchargement (limite à 1 intacte)
  const part = await fetch(`${srv.base}/api/public/t/${id}/f/${fd.id}?v=lecteur&pv=1`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${srv.base}/api/public/t/${id}/f/${fd.id}?v=lecteur&pv=1`)).status, 200);
  assert.equal((await fetch(`${srv.base}/api/public/t/${id}/f/${fp.id}?v=lecteur&pv=1&inline=1`)).status, 200);
  // 3.25 : pages du PDF en images, envoyées une par une par l'expéditeur
  const pg = (i, extra = {}) => call(srv.base, `/api/transfers/${id}/files/${fp.id}/pages`, { method: 'POST', key, body: Object.assign({ i, img: jpeg(900).toString('base64'), total: 12, w: 595, h: 842 }, extra) });
  assert.equal((await pg(1)).status, 200);
  assert.equal((await pg(3)).data.n, 1, 'page 2 manquante : seule la page 1 compte');
  assert.equal((await pg(2)).data.n, 3);
  assert.equal((await pg(11)).status, 400);
  assert.equal((await pg(4, { img: Buffer.from('pas une image').toString('base64') })).status, 400);
  assert.equal((await call(srv.base, `/api/transfers/${id}/files/${fp.id}/pages`, { method: 'POST', body: { i: 4, img: jpeg(10).toString('base64') } })).status, 403);
  const pub = await call(srv.base, `/api/public/t/${id}?v=lecteur`);
  const vp = pub.data.files.find(x => x.id === fp.id);
  assert.deepEqual(vp.pg, { n: 3, total: 12, w: 595, h: 842 });
  const im = await fetch(`${srv.base}/api/public/t/${id}/pg/${fp.id}/2?v=lecteur`);
  assert.equal(im.status, 200); assert.equal(im.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${srv.base}/api/public/t/${id}/pg/${fp.id}/5?v=lecteur`)).status, 404);

  const st = (await call(srv.base, `/api/transfers/${id}`, { key })).data.stats;
  assert.equal(st.downloads, 0, 'l\'aperçu ne compte pas de téléchargement');
  // pv=1 ne vaut rien pour un fichier qui n'est pas un document
  await fetch(`${srv.base}/api/public/t/${id}/f/${fx.id}?v=autre&pv=1`);
  assert.equal((await call(srv.base, `/api/transfers/${id}`, { key })).data.stats.downloads, 1);
});
