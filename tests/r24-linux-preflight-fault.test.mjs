import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightStop } from '../pinokio/lifecycle.mjs';
import library from '../pinokio/lib.js';
import { installPreflightOutputFault, withPreflightOutputFault } from '../pinokio/providers/linux-preflight-fault.mjs';

function fixture(t, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-fault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const python = path.join(dir, 'python');
  // A local executable fixture, not an installed Runtime or busy task.
  fs.writeFileSync(python, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  return { python, data: dir, env: process.env };
}

test('drops a real preflight child response and restores the exact runner', async t => {
  const installed = fixture(t, "process.stdout.write(JSON.stringify({safe:true}))");
  const prior = async () => 'original';
  const slot = { run: prior };
  const seam = installPreflightOutputFault(slot);
  const injected = slot.run;
  await assert.rejects(preflightStop(installed, { run: injected }), /response unavailable/);
  const finalizing = seam.finalize();
  await assert.rejects(preflightStop(installed, { run: slot.run }), /closed/);
  assert.deepEqual(await finalizing, { state: 'unknown', issues: [] });
  assert.equal(slot.run, prior);
  await assert.rejects(preflightStop(installed, { run: injected }), /closed/);
  assert.equal(await slot.run(), 'original');
});

test('finalization cancels and reaps the exact child and blocks a late result', async t => {
  const installed = fixture(t, 'setTimeout(() => console.log("late safe"), 2000)');
  const slot = { run: async () => 'original' };
  const seam = installPreflightOutputFault(slot);
  const injected = slot.run;
  const rejected = assert.rejects(preflightStop(installed, { run: injected }), /response unavailable/);
  assert.deepEqual(await seam.finalize(), { state: 'unknown', issues: [] });
  await rejected;
  await assert.rejects(preflightStop(installed, { run: injected }), /closed/);
});

test('tampering prevents restoration from being declared successful', async () => {
  const prior = async () => {};
  const replacement = async () => {};
  const slot = { run: prior };
  const seam = installPreflightOutputFault(slot);
  slot.run = replacement;
  const result = await seam.finalize();
  assert.equal(result.state, 'fail');
  assert.deepEqual(result.issues, ['seam-identity-changed', 'runner-not-restored']);
  assert.equal(slot.run, replacement);
  assert.deepEqual(await seam.finalize(), result);
});

test('rejects unsafe slots, unrelated commands and reuse', async t => {
  assert.throws(() => installPreflightOutputFault({}), /writable/);
  const slot = { run: async () => {} };
  const seam = installPreflightOutputFault(slot);
  await assert.rejects(slot.run({ command: process.execPath, args: ['-e', ''] }, {}), /not dispatched/);
  await assert.rejects(preflightStop(fixture(t, ''), { run: slot.run }), /closed/);
  assert.equal((await seam.finalize()).state, 'unknown');
});

test('Pinokio stop propagates an unreadable preflight before controller or native stop', async t => {
  const installed = fixture(t, "process.stdout.write(JSON.stringify({safe:true}))");
  const sentinel = path.join(installed.data, 'protected');
  fs.writeFileSync(sentinel, 'unchanged');
  const original = async () => 'original';
  const slot = { run: original };
  const calls = [];
  const app = library.createApp({ platform: 'linux', appDirectory: installed.data, lifecycle: {
    preflightStop: () => preflightStop(installed, { run: slot.run }),
    requestGracefulStop: async () => calls.push('controller'),
    waitForInstallerLock: async () => calls.push('lock'),
  } });
  const uri = path.join(installed.data, 'pinokio', 'start.js');
  const kernel = { api: { running: { [uri]: true }, stop: async () => calls.push('native-stop') } };
  await assert.rejects(withPreflightOutputFault(slot, () => app.stopOwnedStart({}, undefined, kernel)), /response unavailable/);
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(slot.run, original);
});

test('scoped finalizer runs on success or failure and cleanup failure overrides refusal', async () => {
  const original = async () => {};
  const slot = { run: original };
  await assert.rejects(withPreflightOutputFault(slot, async () => {}), /did not refuse/);
  assert.equal(slot.run, original);
  await assert.rejects(withPreflightOutputFault(slot, async () => {
    slot.run = async () => {};
    throw new Error('product refused');
  }), /finalization failed.*session invalid/);
});
