'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIVE_URI, requestId, runAction, terminalProjection, busyProjection, readControl } = require('../pinokio/providers/r24-action.cjs');
const live = require('../pinokio/providers/r24-live-action.js');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
  const session = 'a'.repeat(32), request = 'b'.repeat(64), id = requestId(LIVE_URI, session, 'probe');
  const run = { id, packets: [
    { id, type: 'result', data: { schema: 'binding', session } },
    { id, type: 'event', data: 'stop' }, { id, type: 'disconnect' }
  ] };
  assert.equal(terminalProjection(run, value => value.schema === 'binding').request_id, id);
  assert.throws(() => terminalProjection({ id, packets: run.packets.slice(0, 2) }, () => true));
  const control = { session, request_sha256: request };
  const busy = busyProjection({ schema: 'astrid.r24.preflight.v1', session, request_sha256: request,
    mode: 'busy', safe: false, task_count: 1, headline: 'busy',
    blockers: [{ task_id: 'task-1', blocker_kind: 'running_task', kind: 'render', state: 'running' }] }, control, 'busy');
  assert.equal(busy.blockers[0].task_id, 'task-1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-action-'));
  try {
    const lifecycle = path.join(root, 'lifecycle.mjs'), pythonTarget = path.join(root, 'python-target');
    const python = path.join(root, 'venv-python'), controlDir = path.join(root, 'control');
    fs.writeFileSync(lifecycle, 'fixture'); fs.writeFileSync(pythonTarget, 'fixture');
    fs.symlinkSync(pythonTarget, python); fs.mkdirSync(controlDir);
    const input = { schema: 'astrid.r24.live-action-input.v1', mode: 'probe', session,
      request_sha256: request, lifecycle, lifecycle_sha256: digest(fs.readFileSync(lifecycle)),
      backend_root: root, python, python_target: pythonTarget,
      python_sha256: digest(fs.readFileSync(pythonTarget)), data_root: root, control_dir: controlDir };
    assert.equal((await live.execute({ input })).session, session);
    input.python_target = path.join(root, 'forged-target');
    await assert.rejects(live.execute({ input }));
    input.python_target = pythonTarget;
    input.lifecycle_sha256 = '0'.repeat(64);
    await assert.rejects(live.execute({ input }));
    const full = { schema: 'astrid.r24.live-control.v1', pterm: root, session, request_sha256: request,
      live_uri: '~/api/astrid/pinokio/providers/r24-live-action.js', stop_uri: '~/api/astrid/pinokio/stop.js',
      lifecycle, lifecycle_sha256: digest(fs.readFileSync(lifecycle)),
      backend_root: root, python, python_target: pythonTarget,
      python_sha256: digest(fs.readFileSync(pythonTarget)), data_root: root, control_dir: controlDir };
    const file = path.join(root, 'control.json'); fs.writeFileSync(file, JSON.stringify(full));
    assert.equal(readControl(file).session, session);
    assert.throws(() => requestId('/absolute/action.js', session, 'probe'));
    let socket;
    class FakeSocket {
      constructor() { this.listeners = new Map(); this.closeObserved = false; }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener); this.listeners.set(type, listeners);
      }
      emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
      close() { queueMicrotask(() => { this.closeObserved = true; this.emit('close'); }); }
      send(raw) {
        const rpc = JSON.parse(raw);
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: rpc.id, type: 'start' }) }));
      }
    }
    const create = () => {
      socket = new FakeSocket(); queueMicrotask(() => socket.emit('open')); return socket;
    };
    const fault = await runAction(create, { id, uri: LIVE_URI, input,
      closeOnStart: true, onObserverLost: () => assert.equal(socket.closeObserved, true) });
    assert.equal(fault.observer_lost, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('7 local action/control protocol fixtures passed');
})().catch(() => { console.error('action protocol fixture failed'); process.exitCode = 1; });
