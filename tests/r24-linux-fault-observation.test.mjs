import { test } from 'node:test';
import assert from 'node:assert/strict';
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
});

test('a missing refusal is a local contradiction while the provider result stays unknown', { skip: process.platform !== 'linux' }, async () => {
  const slot = { run: async () => {} };
  const result = await observePreflightOutputFault(slot, async () => {});

  assert.equal(result.state, 'unknown');
  assert.equal(result.observed, 'fail');
  assert.equal(result.observations.find(({ kind }) => kind === 'fault-observed').result, 'fail');
  assert.equal(result.finalization.state, 'unknown');
  assert.deepEqual(result.observations.at(-1).issues, []);
});

test('the Linux facade exposes the bounded fault observer and keeps it closed', () => {
  const provider = createLinuxProviderSurface();
  assert.equal(provider.fault.observePreflightOutputFault, observePreflightOutputFault);
  assert.equal(provider.fault.state, 'unknown');
  assert.equal(provider.fault.qualification, 'closed');
  assert.deepEqual(provider.fault.externalAwait, FAULT_EXTERNAL_AWAIT);
});
