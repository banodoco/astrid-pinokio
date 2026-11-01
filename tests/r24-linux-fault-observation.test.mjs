import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FAULT_EXTERNAL_AWAIT, observePreflightOutputFault } from '../pinokio/providers/linux-preflight-fault.mjs';
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

test('the Linux facade exposes the bounded fault observer and keeps it closed', () => {
  const provider = createLinuxProviderSurface();
  assert.equal(provider.fault.observePreflightOutputFault, observePreflightOutputFault);
  assert.equal(provider.fault.state, 'unknown');
  assert.equal(provider.fault.qualification, 'closed');
  assert.deepEqual(provider.fault.externalAwait, FAULT_EXTERNAL_AWAIT);
});
