'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mountAccount } = require('../lib/account');

function setup() {
  const routes = {}, files = new Map();
  const app = { get: (p, f) => (routes['GET ' + p] = f), put: (p, f) => (routes['PUT ' + p] = f), delete: (p, f) => (routes['DELETE ' + p] = f) };
  const storage = { putBuffer: async (k, b) => files.set(k, b), getBuffer: async (k) => { if (!files.has(k)) throw new Error('absent'); return files.get(k); }, deleteKey: async (k) => files.delete(k) };
  const acc = mountAccount(app, { storage, secret: 'secret-de-test', verifiedEmail: (req) => req.email || null });
  const call = (m, p, email, body) => new Promise((ok, ko) => {
    const res = { code: 200, set() { return res; }, status(c) { res.code = c; return res; }, json(d) { ok({ code: res.code, body: d }); } };
    routes[m + ' ' + p]({ email, body, headers: {}, ip: '1.2.3.4', socket: {}, get: () => '' }, res, ko);
  });
  return { call, files, acc };
}

test('Compte : coffre chiffré par adresse, réservé à son propriétaire', async () => {
  const { call, files } = setup();
  assert.equal((await call('GET', '/api/account/vault', null)).code, 401, 'sans connexion : refusé');
  const vault = { owned: [{ id: 'abc123', key: 'cle-secrete-123', title: 'Devoir L2' }], meetings: [], lives: [] };
  assert.equal((await call('PUT', '/api/account/vault', 'prof@lestha.sn', { vault })).body.ok, true);
  const raw = [...files.values()][0].toString('latin1');
  assert.ok(!raw.includes('cle-secrete-123') && !raw.includes('prof@lestha.sn'), 'rien de lisible dans le stockage');
  assert.ok(![...files.keys()][0].includes('prof'), 'adresse absente du nom de fichier');
  const back = await call('GET', '/api/account/vault', 'prof@lestha.sn');
  assert.deepEqual(back.body.vault, vault, 'retrouvé sur un autre appareil');
  assert.equal((await call('GET', '/api/account/vault', 'autre@lestha.sn')).body.vault, null, 'chaque compte ne voit que le sien');
  assert.equal((await call('PUT', '/api/account/vault', 'prof@lestha.sn', { vault: [] })).code, 400);
  assert.equal((await call('PUT', '/api/account/vault', 'prof@lestha.sn', { vault: { big: 'x'.repeat(600 * 1024) } })).code, 413);
  await call('DELETE', '/api/account/vault', 'prof@lestha.sn');
  assert.equal((await call('GET', '/api/account/vault', 'prof@lestha.sn')).body.vault, null, 'compte supprimé');
});

test('Admin : liste des inscrits avec leurs compteurs, annuaire chiffré', async () => {
  const { call, files, acc } = setup();
  await call('PUT', '/api/account/vault', 'a@lestha.sn', { vault: { owned: [{ id: 'x', key: 'k' }], requests: [{ id: 'r1' }, { id: 'r2' }], meetings: [], lives: [] } });
  await call('GET', '/api/account/vault', 'b@lestha.sn');
  await new Promise(r => setTimeout(r, 5));
  const list = await acc.list();
  assert.deepEqual(list.map(x => x.email).sort(), ['a@lestha.sn', 'b@lestha.sn']);
  const a = list.find(x => x.email === 'a@lestha.sn');
  assert.deepEqual(a.counts, { t: 1, r: 2, m: 0, l: 0 });
  assert.ok(a.first > 0 && a.last >= a.first && a.visits === 1);
  await acc.flush();
  const raw = files.get('accounts/directory.bin').toString('latin1');
  assert.ok(!raw.includes('a@lestha.sn'), 'annuaire illisible sans le secret');
  await call('DELETE', '/api/account/vault', 'a@lestha.sn');
  assert.deepEqual((await acc.list()).map(x => x.email), ['b@lestha.sn'], 'compte supprimé : retiré de la liste');
});
