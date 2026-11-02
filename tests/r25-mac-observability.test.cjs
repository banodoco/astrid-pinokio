'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { createBoundedCapture, copyBoundedTail, captureProcessSnapshot } = require('../.github/venue/r25-snapshot-runner.cjs');
const { cleanupOwnedDaemon } = require('../.github/venue/r25-snapshot-runner.cjs');
const { ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r25-mac-observability-'));
}

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('close', resolve));
}

test('setup failure keeps its inner exit and cleans only the owned daemon within a bound', async () => {
  const daemon = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const inner = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(23), 20);'], { stdio: 'ignore' });
  try {
    const innerExit = await ptermExit(inner, 'R-25 setup-install', 1000);
    assert.deepEqual(innerExit, { code: 23, signal: null });
    const started = process.hrtime.bigint();
    const cleanup = await cleanupOwnedDaemon(daemon, { termMs: 50, killMs: 250 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(cleanup.signal, 'SIGKILL');
    assert.deepEqual(cleanup.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(cleanup.bounded, true);
    assert.ok(elapsedMs < 1000, `owned-daemon cleanup took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(unrelated.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    for (const child of [daemon, unrelated, inner]) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all([waitForClose(daemon), waitForClose(unrelated), waitForClose(inner)]);
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
