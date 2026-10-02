'use strict';
/**
 * Tests de sécurité de bout en bout : un vrai serveur est démarré sur un port libre,
 * avec un stockage disque temporaire, puis attaqué comme le ferait un script malveillant.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const GB = 1024 ** 3;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lestha-test-'));
  const env = Object.assign({}, process.env, {
    PORT: String(port), STORAGE_DRIVER: 'local', DATA_DIR: dir, PUBLIC_URL: `http://127.0.0.1:${port}`,
    RENDER: '', RENDER_SERVICE_ID: '', SENDGRID_API_KEY: '', SMTP_HOST: '', UPLOAD_CODE: '', ORIGIN_SECRET: '',
    TURNSTILE_SECRET: '', TURNSTILE_SITE_KEY: '', ADMIN_PASSWORD: '', NODE_ENV: 'test'
  }, extraEnv);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (e) { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error('Serveur non démarré :\n' + log);
  }
  const stop = () => new Promise((resolve) => { child.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); }); child.kill('SIGTERM'); });
  return { base, stop, log: () => log };
}

const ip = (n) => `203.0.113.${n}`;
async function call(base, p, { method = 'GET', body, headers = {}, fromIp } = {}) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers);
  if (fromIp) h['cf-connecting-ip'] = fromIp;
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const smallFile = (size = 1000) => ({ name: 'photo.jpg', size, type: 'image/jpeg' });

test('ORIGIN_SECRET : toute requête qui contourne Cloudflare est refusée, /health reste accessible', async (t) => {
  const srv = await startServer({ ORIGIN_SECRET: 'secret-de-test-tres-long-123' });
  t.after(srv.stop);
  assert.equal((await fetch(srv.base + '/health')).status, 200);
  assert.equal((await fetch(srv.base + '/api/config')).status, 403);
  assert.equal((await fetch(srv.base + '/api/config', { headers: { 'x-origin-secret': 'mauvais' } })).status, 403);
  assert.equal((await fetch(srv.base + '/api/config', { headers: { 'x-origin-secret': 'secret-de-test-tres-long-123' } })).status, 200);
  // socket.io : la connexion à l'espace de noms est refusée sans l'en-tête, acceptée avec
  async function nsConnect(headers) {
    const hs = await (await fetch(srv.base + '/socket.io/?EIO=4&transport=polling', { headers })).text();
    const sid = JSON.parse(hs.slice(1)).sid;
    const url = `${srv.base}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
    await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'text/plain;charset=UTF-8' }, headers), body: '40' });
    return (await fetch(url, { headers })).text();
  }
  assert.match(await nsConnect({}), /^44/);
  assert.match(await nsConnect({ 'x-origin-secret': 'secret-de-test-tres-long-123' }), /^40/);
});

test('offre sans compte : taille, envois vides, quota journalier, PIN court et e-mails refusés', async (t) => {
  const srv = await startServer({ FREE_DAILY_TRANSFERS: '2' });
  t.after(srv.stop);
  const cfg = await call(srv.base, '/api/config');
  assert.equal(cfg.data.tier, 'free');
  assert.equal(cfg.data.maxTransferBytes, 2 * GB);
  assert.equal(cfg.data.emailRecipients, 0);

  const big = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile(3 * GB)] }, fromIp: ip(1) });
  assert.equal(big.status, 413);
  assert.equal(big.data.needVerify, true);

  const empty = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [{ name: 'vide.txt', size: 0 }] }, fromIp: ip(1) });
  assert.equal(empty.status, 400);

  const shortPin = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()], pin: '1234' }, fromIp: ip(1) });
  assert.equal(shortPin.status, 400);
  // les envois refusés ne consomment pas le quota du jour : l'adresse ip(1) peut encore envoyer 2 fois
  for (let i = 0; i < 2; i++) assert.equal((await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()] }, fromIp: ip(1) })).status, 200);

  // ttl demandé de 30 jours : ramené à la durée de l'offre (3 jours), et alerte refusée sans adresse vérifiée
  const ok = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()], ttl: 30 * 86400e3, notifyOnDownload: true, senderEmail: 'victime@exemple.com' }, fromIp: ip(2) });
  assert.equal(ok.status, 200);
  const owner = await call(srv.base, `/api/transfers/${ok.data.id}`, { headers: { 'x-owner-key': ok.data.ownerKey } });
  assert.equal(owner.data.notifyOnDownload, false);
  assert.equal(owner.data.senderEmail, '');

  assert.equal((await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()] }, fromIp: ip(2) })).status, 200);
  const third = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()] }, fromIp: ip(2) });
  assert.equal(third.status, 429);

  // e-mail du mode Direct : refusé sans adresse vérifiée
  const mail = await call(srv.base, '/api/send-email', { method: 'POST', body: { to: 'cible@exemple.com', link: srv.base + '/?room=TX-ABCDEFGH' }, fromIp: ip(3) });
  assert.equal(mail.status, 401);
  assert.equal(mail.data.needVerify, true);

  // demande de fichiers : réservée aux adresses vérifiées
  const req = await call(srv.base, '/api/requests', { method: 'POST', body: { title: 'Devoirs' }, fromIp: ip(4) });
  assert.equal(req.status, 401);
  assert.equal(req.data.needVerify, true);
});

test('PIN : verrouillage du lien après 20 échecs, même depuis 20 adresses différentes', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()], pin: '135790' }, fromIp: ip(10) });
  assert.equal(c.status, 200);
  for (let i = 0; i < 20; i++) {
    const r = await call(srv.base, `/api/public/t/${c.data.id}/unlock`, { method: 'POST', body: { pin: String(100000 + i) }, fromIp: ip(100 + i) });
    assert.equal(r.status, 403);
  }
  const locked = await call(srv.base, `/api/public/t/${c.data.id}/unlock`, { method: 'POST', body: { pin: '135790' }, fromIp: ip(200) });
  assert.equal(locked.status, 429);
});

test('signalements : 3 signalements distincts suspendent le lien, et l\'expéditeur ne peut pas le réactiver', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()] }, fromIp: ip(20) });
  for (let i = 0; i < 3; i++) {
    const r = await call(srv.base, `/api/public/t/${c.data.id}/report`, { method: 'POST', body: { reason: 'Arnaque' }, fromIp: ip(30 + i) });
    assert.equal(r.status, 200);
  }
  const pub = await call(srv.base, `/api/public/t/${c.data.id}`);
  assert.equal(pub.data.state, 'disabled');
  assert.equal(pub.data.reported, true);
  const reenable = await call(srv.base, `/api/transfers/${c.data.id}`, { method: 'PATCH', headers: { 'x-owner-key': c.data.ownerKey }, body: { disabled: false } });
  assert.equal(reenable.status, 403);
});

test('administrateur : accès complet, sans quotas', async (t) => {
  const srv = await startServer({ ADMIN_PASSWORD: 'mot-de-passe-admin-solide', FREE_DAILY_TRANSFERS: '1' });
  t.after(srv.stop);
  const login = await call(srv.base, '/api/admin/login', { method: 'POST', body: { password: 'mot-de-passe-admin-solide' }, fromIp: ip(40) });
  assert.equal(login.status, 200);
  const auth = { authorization: 'Bearer ' + login.data.token };
  const cfg = await call(srv.base, '/api/config', { headers: auth });
  assert.equal(cfg.data.tier, 'full');
  assert.equal(cfg.data.admin, true);
  // les pages publiques envoient le jeton dans X-Admin-Token : mêmes droits, y compris l'e-mail sans vérification
  const pub = { 'x-admin-token': login.data.token };
  assert.equal((await call(srv.base, '/api/config', { headers: pub })).data.tier, 'full');
  assert.equal((await call(srv.base, '/api/requests', { method: 'POST', headers: pub, body: { title: 'Dossiers' }, fromIp: ip(42) })).status, 200);
  assert.equal((await call(srv.base, '/api/config', { headers: { 'x-admin-token': 'faux.jeton' } })).data.tier, 'free');
  for (let i = 0; i < 3; i++) {
    const r = await call(srv.base, '/api/transfers', { method: 'POST', headers: auth, body: { files: [smallFile(50 * GB)] }, fromIp: ip(41) });
    assert.equal(r.status, 200);
  }
  const ov = await call(srv.base, '/api/admin/overview?fresh=1', { headers: auth });
  assert.equal(ov.status, 200);
  assert.ok(ov.data.system.warnings.some(w => w.code === 'no-origin-secret'));
});

test('mot de passe admin : 6 essais au plus par quart d\'heure et par adresse', async (t) => {
  const srv = await startServer({ ADMIN_PASSWORD: 'mot-de-passe-admin-solide', ORIGIN_SECRET: 'secret-de-test-tres-long-123' });
  t.after(srv.stop);
  const h = { 'x-origin-secret': 'secret-de-test-tres-long-123' };
  let last;
  for (let i = 0; i < 7; i++) last = await call(srv.base, '/api/admin/login', { method: 'POST', headers: h, body: { password: 'faux' + i }, fromIp: ip(50) });
  assert.equal(last.status, 429);
});

test('lien Direct : après un redémarrage, seul l\'expéditeur d\'origine peut le reprendre', async () => {
  const { mountP2P } = require('../lib/p2p');
  const files = new Map();
  const storage = {
    putBuffer: async (k, b) => { files.set(k, Buffer.from(b)); },
    getBuffer: async (k) => files.get(k) || null,
    deleteKey: async (k) => { files.delete(k); }
  };
  function harness() {
    let onConnection;
    const io = { on: (e, h) => { if (e === 'connection') onConnection = h; }, to: () => ({ emit: () => {} }) };
    mountP2P(io, { storage });
    return () => {
      const handlers = new Map();
      const socket = { id: 's' + Math.random(), handshake: { headers: {}, address: '127.0.0.1' }, data: {}, join: () => {}, emit: () => {}, on: (e, h) => handlers.set(e, h) };
      onConnection(socket);
      return (ev, payload) => new Promise((resolve) => { const r = handlers.get(ev)(payload, resolve); if (r && r.then) r.then(() => {}); });
    };
  }
  const first = harness()();
  const created = await first('create-room', { ttl: 3600e3 });
  assert.equal(created.success, true);
  assert.match(created.roomId, /^TX-[A-Z0-9]{8}$/);
  await new Promise(r => setTimeout(r, 10));

  const restarted = harness();              // nouveau processus : salles en mémoire perdues
  const thief = await restarted()('reclaim-room', { roomId: created.roomId, senderKey: 'cle-volee', expiresAt: Date.now() + 3600e3 });
  assert.equal(thief.success, false);
  const owner = await restarted()('reclaim-room', { roomId: created.roomId, senderKey: created.senderKey });
  assert.equal(owner.success, true);

  const badPin = await restarted()('create-room', { ttl: 3600e3, pin: '1234' });
  assert.equal(badPin.success, false);
});

/* Faux serveur SMTP : capte les e-mails envoyés par le serveur testé */
function fakeSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    sock.write('220 test\r\n');
    let buf = '', inData = false;
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
          messages.push(buf.slice(0, end)); buf = buf.slice(end + 5); inData = false; sock.write('250 ok\r\n'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); return; }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, messages, close: () => new Promise(r => server.close(r)) })));
}

