'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSfu } = require('../lib/meet');
const { createCodes } = require('../lib/codes');

test('réunions : client Cloudflare Realtime (URL, secret, erreurs) et code à 6 chiffres', async () => {
  assert.equal(createSfu({}), null, 'sans identifiants : moteur direct');
  const calls = [];
  const sfu = createSfu({ CF_SFU_APP_ID: 'APP', CF_SFU_APP_TOKEN: 'TOK' }, { fetchImpl: async (url, o) => { calls.push({ url, o }); return { ok: true, status: 201, json: async () => ({ sessionId: 'abc' }) }; } });
  assert.equal((await sfu.newSession()).sessionId, 'abc');
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/apps/APP/sessions/new');
  assert.equal(calls[0].o.headers.Authorization, 'Bearer TOK');
  const bad = createSfu({ CF_SFU_APP_ID: 'A', CF_SFU_APP_TOKEN: 'T' }, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errorCode: 'X', errorDescription: 'refusé' }) }) });
  await assert.rejects(bad.tracks('s', {}), /refusé/);
  const codes = createCodes({ storage: { getBuffer: async () => null, putBuffer: async () => {} } });
  let alive = true; codes.useMeet(() => alive);
  const c = await codes.forMeet('abcdefghjk');
  assert.deepEqual(await codes.resolve(c, () => false), { kind: 'meet', id: 'abcdefghjk' });
  alive = false;
  assert.equal(await codes.resolve(c, () => false), null, 'réunion terminée : code libéré');
  // Lien durable : le code survit à un redémarrage (lu dans le stockage)
  const store = new Map();
  const st = { getBuffer: async k => store.get(k) || null, putBuffer: async (k, b) => { store.set(k, b); }, deleteKey: async k => { store.delete(k); } };
  const c2 = await createCodes({ storage: st }).forMeet('mnpqrstuvw', Date.now() + 3600e3);
  const fresh = createCodes({ storage: st }); fresh.useMeet(async id => id === 'mnpqrstuvw');
  assert.deepEqual(await fresh.resolve(c2, () => false), { kind: 'meet', id: 'mnpqrstuvw' });
  fresh.restoreMeet(c2, 'mnpqrstuvw'); fresh.dropMeet('mnpqrstuvw', true);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.size, 0, 'lien supprimé : code effacé du stockage');
});
