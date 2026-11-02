'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const binding = require('../pinokio/providers/r25-native-collector-binding.cjs');

const specimenPath = path.join(__dirname, 'fixtures', 'r25-snapshot-specimen-v1.json');
const specimen = JSON.parse(fs.readFileSync(specimenPath, 'utf8'));

test('ships a versioned synthetic specimen, never execution evidence', () => {
  assert.equal(specimen.schema, 'astrid.r25.pinokio-snapshot-specimen.v1');
  assert.equal(specimen.specimen_version, 1);
  assert.equal(specimen.synthetic, true);
  assert.equal(specimen.execution_evidence, false);
  assert.equal(specimen.qualification, false);
  assert.equal(specimen.m4_6_acceptance, false);
  assert.equal(specimen.request.origin.artifact_id, null);
  assert.match(specimen.request.origin.repository_full_name, /^synthetic\//);
  assert.equal(specimen.request.origin.workflow_sha, '0'.repeat(40));
  assert.equal(specimen.request.origin.head_sha, '0'.repeat(40));
});

test('synthetic request has the exact producer tuple, source and action binding', () => {
  const request = binding.validateRequest(specimen.request);
  assert.deepEqual(request.tuple, {
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
  });
  assert.equal(request.collector.agent_ref, specimen.inputs.agent_ref);
  assert.equal(request.collector.pinokio_ref, specimen.inputs.pinokio_ref);
  assert.deepEqual(Object.keys(request.collector.sources).sort(), Object.keys(binding.flattenedSources).sort());
  assert.deepEqual(request.actions.map((row) => row.action), binding.REQUIRED_ACTIONS);
});

test('documents the before/during/boundary poll and finalization contract', () => {
  const contract = specimen.observation_contract;
  assert.deepEqual(contract.ordered_phases, ['before', 'during', 'boundary']);
  assert.equal(contract.boundary_alias, 'after-action final snapshot');
  assert.equal(contract.minimum_observation_files, 18);
  assert.equal(contract.per_action.bounded_poll.max_poll_samples, 900);
  assert.equal(contract.finalization.receipt_schema, 'astrid.r25.pinokio-snapshot-receipt.v1');
  assert.equal(contract.finalization.closed_world, true);
  assert.equal(contract.finalization.m4_6_acceptance, false);
  assert.ok(specimen.required_authenticated_joins.length >= 8);
  assert.ok(specimen.missing_for_qualification.length >= 5);
});
