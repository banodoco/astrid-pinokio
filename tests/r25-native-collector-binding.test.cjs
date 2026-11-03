'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const binding = require('../pinokio/providers/r25-native-collector-binding.cjs');

const tuple = {
  app: '79f7e5397c044c4c97dc7e97b20ad96f787e5247',
  agent: 'ab43bad818ef65ca1e929b973a2f61cd9fc4bf61',
  runtime: '2776ba973b6c8f3555b5629b0840d9691a98d3c2',
  pinokio: '3a6a98ae251ca126505245286e2d3e760f4348e9',
  manifest_sha256: 'b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f',
  artifacts: {
    'public/install': '100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d',
    'public/install.sh': '591c4c51b148fccef2a7d1c45782d9ff949d5fd03d46cd82b5591e3a23d1b285',
    'public/install.ps1': 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258',
  },
  published_at: '2026-11-02T17:55:27Z',
};
const candidateRef = 'a'.repeat(40);

function origin(slot, artifactId = null) {
  return {
    repository_id: 101,
    repository_full_name: 'banodoco/astrid-pinokio',
    workflow_id: 202,
    workflow_ref: 'banodoco/astrid-pinokio/.github/workflows/r25.yml@refs/heads/lane',
    workflow_sha: candidateRef,
    run_id: 303,
    run_attempt: 1,
    head_sha: candidateRef,
    producer_job_id: 404,
    producer_job_name: slot,
    artifact_id: artifactId,
    artifact_name: `r25-snapshots-${slot}-303-1`,
  };
}

function actions() {
  return binding.REQUIRED_ACTIONS.map((action, index) => ({
    action,
    action_id: `m46-${action}-303-1`,
    action_sha256: (index + 1).toString(16).repeat(64),
  }));
}

test('builds exact run/action/source-bound requests for macOS and Windows slots', () => {
  const macSlot = 'pinokio-backend-macos';
  const mac = binding.buildRequest(tuple, {
    slotId: macSlot, candidateRef, origin: origin(macSlot), actions: actions(),
    targets: { os: 'macos', launchd_targets: ['gui/501/haus.astrid.runtime'] },
  });
  assert.equal(mac.schema, binding.SCHEMA);
  assert.equal(mac.collector.agent_ref, binding.AGENT_SOURCE_REF);
  assert.equal(mac.collector.pinokio_ref, candidateRef);
  assert.deepEqual(Object.keys(mac.collector.sources).sort(), Object.keys(binding.flattenedSources).sort());
  assert.equal(mac.origin.artifact_id, null);
  assert.match(binding.requestSha256(mac), /^[0-9a-f]{64}$/);

  const windowsSlot = 'pinokio-fully-local-windows';
  const win = binding.buildRequest(tuple, {
    slotId: windowsSlot, candidateRef, origin: origin(windowsSlot, 505), actions: actions(),
    targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
  });
  assert.equal(win.origin.artifact_id, 505);
  assert.deepEqual(win.actions.map(row => row.action), binding.REQUIRED_ACTIONS);
});

test('declares exactly four snapshot slots and reviewed platform profiles', () => {
  assert.deepEqual(binding.slots.map(slot => slot.id), [
    'pinokio-backend-macos', 'pinokio-fully-local-macos',
    'pinokio-backend-windows', 'pinokio-fully-local-windows',
  ]);
  assert.equal(binding.profiles.macos.platform, 'macos-15');
  assert.equal(binding.profiles.windows.runner, 'windows-2022');
  assert.deepEqual(binding.selectedSlots('both', 'backend').map(slot => slot.id), [
    'pinokio-backend-macos', 'pinokio-backend-windows',
  ]);
});

test('fails closed on wrong source ref, action order, tuple shape, and target duplication', () => {
  const slot = 'pinokio-backend-windows';
  const options = {
    slotId: slot, candidateRef, origin: origin(slot), actions: actions(),
    targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
  };
  assert.throws(() => binding.buildRequest(tuple, { ...options, agentRef: 'b'.repeat(40) }), /agent_ref/);
  const wrongActions = actions();
  [wrongActions[0], wrongActions[1]] = [wrongActions[1], wrongActions[0]];
  assert.throws(() => binding.buildRequest(tuple, { ...options, actions: wrongActions }), /out of order/);
  assert.throws(() => binding.buildRequest({ ...tuple, artifacts: {} }, options), /tuple.artifacts fields/);
  assert.throws(() => binding.buildRequest(tuple, {
    ...options,
    targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime', '\\astrid runtime'], service_names: [] },
  }), /duplicate target/);
});

test('requires exact origin and artifact binding without claiming qualification', () => {
  const slot = 'pinokio-fully-local-macos';
  const options = {
    slotId: slot, candidateRef, actions: actions(),
    targets: { os: 'macos', launchd_targets: [] },
  };
  assert.throws(() => binding.buildRequest(tuple, {
    ...options, origin: { ...origin(slot), artifact_name: 'unbound' },
  }), /not bound to the slot/);
  assert.equal(binding.R36_REF, '010e8f25c70109f0a93a6fccb0a16f7f40e06739');
  assert.throws(() => binding.validateSourceRoots({
    agentRoot: __dirname, pinokioRoot: __dirname,
  }), /collector source mismatch/);
});
