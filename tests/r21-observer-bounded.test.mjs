import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createObserverIO } = require('../.github/venue/r21-observer-io.cjs');
const { publish } = require('../.github/venue/r21-publish.cjs');
const { TRACE_LIMIT, createTrace } = require('../.github/venue/r21-observer-diagnostics.cjs');

function fixture({ socketMode = 'success', fetchMode = 'success', spawnMode = 'normal', pollMs = 45 } = {}) {
  const notes = [];
  const sockets = [];
  let child;
  class Socket extends EventTarget {
    constructor() {
      super(); sockets.push(this);
      if (socketMode !== 'connect-timeout') setImmediate(() => this.dispatchEvent(new Event(socketMode === 'connect-error' ? 'error' : 'open')));
    }
    send() {
      if (socketMode === 'send-error') throw new Error('private');
      if (socketMode === 'response-timeout') return;
      setImmediate(() => {
        const event = new Event('message');
        event.data = socketMode === 'bad-json' ? '{' : JSON.stringify({ data: socketMode !== 'not-ready' });
        this.dispatchEvent(event);
      });
    }
    terminate() { this.terminated = true; this.dispatchEvent(new Event('close')); }
  }
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, signal: options.signal });
    const kind = url.includes('/resource/') ? 'engine-resource' : url.includes('/health') ? 'runtime' : 'application';
    if (fetchMode === `${kind}-timeout`) return new Promise(() => {});
    if (fetchMode === `${kind}-body-timeout`) return { ok: true, status: 200, json: () => new Promise(() => {}) };
    if (fetchMode === `${kind}-error`) { const error = new TypeError('private'); error.cause = { code: 'ECONNREFUSED', message: 'private' }; throw error; }
    if (fetchMode === `${kind}-not-ready`) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => kind === 'runtime' ? { protocol: fetchMode === 'wrong-protocol' ? 'other' : 'workspace.v1' } : { path: fetchMode === 'wrong-path' ? '/other' : '/app', running_scripts: fetchMode === 'missing-script' ? [] : ['pinokio/start.js'] } };
  };
  const io = createObserverIO({ WebSocket: Socket, fetch: fakeFetch, spawn: () => {
    child = spawnMode === 'error' ? realSpawn('/path/does-not-exist') : realSpawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    return child;
  }, record: note => notes.push(note), appRoot: '/app', ptermRoot: '/pterm', home: '/tmp', endpoint: 'pinokio://endpoint',
  connectMs: 20, responseMs: 20, resourceMs: 20, runtimeMs: 20, applicationMs: 20, pollMs, cleanupMs: 100 });
  return { io, notes, sockets, requests, get child() { return child; } };
}

for (const mode of ['connect-timeout', 'connect-error', 'response-timeout', 'send-error', 'bad-json']) {
  test(`Start status ${mode} fails and disposes its socket and owned client`, async () => {
    const f = fixture({ socketMode: mode });
    await assert.rejects(f.io.startOldLauncher());
    const last = f.notes.at(-1);
    assert.equal(last.operation, 'start-status');
    assert.equal(last.category, mode.includes('timeout') ? 'timeout' : 'error');
    assert.ok(!Number.isNaN(Date.parse(last.timestamp)));
    await f.io.cleanup();
    assert.ok(f.sockets.every(socket => socket.terminated));
    assert.notEqual(f.child.signalCode, null);
  });
}

test('Start status poll deadline reports timeout and cleans up', async () => {
  const f = fixture({ socketMode: 'not-ready' });
  await assert.rejects(f.io.startOldLauncher(), /timeout/);
  assert.equal(f.notes.at(-1).category, 'timeout');
  await f.io.cleanup();
  assert.notEqual(f.child.signalCode, null);
});

for (const operation of ['engine-resource', 'runtime', 'application']) {
  for (const mode of ['timeout', 'error', 'not-ready']) {
    test(`${operation} ${mode} remains bounded, classified, and cleans Start client`, async () => {
      const f = fixture({ fetchMode: `${operation}-${mode}` });
      await assert.rejects(f.io.startOldLauncher(), /readiness timeout/);
      const last = f.notes.at(-1);
      assert.equal(last.operation, operation);
      assert.equal(last.category, mode);
      if (mode === 'timeout') assert.ok(f.requests.at(-1).signal.aborted);
      await f.io.cleanup();
      assert.notEqual(f.child.signalCode, null);
    });
  }
}

