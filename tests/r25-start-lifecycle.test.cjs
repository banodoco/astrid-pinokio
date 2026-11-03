'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { observeAction, observeDaemonStart } = require('../.github/venue/r25-snapshot-runner.cjs');
const { createObserverIO } = require('../.github/venue/r21-observer-io.cjs');

function fixture({ failedPredicate = null, earlyExit = false } = {}) {
  const notes = [];
  const requests = [];
  let child;
  class Socket extends EventTarget {
    constructor() { super(); setImmediate(() => this.dispatchEvent(new Event('open'))); }
    send() {
      setImmediate(() => {
        const event = new Event('message');
        event.data = JSON.stringify({ data: true });
        this.dispatchEvent(event);
      });
    }
    terminate() { this.dispatchEvent(new Event('close')); }
  }
  const fetch = async url => {
    const predicate = url.includes('/resource/') ? 'engine-resource'
      : url.includes('/health') ? 'runtime' : 'application';
    requests.push(predicate);
    if (earlyExit && predicate === 'runtime') await new Promise(resolve => setTimeout(resolve, 20));
    const ok = predicate !== failedPredicate;
    if (predicate === 'engine-resource') return { ok, status: ok ? 200 : 503,
      json: async () => ({ path: '/app', running_scripts: ['pinokio/start.js'] }) };
    if (predicate === 'runtime') return { ok, status: ok ? 200 : 503,
      json: async () => ({ protocol: 'workspace.v1' }) };
    return { ok, status: ok ? 200 : 503 };
  };
  const io = createObserverIO({ WebSocket: Socket, fetch, spawn: () => {
    const code = earlyExit ? 'setTimeout(() => process.exit(17), 5)' : 'setInterval(() => {}, 1000)';
    child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    return child;
  }, record: value => notes.push(value), appRoot: '/app', ptermRoot: '/pterm', home: '/home',
  endpoint: 'pinokio://endpoint', connectMs: 100, responseMs: 100, resourceMs: 15,
  runtimeMs: 15, applicationMs: 15, pollMs: 50, cleanupMs: 100 });
  return { io, notes, requests, get child() { return child; } };
}

test('R-25 start reaches every independent readiness predicate while its PTerm daemon client stays alive', async () => {
  const f = fixture();
  const result = await observeDaemonStart(f.io);
  assert.equal(result.execution_kind, 'long-lived-daemon-client');
  assert.equal(result.inner_exit, null, 'the live client exit is not used as action settlement');
  assert.equal(result.status_after, true);
  assert.deepEqual(result.readiness, { engine_resource: true, runtime_health: true, application: true });
  assert.deepEqual(f.requests, ['engine-resource', 'runtime', 'application']);
  assert.equal(f.child.exitCode, null, 'the Start PTerm client must remain live after readiness');
  await f.io.cleanup();
  assert.notEqual(f.child.signalCode, null, 'tracked client must be reaped by cleanup');
});

for (const predicate of ['engine-resource', 'runtime', 'application']) {
  test(`R-25 start fails closed when ${predicate} readiness fails`, async () => {
    const f = fixture({ failedPredicate: predicate });
    await assert.rejects(observeDaemonStart(f.io), /readiness timeout/);
    assert.ok(f.notes.some(item => item.operation === predicate && item.category === 'not-ready'));
    await f.io.cleanup();
    assert.notEqual(f.child.signalCode, null);
  });
}

test('R-25 start treats PTerm exit before readiness as failure', async () => {
  const f = fixture({ earlyExit: true });
  await assert.rejects(observeDaemonStart(f.io), /PTerm exited before readiness/);
  await f.io.cleanup();
  assert.notEqual(f.child.exitCode, null);
});

test('R-25 Stop boundary leaves Start client tracked for bounded cleanup', async () => {
  const f = fixture();
  await observeDaemonStart(f.io);
  assert.equal(f.child.exitCode, null);
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-start-stop-'));
  try {
    const stop = await observeAction({
      io: f.io, ptermRoot: '/pterm', home: '/home', endpoint: 'pinokio://endpoint',
      appRoot: '/app', script: 'pinokio/stop.js', action: 'stop', logRoot,
      timeoutMs: 1000, spawnProcess: () => spawn(process.execPath, ['-e', 'process.exit(0)']),
    });
    assert.deepEqual(stop.inner_exit, { code: 0, signal: null });
    assert.equal(stop.first_error, null);
    assert.equal(f.child.exitCode, null, 'the Start client remains tracked through measured Stop');
    await f.io.cleanup();
    assert.notEqual(f.child.signalCode, null, 'cleanup reaps the tracked Start client');
  } finally {
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
});
