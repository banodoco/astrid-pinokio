import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createStartDiagnostics, projectStartDiagnostics, requireInitialInstallForStart, runBoundedRuntimeStatus, probePort17340 } =
  require('../.github/venue/r21-start-diagnostics.cjs');
const { publish } = require('../.github/venue/r21-publish.cjs');

const binding = { request_id: 'R-21-PUBLISHED-TUPLE-R1', runner_ref: 'a'.repeat(40), run_id: '100', run_attempt: '1' };

test('initial Start requires settled Install, exact tuple, and authentic success marker', () => {
  const install = { inner_exit: { code: 0, signal: null }, terminal: { stop: true, disconnect: true }, installer_success: true };
  assert.doesNotThrow(() => requireInitialInstallForStart({ install, installedTuplePresent: true }));
  assert.throws(() => requireInitialInstallForStart({ install, installedTuplePresent: false }), /lacks the published tuple/);
  assert.throws(() => requireInitialInstallForStart({ install: { ...install, installer_success: false }, installedTuplePresent: true }), /installer success marker/);
  assert.throws(() => requireInitialInstallForStart({ install: { ...install, inner_exit: { code: 1, signal: null } }, installedTuplePresent: true }), /did not settle/);
});

test('first Start diagnostic retains only its five typed facts', () => {
  let evidence;
  const recorder = createStartDiagnostics(binding, value => { evidence = value; });
  recorder.install({ installedTuplePresent: false, installMarkerObserved: false });
  recorder.startListener();
  recorder.startPacket({ type: 'error', data: { message: '/private/secret', token: 'secret-token' } });
  recorder.startPacket({ type: 'event', data: 'stop', raw: 'secret-token' });
  recorder.startPacket({ type: 'disconnect', data: '/private/secret' });
  recorder.runtimeStatus({ class: 'exit', code: 23, command: '/private/secret' });
  recorder.listener(false);
  assert.deepEqual(evidence, {
    schema: 1, binding, installed_tuple_present: false, install_marker_observed: false,
    start: { engine_error: true, terminal_stop: true, terminal_disconnect: true },
    runtime_status: { class: 'exit', code: 23 }, port_17340_listener: false,
  });
  const hostile = projectStartDiagnostics({ binding, installed_tuple_present: 'yes', install_marker_observed: true,
    start: { engine_error: 'secret', terminal_stop: false, terminal_disconnect: false, raw: 'secret-token' },
    runtime_status: { class: 'secret', code: 999, output: '/private/secret' }, port_17340_listener: true, secret: 'secret-token' }, binding);
  assert.deepEqual(hostile.runtime_status, { class: 'pending', code: null });
  assert.doesNotMatch(JSON.stringify({ evidence, hostile }), /secret|private/);
});

test('independent Runtime status is bounded and distinguishes exit, timeout, and unavailable', async () => {
  const exited = new EventEmitter(); exited.kill = () => {};
  const resolved = runBoundedRuntimeStatus({ spawn: () => exited, spec: { command: 'private', args: [], cwd: '/private' } });
  exited.emit('exit', 17);
  assert.deepEqual(await resolved, { class: 'exit', code: 17 });

  const timers = [];
  const pending = new EventEmitter(); pending.kill = signal => { pending.signal = signal; };
  const timeout = runBoundedRuntimeStatus({ spawn: () => pending, spec: { command: 'private', args: [], cwd: '/private' }, timeoutMs: 9,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  timers[0].fn();
  assert.deepEqual(await timeout, { class: 'timeout', code: null });
  assert.equal(pending.signal, 'SIGTERM');
  assert.equal(timers[1].ms, 2000);
  pending.emit('exit', null);
  assert.deepEqual(await runBoundedRuntimeStatus({ spawn: () => { throw new Error('/private/secret'); }, spec: { command: 'private', args: [], cwd: '/private' } }),
    { class: 'spawn-error', code: null });
  assert.deepEqual(await runBoundedRuntimeStatus({ spawn: () => pending, spec: null }), { class: 'unavailable', code: null });
});

test('port 17340 diagnostic records a TCP accept boolean only', async () => {
  const present = new EventEmitter(); present.destroy = () => { present.destroyed = true; };
  const yes = probePort17340({ connect: () => { queueMicrotask(() => present.emit('connect')); return present; } });
  assert.equal(await yes, true);
  assert.equal(present.destroyed, true);
  const absent = new EventEmitter(); absent.destroy = () => {};
  const no = probePort17340({ connect: () => { queueMicrotask(() => absent.emit('error', new Error('/private/secret'))); return absent; } });
  assert.equal(await no, false);
});

test('publisher reprojects only exact-bound Start diagnostics without affecting acceptance', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r21-start-publish-'));
  const env = {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
    GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: binding.request_id,
    R21_CONFIRMATION: 'REAL_ENGINE_UPDATE_STOP_RETRY', R21_RUNNER_REF: binding.runner_ref,
  };
  try {
    const evidenceDir = path.join(root, 'evidence'); fs.mkdirSync(evidenceDir);
    fs.writeFileSync(path.join(evidenceDir, 'r21-start-diagnostics.json'), JSON.stringify({
      schema: 99, binding: { ...binding, secret: 'secret-token' }, installed_tuple_present: false, install_marker_observed: false,
      start: { engine_error: true, terminal_stop: false, terminal_disconnect: true, raw: '/private/secret' },
      runtime_status: { class: 'timeout', code: 42, output: '/private/secret' }, port_17340_listener: false, secret: 'secret-token',
    }));
    const destination = path.join(root, 'result');
    const verdict = publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    assert.equal(verdict.status, 'FAILED');
    const text = fs.readFileSync(path.join(destination, 'start-diagnostics.json'), 'utf8');
    assert.deepEqual(JSON.parse(text), {
      schema: 1, binding, installed_tuple_present: false, install_marker_observed: false,
      start: { engine_error: true, terminal_stop: false, terminal_disconnect: true },
      runtime_status: { class: 'timeout', code: null }, port_17340_listener: false,
    });
    assert.doesNotMatch(text, /secret|private|output|raw/);
    assert.match(fs.readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8'), /  start-diagnostics\.json/);
    const wrong = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'r21-start-diagnostics.json')));
    for (const key of Object.keys(binding)) {
      wrong.binding = { ...binding, [key]: 'wrong' };
      fs.writeFileSync(path.join(evidenceDir, 'r21-start-diagnostics.json'), JSON.stringify(wrong));
      const other = path.join(root, `wrong-${key}`);
      publish({ env, evidenceDir, destination: other, setupExit: 0, journeyExit: 1 });
      assert.equal(fs.existsSync(path.join(other, 'start-diagnostics.json')), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
