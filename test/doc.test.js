'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { mountMeet } = require('../lib/meet');

/* Faux socket.io (comme teach.test.js) */
function fakeIo() {
  const rooms = new Map(), sockets = new Map(), handlers = [];
  const deliver = (ids, ev, data, except) => ids.forEach(id => { if (id !== except) { const s = sockets.get(id); if (s) s.got.push([ev, data]); } });
  const target = (name, except) => { const em = (ev, data) => deliver([...(rooms.get(name) || [])].concat(sockets.has(name) ? [name] : []), ev, data, except); return { emit: em, volatile: { emit: em } }; };
  const io = { on: (ev, fn) => { if (ev === 'connection') handlers.push(fn); }, to: (name) => target(name), sockets: { sockets } };
  let n = 0;
  io.connect = () => {
    const ev = new Map();
    const s = {
      id: 'sock' + (++n), got: [], handshake: { headers: {}, address: '10.0.0.' + n }, conn: { remoteAddress: '10.0.0.' + n },
      on: (e, fn) => ev.set(e, fn), join: (r) => { if (!rooms.has(r)) rooms.set(r, new Set()); rooms.get(r).add(s.id); },
      leave: (r) => { const x = rooms.get(r); if (x) x.delete(s.id); }, to: (r) => target(r, s.id),
      call: (e, data) => new Promise(res => { const fn = ev.get(e); fn(data, res); setTimeout(() => res(undefined), 20); }),
      last: (e) => [...s.got].reverse().find(x => x[0] === e)
    };
    sockets.set(s.id, s); handlers.forEach(h => h(s)); return s;
  };
  return io;
}
/* Fausse application express : routes gardées, appelées avec de fausses requêtes */
function fakeApp() {
  const routes = [];
  const add = (method) => (path, ...fns) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fns });
  const app = { post: add('POST'), put: add('PUT'), get: add('GET') };
  app.call = (method, url, { headers = {}, body, raw } = {}) => new Promise((resolve) => {
    const r = routes.find(x => x.method === method && x.re.test(url));
    const req = Object.assign(new EventEmitter(), { params: r ? url.match(r.re).groups : {}, body, headers, ip: '10.0.0.9', socket: { remoteAddress: '10.0.0.9' }, get: (h) => headers[h.toLowerCase()] });
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, set(h) { Object.assign(this.headers, h); return this; }, type(t) { this.headers['Content-Type'] = t; return this; },
      json(o) { this.headersSent = true; resolve({ status: this.statusCode, json: o }); }, end(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b, headers: this.headers }); } };
    if (!r) return resolve({ status: 404 });
    let i = 0; const next = () => { const fn = r.fns[i++]; if (fn) fn(req, res, next); };
    next();
    if (raw !== undefined) setImmediate(() => { req.emit('data', raw); req.emit('end'); });
  });
  return app;
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

