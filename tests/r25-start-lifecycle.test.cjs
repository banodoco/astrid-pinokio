'use strict';

const assert = require('node:assert/strict');
const { spawn: realSpawn } = require('node:child_process');
const { test } = require('node:test');

const { createObserverIO } = require('../.github/venue/r21-observer-io.cjs');

function fixture({ failedPredicate = null, earlyExit = false, terminalPacket = null } = {}) {
  const events = [];
  const requests = [];
  let child;
  class Socket extends EventTarget {
    constructor() { super(); setImmediate(() => this.dispatchEvent(new Event('open'))); }
    send(payload) {
      const request = JSON.parse(payload);
      if (request.mode === 'listen' && terminalPacket) {
        setImmediate(() => {
          const message = new Event('message');
          message.data = JSON.stringify(terminalPacket);
          this.dispatchEvent(message);
        });
        return;
      }
      setImmediate(() => {
        const message = new Event('message');
        message.data = JSON.stringify({ data: true });
        this.dispatchEvent(message);
      });
    }
    terminate() { this.dispatchEvent(new Event('close')); }
  }
  const fetch = async url => {
    if (earlyExit) await new Promise(resolve => setTimeout(resolve, 20));
    const predicate = url.includes('/resource/') ? 'engine-resource'
      : url.includes('/health') ? 'runtime_health' : 'application';
    requests.push(predicate);
    const ok = predicate !== failedPredicate;
    if (predicate === 'engine-resource') return { ok, status: ok ? 200 : 503,
      json: async () => ({ path: '/app', running_scripts: ['pinokio/start.js'] }) };
    if (predicate === 'runtime_health') return { ok, status: ok ? 200 : 503,
      json: async () => ({ protocol: 'workspace.v1' }) };
    return { ok, status: ok ? 200 : 503 };
  };
  const io = createObserverIO({ WebSocket: Socket, fetch, spawn: () => {
    const script = earlyExit ? "process.exit(17)" : "process.stdout.write('ASTRID_PINOKIO_READY\\n'); setInterval(() => {}, 1000)";
    child = realSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    return child;
  }, record: value => events.push(value), appRoot: '/app', ptermRoot: '/pterm', home: '/home',
  endpoint: 'pinokio://endpoint', connectMs: 100, responseMs: 100, resourceMs: 15,
  runtimeMs: 15, applicationMs: 15, pollMs: 50, cleanupMs: 100 });
  return { io, events, requests, get child() { return child; } };
}

test('backend Start observes sentinel and every independent predicate while its owned PTerm client stays live', async () => {
  const f = fixture();
  let output = '';
  let readiness;
  let lifecycle;
  const terminal = [];
  let signalReady;
  const readyOutput = new Promise(resolve => { signalReady = resolve; });
  const child = await f.io.startOldLauncher({
    onOutput: (_stream, chunk) => { output += chunk.toString(); if (output.includes('ASTRID_PINOKIO_READY')) signalReady(); },
    onReadiness: value => { readiness = value; },
    onClientState: value => { lifecycle = value; },
    onTerminal: value => terminal.push(value),
  });
  await Promise.race([readyOutput, new Promise(resolve => setTimeout(resolve, 100))]);
  assert.match(output, /ASTRID_PINOKIO_READY/);
  assert.deepEqual(readiness, { engine_resource: true, runtime_health: true, application: true });
  assert.deepEqual(f.requests, ['engine-resource', 'runtime_health', 'application']);
  assert.deepEqual(lifecycle, { pid: child.pid, exited: null, still_owned: true });
  assert.equal(child.exitCode, null);
  assert.ok(terminal.length >= 1);
  await f.io.cleanup();
  assert.notEqual(child.signalCode, null, 'bounded cleanup reaps the owned Start client');
});

for (const predicate of ['engine-resource', 'runtime_health', 'application']) {
  test(`backend Start fails closed when ${predicate} readiness fails`, async () => {
    const f = fixture({ failedPredicate: predicate });
    await assert.rejects(f.io.startOldLauncher(), /readiness timeout/);
    const operation = predicate === 'runtime_health' ? 'runtime' : predicate;
    assert.ok(f.events.some(item => item.operation === operation && item.category === 'not-ready'));
    await f.io.cleanup();
    assert.notEqual(f.child.signalCode, null);
  });
}

test('backend Start treats a PTerm exit before independent readiness as failure', async () => {
  const f = fixture({ earlyExit: true });
  await assert.rejects(f.io.startOldLauncher(), /PTerm exited before readiness/);
  await f.io.cleanup();
  assert.notEqual(f.child.exitCode, null);
});

test('backend Start records a top-level terminal packet while retaining the owned client', async () => {
  const f = fixture({ terminalPacket: { type: 'event', data: 'disconnect' } });
  let terminal;
  const child = await f.io.startOldLauncher({ onTerminal: value => { terminal = value; } });
  assert.ok(terminal.disconnect > 0);
  assert.equal(child.exitCode, null);
  await f.io.cleanup();
  assert.notEqual(child.signalCode, null);
});
