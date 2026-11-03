'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  createBoundedCapture, copyBoundedTail, captureProcessSnapshot,
  identityMismatches, captureOwnedDaemonIdentity, cleanupOwnedDaemon, observeAction,
} = require('../.github/venue/r25-macos-snapshot-runner.cjs');
const { createInstallDiagnostics, ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r25-mac-observability-'));
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('close', resolve));
}

async function waitForFile(file, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function writeDaemonFixture(root) {
  const script = path.join(root, 'daemon.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const role = process.argv[2] || 'daemon';
if (role === 'child') { setInterval(() => {}, 1000); }
else {
  const child = spawn(process.execPath, [__filename, 'child'], { cwd: process.env.CHILD_CWD || process.cwd(), stdio: 'ignore' });
  fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
  process.on('SIGTERM', () => fs.appendFileSync(process.env.TERM_FILE, 'SIGTERM\\n'));
  setInterval(() => {}, 1000);
}
`, { mode: 0o600 });
  return script;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('Darwin signal identity requires the exact captured command line and every fresh identity field', () => {
  const observed = {
    available: true, pid: 420, ppid: 42, uid: 501,
    executable: '/usr/local/bin/node', cwd: '/private/run',
    command_line: '/usr/local/bin/node /private/run/child.cjs --role child',
    start_identity: 'macos:Mon Nov 02 18:00:02 2026',
  };
  const expected = {
    pid: 420, ppid: 42, uid: 501,
    executable: '/usr/local/bin/node', cwd: '/private/run', run_root: '/private/run',
    command_line: observed.command_line, start_identity: observed.start_identity,
  };

  assert.deepEqual(identityMismatches(observed, expected, 'darwin'), []);

  for (const [label, mutation, reason] of [
    ['missing expected command identity', value => { delete value.command_line; }, 'command-identity-unavailable'],
    ['changed expected command identity', value => { value.command_line += ' --changed'; }, 'command-changed'],
    ['changed fresh command identity', value => { value.command_line += ' --changed'; }, 'command-changed'],
    ['changed PID', value => { value.pid += 1; }, 'pid-changed'],
    ['changed PPID', value => { value.ppid += 1; }, 'ppid-changed'],
    ['changed UID', value => { value.uid += 1; }, 'uid-changed'],
    ['changed executable', value => { value.executable = '/tmp/node'; }, 'executable-changed'],
    ['changed cwd', value => { value.cwd = '/private/other'; }, 'cwd-changed'],
    ['changed start identity', value => { value.start_identity += '-changed'; }, 'birth-identity-changed'],
  ]) {
    const candidate = { ...expected };
    const fresh = { ...observed };
    if (label === 'changed fresh command identity') mutation(fresh);
    else mutation(candidate);
    assert.ok(identityMismatches(fresh, candidate, 'darwin').includes(reason), label);
  }
  const missingFreshCommand = { ...observed };
  delete missingFreshCommand.command_line;
  assert.ok(identityMismatches(missingFreshCommand, expected, 'darwin').includes('command-identity-unavailable'));
});

test('setup failure marker bounds the PTerm wait without signalling its child', async () => {
  const root = tempRoot();
  let handler;
  let evidence;
  const child = new EventEmitter();
  child.pid = 321;
  child.kill = signal => { child.sent = signal; return true; };
  const socket = {
    addEventListener: (_name, callback) => { handler = callback; },
    send: () => setTimeout(() => {
      handler({ data: JSON.stringify({ type: 'stream', data: { raw: 'ASTRID_PINOKIO_FAIL' } }) });
      handler({ data: JSON.stringify({ type: 'stream', data: { raw: 'URE' } }) });
    }, 10),
  };
  const diagnostic = createInstallDiagnostics({ action: 'setup-install', slot_id: 'pinokio-backend-macos' }, value => { evidence = value; });
  let markerSnapshotCaptured = false;
  diagnostic.beforeFailureMarker = value => {
    markerSnapshotCaptured = value.pid === child.pid;
    diagnostic.stage('process-snapshot-before-failure-marker');
  };
  const started = Date.now();
  try {
    await assert.rejects(observeAction({
      io: { openSocket: async () => socket, disposeSocket: () => {}, status: async () => true },
      ptermRoot: root, home: root, endpoint: 'pinokio://test', appRoot: root,
      script: 'pinokio/install.js', action: 'setup-install', logRoot: root,
      timeoutMs: 10_000, diagnostic, spawnProcess: () => child,
    }), /installer failure marker/);
    assert.ok(Date.now() - started < 1000, 'marker did not stop the setup wait promptly');
    assert.equal(child.sent, undefined, 'marker handling must not signal an unverified process');
    assert.equal(evidence.last_error.kind, 'installer-failure-marker');
    assert.equal(evidence.timer.fired_at, null);
    assert.equal(markerSnapshotCaptured, true);
    assert.ok(evidence.stages.some(stage => stage.stage === 'process-snapshot-before-failure-marker'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup failure preserves the inner exit, sends no daemon TERM, and verifies owned descendants are gone', async () => {
  const root = tempRoot();
  const script = writeDaemonFixture(root);
  const childPidFile = path.join(root, 'child.pid');
  const termFile = path.join(root, 'term.log');
  const daemon = spawn(process.execPath, [script], {
    cwd: root, env: { ...process.env, CHILD_PID_FILE: childPidFile, TERM_FILE: termFile }, stdio: 'ignore',
  });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const inner = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(23), 200);'], { stdio: 'ignore' });
  let descendantPid = null;
  try {
    await waitForFile(childPidFile);
    descendantPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    const identity = captureOwnedDaemonIdentity(daemon, { cwd: root, runRoot: root, args: [script] });
    assert.equal(identity.available, true, JSON.stringify(identity));
    const innerExit = await ptermExit(inner, 'R-25 setup-install', 1000);
    assert.deepEqual(innerExit, { code: 23, signal: null });
    const started = process.hrtime.bigint();
    const cleanup = await cleanupOwnedDaemon(daemon, { identity, killMs: 250 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(cleanup.signal, 'SIGKILL');
    assert.deepEqual(cleanup.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(cleanup.status, 'verified');
    assert.equal(cleanup.cleanup_verified, true);
    assert.equal(cleanup.direct_signal_attempted, true);
    assert.deepEqual(cleanup.residuals, []);
    assert.deepEqual(cleanup.signal_failures, []);
    assert.equal(cleanup.initial_census.source, 'ps-user-process-table');
    assert.equal(cleanup.initial_census.available, true);
    assert.ok(cleanup.initial_census.processes.some(row => row.pid === daemon.pid));
    assert.ok(cleanup.initial_census.processes.some(row => row.pid === descendantPid));
    assert.equal(cleanup.final_census.available, true);
    assert.deepEqual(cleanup.final_census.processes, []);
    assert.ok(elapsedMs < 1000, `owned-daemon cleanup took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(fs.existsSync(termFile), false, 'daemon received an unsafe SIGTERM');
    assert.equal(isAlive(descendantPid), false, 'owned descendant was not cleaned');
    assert.equal(unrelated.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    for (const child of [daemon, unrelated, inner]) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (descendantPid && isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    await Promise.all([waitForClose(daemon), waitForClose(unrelated), waitForClose(inner)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup keeps uncertainty when a descendant is outside the private run root', async () => {
  const root = tempRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-mac-observability-outside-'));
  const script = writeDaemonFixture(root);
  const childPidFile = path.join(root, 'child.pid');
  const termFile = path.join(root, 'term.log');
  const daemon = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CHILD_PID_FILE: childPidFile, TERM_FILE: termFile, CHILD_CWD: outside },
    stdio: 'ignore',
  });
  let descendantPid = null;
  try {
    await waitForFile(childPidFile);
    descendantPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    const identity = captureOwnedDaemonIdentity(daemon, { cwd: root, runRoot: root, args: [script] });
    const cleanup = await cleanupOwnedDaemon(daemon, { identity, killMs: 250 });
    assert.equal(cleanup.status, 'failed');
    assert.equal(cleanup.cleanup_verified, false);
    assert.equal(cleanup.failure, 'descendant-census-unavailable');
    assert.equal(cleanup.direct_signal_attempted, false);
    assert.equal(cleanup.initial_census.available, false);
    assert.equal(isAlive(daemon.pid), true, 'daemon was signalled despite incomplete ownership proof');
    assert.equal(isAlive(descendantPid), true, 'unowned descendant was signalled');
    assert.match(cleanup.residuals[0].reason, /uid-or-cwd-outside-run-root/);
  } finally {
    for (const pid of [daemon.pid, descendantPid]) {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('cleanup fails closed and leaves the daemon untouched when identity changes', async () => {
  const root = tempRoot();
  const script = writeDaemonFixture(root);
  const childPidFile = path.join(root, 'child.pid');
  const termFile = path.join(root, 'term.log');
  const daemon = spawn(process.execPath, [script], {
    cwd: root, env: { ...process.env, CHILD_PID_FILE: childPidFile, TERM_FILE: termFile }, stdio: 'ignore',
  });
  let descendantPid = null;
  try {
    await waitForFile(childPidFile);
    descendantPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    const identity = captureOwnedDaemonIdentity(daemon, { cwd: root, runRoot: root, args: [script] });
    assert.equal(identity.available, true, JSON.stringify(identity));
    const changed = { ...identity, expected: { ...identity.expected, start_identity: 'not-the-captured-birth' } };
    const cleanup = await cleanupOwnedDaemon(daemon, { identity: changed, killMs: 100 });
    assert.equal(cleanup.failure, 'daemon-identity-mismatch');
    assert.equal(cleanup.direct_signal_attempted, false);
    assert.equal(cleanup.signal, null);
    assert.equal(isAlive(daemon.pid), true);
    assert.equal(fs.existsSync(termFile), false);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    if (descendantPid && isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded captures redact credentials and never exceed their byte limit', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'daemon.log');
    const capture = createBoundedCapture(file, 128);
    capture.append('Authorization: Bearer super-secret token=another-secret\n');
    capture.append('x'.repeat(1000));
    capture.close();
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length <= 128);
    assert.doesNotMatch(bytes.toString(), /super-secret|another-secret/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(capture.stats().truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('installer log capture keeps only a bounded redacted tail when present', () => {
  const root = tempRoot();
  try {
    const source = path.join(root, 'install.log');
    const destination = path.join(root, 'diagnostics', 'installer-output.log');
    fs.writeFileSync(source, `${crypto.randomBytes(8).toString('hex')}\npassword=private\n${'tail '.repeat(1000)}`);
    assert.equal(copyBoundedTail(source, destination, 256), 'captured');
    const output = fs.readFileSync(destination, 'utf8');
    assert.ok(Buffer.byteLength(output) <= 256);
    assert.doesNotMatch(output, /password=private/);
    assert.match(output, /tail/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('process snapshot is retained before cleanup with a bounded process tree', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'process-snapshot.json');
    assert.equal(captureProcessSnapshot(file, [process.pid]), 'captured');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(snapshot.schema, 'astrid.r25.process-snapshot.v1');
    assert.deepEqual(snapshot.roots, [process.pid]);
    assert.ok(snapshot.processes.some(row => row.pid === process.pid));
    assert.ok(snapshot.processes.length <= 128);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
