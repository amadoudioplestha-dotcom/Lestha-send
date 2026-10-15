'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStorageUsage, groupOf } = require('../lib/storage-usage');

test('stockage R2 : rangement des objets', () => {
  assert.strictEqual(groupOf('files/abc/f1'), 'fichiers');
  assert.strictEqual(groupOf('files/abc/f1_thumb.jpg'), 'apercus');
  assert.strictEqual(groupOf('files/abc/f1_view.jpg'), 'apercus');
  assert.strictEqual(groupOf('files/abc/f1_pg3.jpg'), 'apercus');
  assert.strictEqual(groupOf('files/abc/f1_r720'), 'videos');
  assert.strictEqual(groupOf('files/abc/voice_c1.mp3'), 'replays');
  assert.strictEqual(groupOf('meetdocs/m1/d1'), 'reunions');
  assert.strictEqual(groupOf('meta/abc.json'), 'donnees');
});

test('stockage R2 : inventaire, coût et alerte une seule fois par seuil', async () => {
  const files = new Map([['files/a/f1', 6e9], ['files/a/f1_thumb.jpg', 1e6], ['files/b/f2', 6e9], ['meta/a.json', 1000]]);
  const store = new Map(), sent = [];
  const storage = { async listSizes() { return [...files].map(([key, size]) => ({ key, size })); }, async getBuffer(k) { return store.get(k) || null; }, async putBuffer(k, b) { store.set(k, b); } };
  const u = createStorageUsage({ storage, mailer: { enabled: true, async send(m) { sent.push(m); } }, env: { ADMIN_EMAIL: 'a@b.c' } });
  const s = await u.scan();
  assert.strictEqual(s.objects, 4);
  assert.ok(Math.abs(s.total - 12.001001e9) < 1);
  assert.ok(s.cost > 0.029 && s.cost < 0.031, 'coût ' + s.cost);
  assert.strictEqual(s.groups[0].key, 'fichiers');
  assert.strictEqual(s.biggest.length, 2);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /100 %/);
  await u.scan();
  assert.strictEqual(sent.length, 1, 'pas de deuxième alerte ce mois-ci');
  assert.ok(store.has('system/storage-usage.json'));
});
