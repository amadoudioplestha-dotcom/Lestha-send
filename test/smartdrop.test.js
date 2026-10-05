'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SD = require('../lib/smartdrop');

test('Smart Drop : modèles, champs nettoyés, contrôle des dépôts, numéros', () => {
  const cat = SD.catalog();
  assert.equal(cat.sectors.length, 15, '15 secteurs');
  assert.ok(cat.templates.every(t => t.fields.some(SD.isFileField)), 'chaque modèle demande des fichiers');
  // Champs fournis par le créateur : types inconnus et libellés vides écartés, un champ fichier ajouté si absent
  const f = SD.cleanFields([{ type: 'text', label: 'Nom', required: true }, { type: 'script', label: 'x' }, { type: 'select', label: 'Choix', options: [] }, { type: 'email', label: '' }]);
  assert.deepEqual(f.map(x => x.type), ['text', 'files']);
  const t = cat.templates.find(x => x.id === 'candidature');
  const q = { fields: SD.cleanFields(t.fields), accept: SD.cleanAccept(t.accept), maxFileBytes: 1000, sector: 'rh' };
  const base = { answers: { nom: 'Ndiaye', prenom: 'Awa', email: 'awa@x.sn', tel: '+221 77 000 00 00' } };
  const ok = SD.checkDeposit(q, Object.assign({}, base, { files: [{ name: 'cv.pdf', size: 10, field: 'cv' }, { name: 'l.docx', size: 10, field: 'lettre' }] }));
  assert.ifError(ok.error);
  assert.equal(ok.name, 'Awa Ndiaye'); assert.equal(ok.email, 'awa@x.sn');
  assert.deepEqual(ok.files.map(x => x.path), ['CV/cv.pdf', 'Lettre de motivation/l.docx']);
  assert.match(SD.checkDeposit(q, Object.assign({}, base, { files: [{ name: 'l.pdf', size: 10, field: 'lettre' }] })).error, /CV/);
  assert.equal(SD.checkDeposit(q, Object.assign({}, base, { files: [{ name: 'x.exe', size: 1, field: 'cv' }, { name: 'l.pdf', size: 1, field: 'lettre' }] })).status, 415);
  assert.equal(SD.checkDeposit(q, Object.assign({}, base, { files: [{ name: 'cv.pdf', size: 5000, field: 'cv' }, { name: 'l.pdf', size: 1, field: 'lettre' }] })).status, 413);
  assert.match(SD.checkDeposit(q, { answers: Object.assign({}, base.answers, { email: 'faux' }), files: [] }).error, /e-mail/);
  assert.match(SD.checkDeposit(q, Object.assign({}, base, { files: [{ name: 'a.pdf', size: 1, field: 'cv' }, { name: 'b.pdf', size: 1, field: 'cv' }, { name: 'l.pdf', size: 1, field: 'lettre' }] })).error, /Un seul fichier/);
  assert.equal(SD.numberOf({ sector: 'rh' }, 7), 'CAND-0007');
  assert.equal(SD.numberOf({}, 12), 'DEP-0012');
  // Anciennes demandes : nom + fichiers + message
  const legacy = SD.checkDeposit({}, { name: 'Moussa', message: 'salut', files: [{ name: 'a.txt', size: 3 }] });
  assert.equal(legacy.name, 'Moussa'); assert.equal(legacy.answers.message, 'salut');
});
