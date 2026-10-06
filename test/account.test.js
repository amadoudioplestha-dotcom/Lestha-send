'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mountAccount } = require('../lib/account');

function setup() {
  const routes = {}, files = new Map();
  const app = { get: (p, f) => (routes['GET ' + p] = f), put: (p, f) => (routes['PUT ' + p] = f), delete: (p, f) => (routes['DELETE ' + p] = f) };
  const storage = { putBuffer: async (k, b) => files.set(k, b), getBuffer: async (k) => { if (!files.has(k)) throw new Error('absent'); return files.get(k); }, deleteKey: async (k) => files.delete(k) };
  mountAccount(app, { storage, secret: 'secret-de-test', verifiedEmail: (req) => req.email || null });
  const call = (m, p, email, body) => new Promise((ok, ko) => {
    const res = { code: 200, set() { return res; }, status(c) { res.code = c; return res; }, json(d) { ok({ code: res.code, body: d }); } };
    routes[m + ' ' + p]({ email, body, headers: {}, ip: '1.2.3.4', socket: {}, get: () => '' }, res, ko);
  });
  return { call, files };
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
