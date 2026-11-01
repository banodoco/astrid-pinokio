import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureActionSources, captureProcess } from '../pinokio/providers/linux-observations.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const launcher = fileURLToPath(new URL('../pinokio/', import.meta.url));
const names = ['start.js', 'stop.js', 'update.js', 'lib.js', 'lifecycle.mjs', 'session.mjs'];

test('captures exact fixed launcher source bytes without claiming evaluated action closure', async () => {
  const result = await captureActionSources(launcher);
  assert.deepEqual(result.files.map((file) => file.path), names);
  for (const file of result.files) {
    assert.deepEqual(file.bytes, await fs.readFile(path.join(launcher, file.path)));
    assert.equal(file.size, file.bytes.length);
    assert.equal(file.sha256, digest(file.bytes));
  }
  assert.ok(result.limitations.includes('dependency-closure-unobserved'));
});

test('missing, symlinked and oversized action sources fail closed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r24-sources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of names) await fs.writeFile(path.join(root, name), 'source');
  await fs.unlink(path.join(root, names[0]));
  await assert.rejects(captureActionSources(root));
  await fs.symlink(path.join(launcher, names[0]), path.join(root, names[0]));
  await assert.rejects(captureActionSources(root));
  await fs.unlink(path.join(root, names[0]));
  await fs.writeFile(path.join(root, names[0]), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(captureActionSources(root), /capture limit/);
});

test('captures a real Linux process birth and executable checkpoint', { skip: process.platform !== 'linux' }, async () => {
  const result = await captureProcess(process.pid);
  assert.equal(result.pid, process.pid);
  assert.equal(result.bootId, (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
  assert.match(result.startTimeTicks, /^\d+$/);
  assert.equal(result.executablePath, await fs.readlink(`/proc/${process.pid}/exe`));
  assert.equal(result.executableSha256, digest(await fs.readFile(`/proc/${process.pid}/exe`)));
  assert.match(result.raw.status.toString(), new RegExp(`^Pid:\\s+${process.pid}$`, 'm'));
  assert.ok(result.limitations.includes('checkpoint-only'));
  await assert.rejects(captureProcess(0), /invalid pid/);
  await assert.rejects(captureProcess(2147483647));
});
