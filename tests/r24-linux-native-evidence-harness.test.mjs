import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runNativeResetDiagnostic } from '../pinokio/providers/linux-native-evidence-harness.mjs';

const uri = '/tmp/r24-native/api/astrid/pinokio/reset.js';
const actionPackets = [
  { type: 'result', id: uri, index: 0, total: 2, data: { stopped: false, lockFree: true } },
  { type: 'result', id: uri, index: 1, total: 2, data: { reset: true, dataKept: true } },
  { type: 'event', id: uri, data: 'stop' }, { type: 'disconnect', id: uri },
];

async function sourceDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'r24-native-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['start.js', 'stop.js', 'update.js', 'update-stage.mjs', 'lib.js', 'lifecycle.mjs', 'session.mjs']) {
    await writeFile(path.join(root, name), `// ${name}\n`);
  }
  return root;
}

function venue() {
  let socket;
  class Socket {
    constructor() { this.handlers = {}; socket = this; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
    emit(name, event) { for (const callback of this.handlers[name] || []) callback(event); }
    send(value) {
      const packet = JSON.parse(value);
      if (packet.status) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ data: false }) }));
    }
    close() {}
  }
  return { Socket, action: () => { for (const packet of actionPackets) socket.emit('message', { data: JSON.stringify(packet) }); } };
}

test('native evidence harness observes a PTerm-dispatched real-engine-shaped stream without upgrading protected journeys', { skip: process.platform !== 'linux' }, async (t) => {
  const sources = await sourceDirectory(t);
  const v = venue();
  let ptermCalls = 0;
  const result = await runNativeResetDiagnostic({
    WebSocket: v.Socket, endpoint: 'ws://127.0.0.1:42000', uri, daemonPid: process.pid,
    pinokioDirectory: sources, startAction: async () => { ptermCalls++; v.action(); },
    subscriptionDelayMs: 0, timeoutMs: 1000,
  });
  assert.equal(ptermCalls, 1);
  assert.equal(result.state, 'unknown');
  assert.equal(result.qualification, 'closed');
  assert.equal(result.dispatched, true);
  assert.ok(result.settlement.issues.includes('engine-execution-id-unavailable'));
  assert.ok(!result.settlement.issues.includes('terminal-unavailable'));
  assert.ok(!result.settlement.issues.includes('idle-not-observed'));
  assert.match(result.custody.initial.observation.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.custody.initial.observation.file, 'observations/obs-000001.json');
  assert.equal(result.custody.final.observation.file, 'observations/obs-000002.json');
  assert.equal(result.fullyLocalRestoration.state, 'not-run');
  assert.deepEqual(result.fullyLocalRestoration.source.files.map((file) => file.path),
    ['start.js', 'stop.js', 'update.js', 'update-stage.mjs', 'lib.js', 'lifecycle.mjs', 'session.mjs']);
  assert.deepEqual(result.fault.externalAwait.map((entry) => entry.id), ['R-15', 'R-21', 'R-36']);
  assert.deepEqual(result.journeys['M4-5'].externalAwait.map((entry) => entry.id), ['R-06', 'R-15', 'R-21', 'R-36']);
  for (const journey of Object.values(result.journeys)) {
    assert.equal(journey.state, 'not-run');
    assert.equal(journey.qualification, 'closed');
  }
});

test('a missing source checkpoint refuses dispatch and preserves closed M4 rows', { skip: process.platform !== 'linux' }, async () => {
  let called = false;
  const result = await runNativeResetDiagnostic({
    WebSocket: class {}, endpoint: 'ws://127.0.0.1:42000', uri, daemonPid: process.pid,
    pinokioDirectory: '/definitely-not-r24-source', startAction: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.issues, ['source-checkpoint-unavailable']);
  assert.equal(result.journeys['M4-4b'].state, 'not-run');
});
