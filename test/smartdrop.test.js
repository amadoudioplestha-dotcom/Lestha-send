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

test('Smart Drop : chemins de fichiers sûrs (ZIP) et types vérifiés aussi sur le chemin', () => {
  const { safePath } = require('../lib/util');
  assert.equal(safePath('....//....//....//evil.exe'), '..../..../..../evil.exe');
  assert.equal(safePath('../../a/b.txt'), 'a/b.txt');
  assert.equal(safePath('a\\..\\..\\x.pdf'), 'a/x.pdf');
  assert.equal(safePath('/etc/passwd'), 'etc/passwd');
  assert.ok(!safePath('../../../x').split('/').includes('..'));
  const t = SD.catalog().templates.find(x => x.id === 'devoir');
  const q = { fields: SD.cleanFields(t.fields), accept: ['pdf'] };
  const one = (files) => SD.checkDeposit(q, { answers: { etudiant: 'Awa' }, files });
  assert.equal(one([{ name: 'cv.pdf', path: 'x/../../cv.exe', size: 10 }]).status, 415, '.exe caché dans le chemin refusé');
  assert.equal(one([{ name: 'cv.pdf', path: '../../../cv.pdf', size: 10 }]).files[0].path, 'cv.pdf', 'chemin nettoyé');
  assert.ok(one([null, { name: 'a.pdf', size: 3 }]).files, 'entrée vide ignorée sans erreur');
  assert.equal(one([{ name: 'devoir.pdf', path: 'evil.exe/', size: 10 }]).status, 415, 'barre finale : .exe refusé');
  assert.equal(safePath('C:\\x\\y.pdf'), 'C-/x/y.pdf', 'pas de « : » dans un chemin de ZIP');
});

test('Smart Drop : nom du déposant jamais écrit deux fois', () => {
  const F = { id: 'f', type: 'files', label: 'Fichiers', required: true };
  const t = (id, label) => ({ id, type: 'text', label });
  const name = (fields, answers) => SD.checkDeposit({ fields }, { answers, files: [{ name: 'a.pdf', size: 1, field: 'f' }] });
  assert.equal(name([t('nom', 'Nom'), t('prenom', 'Prénom'), F], { nom: 'Diop', prenom: 'Awa' }).name, 'Awa Diop');
  assert.equal(name([t('nom', 'Nom et prénom'), F], { nom: 'Awa Diop' }).name, 'Awa Diop', 'un seul champ « Nom et prénom »');
  assert.equal(name([t('text1', 'Nom'), t('text2', 'Prénom'), F], { text1: 'Diop', text2: 'Awa' }).name, 'Awa Diop', 'champs ajoutés à la main');
  assert.equal(name([t('nom', 'Nom'), t('prenom', 'Prénom'), F], { nom: 'Awa Diop', prenom: 'Awa' }).name, 'Awa Diop', 'nom complet tapé dans « Nom »');
  assert.equal(name([t('projet', 'Nom du projet'), t('nom', 'Nom ou société'), F], { projet: 'X', nom: 'Studio Y' }).name, 'Studio Y');
  assert.deepEqual(name([t('nom', 'Nom'), t('prenom', 'Prénom'), t('classe', 'Classe'), F], { nom: 'Diop', prenom: 'Awa', classe: 'L2' }).nameFields, ['prenom', 'nom']);
});
