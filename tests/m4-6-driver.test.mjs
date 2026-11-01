import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  EXPECTED_SLOTS,
  PACKET_FILES,
  RC0_TUPLE,
  SCENARIO_GROUPS,
  STOP_OUTCOMES,
  loadPacket,
  runSlot,
  sha256,
  stableJson,
  writeReceipt,
} from '../.github/venue/m4-6-driver.mjs';

const roots = [];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const temporary = (prefix) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};
after(() => roots.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function canonicalConfig() {
  return {
    schema_version: 'r25-executor-config.v1',
    packet_id: 'R-25-EXECUTOR-CONFIG-RC-0-M4-6',
    immutable_rc0_tuple: { ...RC0_TUPLE },
    required_scenario_groups: [...SCENARIO_GROUPS],
    required_stop_safety_outcomes: [...STOP_OUTCOMES],
    records: EXPECTED_SLOTS.map((slot) => ({
      ...slot,
      venue: 'M-VENUE',
      immutable_pinokio_sha: RC0_TUPLE.pinokio,
      rc0_tuple: { ...RC0_TUPLE },
      required_scenario_groups: [...SCENARIO_GROUPS],
      required_stop_safety_outcomes: [...STOP_OUTCOMES],
    })),
  };
}

function writePacket(directory, config = canonicalConfig()) {
  const contents = {
    'RC-0-EXECUTOR-CONFIGS.json': `${JSON.stringify(config, null, 2)}\n`,
    'SLOT-MAPPING.md': '# synthetic mapping\n',
    'R-21-R7-DISPATCH.md': '# synthetic dispatch\n',
    'REPORT.md': '# synthetic report\n',
  };
  for (const [name, value] of Object.entries(contents)) fs.writeFileSync(path.join(directory, name), value);
  const checksumNames = ['RC-0-EXECUTOR-CONFIGS.json', 'SLOT-MAPPING.md', 'R-21-R7-DISPATCH.md', 'REPORT.md'];
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), checksumNames.map((name) => `${digest(contents[name])}  ${name}`).join('\n') + '\n');
  return Object.fromEntries([...Object.keys(contents), 'SHA256SUMS'].map((name) => [name, digest(fs.readFileSync(path.join(directory, name)))]));
}

function loadedPacket() {
  const directory = temporary('r25-m4-6-packet-');
  return loadPacket(directory, writePacket(directory));
}

function cleanCheckouts(productPath = '/immutable/product') {
  return {
    driver: { head: 'a'.repeat(40), clean: true },
    product: { head: RC0_TUPLE.pinokio, clean: true, path: productPath },
  };
}

function completeBinding(root, slot) {
  const installed = path.join(root, 'installed-product.bin');
  fs.writeFileSync(installed, 'bound installed product\n');
  const provider = path.join(root, 'provider.mjs');
  fs.writeFileSync(provider, `
import fs from 'node:fs';
import path from 'node:path';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  fs.mkdirSync(request.evidence_directory, { recursive: true });
  fs.writeFileSync(path.join(request.evidence_directory, 'observation.json'), JSON.stringify({ scenario: request.scenario_group }) + '\\n');
  const result = {
    schema_version: 'r25-m4-6-provider-result.v1',
    scenario_group: request.scenario_group,
    state: 'pass',
    artifacts: ['observation.json'],
  };
  if (request.scenario_group === 'stop_safety') result.stop_safety = { refused: 'pass', unknown: 'pass' };
  process.stdout.write(JSON.stringify(result));
});
`);
  return {
    schema_version: 'r25-m4-6-execution-binding.v1',
    slot_id: slot.slot_id,
    tuple: { ...RC0_TUPLE },
    provider: { id: 'test-r24-provider', sha256: '1'.repeat(64), command: [process.execPath, provider] },
    fixture_profile: { id: 'test-fixture-profile', sha256: '2'.repeat(64) },
    installed_product: { id: 'test-installed-product', path: path.basename(installed), sha256: digest(fs.readFileSync(installed)) },
    r36: {
      collector: { id: 'test-r36-collector', sha256: '3'.repeat(64) },
      verifier: { id: 'test-r36-verifier', sha256: '4'.repeat(64) },
    },
    real_engine: { kind: 'pinokio-real-engine', kernel: 'pinokio-daemon', fake_kernel: false, mode: slot.mode },
  };
}

