'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const actions = require('../pinokio/providers/r25-mode-actions.cjs');

class FakeSocket {
  constructor(kind) { this.kind = kind; this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  close() { queueMicrotask(() => this.emit('close')); }
  send(raw) {
    const rpc = JSON.parse(raw);
    if (this.kind === 'action') {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({
        id: rpc.id, type: 'error', data: 'busy task-1',
      }) }));
    } else if (this.kind === 'fence') {
      if (rpc.mode === 'listen') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({
          id: rpc.id, type: 'connect',
        }) }));
      } else if (rpc.stop === true) {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({
          id: rpc.id, type: 'disconnect',
        }) }));
      }
    } else if (this.kind === 'status') {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ data: false }) }));
    }
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-mode-actions-'));
  try {
    const control = { schema: 'astrid.r25.linux-mode-action-control.v1', pterm: root,
      session: 'a'.repeat(32), request_sha256: 'b'.repeat(64), mode: 'backend' };
    const file = path.join(root, 'control.json');
    fs.writeFileSync(file, JSON.stringify(control));
    assert.deepEqual(actions.readControl(file), control);
    assert.equal(actions.OPERATIONS.backend.length, 2);
    assert.equal(actions.OPERATIONS['fully-local'].length, 1);
    assert.throws(() => actions.requestId('/forged.js', control.session, 'update'));

    let index = 0;
    const kinds = ['action', 'fence', 'status', 'action', 'fence', 'status'];
    const create = () => {
      const socket = new FakeSocket(kinds[index++]);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    };
    const result = await actions.collect(control, create);
    assert.equal(result.schema, 'astrid.r25.linux-mode-action-control-result.v1');
    assert.deepEqual(result.actions.map(row => row.operation),
      ['update', 'keep_data_uninstall']);
    assert.ok(result.actions.every(row => row.fence.idle_observed === true));

    const local = { ...control, mode: 'fully-local' };
    index = 0;
    const localKinds = ['action', 'fence', 'status'];
    const localCreate = () => {
      const socket = new FakeSocket(localKinds[index++]);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    };
    assert.deepEqual((await actions.collect(local, localCreate)).actions.map(row => row.operation),
      ['keep_data_uninstall']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('8 R-25 mode-action protocol assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