for (const mode of ['wrong-path', 'missing-script', 'wrong-protocol']) {
  test(`readiness rejects ${mode}`, async () => {
    const f = fixture({ fetchMode: mode });
    const ready = mode === 'wrong-protocol' ? await f.io.runtimeReady() : await f.io.engineResourceReady();
    assert.equal(ready, false);
    assert.equal(f.notes.at(-1).category, 'not-ready');
    await f.io.cleanup();
  });
}

test('Runtime diagnostics distinguish transport, HTTP failure, protocol mismatch and success', async () => {
  for (const [mode, expected, ready] of [
    ['runtime-error', { kind: 'transport', error_class: 'TypeError', error_code: 'ECONNREFUSED' }, false],
    ['runtime-not-ready', { kind: 'http', status: 503, protocol_match: false }, false],
    ['wrong-protocol', { kind: 'http', status: 200, protocol_match: false }, false],
    ['success', { kind: 'http', status: 200, protocol_match: true }, true],
    ['runtime-body-timeout', { kind: 'http', status: 200, protocol_match: null }, false],
  ]) {
    const f = fixture({ fetchMode: mode });
    assert.equal(await f.io.runtimeReady(), ready);
    assert.deepEqual(f.notes.at(-1).runtime, expected);
    assert.equal(JSON.stringify(f.notes).includes('private'), false);
    await f.io.cleanup();
  }
});

test('operation trace retains only the last bounded sanitized records in order', () => {
  const trace = createTrace();
  for (let i = 0; i < TRACE_LIMIT + 7; i++) trace.record({ operation: 'runtime', category: 'error', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), runtime: { kind: 'transport', error_class: 'Error', error_code: 'other', raw: 'private' }, raw: 'private' });
  const entries = trace.snapshot();
  assert.equal(entries.length, TRACE_LIMIT);
  assert.equal(entries[0].timestamp, '2026-01-01T00:00:07.000Z');
  assert.equal(entries.at(-1).timestamp, '2026-01-01T00:00:26.000Z');
  assert.equal(JSON.stringify(entries).includes('private'), false);
});

test('engine resource body timeout also aborts', async () => {
  const f = fixture({ fetchMode: 'engine-resource-body-timeout' });
  assert.equal(await f.io.engineResourceReady(), false);
  assert.equal(f.notes.at(-1).category, 'timeout');
  assert.ok(f.requests.at(-1).signal.aborted);
  await f.io.cleanup();
});

test('spawn failure interrupts a pending connection and cleanup completes', async () => {
  const f = fixture({ spawnMode: 'error', socketMode: 'connect-timeout' });
  await assert.rejects(f.io.startOldLauncher(), /spawn failed/);
  assert.equal(f.notes.at(-1).operation, 'start-client');
  assert.equal(f.notes.at(-1).category, 'error');
  await f.io.cleanup();
  assert.ok(f.sockets.every(socket => socket.terminated));
});

test('successful Start still requires explicit engine, runtime and application readiness; cleanup escalates and reaps', async () => {
  const f = fixture();
  const child = await f.io.startOldLauncher();
  await new Promise(resolve => child.stdout.once('data', resolve));
  assert.deepEqual(f.requests.map(r => r.url.includes('/resource/') ? 'engine-resource' : r.url.includes('/health') ? 'runtime' : 'application'), ['engine-resource', 'runtime', 'application']);
  assert.deepEqual(f.notes.filter(n => n.category === 'success').map(n => n.operation), ['start-status', 'engine-resource', 'runtime', 'application']);
  const started = Date.now();
  await f.io.cleanup();
  assert.equal(child.signalCode, 'SIGKILL');
  assert.ok(Date.now() - started < 1500);
  assert.ok(f.sockets.every(socket => socket.terminated));
});

