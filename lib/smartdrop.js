'use strict';
/**
 * Smart Drop : modèles d'espaces de dépôt par secteur, champs personnalisables,
 * contrôle des réponses et des fichiers, numéros d'accusé de réception, statuts.
 * Source unique : le navigateur reçoit ce catalogue par /api/smartdrop/catalog.
 */

const F = (id, type, label, extra = {}) => Object.assign({ id, type, label, required: false }, extra);
const req = (f) => Object.assign(f, { required: true });

/* Types de fichiers autorisés (par extension ; le navigateur filtre aussi le sélecteur) */
const ACCEPT = {
  pdf: { label: 'PDF', ext: ['pdf'] },
  office: { label: 'Word, Excel, PowerPoint', ext: ['doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp'] },
  image: { label: 'Images', ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng'] },
  video: { label: 'Vidéos', ext: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mts', 'm2ts', 'mxf', '3gp'] },
  audio: { label: 'Audio', ext: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'aif', 'aiff'] },
  design: { label: 'Fichiers de création', ext: ['psd', 'ai', 'eps', 'indd', 'idml', 'fig', 'sketch', 'xd', 'afdesign', 'afphoto', 'cdr', 'prproj', 'aep', 'drp', 'fcpxml', 'blend', 'dwg', 'dxf', 'skp', 'rvt', 'ifc', 'ttf', 'otf'] },
  archive: { label: 'Archives (ZIP…)', ext: ['zip', 'rar', '7z', 'tar', 'gz'] }
};

const SECTORS = [
  { id: 'rh', label: 'RH / Recrutement', prefix: 'CAND', icon: 'users' },
  { id: 'education', label: 'Éducation / Formation', prefix: 'REN', icon: 'doc' },
  { id: 'entreprise', label: 'Entreprise / PME', prefix: 'DOC', icon: 'folder' },
  { id: 'administration', label: 'Administration', prefix: 'DOS', icon: 'clipboard' },
  { id: 'ong', label: 'ONG / Association', prefix: 'DOS', icon: 'sparkles' },
  { id: 'evenement', label: 'Événementiel', prefix: 'EVT', icon: 'image' },
  { id: 'audiovisuel', label: 'Audiovisuel / Photographie', prefix: 'PROD', icon: 'film' },
  { id: 'communication', label: 'Communication / Marketing', prefix: 'COM', icon: 'share' },
  { id: 'btp', label: 'Architecture / BTP', prefix: 'PLAN', icon: 'monitor' },
  { id: 'commerce', label: 'Commerce', prefix: 'CMD', icon: 'inbox' },
  { id: 'finance', label: 'Comptabilité / Finance', prefix: 'PIECE', icon: 'chart' },
  { id: 'juridique', label: 'Juridique / Conseil', prefix: 'DOS', icon: 'shield' },
  { id: 'recherche', label: 'Recherche / Université', prefix: 'RECH', icon: 'search' },
  { id: 'projet', label: 'Projets / Prestations', prefix: 'PROJ', icon: 'bolt' },
  { id: 'autre', label: 'Autre', prefix: 'DEP', icon: 'upload' }
];

/* Modèles : champs proposés, règles de fichiers, mots qui déclenchent la suggestion */
const TEMPLATES = [
  { id: 'candidature', sector: 'rh', title: 'Candidature — [poste]', message: 'Merci de déposer votre CV et votre lettre de motivation au format PDF. Date limite indiquée ci-dessus.',
    words: ['candidat', 'candidature', 'recrut', 'cv', 'poste', 'emploi', 'stage', 'stagiaire', 'embauche', 'offre d', 'job', 'alternance'],
    accept: ['pdf', 'office', 'image'], maxFileMB: 20,
    fields: [req(F('nom', 'text', 'Nom')), req(F('prenom', 'text', 'Prénom')), req(F('email', 'email', 'E-mail')), req(F('tel', 'tel', 'Téléphone')), F('poste', 'text', 'Poste visé'),
      req(F('cv', 'file', 'CV')), req(F('lettre', 'file', 'Lettre de motivation')), F('portfolio', 'files', 'Portfolio'), F('diplomes', 'files', 'Diplômes'), F('attestations', 'files', 'Attestations'), F('autres', 'files', 'Autres documents')] },
  { id: 'devoir', sector: 'education', title: 'Rendu — [matière] — [classe]', message: 'Déposez votre travail avant la date limite. Nommez vos fichiers : NOM_Prénom.',
    words: ['devoir', 'étudiant', 'etudiant', 'élève', 'eleve', 'rendu', 'rapport', 'mémoire', 'memoire', 'exposé', 'expose', 'tp', 'travaux pratiques', 'classe', 'cours', 'évaluation', 'evaluation', 'examen', 'enseignant', 'professeur', 'formation', 'apprenant'],
    accept: ['pdf', 'office', 'image', 'archive'], maxFileMB: 100,
    fields: [req(F('etudiant', 'text', 'Nom et prénom')), F('matricule', 'text', 'Matricule'), F('classe', 'text', 'Classe / groupe'), F('titre', 'text', 'Titre du travail'), req(F('fichiers', 'files', 'Votre travail')), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'creatif', sector: 'audiovisuel', title: 'Fichiers du projet — [client]', message: 'Déposez vos rushs, photos, logos et références. Les gros fichiers sont acceptés.',
    words: ['rush', 'vidéo', 'video', 'tournage', 'montage', 'photo shoot', 'shooting', 'photographe', 'vidéaste', 'videaste', 'graphiste', 'logo', 'studio', 'agence', 'brief', 'charte', 'maquette'],
    accept: ['image', 'video', 'audio', 'design', 'pdf', 'archive'], maxFileMB: 50 * 1024,
    fields: [req(F('nom', 'text', 'Nom ou société')), req(F('email', 'email', 'E-mail')), F('projet', 'text', 'Nom du projet'), F('brief', 'files', 'Brief / documents'), F('rushs', 'files', 'Rushs / vidéos'), F('photos', 'files', 'Photos'), F('logos', 'files', 'Logos et éléments graphiques'), F('refs', 'files', 'Références'), F('commentaire', 'textarea', 'Indications')] },
  { id: 'evenement', sector: 'evenement', title: 'Photos — [événement]', message: 'Partagez vos plus belles photos et vidéos de l\'événement. Merci !',
    words: ['événement', 'evenement', 'forum', 'mariage', 'soirée', 'soiree', 'conférence', 'conference', 'salon', 'festival', 'cérémonie', 'ceremonie', 'gala', 'souvenir', 'photos de', 'anniversaire', 'baptême', 'bapteme'],
    accept: ['image', 'video'], maxFileMB: 2048,
    fields: [req(F('nom', 'text', 'Votre prénom')), F('email', 'email', 'E-mail (facultatif)'), req(F('medias', 'files', 'Photos et vidéos')), F('message', 'textarea', 'Un mot')] },
  { id: 'pme', sector: 'entreprise', title: 'Documents — [dossier]', message: 'Déposez les pièces demandées. Un accusé de réception vous sera remis.',
    words: ['facture', 'contrat', 'fournisseur', 'pme', 'entreprise', 'dossier client', 'bon de commande', 'devis', 'documents administratifs'],
    accept: ['pdf', 'office', 'image', 'archive'], maxFileMB: 100,
    fields: [req(F('societe', 'text', 'Société / nom')), req(F('email', 'email', 'E-mail')), F('tel', 'tel', 'Téléphone'), F('reference', 'text', 'Référence du dossier'), F('type', 'select', 'Type de document', { options: ['Facture', 'Contrat', 'Devis', 'Bon de commande', 'Pièce administrative', 'Autre'] }), req(F('documents', 'files', 'Documents')), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'administration', sector: 'administration', title: 'Dépôt de dossier — [démarche]', message: 'Joignez toutes les pièces demandées. Un numéro de dossier vous sera attribué.',
    words: ['administration', 'mairie', 'ministère', 'ministere', 'démarche', 'demarche', 'dossier administratif', 'inscription', 'pièce justificative', 'piece justificative', 'service public'],
    accept: ['pdf', 'image'], maxFileMB: 20,
    fields: [req(F('nom', 'text', 'Nom')), req(F('prenom', 'text', 'Prénom')), req(F('email', 'email', 'E-mail')), req(F('tel', 'tel', 'Téléphone')), F('demarche', 'text', 'Objet de la démarche'), req(F('pieces', 'files', 'Pièces justificatives')), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'ong', sector: 'ong', title: 'Appel à candidatures — [programme]', message: 'Déposez votre dossier complet avant la date limite.',
    words: ['ong', 'association', 'bénévole', 'benevole', 'appel à candidature', 'appel a candidature', 'subvention', 'programme', 'bourse', 'projet communautaire'],
    accept: ['pdf', 'office', 'image'], maxFileMB: 50,
    fields: [req(F('nom', 'text', 'Nom complet / structure')), req(F('email', 'email', 'E-mail')), F('tel', 'tel', 'Téléphone'), F('pays', 'text', 'Pays / ville'), req(F('dossier', 'files', 'Dossier de candidature')), F('justificatifs', 'files', 'Pièces justificatives'), F('commentaire', 'textarea', 'Présentation rapide')] },
  { id: 'prestation', sector: 'projet', title: 'Projet — [client]', message: 'Déposez ici tout ce qu\'il faut pour démarrer : logo, charte, textes, images, cahier des charges.',
    words: ['site web', 'site internet', 'prestation', 'client', 'projet', 'cahier des charges', 'application', 'refonte'],
    accept: ['pdf', 'office', 'image', 'video', 'design', 'archive'], maxFileMB: 2048,
    fields: [req(F('client', 'text', 'Client / société')), req(F('email', 'email', 'E-mail')), F('logo', 'files', 'Logo'), F('charte', 'files', 'Charte graphique'), F('textes', 'files', 'Textes'), F('images', 'files', 'Images et vidéos'), F('cdc', 'files', 'Cahier des charges'), F('autres', 'files', 'Autres documents'), F('commentaire', 'textarea', 'Précisions')] },
  { id: 'finance', sector: 'finance', title: 'Pièces comptables — [période]', message: 'Déposez vos pièces du mois (factures, relevés, justificatifs).',
    words: ['comptab', 'bilan', 'relevé', 'releve', 'justificatif', 'note de frais', 'tva', 'fiscal', 'expert-comptable', 'expert comptable'],
    accept: ['pdf', 'office', 'image', 'archive'], maxFileMB: 50,
    fields: [req(F('societe', 'text', 'Société / nom')), req(F('email', 'email', 'E-mail')), F('periode', 'text', 'Période (ex. octobre 2026)'), F('nature', 'multi', 'Nature des pièces', { options: ['Factures d\'achat', 'Factures de vente', 'Relevés bancaires', 'Notes de frais', 'Autres'] }), req(F('pieces', 'files', 'Pièces')), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'juridique', sector: 'juridique', title: 'Dossier — [affaire]', message: 'Déposez les documents relatifs à votre dossier. Ils restent confidentiels.',
    words: ['avocat', 'juridique', 'notaire', 'litige', 'conseil juridique', 'affaire', 'contentieux'],
    accept: ['pdf', 'office', 'image'], maxFileMB: 50,
    fields: [req(F('nom', 'text', 'Nom complet')), req(F('email', 'email', 'E-mail')), F('tel', 'tel', 'Téléphone'), F('reference', 'text', 'Référence du dossier'), req(F('documents', 'files', 'Documents')), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'recherche', sector: 'recherche', title: 'Soumission — [colloque / revue]', message: 'Déposez votre manuscrit et les données associées.',
    words: ['recherche', 'université', 'universite', 'thèse', 'these', 'colloque', 'article', 'manuscrit', 'laboratoire', 'doctorant', 'publication'],
    accept: ['pdf', 'office', 'archive', 'image'], maxFileMB: 500,
    fields: [req(F('auteur', 'text', 'Auteur(s)')), req(F('email', 'email', 'E-mail')), F('institution', 'text', 'Institution'), req(F('titre', 'text', 'Titre')), req(F('manuscrit', 'file', 'Manuscrit')), F('donnees', 'files', 'Données / annexes'), F('resume', 'textarea', 'Résumé')] },
  { id: 'communication', sector: 'communication', title: 'Contenus — [campagne]', message: 'Déposez vos visuels, vidéos et textes pour la campagne.',
    words: ['campagne', 'marketing', 'communication', 'réseaux sociaux', 'reseaux sociaux', 'visuel', 'influenceur', 'publicité', 'publicite'],
    accept: ['image', 'video', 'design', 'pdf', 'office', 'archive'], maxFileMB: 5120,
    fields: [req(F('nom', 'text', 'Nom / marque')), req(F('email', 'email', 'E-mail')), F('campagne', 'text', 'Campagne'), F('visuels', 'files', 'Visuels'), F('videos', 'files', 'Vidéos'), F('textes', 'files', 'Textes'), F('commentaire', 'textarea', 'Indications')] },
  { id: 'btp', sector: 'btp', title: 'Plans — [chantier]', message: 'Déposez plans, rendus et documents techniques.',
    words: ['plan', 'architecte', 'chantier', 'btp', 'construction', 'maquette 3d', 'dwg', 'bureau d\'études', 'bureau d etudes'],
    accept: ['pdf', 'design', 'image', 'office', 'archive'], maxFileMB: 5120,
    fields: [req(F('societe', 'text', 'Société / nom')), req(F('email', 'email', 'E-mail')), F('chantier', 'text', 'Chantier / lot'), req(F('plans', 'files', 'Plans et documents')), F('photos', 'files', 'Photos du site'), F('commentaire', 'textarea', 'Commentaire')] },
  { id: 'commerce', sector: 'commerce', title: 'Commande — [boutique]', message: 'Déposez vos fichiers pour votre commande (photos à imprimer, logos, maquettes…).',
    words: ['commande', 'boutique', 'impression', 'imprimerie', 'personnalis', 'magasin', 'vente'],
    accept: ['image', 'pdf', 'design'], maxFileMB: 500,
    fields: [req(F('nom', 'text', 'Nom')), req(F('tel', 'tel', 'Téléphone')), F('email', 'email', 'E-mail'), F('commande', 'text', 'N° ou objet de la commande'), req(F('fichiers', 'files', 'Fichiers')), F('commentaire', 'textarea', 'Précisions')] },
  { id: 'simple', sector: 'autre', title: 'Déposez vos fichiers', message: '',
    words: [], accept: [], maxFileMB: 0,
    fields: [req(F('nom', 'text', 'Votre nom')), req(F('fichiers', 'files', 'Fichiers')), F('message', 'textarea', 'Message')] }
];

const TYPES = ['text', 'email', 'tel', 'number', 'select', 'multi', 'date', 'textarea', 'file', 'files'];
const STATUSES = [
  { id: 'received', label: 'Reçu' }, { id: 'review', label: 'En cours d\'analyse' }, { id: 'incomplete', label: 'À compléter' },
  { id: 'validated', label: 'Validé' }, { id: 'refused', label: 'Refusé' }, { id: 'archived', label: 'Archivé' }
];
const STATUS_IDS = STATUSES.map(s => s.id);
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const isFileField = (f) => f.type === 'file' || f.type === 'files';

/** Champs fournis par le créateur → champs sûrs (types connus, libellés courts, 40 au plus) */
function cleanFields(list) {
  const out = [], seen = new Set();
  for (const raw of (Array.isArray(list) ? list : []).slice(0, 40)) {
    if (!raw || !TYPES.includes(raw.type)) continue;
    const label = clip(raw.label, 80); if (!label) continue;
    let id = String(raw.id || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24) || 'f' + out.length;
    while (seen.has(id)) id += '_';
    seen.add(id);
    const f = { id, type: raw.type, label, required: !!raw.required };
    if (raw.type === 'select' || raw.type === 'multi') {
      f.options = (Array.isArray(raw.options) ? raw.options : []).map(o => clip(o, 60)).filter(Boolean).slice(0, 20);
      if (!f.options.length) continue;
    }
    if (raw.help) f.help = clip(raw.help, 160);
    out.push(f);
  }
  if (!out.some(isFileField)) out.push({ id: 'fichiers', type: 'files', label: 'Fichiers', required: true });
  return out;
}
/** Anciennes demandes (avant Smart Drop) : nom, fichiers, message */
const LEGACY = [{ id: 'name', type: 'text', label: 'Votre nom', required: true }, { id: 'files', type: 'files', label: 'Fichiers', required: true }, { id: 'message', type: 'textarea', label: 'Message', required: false }];
const fieldsOf = (q) => (Array.isArray(q.fields) && q.fields.length ? q.fields : LEGACY);

const cleanAccept = (list) => (Array.isArray(list) ? list : []).filter(k => ACCEPT[k]).slice(0, 7);
const extOf = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
function fileAllowed(name, accept) {
  if (!accept || !accept.length) return true;
  const e = extOf(name);
  return accept.some(k => ACCEPT[k].ext.includes(e));
}
const acceptLabel = (accept) => (accept && accept.length ? accept.map(k => ACCEPT[k].label).join(', ') : 'Tous les types');

/** Contrôle d'un dépôt : réponses + fichiers rattachés aux champs. → { error } | { answers, name, email, files } */
function checkDeposit(q, body) {
  const fields = fieldsOf(q), b = body || {};
  const raw = b.answers && typeof b.answers === 'object' ? b.answers : {};
  // Compatibilité : ancien formulaire (name + message)
  if (!Array.isArray(q.fields) || !q.fields.length) { if (b.name && !raw.name) raw.name = b.name; if (b.message && !raw.message) raw.message = b.message; }
  const answers = {};
  for (const f of fields) {
    if (isFileField(f)) continue;
    let v = raw[f.id];
    if (f.type === 'multi') v = (Array.isArray(v) ? v : []).map(x => clip(x, 60)).filter(x => f.options.includes(x));
    else v = clip(v, f.type === 'textarea' ? 2000 : 200);
    const empty = Array.isArray(v) ? !v.length : !v;
    if (f.required && empty) return { error: `Le champ « ${f.label} » est obligatoire.` };
    if (!empty) {
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: `Le champ « ${f.label} » doit contenir une adresse e-mail valide.` };
      if (f.type === 'tel' && !/^[+0-9 ().-]{6,24}$/.test(v)) return { error: `Le champ « ${f.label} » doit contenir un numéro de téléphone valide.` };
      if (f.type === 'number' && !/^-?\d+([.,]\d+)?$/.test(v)) return { error: `Le champ « ${f.label} » doit contenir un nombre.` };
      if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `Le champ « ${f.label} » doit contenir une date.` };
      if (f.type === 'select' && !f.options.includes(v)) return { error: `Choix invalide pour « ${f.label} ».` };
      answers[f.id] = v;
    }
  }
  const files = Array.isArray(b.files) ? b.files : [];
  const fileFields = fields.filter(isFileField);
  const byField = new Map(fileFields.map(f => [f.id, 0]));
  const maxFile = q.maxFileBytes || 0;
  for (const x of files) {
    const fid = byField.has(x.field) ? x.field : fileFields[0].id;
    x.field = fid;
    byField.set(fid, byField.get(fid) + 1);
    if (!fileAllowed(x.name, q.accept)) return { error: `« ${clip(x.name, 60)} » : type de fichier non accepté (${acceptLabel(q.accept)}).`, status: 415 };
    if (maxFile && Number(x.size) > maxFile) return { error: `« ${clip(x.name, 60)} » dépasse la taille maximale par fichier.`, status: 413 };
  }
  for (const f of fileFields) {
    const n = byField.get(f.id);
    if (f.required && !n) return { error: `Ajoutez un fichier pour « ${f.label} ».` };
    if (f.type === 'file' && n > 1) return { error: `Un seul fichier pour « ${f.label} ».` };
  }
  if (!files.length) return { error: 'Ajoutez au moins un fichier.' };
  // Nom affiché et e-mail du déposant, déduits des champs
  const textF = fields.filter(f => f.type === 'text');
  const pickId = (re) => { const f = textF.find(x => re.test(x.id + ' ' + x.label.toLowerCase())); return f && answers[f.id]; };
  const nom = pickId(/^(nom|name)\b|^nom /), prenom = pickId(/prenom|prénom/);
  const name = clip([prenom, nom].filter(Boolean).join(' ') || pickId(/nom|name|etudiant|auteur|client|societe|société/) || (textF[0] && answers[textF[0].id]) || 'Anonyme', 80);
  const emailF = fields.find(f => f.type === 'email');
  const email = emailF && answers[emailF.id] ? answers[emailF.id].toLowerCase() : '';
  // Fichiers rangés par champ dans le ZIP : « CV/… », « Lettre de motivation/… »
  const labelOf = new Map(fileFields.map(f => [f.id, f.label.replace(/[\\/:*?"<>|]+/g, '-')]));
  files.forEach(x => { const base = String(x.path || x.name || '').split('/').pop(); x.path = fileFields.length > 1 ? labelOf.get(x.field) + '/' + base : (x.path || null); });
  return { answers, name, email, files };
}

const prefixOf = (sector) => (SECTORS.find(s => s.id === sector) || SECTORS[SECTORS.length - 1]).prefix;
const numberOf = (q, seq) => prefixOf(q.sector) + '-' + String(seq).padStart(4, '0');

function catalog() {
  return {
    sectors: SECTORS, statuses: STATUSES, types: TYPES,
    accept: Object.fromEntries(Object.entries(ACCEPT).map(([k, v]) => [k, { label: v.label, ext: v.ext }])),
    templates: TEMPLATES.map(t => ({ id: t.id, sector: t.sector, title: t.title, message: t.message, words: t.words, accept: t.accept, maxFileMB: t.maxFileMB, fields: t.fields }))
  };
}

module.exports = { SECTORS, TEMPLATES, STATUSES, STATUS_IDS, ACCEPT, cleanFields, cleanAccept, fieldsOf, checkDeposit, fileAllowed, acceptLabel, numberOf, catalog, isFileField };
