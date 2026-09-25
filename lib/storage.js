'use strict';
/**
 * Couche de stockage TransferX
 *  - driver "s3"    : Cloudflare R2 (ou tout stockage compatible S3 : AWS, Backblaze B2, MinIO…)
 *                     → upload multipart présigné DIRECTEMENT navigateur → bucket (vitesse max)
 *                     → téléchargement par URL présignée (reprise native via HTTP Range)
 *  - driver "local" : disque du serveur (dev / VPS). Même API, URLs signées servies par Express.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/*  Driver S3 / R2                                                     */
/* ------------------------------------------------------------------ */
function createS3Driver(cfg) {
  const {
    S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand,
    GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
    ListMultipartUploadsCommand
  } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const client = new S3Client({
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: !!cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Indispensable pour R2 + navigateur : pas de checksum CRC32 automatique dans les URLs présignées
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });
  const Bucket = cfg.bucket;

  const isNotFound = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404);

  return {
    name: 's3',
    direct: true,

    async createMultipart(key, contentType) {
      const r = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType || 'application/octet-stream' }));
      return r.UploadId;
    },

    async presignPart(key, uploadId, partNumber, _partSize, expiresIn = 3600) {
      return getSignedUrl(client, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn });
    },

    async presignPut(key, contentType, expiresIn = 3600) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType || 'application/octet-stream' }), {
        expiresIn, signableHeaders: new Set(['content-type'])
      });
    },

    async listParts(key, uploadId) {
      const parts = [];
      let marker;
      do {
        const r = await client.send(new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
        (r.Parts || []).forEach(p => parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size }));
        marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    },

    async completeMultipart(key, uploadId, parts) {
      const sorted = parts.slice().sort((a, b) => a.PartNumber - b.PartNumber).map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
      await client.send(new CompleteMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: sorted } }));
    },

    async abortMultipart(key, uploadId) {
      try { await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })); } catch (e) { /* déjà terminé */ }
    },

    async putBuffer(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType || 'application/octet-stream' }));
    },

    async getBuffer(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) { if (isNotFound(e)) return null; throw e; }
    },

    async getStream(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return r.Body; // Readable (Node)
    },

    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(r.ContentLength) || 0 };
      } catch (e) { if (isNotFound(e)) return null; throw e; }
    },

    async listKeys(prefix) {
      const keys = [];
      let token;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        (r.Contents || []).forEach(o => keys.push(o.Key));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },

    async deletePrefix(prefix) {
      const keys = await this.listKeys(prefix);
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
        await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch, Quiet: true } }));
      }
      // Uploads multipart inachevés
      try {
        const r = await client.send(new ListMultipartUploadsCommand({ Bucket, Prefix: prefix }));
        for (const u of (r.Uploads || [])) await this.abortMultipart(u.Key, u.UploadId);
      } catch (e) { /* non supporté partout */ }
    },

    async deleteKey(key) {
      await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }));
    },

    /** URL de téléchargement direct (R2) – supporte Range → reprise native du navigateur */
    async presignGet(key, { filename, inline, contentType, expiresIn = 6 * 3600 } = {}) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket, Key: key,
        ResponseContentDisposition: contentDisposition(filename || 'fichier', inline),
        ResponseContentType: contentType || undefined
      }), { expiresIn });
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Driver disque local                                                */
/* ------------------------------------------------------------------ */
function createLocalDriver(cfg) {
  const root = path.resolve(cfg.dir || './data');
  const objDir = path.join(root, 'objects');
  fs.mkdirSync(objDir, { recursive: true });

  const safe = (key) => {
    const p = path.resolve(objDir, key);
    if (!p.startsWith(objDir + path.sep)) throw new Error('Clé invalide');
    return p;
  };
  const uploadsFile = (key) => safe(key) + '.__upload.json';
  const locks = new Map(); // sérialise l'écriture des sidecars

  async function readUpload(key) {
    try { return JSON.parse(await fsp.readFile(uploadsFile(key), 'utf8')); } catch (e) { return null; }
  }
  async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise(r => (release = r));
    locks.set(key, prev.then(() => next));
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
  }

  return {
    name: 'local',
    direct: false,
    root,

    async createMultipart(key) {
      const p = safe(key);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p + '.__partial', Buffer.alloc(0));
      const uploadId = crypto.randomBytes(12).toString('hex');
      await fsp.writeFile(uploadsFile(key), JSON.stringify({ uploadId, parts: {} }));
      return uploadId;
    },

    // Les URLs "présignées" locales sont générées par le serveur (voir server.js → signLocal)
    presignPart: null,
    presignPut: null,

    /** Écrit un morceau à son offset dans le fichier partiel (appelé par la route PUT /api/local/part) */
    async writePart(key, uploadId, partNumber, offset, expectedSize, stream) {
      const up = await readUpload(key);
      if (!up || up.uploadId !== uploadId) throw Object.assign(new Error('Upload inconnu'), { status: 404 });
      const p = safe(key) + '.__partial';
      let written = 0;
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(p, { flags: 'r+', start: offset });
        stream.on('data', (c) => { written += c.length; if (written > expectedSize) { stream.destroy(); ws.destroy(); reject(Object.assign(new Error('Morceau trop grand'), { status: 400 })); } });
        stream.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        stream.pipe(ws);
      });
      if (written !== expectedSize) throw Object.assign(new Error(`Morceau incomplet (${written}/${expectedSize})`), { status: 400 });
      await withLock(key, async () => {
        const cur = await readUpload(key);
        cur.parts[partNumber] = written;
        await fsp.writeFile(uploadsFile(key), JSON.stringify(cur));
      });
      return '"local-' + partNumber + '"';
    },

    async listParts(key, uploadId) {
      const up = await readUpload(key);
      if (!up || up.uploadId !== uploadId) return [];
      return Object.entries(up.parts).map(([n, size]) => ({ PartNumber: Number(n), ETag: '"local-' + n + '"', Size: size }));
    },

    async completeMultipart(key, uploadId, parts, totalSize) {
      const p = safe(key);
      if (typeof totalSize === 'number') await fsp.truncate(p + '.__partial', totalSize);
      await fsp.rename(p + '.__partial', p);
      await fsp.rm(uploadsFile(key), { force: true });
    },

    async abortMultipart(key) {
      const p = safe(key);
      await fsp.rm(p + '.__partial', { force: true });
      await fsp.rm(uploadsFile(key), { force: true });
    },

    async putBuffer(key, body) {
      const p = safe(key);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const tmp = p + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, p);
    },

    async getBuffer(key) {
      try { return await fsp.readFile(safe(key)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },

    async getStream(key) { return fs.createReadStream(safe(key)); },

    async head(key) {
      try { const s = await fsp.stat(safe(key)); return { size: s.size }; } catch (e) { return null; }
    },

    async listKeys(prefix) {
      const base = safe(prefix.replace(/\/$/, '') || '.');
      const out = [];
      async function walk(dir) {
        let entries = [];
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (!/\.(tmp|__partial|__upload\.json)$/.test(e.name)) out.push(path.relative(objDir, full).split(path.sep).join('/'));
        }
      }
      await walk(base);
      return out;
    },

    async deletePrefix(prefix) {
      const p = safe(prefix.replace(/\/$/, ''));
      await fsp.rm(p, { recursive: true, force: true });
    },

    async deleteKey(key) { await fsp.rm(safe(key), { force: true }); },

    pathFor(key) { return safe(key); },

    presignGet: null
  };
}

/* ------------------------------------------------------------------ */
function contentDisposition(filename, inline) {
  const clean = String(filename).replace(/[\r\n"]/g, '').slice(0, 250) || 'fichier';
  const ascii = clean.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/[\\;]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function createStorage(env) {
  const r2Endpoint = env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
  const bucket = env.S3_BUCKET || env.R2_BUCKET;
  const wantS3 = (env.STORAGE_DRIVER || (bucket ? 's3' : 'local')) === 's3';
  if (wantS3) {
    const accessKeyId = env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('Stockage S3/R2 : S3_BUCKET (ou R2_BUCKET), clés d\'accès et endpoint requis');
    }
    return createS3Driver({
      bucket, accessKeyId, secretAccessKey,
      endpoint: env.S3_ENDPOINT || r2Endpoint,
      region: env.S3_REGION || 'auto',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true'
    });
  }
  return createLocalDriver({ dir: env.DATA_DIR || path.join(__dirname, '..', 'data') });
}

module.exports = { createStorage, contentDisposition };
