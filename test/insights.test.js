'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInsights, normSource, normError, normCountry, deviceOf } = require('../lib/insights');
const { createIce } = require('../lib/turn');

function memStorage() {
  const m = new Map();
  return { m, async getBuffer(k) { return m.has(k) ? m.get(k) : null; }, async putBuffer(k, b) { m.set(k, Buffer.from(b)); } };
}
const req = (h = {}) => ({ get: (k) => h[k.toLowerCase()] });
const AID = 'a1b2c3d4e5f6a7b8c9d0e1f2';

test('provenance, pays, appareil et erreurs sont normalisés sans donnée personnelle', () => {
  assert.equal(normSource('https://www.tiktok.com/@x/video/1'), 'tiktok');
  assert.equal(normSource('l.facebook.com'), 'facebook');
  assert.equal(normSource('wa.me'), 'whatsapp');
  assert.equal(normSource(''), 'direct');
  assert.equal(normSource('<script>'), 'script');
  assert.equal(normCountry('sn'), 'SN');
  assert.equal(normCountry('XX'), '??');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 13; SM) Mobile'), 'mobile');
  const e = normError('Le fichier « rapport-confidentiel.pdf » dépasse 2 Go pour moussa@exemple.sn');
  assert.ok(!/rapport|moussa|2/.test(e), e);
});

test('événements agrégés : visites, parcours, modes, fidélité, Direct', async () => {
  let now = Date.UTC(2026, 9, 5, 10);
  const storage = memStorage();
  const ins = createInsights({ storage, secret: 's'.repeat(32), mailer: { enabled: false }, env: {}, ctx: {}, now: () => now });
  await ins.ready;
  const r = req({ 'cf-ipcountry': 'SN', 'user-agent': 'iPhone Mobile' });
  await ins.record({ e: 'visit', aid: AID, src: 'tiktok' }, r);
  await ins.record({ e: 'pick', aid: AID }, r);
  await ins.record({ e: 'sent', aid: AID, m: 'direct', b: 9e9 }, r);
  await ins.record({ e: 'p2p', aid: AID, ok: 1, relay: true, b: 9e9, ms: 600000, r: 2 }, r);
  await ins.record({ e: 'err', aid: AID, msg: 'Connexion impossible. Vérifiez votre réseau.' }, r);
  assert.equal(await ins.record({ e: 'inconnu' }, r), false);
  now += 86400e3 * 2;
  await ins.record({ e: 'visit', aid: AID, src: 'whatsapp' }, req({ 'cf-ipcountry': 'CI' }));
  await ins.record({ e: 'sent', aid: AID, m: 'cloud' }, r);
  const rep = await ins.report(7);
  assert.equal(rep.totals.visits, 2);
  assert.equal(rep.totals.src.tiktok, 1);
  assert.equal(rep.totals.cc.SN, 1);
  assert.equal(rep.totals.funnel.sent, 2);
  assert.equal(rep.totals.modes.direct, 1);
  assert.equal(rep.totals.p2p.relay, 1);
  assert.equal(rep.p2pAvgSpeed, 15e6);
  assert.equal(rep.loyalty.active, 1);
  assert.equal(rep.loyalty.repeat, 1);
  assert.equal(rep.errors.length, 1);
  await ins.flush();
  const saved = [...storage.m.keys()].join(' ');
  assert.match(saved, /system\/insights\/d\/2026-10-05\.json/);
  assert.ok(!saved.includes(AID) && ![...storage.m.values()].some(b => b.toString().includes(AID)), 'identifiant brut jamais stocké');
});

test('avis et votes : validation, un vote par visiteur', async () => {
  const ins = createInsights({ storage: memStorage(), secret: 'k'.repeat(32), mailer: { enabled: false }, env: {}, ctx: {} });
  await ins.ready;
  await assert.rejects(ins.addFeedback({}, req()), /quelques mots/);
  const f = await ins.addFeedback({ mood: 5, text: 'Très rapide <b>!</b>', email: 'pas-un-email', heard: 'tiktok', kind: 'avis' }, req({ 'cf-ipcountry': 'SN' }));
  assert.equal(f.email, '');
  assert.equal(f.mood, 5);
  // Idée créée par la console, puis votée
  const routes = {};
  const r = { get: (p, h) => { routes['GET ' + p] = h; }, post: (p, h) => { routes['POST ' + p] = h; }, patch: (p, h) => { routes['PATCH ' + p] = h; }, delete: (p, h) => { routes['DELETE ' + p] = h; } };
  ins.mountAdmin(r);
  let out; const res = { json: (x) => { out = x; }, status() { return this; } };
  await routes['POST /ideas']({ body: { title: 'Envoi programmé' } }, res);
  const id = out.id;
  assert.equal((await ins.vote(id, AID)).votes, 1);
  assert.equal((await ins.vote(id, AID)).votes, 0, 'second clic = retrait du vote');
  await ins.vote(id, AID);
  await ins.vote(id, 'zzzzzzzzzzzzzzzzzzzzzzzz');
  assert.equal((await ins.listIdeas(AID))[0].votes, 2);
  assert.equal((await ins.listIdeas(AID))[0].voted, true);
  const w = await ins.weeklyHtml();
  assert.ok(w.paragraphs.some(p => p.includes('Envoi programmé')));
});

test('relais TURN Cloudflare : identifiants éphémères, cache, port 53 retiré, repli', async () => {
  let calls = 0, t = 1e12;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.match(url, /\/v1\/turn\/keys\/KEY\/credentials\/generate-ice-servers$/);
    assert.equal(opts.headers.Authorization, 'Bearer TOK');
    assert.equal(JSON.parse(opts.body).ttl, 21600);
    return { ok: true, status: 201, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }) };
  };
  const ice = createIce({ CF_TURN_KEY_ID: 'KEY', CF_TURN_API_TOKEN: 'TOK' }, { fetchImpl, now: () => t });
  assert.equal(ice.provider, 'cloudflare');
  const a = await ice.getIceServers();
  assert.equal(a.relay, true);
  const turn = a.iceServers.find(s => s.username);
  assert.deepEqual(turn.urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
  await ice.getIceServers();
  assert.equal(calls, 1, 'mis en cache');
  t += 21 * 60e3;
  await ice.getIceServers();
  assert.equal(calls, 2, 'renouvelé après 20 min');
  const down = createIce({ CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }, { fetchImpl: async () => ({ ok: false, status: 401 }) });
  const b = await down.getIceServers();
  assert.equal(b.relay, false);
  assert.ok(b.iceServers.length >= 1);
  assert.match(down.status().lastError, /401/);
  const none = createIce({});
  assert.equal(none.provider, null);
  const custom = createIce({ TURN_URL: 'turn:relay.exemple.sn:3478', TURN_USERNAME: 'a', TURN_CREDENTIAL: 'b' });
  assert.equal((await custom.getIceServers()).relay, true);
});
