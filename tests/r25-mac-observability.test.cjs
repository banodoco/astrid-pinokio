'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  createBoundedCapture, copyBoundedTail, captureProcessSnapshot,
  captureOwnedDaemonIdentity, cleanupOwnedDaemon,
} = require('../.github/venue/r25-snapshot-runner.cjs');
const { ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');

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