test('adresse vérifiée : code par e-mail, offre élargie, plafond de destinataires', async (t) => {
  const smtp = await fakeSmtp();
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@test.local', EMAIL_MAX_RECIPIENTS: '2' });
  t.after(async () => { await srv.stop(); await smtp.close(); });

  const start = await call(srv.base, '/api/verify/start', { method: 'POST', body: { email: 'Amadou@Exemple.com' }, fromIp: ip(60) });
  assert.equal(start.status, 200);
  await new Promise(r => setTimeout(r, 200));
  const code = (smtp.messages.join('\n').match(/(\d{6}) est votre code/) || [])[1];
  assert.ok(code, 'code reçu par e-mail');

  const wrong = await call(srv.base, '/api/verify/confirm', { method: 'POST', body: { email: 'amadou@exemple.com', code: code === '000000' ? '111111' : '000000' }, fromIp: ip(60) });
  assert.equal(wrong.status, 403);
  const ok = await call(srv.base, '/api/verify/confirm', { method: 'POST', body: { email: 'amadou@exemple.com', code }, fromIp: ip(60) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, 'amadou@exemple.com');
  const H = { 'x-sender-token': ok.data.token };

  const cfg = await call(srv.base, '/api/config', { headers: H });
  assert.equal(cfg.data.tier, 'verified');
  assert.equal(cfg.data.maxTransferBytes, 10 * GB);

  // 5 Go : refusé sans compte, accepté avec l'adresse vérifiée
  assert.equal((await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile(5 * GB)] }, fromIp: ip(61) })).status, 413);
  const c = await call(srv.base, '/api/transfers', { method: 'POST', headers: H, body: { files: [smallFile(5 * GB)], notifyOnDownload: true, senderEmail: 'victime@exemple.com' }, fromIp: ip(61) });
  assert.equal(c.status, 200);
  const owner = await call(srv.base, `/api/transfers/${c.data.id}`, { headers: Object.assign({ 'x-owner-key': c.data.ownerKey }, H) });
  assert.equal(owner.data.senderEmail, 'amadou@exemple.com');   // les alertes ne partent que vers l'adresse vérifiée

  // un jeton falsifié n'ouvre rien
  const forged = await call(srv.base, '/api/config', { headers: { 'x-sender-token': ok.data.token.slice(0, -2) + 'xx' } });
  assert.equal(forged.data.tier, 'free');

  // e-mail du lien Direct accepté avec le jeton, et l'expéditeur vérifié figure dans le message
  const before = smtp.messages.length;
  const mail = await call(srv.base, '/api/send-email', { method: 'POST', headers: H, body: { to: 'ami@exemple.com', link: srv.base + '/?room=TX-ABCDEFGH', fileName: 'photos.zip' }, fromIp: ip(62) });
  assert.equal(mail.status, 200);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(smtp.messages.length > before);
  assert.match(smtp.messages[smtp.messages.length - 1], /amadou@exemple\.com/);
});

