import assert from 'node:assert/strict';

export function releaseRefs(oldRef, candidateRef) {
  for (const ref of [oldRef, candidateRef]) assert.match(ref || '', /^[0-9a-f]{40}$/, 'release refs must be full lowercase App commit SHAs');
  assert.notEqual(oldRef, candidateRef, 'release refs must differ');
  return { oldRef, candidateRef };
}

export function assertVersionChanged(before, after) {
  for (const [label, observation] of [['before', before], ['after', after]]) {
    assert.ok(observation.current, `${label} current version is missing`);
    assert.equal(observation.status, 200, `${label} health is not ready`);
    assert.equal(observation.health?.install?.managed_by, 'pinokio', `${label} health is not Pinokio-owned`);
    assert.ok(observation.health?.identity && typeof observation.health.identity === 'object', `${label} health identity is missing`);
    assert.ok(observation.recordIdentity, `${label} installed identity is missing`);
    assert.deepEqual(observation.health.identity, observation.recordIdentity, `${label} health identity differs from selected version`);
  }
  assert.notEqual(after.current, before.current, 'selected version did not change');
  assert.notDeepEqual(after.health.identity, before.health.identity, 'health identity did not change');
}
