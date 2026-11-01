import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M46_SCENARIO_GROUPS,
  M46_STOP_OUTCOMES,
  PENDING_M46_SLOT_BINDINGS,
  getPendingM46Slot,
  isM46ExecutionEligible,
} from '../.github/venue/adapters/m4-6-slot-bindings.mjs';

test('D9 keeps exactly the six independent Pinokio M4-6 slots mandatory', () => {
  assert.deepEqual(
    PENDING_M46_SLOT_BINDINGS.map(slot => slot.id).sort(),
    [
      'pinokio-backend-linux',
      'pinokio-backend-macos',
      'pinokio-backend-windows',
      'pinokio-fully-local-linux',
      'pinokio-fully-local-macos',
      'pinokio-fully-local-windows',
    ],
  );
  assert.equal(new Set(PENDING_M46_SLOT_BINDINGS.map(slot => JSON.stringify(slot.obligation_key))).size, 6);
});

test('every slot retains all M4-6 groups, both stop outcomes, and pending receipts', () => {
  for (const slot of PENDING_M46_SLOT_BINDINGS) {
    assert.deepEqual(slot.required.scenario_groups, M46_SCENARIO_GROUPS);
    assert.deepEqual(slot.required.stop_outcomes, M46_STOP_OUTCOMES);
    assert.equal(slot.execution.receipt, 'pending');
    assert.equal(slot.execution.qualification, 'closed');
    assert.equal(slot.bindings.provider.state, 'pending-acceptance');
    assert.equal(slot.bindings.trusted_collection_and_verifier.state, 'pending');
    assert.equal(slot.bindings.source_profile.state, 'pending-approval');
    assert.equal(isM46ExecutionEligible(slot), false);
  }
});

test('the map has no implicit fallback, reduced slot, or executable pending plan', () => {
  assert.equal(getPendingM46Slot('pinokio-backend-macos').venue.runner, 'macos-14');
  assert.equal(getPendingM46Slot('pinokio-fully-local-windows').venue.shell, 'powershell.exe');
  assert.equal(getPendingM46Slot('pinokio-direct-linux'), null);
  assert.equal(isM46ExecutionEligible(null), false);
});