test('canonical packet has exactly the six D9 slots, both modes, all groups, and both stop outcomes', () => {
  const packet = loadedPacket();
  assert.equal(packet.config.records.length, 6);
  assert.deepEqual(new Set(packet.config.records.map((record) => record.mode)), new Set(['backend', 'fully-local']));
  assert.deepEqual(new Set(packet.config.records.map((record) => record.slot_id)), new Set(EXPECTED_SLOTS.map((slot) => slot.slot_id)));
  for (const record of packet.config.records) {
    assert.deepEqual(record.rc0_tuple, RC0_TUPLE);
    assert.deepEqual(record.required_scenario_groups, SCENARIO_GROUPS);
    assert.deepEqual(record.required_stop_safety_outcomes, STOP_OUTCOMES);
  }
});

test('wrong tuple and malformed duplicate-key packets are rejected before a slot is selected', () => {
  const wrongTupleDirectory = temporary('r25-m4-6-wrong-tuple-');
  const wrongTuple = canonicalConfig();
  wrongTuple.records[0].rc0_tuple.agent = '0'.repeat(40);
  assert.throws(() => loadPacket(wrongTupleDirectory, writePacket(wrongTupleDirectory, wrongTuple)), /immutable RC-0 tuple/);

  const duplicateDirectory = temporary('r25-m4-6-duplicate-');
  const hashes = writePacket(duplicateDirectory);
  const duplicate = '{"schema_version":"r25-executor-config.v1","schema_version":"r25-executor-config.v1"}';
  fs.writeFileSync(path.join(duplicateDirectory, 'RC-0-EXECUTOR-CONFIGS.json'), duplicate);
  hashes['RC-0-EXECUTOR-CONFIGS.json'] = digest(duplicate);
  const sums = fs.readFileSync(path.join(duplicateDirectory, 'SHA256SUMS'), 'utf8').replace(/^[a-f0-9]{64}(?=  RC-0-EXECUTOR-CONFIGS\.json)/m, hashes['RC-0-EXECUTOR-CONFIGS.json']);
  fs.writeFileSync(path.join(duplicateDirectory, 'SHA256SUMS'), sums);
  hashes.SHA256SUMS = digest(sums);
  assert.throws(() => loadPacket(duplicateDirectory, hashes), /duplicate key/);
});

test('every slot emits an explicit unknown AWAITING_BINDINGS receipt when authority is absent', async () => {
  const packet = loadedPacket();
  for (const slot of packet.config.records) {
    const receipt = await runSlot({
      packet,
      slotId: slot.slot_id,
      outputDirectory: temporary(`r25-m4-6-${slot.slot_id}-`),
      checkouts: cleanCheckouts(),
      actualPlatform: slot.os,
    });
    assert.equal(receipt.disposition, 'AWAITING_BINDINGS');
    assert.equal(receipt.qualification, 'NOT_QUALIFIED');
    assert.deepEqual(receipt.bindings.r24_provider, 'missing');
    for (const group of SCENARIO_GROUPS) assert.equal(receipt.scenarios[group].state, 'unknown');
    assert.deepEqual(receipt.scenarios.stop_safety.outcomes, { refused: 'unknown', unknown: 'unknown' });
  }
});

test('wrong binding tuple refuses execution and does not mint a passing receipt', async () => {
  const packet = loadedPacket();
  const slot = packet.config.records[0];
  const root = temporary('r25-m4-6-wrong-binding-');
  const binding = completeBinding(root, slot);
  binding.tuple.runtime = '0'.repeat(40);
  const receipt = await runSlot({
    packet,
    slotId: slot.slot_id,
    outputDirectory: root,
    binding,
    bindingDirectory: root,
    checkouts: cleanCheckouts(),
    actualPlatform: slot.os,
  });
  assert.equal(receipt.disposition, 'REFUSED_BINDING');
  assert.equal(receipt.qualification, 'NOT_QUALIFIED');
  assert.equal(receipt.scenarios.interruption_recovery.state, 'unknown');
});

