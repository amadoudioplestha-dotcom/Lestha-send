'use strict';

const MAX_DIRECT_BYTES = 250 * 1024 ** 3;
const MAX_DIRECT_FILES = 2000;

function validateDirectFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'Aucun fichier.' };
  if (files.length > MAX_DIRECT_FILES) return { ok: false, error: `Maximum ${MAX_DIRECT_FILES} fichiers par transfert direct.` };

  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') return { ok: false, error: 'Métadonnées de fichier invalides.' };
    if (typeof file.name !== 'string' || !file.name) return { ok: false, error: 'Nom de fichier invalide.' };
    if (file.type != null && typeof file.type !== 'string') return { ok: false, error: 'Type de fichier invalide.' };
    if (file.path != null && typeof file.path !== 'string') return { ok: false, error: 'Chemin de fichier invalide.' };
    const size = file.size;
    if (typeof size !== 'number') return { ok: false, error: 'Taille de fichier invalide.' };
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: 'Taille de fichier invalide.' };
    if (size > MAX_DIRECT_BYTES - total) return { ok: false, error: 'Transfert direct trop volumineux (maximum 250 Gio).' };
    total += size;
  }
  return { ok: true, total };
}

module.exports = { MAX_DIRECT_BYTES, MAX_DIRECT_FILES, validateDirectFiles };
