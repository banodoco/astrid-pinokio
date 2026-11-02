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
};

test('native binding names the immutable existing macOS/Windows source and build paths', () => {
  assert.equal(binding.SOURCE_REF, '47059b072889b489b2db20d3a3e86acf02e5a3d4');
  assert.equal(Object.keys(binding.sourceFiles).length, 7);
  assert.match(binding.profiles.macos.build, /xcrun --sdk macosx --show-sdk-path/);
  assert.match(binding.profiles.windows.build, /vcvars64\.bat/);
  for (const profile of Object.values(binding.profiles)) assert.match(profile.sha256, /^[a-f0-9]{64}$/);
});

test('dispatch expands the four native slots without promoting them to qualification', () => {
  const dispatch = binding.buildDispatch(tuple, {
    candidateRef: 'd6aa33bf125ffdabed9e397fb1aea319b8a9badb', targetOs: 'both', mode: 'both',
  });
  assert.deepEqual(dispatch.slots.map(slot => slot.id), [
    'pinokio-backend-macos', 'pinokio-fully-local-macos',
    'pinokio-backend-windows', 'pinokio-fully-local-windows',
  ]);
  assert.ok(dispatch.slots.every(slot => slot.execution === 'component-probe-only'));
  assert.ok(dispatch.slots.every(slot => slot.qualification === 'closed-until-r36-binding'));
  assert.equal(dispatch.r36.state, 'unbound');
  assert.equal(dispatch.r36.interface_sha256, binding.R30_INTERFACE_SHA256);
});

test('dispatch rejects mutable or alternate collector source refs', () => {
  assert.throws(() => binding.buildDispatch(tuple, { candidateRef: 'd6aa33bf125ffdabed9e397fb1aea319b8a9badb', sourceRef: 'lane/M-PIN/R-25-R2' }), /source_ref/);
  assert.throws(() => binding.buildDispatch(tuple, { candidateRef: 'lane/M-PIN/R-25-NATIVE-COLLECTORS-R1' }), /candidate_ref/);
});

test('source validation fails closed when the fixed executable inputs are absent or altered', () => {
  assert.throws(() => binding.validateSourceRoot(__dirname), /native collector source mismatch/);
});

test('all six M4-6 slot identities remain explicit, with Linux delegated independently', () => {
  assert.deepEqual(binding.slots.map(slot => slot.id), [
    'pinokio-backend-macos', 'pinokio-fully-local-macos',
    'pinokio-backend-linux', 'pinokio-fully-local-linux',
    'pinokio-backend-windows', 'pinokio-fully-local-windows',
  ]);
  assert.deepEqual(binding.slots.filter(slot => slot.os === 'linux').map(slot => slot.mode), ['backend', 'fully-local']);
});
