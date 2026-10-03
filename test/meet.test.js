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
  const c = codes.forMeet('abcdefghjk');
  assert.deepEqual(await codes.resolve(c, () => false), { kind: 'meet', id: 'abcdefghjk' });
  alive = false;
  assert.equal(await codes.resolve(c, () => false), null, 'réunion terminée : code libéré');
});
