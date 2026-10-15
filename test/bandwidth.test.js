'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createBandwidth, categoryOf } = require('../lib/bandwidth');

test('bande passante : catégories des adresses', () => {
  assert.strictEqual(categoryOf('/api/public/t/abc/zip'), 'zip');
  assert.strictEqual(categoryOf('/api/public/t/abc/f/x1'), 'fichiers');
  assert.strictEqual(categoryOf('/api/public/t/abc/pg/x1/2'), 'apercus');
  assert.strictEqual(categoryOf('/api/meet/r1/doc/3.jpg'), 'reunions');
  assert.strictEqual(categoryOf('/js/app.js'), 'site');
  assert.strictEqual(categoryOf('/api/transfers'), 'api');
});

test('bande passante : compte les octets envoyés, par catégorie, et alerte au seuil', async () => {
  const files = new Map(), sent = [];
  const storage = { direct: true, async getBuffer(k) { return files.get(k) || null; }, async putBuffer(k, b) { files.set(k, b); } };
  const mailer = { enabled: true, async send(m) { sent.push(m); } };
  const bw = createBandwidth({ storage, mailer, env: { BW_LIMIT_GB: '0.000001', ADMIN_EMAIL: 'a@b.c' } });   // limite : 1 Ko
  await bw.ready;
  const app = express(); const server = http.createServer(app);
  bw.attach(server, app);
  app.get('/api/public/t/x/zip', (req, res) => res.end(Buffer.alloc(5000)));
  app.get('/js/a.js', (req, res) => res.send('x'.repeat(1000)));
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const u of ['/api/public/t/x/zip', '/js/a.js']) { const r = await fetch(base + u); await r.arrayBuffer(); }
  await storage.putBuffer('files/a/b.jpg', Buffer.alloc(300));
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await new Promise(r => setTimeout(r, 50));
  const s = bw.summary();
  const cat = Object.fromEntries(s.categories.map(c => [c.key, c.bytes]));
  assert.strictEqual(cat.zip, 5000);
  assert.strictEqual(cat.site, 1000);
  assert.strictEqual(cat.r2, 300);
  assert.ok(s.total >= 6300, 'total avec en-têtes : ' + s.total);
  assert.ok(cat.tempsreel > 0, 'en-têtes comptés à part');
  await bw.check();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /100 %/);
  await bw.check();
  assert.strictEqual(sent.length, 1, 'une seule alerte par seuil');
  await bw.flush();
  assert.ok([...files.keys()].some(k => k.startsWith('system/bandwidth/')));
});
