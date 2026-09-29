'use strict';

const crypto = require('crypto');
const { randomId, safeEqual, rateLimiter, clientIp } = require('./util');

const MAX_PARTICIPANTS = 25;
const HOST_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

function apiBase(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['https:', ...(local ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('BBB_URL doit être une URL HTTPS sans identifiants, paramètres ni fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  if (!url.pathname || url.pathname === '/') throw new Error('BBB_URL doit inclure le chemin /bigbluebutton.');
  return url;
}

function checksum(method, query, secret) {
  return crypto.createHash('sha1').update(method + query + secret).digest('hex');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function xmlValue(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml).match(new RegExp('<' + escaped + '>([\\s\\S]*?)</' + escaped + '>', 'i'));
  return match ? decodeXml(match[1].trim()) : '';
}

function assertSuccess(xml, method) {
  const code = xmlValue(xml, 'returncode');
  if (code !== 'SUCCESS') {
    const error = new Error(`Échec de l’appel BigBlueButton (${method}, ${xmlValue(xml, 'messageKey') || 'réponse invalide'}).`);
    error.status = 502;
    throw error;
  }
}

function parseAttendance(xml) {
  assertSuccess(xml, 'getMeetingInfo');
  const block = xmlValue(xml, 'attendees');
  return [...block.matchAll(/<attendee>([\s\S]*?)<\/attendee>/gi)].map(([, attendee]) => ({
    id: xmlValue(attendee, 'userID').slice(0, 256),
    name: xmlValue(attendee, 'fullName').slice(0, 120),
    role: xmlValue(attendee, 'role').slice(0, 24),
    hasAudio: xmlValue(attendee, 'hasJoinedVoice') === 'true',
    hasVideo: xmlValue(attendee, 'hasVideo') === 'true'
  }));
}

function parseRecordings(xml, base) {
  assertSuccess(xml, 'getRecordings');
  return [...String(xml).matchAll(/<recording>([\s\S]*?)<\/recording>/gi)].map(([, item]) => {
    const rawUrl = xmlValue(item, 'url');
    let url = null;
    try {
      const candidate = new URL(rawUrl);
      if (candidate.origin === base.origin && candidate.protocol === base.protocol) url = candidate.href;
    } catch (e) { /* Une URL de lecture invalide n'est pas exposée. */ }
    return {
      id: xmlValue(item, 'recordID').slice(0, 256),
      name: xmlValue(item, 'name').slice(0, 120),
      published: xmlValue(item, 'published') === 'true',
      url
    };
  }).filter(recording => recording.id && recording.url);
}

function createBigBlueButton({ url, secret, fetchImpl = fetch }) {
  if (!url && !secret) return { enabled: false };
  if (!url || !secret) throw new Error('BBB_URL et BBB_SECRET doivent être configurés ensemble.');
  const base = apiBase(url);
  const apiRoot = new URL(base.href.replace(/\/$/, '') + '/api/', base.origin);

  async function call(method, params) {
    const query = new URLSearchParams(params).toString();
    const signature = checksum(method, query, secret);
    const endpoint = new URL(`${method}?${query}${query ? '&' : ''}checksum=${signature}`, apiRoot);
    let response;
    try {
      response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    } catch (e) {
      const error = new Error('Le serveur BigBlueButton est injoignable.');
      error.status = 502;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`BigBlueButton a répondu avec HTTP ${response.status}.`);
      error.status = 502;
      throw error;
    }
    const body = await response.text();
    if (body.length > 2_000_000) {
      const error = new Error('Réponse BigBlueButton trop volumineuse.');
      error.status = 502;
      throw error;
    }
    return body;
  }

  return {
    enabled: true,
    create({ id, title, record }) {
      return call('create', {
        name: title,
        meetingID: id,
        attendeePW: crypto.createHmac('sha256', secret).update(`${id}:attendee`).digest('hex').slice(0, 32),
        moderatorPW: crypto.createHmac('sha256', secret).update(`${id}:moderator`).digest('hex').slice(0, 32),
        maxParticipants: String(MAX_PARTICIPANTS),
        record: String(!!record),
        autoStartRecording: String(!!record),
        allowStartStopRecording: String(!!record),
        notifyRecordingIsOn: String(!!record),
        endWhenNoModerator: 'true'
      }).then(xml => { assertSuccess(xml, 'create'); return xml; });
    },
    join({ id, name, role }) {
      const password = crypto.createHmac('sha256', secret).update(`${id}:${role}`).digest('hex').slice(0, 32);
      const query = new URLSearchParams({
        fullName: name,
        meetingID: id,
        password,
        redirect: 'true'
      }).toString();
      const signature = checksum('join', query, secret);
      return new URL(`join?${query}&checksum=${signature}`, apiRoot).href;
    },
    async end({ id }) {
      const password = crypto.createHmac('sha256', secret).update(`${id}:moderator`).digest('hex').slice(0, 32);
      const xml = await call('end', { meetingID: id, password });
      assertSuccess(xml, 'end');
      return true;
    },
    async attendance({ id }) {
      const xml = await call('getMeetingInfo', { meetingID: id });
      return parseAttendance(xml);
    },
    async recordings({ id }) {
      const xml = await call('getRecordings', { meetingID: id });
      return parseRecordings(xml, base);
    }
  };
}

function mountClassroom(app, { env, storage, signer }) {
  const express = require('express');
  const router = express.Router();
  const bbb = createBigBlueButton({ url: env.BBB_URL, secret: env.BBB_SECRET });
  const createAttemptLimit = rateLimiter({ windowMs: 60 * 60 * 1000, max: 15 });
  const createLimit = rateLimiter({ windowMs: 60 * 60 * 1000, max: 4 });
  const joinLimit = rateLimiter({ windowMs: 10 * 60 * 1000, max: 40 });
  const hostActionLimit = rateLimiter({ windowMs: 60 * 1000, max: 90 });
  const idPattern = /^[A-Za-z0-9]{20}$/;
  const metaKey = id => `classrooms/${id}.json`;
  const fail = (res, status, error) => res.status(status).json({ error });
  const createCodeConfigured = () => typeof env.CLASSROOM_CREATE_CODE === 'string' && env.CLASSROOM_CREATE_CODE.length >= 16;
  const validHost = (req, id) => {
    const token = signer.verify(req.get('x-classroom-host'));
    return !!(token && token.id === id && token.role === 'host');
  };
  const allowHostAction = (req, res, id) => {
    if (!validHost(req, id)) { fail(res, 403, 'Lien privé enseignant invalide.'); return false; }
    if (!hostActionLimit(clientIp(req) + ':' + id)) { fail(res, 429, 'Trop de demandes de gestion. Réessayez dans une minute.'); return false; }
    return true;
  };

  async function cleanupExpired() {
    try {
      const keys = await storage.listKeys('classrooms/');
      for (const key of keys) {
        if (!/^classrooms\/[A-Za-z0-9]{20}\.json$/.test(key)) continue;
        const contents = await storage.getBuffer(key);
        if (!contents) continue;
        try {
          const meeting = JSON.parse(contents.toString('utf8'));
          if (Number.isFinite(meeting.expiresAt) && Date.now() > meeting.expiresAt) await storage.deleteKey(key);
        } catch (e) {
          console.error('classroom metadata invalide', key, e.message);
        }
      }
    } catch (e) {
      console.error('classroom cleanup', e.message);
    }
  }
  setTimeout(cleanupExpired, 60_000).unref();
  setInterval(cleanupExpired, 60 * 60 * 1000).unref();

  async function getClass(id) {
    if (!idPattern.test(id)) return null;
    const contents = await storage.getBuffer(metaKey(id));
    if (!contents) return null;
    try {
      const meeting = JSON.parse(contents.toString('utf8'));
      if (meeting.id !== id || Date.now() > meeting.expiresAt) {
        await storage.deleteKey(metaKey(id));
        return null;
      }
      return meeting;
    } catch (e) {
      return null;
    }
  }

  router.get('/config', (req, res) => res.json({
    enabled: bbb.enabled,
    canCreate: bbb.enabled && createCodeConfigured(),
    maxParticipants: MAX_PARTICIPANTS
  }));

  router.post('/', async (req, res, next) => {
    try {
      if (!bbb.enabled) return fail(res, 503, 'La connexion à BigBlueButton n’est pas configurée.');
      if (!createCodeConfigured()) return fail(res, 503, 'La création de cours est désactivée : CLASSROOM_CREATE_CODE doit contenir au moins 16 caractères.');
      if (!createAttemptLimit(clientIp(req))) return fail(res, 429, 'Trop de tentatives de création. Réessayez dans une heure.');
      if (!safeEqual(String(req.get('x-classroom-code') || ''), env.CLASSROOM_CREATE_CODE)) return fail(res, 401, 'Code de création de cours incorrect.');
      if (!createLimit(clientIp(req))) return fail(res, 429, 'Trop de cours créés depuis cette connexion. Réessayez plus tard.');

      const title = String(req.body?.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
      const moderatorName = String(req.body?.moderatorName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
      if (title.length < 2 || moderatorName.length < 2) return fail(res, 400, 'Le titre et le nom de l’enseignant doivent contenir au moins 2 caractères.');

      const id = randomId(20);
      const record = req.body?.record === true;
      await bbb.create({ id, title, record });
      const meeting = { id, title, record, createdAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, attendance: [] };
      try {
        await storage.putBuffer(metaKey(id), Buffer.from(JSON.stringify(meeting)), 'application/json');
      } catch (e) {
        try { await bbb.end({ id }); } catch (cleanupError) { console.error('classroom cleanup', id, cleanupError.message); }
        throw e;
      }
      const hostToken = signer.sign({ id, role: 'host', exp: Date.now() + HOST_TOKEN_TTL });
      const base = (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      res.status(201).json({
        id, title, record, maxParticipants: MAX_PARTICIPANTS,
        hostLink: `${base}/classe/${id}#${hostToken}`,
        participantLink: `${base}/classe/${id}`
      });
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      res.json({ id: meeting.id, title: meeting.title, record: meeting.record, maxParticipants: MAX_PARTICIPANTS });
    } catch (e) { next(e); }
  });

  router.post('/:id/join', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      if (!joinLimit(clientIp(req) + ':' + meeting.id)) return fail(res, 429, 'Trop de demandes de connexion. Réessayez dans quelques minutes.');
      const host = validHost(req, meeting.id);
      const name = String(req.body?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
      if (name.length < 2) return fail(res, 400, 'Votre nom doit contenir au moins 2 caractères.');
      const joinUrl = bbb.join({ id: meeting.id, name, role: host ? 'moderator' : 'attendee' });
      const target = new URL(joinUrl);
      if (target.origin !== new URL(env.BBB_URL).origin || target.protocol !== new URL(env.BBB_URL).protocol) return fail(res, 502, 'BigBlueButton a retourné un lien de réunion invalide.');
      res.json({ joinUrl });
    } catch (e) { next(e); }
  });

  router.post('/:id/end', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      if (!allowHostAction(req, res, meeting.id)) return;
      await bbb.end({ id: meeting.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/:id/attendance', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      if (!allowHostAction(req, res, meeting.id)) return;
      res.json({ attendance: (meeting.attendance || []).map(({ name, role, firstSeen, lastSeen }) => ({ name, role, firstSeen, lastSeen })) });
    } catch (e) { next(e); }
  });

  router.post('/:id/attendance/refresh', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      if (!allowHostAction(req, res, meeting.id)) return;
      const current = await bbb.attendance({ id: meeting.id });
      const now = Date.now();
      meeting.attendance = meeting.attendance || [];
      for (const attendee of current) {
        const identity = crypto.createHash('sha256').update(attendee.id || `${attendee.name}:${attendee.role}`).digest('hex');
        const seen = meeting.attendance.find(item => item.identity === identity);
        if (seen) {
          seen.lastSeen = now;
          seen.hasAudio = attendee.hasAudio;
          seen.hasVideo = attendee.hasVideo;
        } else {
          meeting.attendance.push({
            identity, name: attendee.name, role: attendee.role,
            firstSeen: now, lastSeen: now, hasAudio: attendee.hasAudio, hasVideo: attendee.hasVideo
          });
        }
      }
      await storage.putBuffer(metaKey(meeting.id), Buffer.from(JSON.stringify(meeting)), 'application/json');
      res.json({
        attendees: current.map(({ name, role, hasAudio, hasVideo }) => ({ name, role, hasAudio, hasVideo })),
        attendance: meeting.attendance.map(({ name, role, firstSeen, lastSeen }) => ({ name, role, firstSeen, lastSeen })),
        updatedAt: now
      });
    } catch (e) { next(e); }
  });

  router.get('/:id/recordings', async (req, res, next) => {
    try {
      const meeting = await getClass(req.params.id);
      if (!meeting) return fail(res, 404, 'Cours introuvable ou lien expiré.');
      if (!allowHostAction(req, res, meeting.id)) return;
      res.json({ recordings: await bbb.recordings({ id: meeting.id }) });
    } catch (e) { next(e); }
  });

  app.use('/api/classrooms', router);
}

module.exports = {
  MAX_PARTICIPANTS, apiBase, checksum, parseAttendance, parseRecordings,
  createBigBlueButton, mountClassroom
};
