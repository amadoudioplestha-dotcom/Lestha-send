'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('OPFS worker persists complete writes even when a storage write is partial', async () => {
  const entries = new Map();
  const self = {};
  const context = {
    self,
    navigator: {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async (name) => {
            if (!entries.has(name)) entries.set(name, Buffer.alloc(0));
            return {
              createSyncAccessHandle: async () => ({
                getSize: () => entries.get(name).length,
                write: (view, { at }) => {
                  const data = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
                  const count = Math.min(data.length, 2);
                  const old = entries.get(name);
                  const next = Buffer.alloc(Math.max(old.length, at + count));
                  old.copy(next);
                  data.copy(next, at, 0, count);
                  entries.set(name, next);
                  return count;
                },
                truncate: (size) => {
                  const next = Buffer.alloc(size);
                  entries.get(name).copy(next, 0, 0, size);
                  entries.set(name, next);
                },
                flush() {},
                close() {}
              })
            };
          }
        })
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/opfs-worker.js'), 'utf8'), context);

  async function send(data) {
    return new Promise(resolve => {
      self.postMessage = resolve;
      self.onmessage({ data });
    });
  }

  assert.equal((await send({ id: 1, cmd: 'open', name: 'test.bin' })).ok, true);
  const input = Uint8Array.from([1, 2, 3, 4, 5]);
  assert.equal((await send({ id: 2, cmd: 'write', name: 'test.bin', pos: 0, data: input.buffer })).end, 5);
  assert.deepEqual([...entries.get('test.bin')], [1, 2, 3, 4, 5]);
  assert.equal((await send({ id: 3, cmd: 'truncate', name: 'test.bin', size: 3 })).size, 3);
  assert.deepEqual([...entries.get('test.bin')], [1, 2, 3]);
});
