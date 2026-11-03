import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { captureLockRefusal } from './smoke/lock-refusal-diagnostics.mjs';

const linux = process.platform === 'linux';

test('Linux lock refusal capture records a present disposable flock holder', { skip: !linux }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pinokio-lock-diag-'));
  const lockPath = path.join(scratch, 'astrid-install.lock');
  const child = spawn('python3', ['-c', [
    'import fcntl,sys,time',
    'handle=open(sys.argv[1], "a+")',
    'fcntl.flock(handle, fcntl.LOCK_EX)',
    'print("ready", flush=True)',
    'time.sleep(30)',
  ].join(';'), lockPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture holder did not become ready')), 5000);
      child.stdout.on('data', () => {
        if (output.includes('ready\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    await ready;
    const record = captureLockRefusal({ lockPath });
    assert.equal(record.inode, String(fs.statSync(lockPath).ino));
    assert.equal(record.holder_pid, child.pid);
    assert.equal(record.holders[0].pid, child.pid);
    assert.equal(record.holders[0].fd_link, 'matched-lock-inode');
    assert.equal(record.holders[0].comm, 'python3');
    assert.equal(record.limitations.length, 0);
    assert.equal(JSON.stringify(record).includes(scratch), false, 'diagnostic must redact disposable absolute paths');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await once(child, 'close').catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('Linux lock refusal capture reports explicit unknowns when lock data is unavailable', { skip: !linux }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pinokio-lock-diag-'));
  try {
    const record = captureLockRefusal({
      lockPath: path.join(scratch, 'missing.lock'),
      procRoot: path.join(scratch, 'missing-proc'),
    });
    assert.equal(record.device, 'unknown');
    assert.equal(record.inode, 'unknown');
    assert.equal(record.holder_pid, 'unknown');
    assert.deepEqual(record.holders, []);
    assert.deepEqual(record.limitations, ['lock-path-not-present-at-capture']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
