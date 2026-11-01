import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { diagnostic, parse, unavailableResult } = createRequire(import.meta.url)('../.github/venue/observer-probe/probe.cjs');

test('missing, malformed and gaps fail closed', () => {
  assert.equal(diagnostic([]), 'unknown:source-missing');
  assert.equal(diagnostic([{ sequence: '1', type: 'event' }]), 'unknown:malformed');
  assert.equal(diagnostic([{ sequence: 1, type: 'event' }, { sequence: 3, type: 'terminal' }]), 'unknown:gap');
});
test('loss and terminal boundaries never grant continuity', () => {
  assert.equal(diagnostic([{ sequence: 1, type: 'loss' }]), 'unknown:loss');
  assert.equal(diagnostic([{ sequence: 1, type: 'event' }]), 'unknown:terminal-missing');
  assert.equal(diagnostic([{ sequence: 1, type: 'terminal' }]), 'unknown:unapproved-source');
  assert.equal(diagnostic([{ sequence: 1, type: 'terminal' }, { sequence: 2, type: 'event' }]), 'unknown:after-terminal');
});
test('native probe results require fixed fields and numeric statuses', () => {
  assert.equal(parse('endpoint-security', '{"source":"endpoint-security","new_client_result":1,"delete_client_result":-1,"created":0,"cleanup_ok":-1,"not_entitled":3,"not_permitted":4,"not_privileged":5}').new_client_result, 1);
  assert.throws(() => parse('etw-kernel-process', '{}'));
  assert.throws(() => parse('endpoint-security', '{'));
  assert.throws(() => parse('endpoint-security', '{"source":"endpoint-security","new_client_result":0,"delete_client_result":0,"created":1,"cleanup_ok":1,"not_entitled":3,"not_permitted":4,"not_privileged":5,"extra":0}'));
});

test('unavailable SDK remains unknown and fail-closed', () => {
  const result = unavailableResult();
  assert.equal(result.status, 'unknown');
  assert.equal(result.continuity, 'unavailable');
  assert.equal(result.authority, 'none');
  assert.equal(result.error, 'sdk-framework-unavailable');
});