test('a partial binding still awaits the missing fixture, installed product, and R-36 authority', async () => {
  const packet = loadedPacket();
  const slot = packet.config.records[0];
  const root = temporary('r25-m4-6-partial-binding-');
  const binding = completeBinding(root, slot);
  delete binding.fixture_profile;
  delete binding.installed_product;
  delete binding.r36;
  const receipt = await runSlot({
    packet,
    slotId: slot.slot_id,
    outputDirectory: root,
    binding,
    bindingDirectory: root,
    checkouts: cleanCheckouts(),
    actualPlatform: slot.os,
  });
  assert.equal(receipt.disposition, 'AWAITING_BINDINGS');
  assert.equal(receipt.bindings.fixture_profile, 'missing');
  assert.equal(receipt.bindings.installed_product, 'missing');
  assert.equal(receipt.bindings.r36_collector, 'missing');
  assert.equal(receipt.scenarios.keep_data_uninstall.state, 'unknown');
});

test('bound provider results retain all groups and an artifact hash inventory but await R-36', async () => {
  const packet = loadedPacket();
  const slot = packet.config.records.find((record) => record.slot_id === 'pinokio-backend-linux');
  const root = temporary('r25-m4-6-provider-');
  const binding = completeBinding(root, slot);
  const receipt = await runSlot({
    packet,
    slotId: slot.slot_id,
    outputDirectory: root,
    binding,
    bindingDirectory: root,
    checkouts: cleanCheckouts('/immutable/product'),
    actualPlatform: 'linux',
  });
  assert.equal(receipt.disposition, 'AWAITING_R36_VERIFICATION');
  assert.equal(receipt.qualification, 'NOT_QUALIFIED');
  assert.equal(receipt.inner_exit_code, 0);
  assert.equal(receipt.artifact_hashes.length, SCENARIO_GROUPS.length);
  for (const group of SCENARIO_GROUPS) assert.equal(receipt.scenarios[group].state, 'pass');
  assert.deepEqual(receipt.scenarios.stop_safety.outcomes, { refused: 'pass', unknown: 'pass' });
  assert.equal(receipt.bindings.accepted_r24_provider_binding, null);
  assert.equal(receipt.trusted_r36_verifier_result, 'unknown');
  assert.deepEqual(receipt.checkout.product, { head: RC0_TUPLE.pinokio, clean: true });
  assert.doesNotMatch(stableJson(receipt), /immutable\/product/);

  const written = writeReceipt(root, slot.slot_id, receipt);
  const inventory = fs.readFileSync(path.join(root, 'SHA256SUMS'), 'utf8');
  const inventoryEntries = inventory.trimEnd().split('\n');
  assert.equal(inventoryEntries.length, SCENARIO_GROUPS.length + 1);
  assert.ok(inventoryEntries.includes(`${written.hash}  m4-6-receipt-${slot.slot_id}.json`));
  for (const artifact of receipt.artifact_hashes) assert.ok(inventoryEntries.includes(`${artifact.sha256}  ${artifact.path}`));
  assert.equal(written.hash, sha256(fs.readFileSync(written.receiptPath)));
  assert.match(fs.readFileSync(written.receiptPath, 'utf8'), /"artifact_hashes"/);
  assert.equal(stableJson(receipt), stableJson(JSON.parse(fs.readFileSync(written.receiptPath, 'utf8'))));
});

test('the published packet digest inventory is immutable in the driver', () => {
  assert.deepEqual(Object.keys(PACKET_FILES).sort(), ['R-21-R7-DISPATCH.md', 'RC-0-EXECUTOR-CONFIGS.json', 'REPORT.md', 'SHA256SUMS', 'SLOT-MAPPING.md'].sort());
});
