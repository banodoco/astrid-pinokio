import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { trackDisposableChild, terminateDisposableChild, boundOwnedOperation } from './smoke/owned-process.mjs';

test('unknown ownership refuses termination without signalling the unrelated process', async () => {
  let signals = 0;
  await assert.rejects(terminateDisposableChild({ pid: process.pid, kill() { signals += 1; } }), /unknown task ownership/);
  assert.equal(signals, 0);
});

test('bounded timeout terminates only a verified spawned task child and permits later work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepgoing-child-'));
  let child;
  try {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    trackDisposableChild(child, { cwd: root, root });
    let cleanup;
    const never = new Promise(() => {});
    await assert.rejects(boundOwnedOperation(child, never, 100, value => { cleanup = value; }), /owned-child timeout/);
    assert.equal(cleanup.exited, true);
    assert.equal(cleanup.scope, 'spawned-child-handle-only');
    assert.match(cleanup.descendants, /no tree termination/);
    const later = path.join(root, 'subsequent-stage');
    fs.writeFileSync(later, 'reached');
    assert.equal(fs.readFileSync(later, 'utf8'), 'reached');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('a child exiting zero during forced timeout cannot convert the timeout to success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepgoing-zero-exit-'));
  try {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)"],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    trackDisposableChild(child, { cwd: root, root });
    await new Promise(resolve => child.stdout.once('data', resolve));
    const operation = new Promise(resolve => child.once('exit', code => resolve({ code })));
    await assert.rejects(boundOwnedOperation(child, operation, 100), /owned-child timeout/);
    assert.notEqual(child.exitCode, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
