'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_DIRECT_BYTES, MAX_DIRECT_FILES, validateDirectFiles } = require('../lib/direct-transfer');
const { mountNearby } = require('../lib/nearby');
const clientLimits = import('../public/js/direct-limits.mjs');

function nearbyHarness() {
  const emitted = [];
  const handlers = new Map();
  const receiver = { data: { near: { group: 'local' } } };
  let onConnection;
  const io = {
    on: (event, handler) => { if (event === 'connection') onConnection = handler; },
    to: (room) => ({ emit: (...args) => emitted.push({ room, args }) }),
    in: () => ({ fetchSockets: async () => [receiver] })
  };
  mountNearby(io, { secret: 'test-secret' });
  const socket = {
    handshake: { headers: {}, address: '127.0.0.1' },
    data: { near: { deviceId: 'sender01', name: 'Sender', group: 'local', paired: new Set() } },
    on: (event, handler) => handlers.set(event, handler)
  };
  onConnection(socket);
  return { emitted, handlers };
}

test('accepts a direct transfer exactly at the 250 GiB ceiling', () => {
  assert.equal(MAX_DIRECT_BYTES, 250 * 1024 ** 3);
  assert.deepEqual(validateDirectFiles([{ name: 'large.bin', size: MAX_DIRECT_BYTES }]), { ok: true, total: MAX_DIRECT_BYTES });
});

test('rejects direct transfers above the ceiling without overflowing totals', () => {
  assert.equal(validateDirectFiles([{ name: 'large.bin', size: MAX_DIRECT_BYTES + 1 }]).ok, false);
  assert.equal(validateDirectFiles([{ name: 'a', size: Number.MAX_SAFE_INTEGER }, { name: 'b', size: 1 }]).ok, false);
});

test('rejects invalid file sizes and manifests above the supported file count', () => {
  for (const size of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validateDirectFiles([{ name: 'file', size }]).ok, false);
  }
  assert.equal(MAX_DIRECT_FILES, 2000);
  assert.equal(validateDirectFiles(Array.from({ length: MAX_DIRECT_FILES + 1 }, () => ({ name: 'file', size: 0 }))).ok, false);
  assert.equal(validateDirectFiles([null]).ok, false);
});

test('keeps browser and server direct-transfer thresholds aligned', async () => {
  const client = await clientLimits;
  assert.equal(client.MAX_DIRECT_BYTES, MAX_DIRECT_BYTES);
  assert.equal(client.MAX_DIRECT_FILES, MAX_DIRECT_FILES);
  assert.deepEqual(client.validateDirectFiles([{ name: 'large.bin', size: MAX_DIRECT_BYTES }]), { ok: true, total: MAX_DIRECT_BYTES });
  assert.equal(client.validateDirectFiles([{ name: 'large.bin', size: MAX_DIRECT_BYTES + 1 }]).ok, false);
});

test('nearby signaling rejects over-limit manifests and relays the exact supported ceiling', async () => {
  const overLimit = nearbyHarness();
  let rejected;
  await overLimit.handlers.get('near-send')({ to: 'receiver01', kind: 'files', files: [{ name: 'large.bin', size: MAX_DIRECT_BYTES + 1 }] }, r => { rejected = r; });
  assert.equal(rejected.ok, false);
  assert.equal(overLimit.emitted.length, 0);

  const atLimit = nearbyHarness();
  let accepted;
  await atLimit.handlers.get('near-send')({ to: 'receiver01', kind: 'files', files: [{ name: 'large.bin', size: MAX_DIRECT_BYTES }] }, r => { accepted = r; });
  assert.deepEqual(accepted, { ok: true });
  assert.equal(atLimit.emitted[0].args[1].total, MAX_DIRECT_BYTES);
});