test('publisher allows only timestamped fixed operation and category fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-observer-publish-'));
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R13', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-R13', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: 'R-21-R13', R21_CONFIRMATION: 'REAL_ENGINE_UPDATE_STOP_RETRY', R21_RUNNER_REF: 'a'.repeat(40) };
  try {
    const evidenceDir = path.join(root, 'evidence'); const destination = path.join(root, 'result'); fs.mkdirSync(evidenceDir);
    const put = last_operation => fs.writeFileSync(path.join(evidenceDir, 'r21-failure.json'), JSON.stringify({ category: 'timeout', last_operation }));
    put({ operation: 'runtime', category: 'timeout', timestamp: '2026-11-02T00:00:00.000Z', raw: 'private' });
    publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    let failure = JSON.parse(fs.readFileSync(path.join(destination, 'observer-failure.json')));
    assert.deepEqual(failure.last_operation, { operation: 'runtime', category: 'timeout', timestamp: '2026-11-02T00:00:00.000Z' });
    const good = { operation: 'runtime', category: 'error', timestamp: '2026-11-02T00:00:00.000Z', runtime: { kind: 'transport', error_class: 'TypeError', error_code: 'ECONNREFUSED', raw: 'private' } };
    fs.writeFileSync(path.join(evidenceDir, 'r21-failure.json'), JSON.stringify({ category: 'timeout', last_operation: good, readiness_trace: [...Array(25).fill(good), { ...good, runtime: { kind: 'http', status: 200, protocol_match: true, body: 'private' } }, { ...good, runtime: { kind: 'transport', error_class: 'private', error_code: 'private' } }] }));
    publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    failure = JSON.parse(fs.readFileSync(path.join(destination, 'observer-failure.json')));
    assert.equal(failure.readiness_trace.length, TRACE_LIMIT);
    assert.deepEqual(failure.last_operation.runtime, { kind: 'transport', error_class: 'TypeError', error_code: 'ECONNREFUSED' });
    assert.deepEqual(failure.readiness_trace.at(-2).runtime, { kind: 'http', status: 200, protocol_match: true });
    assert.equal(failure.readiness_trace.at(-1).runtime, undefined);
    assert.equal(JSON.stringify(failure).includes('private'), false);
    put({ operation: 'private', category: 'timeout', timestamp: '2026-11-02T00:00:00.000Z' });
    publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    failure = JSON.parse(fs.readFileSync(path.join(destination, 'observer-failure.json')));
    assert.equal(failure.last_operation, null);
    put({ operation: 'runtime', category: 'timeout', timestamp: '2026-02-31T00:00:00.000Z' });
    publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    failure = JSON.parse(fs.readFileSync(path.join(destination, 'observer-failure.json')));
    assert.equal(failure.last_operation, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('observer failure handler writes sanitized failure and reaps its real Start client', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-observer-main-'));
  try {
    const pterm = path.join(root, 'pterm'); const output = path.join(root, 'evidence'); const moduleDir = path.join(pterm, 'node_modules', 'unws');
    fs.mkdirSync(moduleDir, { recursive: true }); fs.mkdirSync(output);
    fs.writeFileSync(path.join(moduleDir, 'index.js'), `let count = 0;
exports.WebSocket = class extends EventTarget {
  constructor() { super(); this.number = ++count; setTimeout(() => this.dispatchEvent(new Event(this.number === 3 ? 'error' : 'open')), this.number === 3 ? 150 : 1); }
  send(raw) { const value = JSON.parse(raw); if (value.mode === 'listen') {
    for (const packet of [{type:'event', data:'stop'}, {type:'disconnect'}]) { const e = new Event('message'); e.data = JSON.stringify(packet); this.dispatchEvent(e); }
  } else { const e = new Event('message'); e.data = JSON.stringify({data:false}); setImmediate(() => this.dispatchEvent(e)); } }
  terminate() { this.dispatchEvent(new Event('close')); }
};`);
    fs.writeFileSync(path.join(pterm, 'index.js'), `if (process.argv[3] === 'pinokio/start.js') { require('fs').writeFileSync(process.env.TEST_START_PID, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }`);
    const { ENDPOINT, TUPLE } = require('../.github/venue/r21-verify.cjs');
    const request = path.join(root, 'request.json'); fs.writeFileSync(request, JSON.stringify({ endpoint: ENDPOINT, tuple: TUPLE }));
    const observer = realSpawn(process.execPath, ['.github/venue/r21-observe.cjs', request, output], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, R21_APP_ROOT: root, R21_PTERM_ROOT: pterm, R21_VENUE_HOME: root, TEST_START_PID: path.join(root, 'start.pid') } });
    const timeout = setTimeout(() => observer.kill('SIGKILL'), 6000);
    const result = await new Promise(resolve => observer.once('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(timeout);
    assert.deepEqual(result, { code: 1, signal: null });
    const failure = JSON.parse(fs.readFileSync(path.join(output, 'r21-failure.json')));
    assert.equal(failure.category, 'engine-or-observer');
    assert.equal(failure.last_operation.operation, 'start-status');
    assert.equal(failure.last_operation.category, 'error');
    assert.deepEqual(failure.readiness_trace.at(-1), failure.last_operation);
    const pid = Number(fs.readFileSync(path.join(root, 'start.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
