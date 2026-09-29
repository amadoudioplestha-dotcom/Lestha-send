'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fileDelivery } = require('../lib/file-response');

test('allows inline delivery only for passive preview types', () => {
  for (const type of ['image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf']) {
    assert.deepEqual(fileDelivery(true, type), { inline: true, contentType: type });
  }
});

test('forces active or unknown content types to an attachment-safe MIME type', () => {
  for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', '']) {
    assert.deepEqual(fileDelivery(true, type), { inline: false, contentType: 'application/octet-stream' });
  }
});

test('normalizes MIME parameters and keeps safe downloads as attachments', () => {
  assert.deepEqual(fileDelivery(true, 'VIDEO/MP4; codecs="avc1"'), {
    inline: true,
    contentType: 'video/mp4'
  });
  assert.deepEqual(fileDelivery(false, 'application/pdf'), {
    inline: false,
    contentType: 'application/pdf'
  });
});
