import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const diagnostics = createRequire(import.meta.url)('../.github/venue/r21-observer-diagnostics.cjs');
const { publish } = createRequire(import.meta.url)('../.github/venue/r21-publish.cjs');
const binding = { request_id: 'R-21-PUBLISHED-TUPLE-R1', runner_ref: 'a'.repeat(40), run_id: '100', run_attempt: '1' };

test('R-21 keeps the long Install timeout while progress continues and accepts a zero inner exit', async () => {
  const child = new EventEmitter();
  const pending = diagnostics.ptermExit(child, 'historical install', 45 * 60 * 1000);
  child.emit('exit', 0, null);
  assert.deepEqual(await pending, { code: 0, signal: null });
});

test('R-21 failure marker settles PTerm with bounded TERM cleanup instead of the Install timeout', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 23, null));
    return true;
  };
  const started = Date.now();
  const result = await diagnostics.ptermExit(child, 'historical install', 45 * 60 * 1000, null,
    Promise.resolve({ source: 'launcher_failure_marker' }), { termGraceMs: 20, settleMs: 20 });
  assert.deepEqual(result, { code: 23, signal: null });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.ok(Date.now() - started < 1000, 'known failure must not wait for initial Install timeout');
});

test('R-21 known failure escalates to KILL and settles when PTerm ignores TERM', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  const started = Date.now();
  const result = await diagnostics.ptermExit(child, 'historical install', 45 * 60 * 1000, null,
    Promise.resolve({ source: 'launcher_failure_marker' }), { termGraceMs: 20, settleMs: 20 });
  assert.deepEqual(result, { code: null, signal: 'SIGKILL' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 1000, 'TERM/KILL settlement must remain bounded');
});

test('R-21 result keeps only bounded redacted first-cause text and the inner exit', () => {
  let evidence;
  const recorder = diagnostics.createInstallDiagnostics(binding, value => { evidence = value; }, () => Date.parse('2026-01-01T00:00:00.000Z'));
  recorder.firstCause({
    source: 'launcher_failure_marker',
    text: 'ASTRID_PINOKIO_FAILURE secret-token TOKEN=top-secret https://token.example/private /home/runner/.ssh/id_rsa Bearer abcdefghijklmnopqrstuvwxyz0123456789',
  });
  recorder.pterm('child-exit', { code: 17, signal: null });
  const projected = diagnostics.projectInstallEvidence({
    ...evidence,
    first_cause: { source: 'launcher_failure_marker', text: 'ASTRID_PINOKIO_FAILURE secret-token TOKEN=top-secret https://token.example/private /home/runner/.ssh/id_rsa' },
    secret: 'top-secret',
  }, binding);
  assert.equal(projected.first_cause.source, 'launcher_failure_marker');
  assert.equal(projected.first_cause.inner_exit.code, 17);
  assert.equal(projected.first_cause.inner_exit.signal, null);
  assert.match(projected.first_cause.text, /ASTRID_PINOKIO_FAILURE/);
  assert.ok(Buffer.byteLength(projected.first_cause.text) <= 512);
  assert.doesNotMatch(JSON.stringify(projected), /secret-token|top-secret|token\.example|id_rsa|home\/runner/i);
  assert.doesNotMatch(JSON.stringify(projected), /raw|private\/|Bearer abcdef/i);
});

test('R-21 publisher writes the redacted first cause and inner exit to the result JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-fail-fast-result-'));
  const evidenceDir = path.join(root, 'evidence');
  const destination = path.join(root, 'result');
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: 'R-21-PUBLISHED-TUPLE-R1',
    R21_CONFIRMATION: 'REAL_ENGINE_UPDATE_STOP_RETRY', R21_RUNNER_REF: 'a'.repeat(40),
  };
  try {
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(path.join(evidenceDir, 'r21-install-diagnostics.json'), JSON.stringify({
      binding,
      first_cause: { source: 'launcher_failure_marker', text: 'ASTRID_PINOKIO_FAILURE TOKEN=top-secret /private/path' },
      child: { code: 19, signal: null },
    }));
    const verdict = publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    const result = fs.readFileSync(path.join(destination, 'install-diagnostics.json'), 'utf8');
    assert.equal(verdict.status, 'FAILED');
    assert.match(result, /ASTRID_PINOKIO_FAILURE/);
    assert.match(result, /"code": 19/);
    assert.doesNotMatch(result, /top-secret|private\/path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
