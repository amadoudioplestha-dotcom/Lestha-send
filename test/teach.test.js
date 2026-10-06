'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mountMeet } = require('../lib/meet');

/* Faux socket.io : juste ce qu'utilise lib/meet.js (salles, émissions, accusés de réception) */
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
      on: (e, fn) => ev.set(e, fn),
      join: (r) => { if (!rooms.has(r)) rooms.set(r, new Set()); rooms.get(r).add(s.id); },
      leave: (r) => { const x = rooms.get(r); if (x) x.delete(s.id); },
      to: (r) => target(r, s.id),
      call: (e, data) => new Promise(res => { const fn = ev.get(e); fn(data, res); setTimeout(() => res(undefined), 20); }),
      last: (e) => [...s.got].reverse().find(x => x[0] === e)
    };
    sockets.set(s.id, s);
    handlers.forEach(h => h(s));
    return s;
  };
  return io;
}

test('outils de l\'enseignant : annotations, tableau blanc, minuteur, compris / perdu', async () => {
  const io = fakeIo();
  mountMeet({ post() {} }, io, { env: {} });
  const prof = io.connect(), eleve = io.connect(), tard = io.connect();
  const c = await prof.call('meet-create', { title: 'Cours', kind: 'video', mode: 'course' });
  const a = await prof.call('meet-join', { id: c.id, name: 'Prof', hostKey: c.hostKey });
  const b = await eleve.call('meet-join', { id: c.id, name: 'Awa' });
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.ink, []);
  assert.equal(a.self.pulse, '');

  // Un élève ne peut pas annoter sans autorisation
  await eleve.call('meet-ink', { op: 'add', s: { id: 'eleve001', tool: 'pen', c: '#22c55e', w: 4, pts: [0.1, 0.1, 0.2, 0.2] } });
  assert.equal(prof.last('meet-ink'), undefined, 'trait refusé');

  // Le présentateur annote : trait vérifié, relayé et gardé pour ceux qui arrivent
  await prof.call('meet-state', { screen: true });
  await prof.call('meet-ink', { op: 'add', s: { id: 'trait001', tool: 'arrow', c: '#EF4444', w: 99, pts: [0.1, 0.2, 5, 0.5] } });
  const got = eleve.last('meet-ink')[1];
  assert.equal(got.op, 'add');
  assert.deepEqual(got.s, { id: 'trait001', by: a.self.pid, tool: 'arrow', c: '#ef4444', w: 40, pts: [0.1, 0.2, 1.2, 0.5] });
  await prof.call('meet-ink', { op: 'add', s: { id: 'trait002', tool: 'text', c: '#ffffff', w: 6, pts: [0.5, 0.5, 0.6, 0.6], t: '<b>Kc</b> = coefficient' } });
  assert.equal(eleve.last('meet-ink')[1].s.t, 'bKc/b = coefficient', 'texte nettoyé');
  assert.deepEqual(eleve.last('meet-ink')[1].s.pts, [0.5, 0.5]);
  await prof.call('meet-ink', { op: 'add', s: { id: 'trait003', tool: 'fade', c: '#ffffff', w: 4, pts: [0.1, 0.1, 0.3, 0.3] } });
  await prof.call('meet-ink', { op: 'add', s: { id: 'mauvais', tool: 'script', pts: [0, 0] } });
  await prof.call('meet-ink', { op: 'add', s: { id: 'trait004', tool: 'pen', pts: [0.1, 'x'] } });
  const c2 = await tard.call('meet-join', { id: c.id, name: 'Moussa' });
  assert.deepEqual(c2.ink.map(x => x.id), ['trait001', 'trait002'], 'encre éphémère et traits invalides non gardés');

  // Laser et trait en cours : relayés, jamais gardés
  await prof.call('meet-ink', { op: 'laser', x: 0.4, y: 0.6 });
  assert.equal(eleve.last('meet-ink')[1].op, 'laser');
  await prof.call('meet-ink', { op: 'live', s: { id: 'trait005', tool: 'pen', c: '#ffffff', w: 4 }, pts: [0.1, 0.1, 0.12, 0.13], at: 0 });
  assert.equal(eleve.last('meet-ink')[1].op, 'live');

  // Autoriser les élèves : ils annotent, et ne gomment que leurs propres traits
  await prof.call('meet-host', { action: 'inkAll', value: true });
  assert.equal(eleve.last('meet-info')[1].inkAll, true);
  await eleve.call('meet-ink', { op: 'add', s: { id: 'eleve002', tool: 'pen', c: '#22c55e', w: 4, pts: [0.1, 0.1, 0.2, 0.2] } });
  eleve.got.length = 0;
  await eleve.call('meet-ink', { op: 'del', ids: ['trait001'] });
  assert.equal(eleve.last('meet-ink'), undefined, 'un élève ne gomme pas le trait du professeur');
  await eleve.call('meet-ink', { op: 'del', ids: ['eleve002'] });
  assert.deepEqual(eleve.last('meet-ink')[1], { op: 'del', ids: ['eleve002'] });
  await eleve.call('meet-ink', { op: 'clear' });
  assert.equal(eleve.last('meet-ink')[1].op, 'del', 'un élève ne peut pas tout effacer');

  // Fin de la présentation : les annotations disparaissent, sauf si le tableau blanc est ouvert
  await prof.call('meet-host', { action: 'board', value: true });
  await prof.call('meet-state', { screen: false });
  assert.equal((await io.connect().call('meet-peek', { id: c.id })).meeting.board, true);
  assert.notEqual(eleve.last('meet-ink')[1].op, 'clear', 'tableau blanc ouvert : on garde les traits');
  await prof.call('meet-host', { action: 'board', value: false });
  assert.deepEqual(eleve.last('meet-ink')[1], { op: 'clear' });

  // Minuteur commun : temps restant, pas l'heure du serveur
  assert.equal((await prof.call('meet-host', { action: 'timer', value: { sec: 2 } })).error, 'Durée invalide.');
  await prof.call('meet-host', { action: 'timer', value: { sec: 300, label: 'Exercice 2' } });
  const t = eleve.last('meet-info')[1].timer;
  assert.equal(t.sec, 300); assert.equal(t.label, 'Exercice 2'); assert.ok(t.left > 299000 && t.left <= 300000);
  await eleve.call('meet-host', { action: 'timerStop' });
  assert.ok(eleve.last('meet-info')[1].timer, 'un élève ne peut pas arrêter le minuteur');
  await prof.call('meet-host', { action: 'timerStop' });
  assert.equal(eleve.last('meet-info')[1].timer, null);

  // J'ai compris / Je suis perdu
  await eleve.call('meet-state', { pulse: 'lost' });
  assert.equal(prof.last('meet-state')[1].pulse, 'lost');
  await eleve.call('meet-state', { pulse: 'n\'importe quoi' });
  assert.equal(prof.last('meet-state')[1].pulse, '');
  await eleve.call('meet-state', { pulse: 'ok' });
  await prof.call('meet-host', { action: 'pulseReset' });
  await eleve.call('meet-state', { away: true });
  assert.equal(prof.last('meet-state')[1].away, true, 'l\'enseignant voit qui a quitté la page du cours');
  assert.equal(eleve.last('meet-state')[1].pulse, '', 'remis à zéro par l\'enseignant');
});
