import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeLinuxReset } from '../pinokio/providers/linux-action-settlement.mjs';
import { captureLinuxCustodyCheckpoint, openLinuxCustodyCheckpointSession } from '../pinokio/providers/linux-custody-observations.mjs';
import { installPreflightOutputFault, observePreflightBusyRefusal, withPreflightOutputFault } from '../pinokio/providers/linux-preflight-fault.mjs';
import { INTERFACE_SHA256, createLinuxProviderSurface } from '../pinokio/providers/linux-provider.mjs';

test('Linux provider exposes the bounded producers without promoting their outputs to authority', () => {
  const provider = createLinuxProviderSurface();
  assert.equal(provider.platform, 'linux');
  assert.equal(provider.interface, 'astrid-qualification/v1');
  assert.equal(provider.interfaceSha256, INTERFACE_SHA256);
  assert.equal(provider.state, 'unbound');
  assert.equal(provider.qualification, 'closed');
  assert.equal(provider.settlement.state, 'unknown');
  assert.equal(provider.settlement.observeReset, observeLinuxReset);
  assert.equal(provider.fault.installPreflightOutputFault, installPreflightOutputFault);
  assert.equal(provider.fault.observePreflightBusyRefusal, observePreflightBusyRefusal);
  assert.equal(provider.fault.withPreflightOutputFault, withPreflightOutputFault);
  assert.equal(provider.custody.captureCheckpoint, captureLinuxCustodyCheckpoint);
  assert.equal(provider.custody.openCheckpointSession, openLinuxCustodyCheckpointSession);
  assert.equal(provider.realEngine.state, 'not-run');
  assert.equal(provider.realEngine.qualification, 'closed');
  assert.deepEqual(provider.realEngine.externalAwait.map((entry) => entry.id), ['R-06', 'R-15', 'R-36']);
  assert.equal(provider.realEngine.fault.installPreflightOutputFault, installPreflightOutputFault);
  assert.equal(provider.realEngine.fault.observePreflightBusyRefusal, observePreflightBusyRefusal);
  assert.equal(provider.realEngine.fault.withPreflightOutputFault, withPreflightOutputFault);
  assert.equal(provider.realEngine.fault.state, 'not-run');
  assert.throws(() => provider.requireTrustedQualification(), /R-36 trusted collector\/verifier/);
  assert.ok(Object.isFrozen(provider));
  assert.ok(Object.isFrozen(provider.settlement));
  assert.ok(Object.isFrozen(provider.fault));
  assert.ok(Object.isFrozen(provider.custody));
});

test('M4 harness plans name external awaits and reject noncanonical harness identifiers', () => {
  const provider = createLinuxProviderSurface();
  const firstClick = provider.prepareM4Harness('M4-4a');
  assert.deepEqual(firstClick.await.map((entry) => entry.id), ['R-21', 'R-36']);
  const local = provider.prepareM4Harness('M4-4b');
  assert.deepEqual(local.await.map((entry) => entry.id), ['R-21', 'R-36']);
  const update = provider.prepareM4Harness('M4-5');
  assert.deepEqual(update.await.map((entry) => entry.id), ['R-06', 'R-15', 'R-21', 'R-36']);
  for (const harness of [firstClick, local, update]) {
    assert.equal(harness.kind, 'pinokio-linux-m4-harness');
    assert.equal(harness.state, 'not-run');
    assert.equal(harness.qualification, 'closed');
    assert.deepEqual(harness.externalAwait, harness.await);
    assert.deepEqual(harness.producers, {
      settlement: 'diagnostic-only', preflightFault: 'diagnostic-only', custody: 'diagnostic-only',
    });
    assert.ok(Object.isFrozen(harness));
  }
  assert.equal(update.externalAwait[0].receipt, 'approved stand-in R2 identity and Pinokio-path receipt');
  assert.equal(update.externalAwait[1].receipt, 'approved same-operation recovery receipt');
  assert.equal(update.externalAwait[3].receipt, 'trusted collector and verifier receipt');
  assert.throws(() => provider.prepareM4Harness('m4-4a'), /unknown Linux M4 harness/);
  assert.throws(() => provider.prepareM4Harness({}), /unknown Linux M4 harness/);
});
