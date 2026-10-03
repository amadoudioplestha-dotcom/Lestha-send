'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCodes } = require('../lib/codes');

const mem = () => { const m = new Map(); return { m, async getBuffer(k) { return m.get(k) || null; }, async putBuffer(k, b) { m.set(k, Buffer.from(b)); } }; };

test('codes à 6 chiffres : Direct en mémoire, Cloud limité à 24 h, échecs plafonnés', async () => {
  let t = 1e12;
  const codes = createCodes({ storage: mem(), now: () => t });
  const alive = new Set(['TX-AAAAAAAA']);
  const c1 = codes.forRoom('TX-AAAAAAAA');
  assert.match(c1, /^\d{6}$/);
  assert.equal(codes.forRoom('TX-AAAAAAAA'), c1, 'même code pour le même lien');
  assert.deepEqual(await codes.resolve(c1, id => alive.has(id)), { kind: 'direct', roomId: 'TX-AAAAAAAA' });
  alive.clear();
  assert.equal(await codes.resolve(c1, id => alive.has(id)), null, 'lien fermé : code libéré');
  const cl = await codes.forTransfer('abc123', t + 7 * 86400e3);
  assert.equal(cl.expiresAt, t + 86400e3, 'jamais plus de 24 h');
  assert.deepEqual(await codes.resolve(cl.code, () => false), { kind: 'cloud', id: 'abc123' });
  const short = await codes.forTransfer('court', t + 3600e3);
  assert.equal(short.expiresAt, t + 3600e3, 'jamais au-delà du lien');
  t += 86400e3 + 1;
  assert.equal(await codes.resolve(cl.code, () => false), null, 'expiré');
  assert.equal(await codes.resolve('12a456', () => true), null);
  for (let i = 0; i < 401; i++) codes.noteFail();
  assert.equal(codes.locked(), true);
});
