'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBoundedCapture, copyBoundedTail, captureProcessSnapshot } = require('../.github/venue/r25-snapshot-runner.cjs');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r25-mac-observability-'));
}

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
