'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { terminalProjection, busyProjection, readControl } = require('../pinokio/providers/r24-action.cjs');
const live = require('../pinokio/providers/r24-live-action.js');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
  const session = 'a'.repeat(32), request = 'b'.repeat(64), id = `r24-session=${session}-probe`;
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
    const lifecycle = path.join(root, 'lifecycle.mjs'), python = path.join(root, 'python'), controlDir = path.join(root, 'control');
    fs.writeFileSync(lifecycle, 'fixture'); fs.writeFileSync(python, 'fixture'); fs.mkdirSync(controlDir);
    const input = { schema: 'astrid.r24.live-action-input.v1', mode: 'probe', session,
      request_sha256: request, lifecycle, lifecycle_sha256: digest(fs.readFileSync(lifecycle)),
      backend_root: root, python, python_sha256: digest(fs.readFileSync(python)), data_root: root, control_dir: controlDir };
    assert.equal((await live.execute({ input })).session, session);
    input.lifecycle_sha256 = '0'.repeat(64);
    await assert.rejects(live.execute({ input }));
    const full = { schema: 'astrid.r24.live-control.v1', pterm: root, session, request_sha256: request,
      live_uri: lifecycle, stop_uri: lifecycle, lifecycle, lifecycle_sha256: digest(fs.readFileSync(lifecycle)),
      backend_root: root, python, python_sha256: digest(fs.readFileSync(python)), data_root: root, control_dir: controlDir };
    const file = path.join(root, 'control.json'); fs.writeFileSync(file, JSON.stringify(full));
    assert.equal(readControl(file).session, session);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log('4 local action/control protocol fixtures passed');
})().catch(() => { console.error('action protocol fixture failed'); process.exitCode = 1; });