test('présenter un fichier : pages, annotations par page, navigation libre, support', async () => {
  const io = fakeIo(), app = fakeApp();
  const stored = new Map();
  const storage = { putBuffer: async (k, b) => { stored.set(k, b); }, getBuffer: async (k) => stored.get(k), deleteKey: async (k) => { stored.delete(k); } };
  mountMeet(app, io, { env: {}, storage });
  const prof = io.connect(), eleve = io.connect();
  const c = await prof.call('meet-create', { title: 'Cours', kind: 'video', mode: 'course' });
  const a = await prof.call('meet-join', { id: c.id, name: 'Prof', hostKey: c.hostKey });
  const b = await eleve.call('meet-join', { id: c.id, name: 'Awa' });
  const P = { 'x-meet-token': a.token }, E = { 'x-meet-token': b.token };

  // Un élève ne peut pas présenter
  assert.equal((await app.call('POST', `/api/meet/${c.id}/doc`, { headers: E, body: { n: 3 } })).status, 403);
  const r = await app.call('POST', `/api/meet/${c.id}/doc`, { headers: P, body: { name: '<b>Cours</b> Kc', n: 3, dims: [[1600, 900], [1600, 900]] } });
  assert.equal(r.status, 200); const doc = r.json.id;
  assert.equal(prof.last('meet-info')[1].doc, null, 'invisible tant que la première page n\'est pas là');

  // Pages : type vérifié, première page = le fichier apparaît chez tout le monde
  assert.equal((await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/0`, { headers: Object.assign({ 'content-type': 'image/jpeg' }, P), raw: Buffer.from('<svg>') })).status, 415);
  assert.equal((await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/9`, { headers: Object.assign({ 'content-type': 'image/jpeg' }, P), raw: JPEG })).status, 400);
  assert.equal((await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/0`, { headers: Object.assign({ 'content-type': 'image/jpeg' }, E), raw: JPEG })).status, 403);
  assert.equal((await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/0`, { headers: Object.assign({ 'content-type': 'image/jpeg' }, P), raw: JPEG })).status, 200);
  const d = eleve.last('meet-info')[1].doc;
  assert.deepEqual({ name: d.name, n: d.n, page: d.page, dims: d.dims[2] }, { name: 'bCours/b Kc', n: 3, page: 0, dims: [1600, 900] });
  await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/1`, { headers: Object.assign({ 'content-type': 'image/jpeg' }, P), raw: JPEG });
  assert.deepEqual(eleve.last('meet-doc')[1], { id: doc, n: 1, ready: 2 });
  const img = await app.call('GET', `/api/meet/${c.id}/doc/${doc}/1`);
  assert.equal(img.headers['Content-Type'], 'image/jpeg'); assert.ok(img.body.equals(JPEG));
  assert.equal((await app.call('GET', `/api/meet/${c.id}/doc/mauvais/1`)).status, 404);

  // Annotations rangées par page
  await prof.call('meet-ink', { op: 'add', s: { id: 'page0aa', tool: 'pen', c: '#ef4444', w: 4, pts: [0.1, 0.1, 0.2, 0.2] } });
  await eleve.call('meet-host', { action: 'docPage', value: 1 });
  assert.equal(eleve.last('meet-info')[1].doc.page, 0, 'un élève ne tourne pas la page pour tout le monde');
  await prof.call('meet-host', { action: 'docPage', value: 1 });
  assert.deepEqual(eleve.last('meet-ink')[1], { op: 'load', ink: [] });
  await prof.call('meet-host', { action: 'docPage', value: 0 });
  assert.deepEqual(eleve.last('meet-ink')[1].ink.map(s => s.id), ['page0aa']);
  const late = await io.connect().call('meet-join', { id: c.id, name: 'Moussa' });
  assert.equal(late.meeting.doc.id, doc); assert.deepEqual(late.ink.map(s => s.id), ['page0aa']);

  // Navigation libre et support téléchargeable
  await prof.call('meet-host', { action: 'docFree', value: true });
  assert.equal(eleve.last('meet-info')[1].doc.free, true);
  assert.equal((await app.call('GET', `/api/meet/${c.id}/doc/${doc}/file`)).status, 404);
  await app.call('PUT', `/api/meet/${c.id}/doc/${doc}/file`, { headers: Object.assign({ 'x-file-name': encodeURIComponent('Cours Kc.pdf') }, P), raw: Buffer.from('%PDF-1.4') });
  assert.equal(eleve.last('meet-info')[1].doc.dl, false, 'pas téléchargeable sans l\'accord de l\'enseignant');
  await prof.call('meet-host', { action: 'docDl', value: true });
  const f = await app.call('GET', `/api/meet/${c.id}/doc/${doc}/file`);
  assert.equal(f.body.toString(), '%PDF-1.4'); assert.match(f.headers['Content-Disposition'], /Cours%20Kc\.pdf/);

  // Fin de la présentation : tout disparaît, y compris le support stocké
  await prof.call('meet-host', { action: 'docClose' });
  assert.equal(eleve.last('meet-info')[1].doc, null);
  assert.deepEqual(eleve.last('meet-ink')[1], { op: 'clear' });
  assert.equal((await app.call('GET', `/api/meet/${c.id}/doc/${doc}/0`)).status, 404);
  assert.equal(stored.size, 0);
});
