import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import library from '../pinokio/lib.js';
import { FAULT_EXTERNAL_AWAIT, observePreflightBusyRefusal, observePreflightOutputFault } from '../pinokio/providers/linux-preflight-fault.mjs';
import { createLinuxProviderSurface } from '../pinokio/providers/linux-provider.mjs';

test('fault observation records the R-23 lifecycle without claiming qualification', { skip: process.platform !== 'linux' }, async () => {
  const slot = { run: async () => {} };
  const result = await observePreflightOutputFault(slot, async () => {
    // The callback's rejection is intentionally ambiguous until R-36 binds
    // the Runtime/controller and parser profiles.
    throw new Error('unavailable preflight response');
  });

  assert.equal(result.state, 'unknown');
  assert.equal(result.qualification, 'closed');
  assert.deepEqual(result.externalAwait, [...FAULT_EXTERNAL_AWAIT]);
  assert.deepEqual(result.observations.map(({ kind, result: state }) => [kind, state]), [
    ['fault-before', 'unknown'],
    ['fault-installed', 'unknown'],
    ['fault-observed', 'unknown'],
    ['fault-after', 'unknown'],
  ]);
  assert.equal(result.finalization.state, 'unknown');
  assert.equal(slot.run.constructor.name, 'AsyncFunction');
  assert.deepEqual(result.observations.map(({ id, kind, file, sha256, sequence }, index) => ({
    id, kind, file, sha256, sequence,
  })), [
    'fault-before', 'fault-installed', 'fault-observed', 'fault-after',
  ].map((kind, index) => ({
    id: `obs-${String(index + 1).padStart(6, '0')}`,
    kind,
    file: `fault/obs-${String(index + 1).padStart(6, '0')}.json`,
    sha256: result.observations[index].sha256,
    sequence: index + 1,
  })));
  assert.deepEqual(result.files.map(({ path, role, sha256, size }) => ({ path, role, sha256, size })),
    result.observations.map(({ file, kind, sha256, bytes }) => ({ path: file, role: kind, sha256, size: bytes.length })));
  for (const observation of result.observations) {
    assert.equal(observation.sha256, createHash('sha256').update(observation.bytes).digest('hex'));
    const payload = JSON.parse(observation.bytes.toString('utf8'));
    assert.equal(payload.sourceSequence, observation.sequence);
    assert.equal(payload.identity, 'unauthenticated');
    assert.equal(payload.sourceProfileSha256, null);
    assert.ok(payload.limitations.includes('not-an-r30-export-or-qualification-receipt'));
  }
});

test('a missing refusal is a local contradiction and producer failure', { skip: process.platform !== 'linux' }, async () => {
  const slot = { run: async () => {} };
  const result = await observePreflightOutputFault(slot, async () => {});

  assert.equal(result.state, 'fail');
  assert.equal(result.observed, 'fail');
  assert.equal(result.observations.find(({ kind }) => kind === 'fault-observed').result, 'fail');
  assert.equal(result.finalization.state, 'unknown');
  assert.deepEqual(result.observations.at(-1).issues, []);
});

test('a failed seam restoration is a producer failure without becoming a qualification result', { skip: process.platform !== 'linux' }, async () => {
  const original = async () => {};
  const slot = { run: original };
  const result = await observePreflightOutputFault(slot, async () => {
    slot.run = async () => {};
    throw new Error('local refusal');
  }, { sequence: 77 });

  assert.equal(result.state, 'fail');
  assert.equal(result.qualification, 'closed');
  assert.equal(result.observed, 'unknown');
  assert.equal(result.finalization.state, 'fail');
  assert.deepEqual(result.finalization.issues, ['seam-identity-changed', 'runner-not-restored']);
  assert.equal(result.observations.at(-1).result, 'fail');
  assert.deepEqual(result.observations.map(({ sequence }) => sequence), [77, 78, 79, 80]);
});

test('busy probe retains only a bounded structured refusal and never installs a synthetic busy seam', async () => {
  const appDirectory = '/tmp/r24-busy-observation';
  const calls = [];
  const app = library.createApp({ platform: 'linux', appDirectory, lifecycle: {
    preflightStop: async () => {
    const error = new Error('do not retain caller-controlled busy text');
    error.details = { task_count: 1, blockers: [{ task_id: 'task-7', kind: 'render', state: 'running' }], secret: 'omit' };
    throw error;
    },
    requestGracefulStop: async () => calls.push('controller'),
    waitForInstallerLock: async () => calls.push('lock'),
  } });
  const kernel = { api: { running: { [path.join(appDirectory, 'pinokio', 'start.js')]: true },
    stop: async () => calls.push('native-stop') } };
  const result = await observePreflightBusyRefusal(() => app.stopOwnedStart({}, undefined, kernel), { sequence: 9 });
  assert.equal(result.state, 'unknown');
  assert.equal(result.qualification, 'closed');
  assert.equal(result.observed, 'busy-refusal');
  assert.deepEqual(result.observations.map(({ kind, result: state }) => [kind, state]), [
    ['fault-before', 'unknown'], ['fault-installed', 'not-run'], ['fault-observed', 'unknown'], ['fault-after', 'unknown'],
  ]);
  const observed = JSON.parse(result.observations[2].bytes.toString('utf8'));
  assert.deepEqual(observed.busy, { taskCount: 1, blockers: [{ taskId: 'task-7', kind: 'render', state: 'running' }] });
  assert.ok(!result.observations.some(({ bytes }) => bytes.toString('utf8').includes('caller-controlled')));
  assert.ok(!result.observations.some(({ bytes }) => bytes.toString('utf8').includes('secret')));
  assert.deepEqual(result.observations.map(({ sequence }) => sequence), [9, 10, 11, 12]);
  assert.deepEqual(calls, []);
});

test('busy probe fails a completed action and does not promote an unclassified refusal', async () => {
  const completed = await observePreflightBusyRefusal(async () => {});
  assert.equal(completed.state, 'fail');
  assert.equal(completed.observed, 'fail');
  const unclassified = await observePreflightBusyRefusal(async () => { throw new Error('untrusted text'); });
  assert.equal(unclassified.state, 'unknown');
  assert.equal(unclassified.observed, 'unknown');
  assert.ok(!unclassified.observations.some(({ bytes }) => bytes.toString('utf8').includes('untrusted text')));
});

test('the Linux facade exposes the bounded fault observer and keeps it closed', () => {
  const provider = createLinuxProviderSurface();
  assert.equal(provider.fault.observePreflightOutputFault, observePreflightOutputFault);
  assert.equal(provider.fault.observePreflightBusyRefusal, observePreflightBusyRefusal);
  assert.equal(provider.fault.state, 'unknown');
  assert.equal(provider.fault.qualification, 'closed');
  assert.deepEqual(provider.fault.externalAwait, FAULT_EXTERNAL_AWAIT);
});