/* ------------------------------------------------------------------ */
/*  Profil, lien personnel @nom, compteurs et pages                     */
/* ------------------------------------------------------------------ */
async function verifiedHeaders(srv, smtp, email, n) {
  await call(srv.base, '/api/verify/start', { method: 'POST', body: { email }, fromIp: ip(n) });
  await new Promise(r => setTimeout(r, 200));
  const all = smtp.messages.join('\n');
  const codes = [...all.matchAll(/(\d{6}) est votre code/g)].map(m => m[1]);
  const ok = await call(srv.base, '/api/verify/confirm', { method: 'POST', body: { email, code: codes[codes.length - 1] }, fromIp: ip(n) });
  assert.equal(ok.status, 200);
  return { 'x-sender-token': ok.data.token };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');

test('profil : nom, couleur et logo contrôlé, affichés sur la page de téléchargement', async (t) => {
  const smtp = await fakeSmtp();
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@test.local' });
  t.after(async () => { await srv.stop(); await smtp.close(); });
  assert.equal((await call(srv.base, '/api/profile')).status, 401);
  const H = await verifiedHeaders(srv, smtp, 'studio@exemple.sn', 70);

  assert.equal((await call(srv.base, '/api/profile', { method: 'PUT', headers: H, body: { displayName: 'Studio', color: 'red' } })).status, 400);
  assert.equal((await call(srv.base, '/api/profile', { method: 'PUT', headers: H, body: { displayName: 'Studio', website: 'javascript:alert(1)' } })).status, 400);
  const put = await call(srv.base, '/api/profile', { method: 'PUT', headers: H, body: { displayName: '<b>Studio Ndiaye</b>', color: '#06D6A0', website: 'studio.sn' } });
  assert.equal(put.status, 200);
  assert.equal(put.data.displayName, 'bStudio Ndiaye/b');
  assert.equal(put.data.website, 'https://studio.sn/');

  // une image SVG (qui peut contenir du script) est refusée, même déguisée
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
  assert.equal((await call(srv.base, '/api/profile/logo', { method: 'POST', headers: H, body: { data: svg } })).status, 415);
  const logo = await call(srv.base, '/api/profile/logo', { method: 'POST', headers: H, body: { data: 'data:image/png;base64,' + PNG } });
  assert.equal(logo.status, 200);
  const img = await fetch(srv.base + logo.data.logo);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');

  const c = await call(srv.base, '/api/transfers', { method: 'POST', headers: H, body: { files: [smallFile()] }, fromIp: ip(71) });
  const pub = await call(srv.base, `/api/public/t/${c.data.id}`);
  assert.equal(pub.data.brand.displayName, 'bStudio Ndiaye/b');
  assert.equal(pub.data.brand.color, '#06d6a0');
  // un envoi sans adresse vérifiée n'a jamais d'habillage
  const anon = await call(srv.base, '/api/transfers', { method: 'POST', body: { files: [smallFile()] }, fromIp: ip(72) });
  assert.equal((await call(srv.base, `/api/public/t/${anon.data.id}`)).data.brand, undefined);
});

test('lien personnel @nom : réservation, unicité, dépôt, reprise sur un autre appareil', async (t) => {
  const smtp = await fakeSmtp();
  const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@test.local' });
  t.after(async () => { await srv.stop(); await smtp.close(); });
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', body: { name: 'amadou' }, fromIp: ip(80) })).status, 401);
  const H = await verifiedHeaders(srv, smtp, 'amadou@exemple.sn', 81);
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', headers: H, body: { name: 'admin' }, fromIp: ip(81) })).status, 400);
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', headers: H, body: { name: 'lestha-officiel' }, fromIp: ip(81) })).status, 400);
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', headers: H, body: { name: 'A' }, fromIp: ip(81) })).status, 400);
  const mk = await call(srv.base, '/api/handles', { method: 'POST', headers: H, body: { name: 'amadou-diop', title: 'Mes dépôts' }, fromIp: ip(81) });
  assert.equal(mk.status, 200);
  assert.match(mk.data.link, /\/@amadou-diop$/);
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', headers: H, body: { name: 'autre-nom' }, fromIp: ip(81) })).status, 409);
  const H2 = await verifiedHeaders(srv, smtp, 'intrus@exemple.sn', 82);
  assert.equal((await call(srv.base, '/api/handles', { method: 'POST', headers: H2, body: { name: 'amadou-diop' }, fromIp: ip(82) })).status, 409);
  assert.equal((await call(srv.base, '/api/handles/check/amadou-diop')).data.available, false);

  const h = await call(srv.base, '/api/public/h/Amadou-Diop');
  assert.equal(h.data.id, mk.data.id);
  const box = await call(srv.base, `/api/public/d/${h.data.id}`);
  assert.equal(box.data.permanent, true);
  assert.equal(box.data.state, 'open');
  const dep = await call(srv.base, `/api/public/d/${h.data.id}/deposit`, { method: 'POST', body: { name: 'Fatou', files: [smallFile()] }, fromIp: ip(83) });
  assert.equal(dep.status, 200);

  // depuis un autre appareil : l'adresse vérifiée redonne la gestion, l'ancienne clé ne sert plus
  assert.equal((await call(srv.base, '/api/handles/recover', { method: 'POST', headers: H2, body: {} })).status, 404);
  const rec = await call(srv.base, '/api/handles/recover', { method: 'POST', headers: H, body: {} });
  assert.equal(rec.status, 200);
  assert.equal((await call(srv.base, `/api/requests/${mk.data.id}`, { headers: { 'x-owner-key': mk.data.ownerKey } })).status, 403);
  const own = await call(srv.base, `/api/requests/${mk.data.id}`, { headers: { 'x-owner-key': rec.data.ownerKey } });
  assert.equal(own.status, 200);
  assert.equal(own.data.deposits.length, 1);
  assert.equal((await call(srv.base, `/api/transfers/${dep.data.transferId}`, { headers: { 'x-owner-key': rec.data.ownerKey } })).status, 200);

  // supprimer le lien libère le nom
  assert.equal((await call(srv.base, `/api/requests/${mk.data.id}`, { method: 'DELETE', headers: { 'x-owner-key': rec.data.ownerKey } })).status, 200);
  assert.equal((await call(srv.base, '/api/handles/check/amadou-diop')).data.available, true);
  assert.equal((await call(srv.base, '/api/public/h/amadou-diop')).status, 404);
});

test('pages publiques, page introuvable et compteurs', async (t) => {
  const srv = await startServer({ STATS_MIN_TRANSFERS: '0' });
  t.after(srv.stop);
  for (const p of ['/', '/a-propos', '/securite', '/faq', '/@amadou']) assert.equal((await fetch(srv.base + p)).status, 200, p);
  const nf = await fetch(srv.base + '/une-page-qui-n-existe-pas');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Lestha Send/);
  assert.equal((await fetch(srv.base + '/fichier-absent.png')).status, 404);
  const s = await call(srv.base, '/api/public/stats');
  assert.equal(s.data.show, true);
  assert.equal(typeof s.data.transfers, 'number');
});

test('compteurs masqués tant que les chiffres sont trop petits', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  assert.equal((await call(srv.base, '/api/public/stats')).data.show, false);
});
