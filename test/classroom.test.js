'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  apiBase, checksum, parseAttendance, parseRecordings, createBigBlueButton
} = require('../lib/classroom');

test('matches the BigBlueButton documented SHA-1 checksum example', () => {
  assert.equal(
    checksum('create', 'name=Test+Meeting&meetingID=abc123&attendeePW=111222&moderatorPW=333444', '639259d4-9dd8-4b25-bf01-95f9567eaf4b'),
    '1fcbb0c4fc1f039f73aa6d697d2db9ba7f803f17'
  );
});

test('normalizes the BBB API base and rejects insecure or credential-bearing endpoints', () => {
  assert.equal(apiBase('https://bbb.example.org/bigbluebutton/').href, 'https://bbb.example.org/bigbluebutton');
  assert.equal(apiBase('https://bbb.example.org/bigbluebutton/api').href, 'https://bbb.example.org/bigbluebutton');
  assert.equal(apiBase('http://localhost:8080/bigbluebutton').protocol, 'http:');
  assert.throws(() => apiBase('http://bbb.example.org/bigbluebutton'), /HTTPS/);
  assert.throws(() => apiBase('https://user:pass@bbb.example.org/bigbluebutton'), /HTTPS/);
});

test('parses attendance with XML entity decoding and returns only intended fields', () => {
  const xml = `<response><returncode>SUCCESS</returncode><attendees><attendee>
    <userID>u-1</userID><fullName>Alice &amp; Bob</fullName><role>VIEWER</role>
    <hasJoinedVoice>true</hasJoinedVoice><hasVideo>false</hasVideo>
  </attendee></attendees></response>`;
  assert.deepEqual(parseAttendance(xml), [{
    id: 'u-1', name: 'Alice & Bob', role: 'VIEWER', hasAudio: true, hasVideo: false
  }]);
});

test('recording URLs must stay on the configured BBB origin', () => {
  const xml = `<response><returncode>SUCCESS</returncode><recordings>
    <recording><recordID>r-1</recordID><name>Leçon &amp; exercices</name><published>true</published>
      <playback><format><type>presentation</type><url>https://bbb.example.org/playback/presentation/2.3/r-1</url></format></playback>
    </recording>
    <recording><recordID>r-2</recordID><name>External</name><published>true</published>
      <playback><format><type>presentation</type><url>https://attacker.example/recording</url></format></playback>
    </recording>
  </recordings></response>`;
  assert.deepEqual(parseRecordings(xml, new URL('https://bbb.example.org/bigbluebutton')), [{
    id: 'r-1',
    name: 'Leçon & exercices',
    published: true,
    url: 'https://bbb.example.org/playback/presentation/2.3/r-1'
  }]);
});

test('keeps BBB shared secrets server-side and caps created meetings at 25 participants', async () => {
  const urls = [];
  const bbb = createBigBlueButton({
    url: 'https://bbb.example.org/bigbluebutton',
    secret: 'test-secret',
    fetchImpl: async url => {
      urls.push(new URL(url));
      return { ok: true, text: async () => '<response><returncode>SUCCESS</returncode></response>' };
    }
  });
  assert.equal(bbb.enabled, true);
  await bbb.create({ id: 'room-1', title: 'Cours', record: true });
  const request = urls[0];
  const signature = request.searchParams.get('checksum');
  request.searchParams.delete('checksum');
  const query = request.searchParams.toString();
  assert.equal(signature, checksum('create', query, 'test-secret'));
  assert.equal(request.searchParams.get('maxParticipants'), '25');
  assert.equal(request.searchParams.get('record'), 'true');
  assert.equal(request.searchParams.get('autoStartRecording'), 'true');
  assert.equal(request.searchParams.has('test-secret'), false);
  assert.equal(request.protocol, 'https:');
});

test('builds signed join links server-side without sending the shared secret to the client', () => {
  const urls = [];
  const bbb = createBigBlueButton({
    url: 'https://bbb.example.org/bigbluebutton',
    secret: 'test-secret',
    fetchImpl: async url => {
      urls.push(new URL(url));
      return { ok: true, text: async () => '<response><returncode>SUCCESS</returncode></response>' };
    }
  });
  const joinUrl = new URL(bbb.join({ id: 'room-1', name: 'Teacher', role: 'moderator' }));
  assert.equal(joinUrl.origin, 'https://bbb.example.org');
  assert.equal(joinUrl.pathname, '/bigbluebutton/api/join');
  const query = joinUrl.searchParams;
  const signature = query.get('checksum');
  query.delete('checksum');
  assert.equal(signature, checksum('join', query.toString(), 'test-secret'));
  assert.equal(query.has('test-secret'), false);
  assert.equal(query.get('password'), crypto.createHmac('sha256', 'test-secret').update('room-1:moderator').digest('hex').slice(0, 32));
  assert.equal(urls.length, 0, 'join URL generation must not call BBB server-side and follow its HTTP redirect');
});
