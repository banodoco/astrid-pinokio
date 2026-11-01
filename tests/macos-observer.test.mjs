import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { inspect, startMacObserver, sourceProfileSha256 } = createRequire(import.meta.url)('../.github/venue/adapters/macos-observer.cjs');
const ready = { type: 'ready' };
const event = sequence => ({ type: 'event', version: 5, sequence: String(sequence), mach_time: '42', event: 1, pid: 100, pidversion: 1, subject_pid: 101, subject_version: 1 });
const terminal = { type: 'terminal', stop: 1, unsubscribe: 0, barrier: 1, cleanup: 0, overflow: 0 };
const raw = (...records) => records.map(r => JSON.stringify(r)).join('\n') + '\n';
const reason = (...records) => inspect(raw(...records), 0).reason;
test('client and subscription failures are unknown with explicit cleanup', () => {
  assert.equal(reason({ type: 'open-failed', code: 3 }), 'client-unavailable');
  assert.equal(inspect(raw({ type: 'open-failed', code: 3 }), 1).source_result.code, 3);
  assert.equal(reason({ type: 'subscribe-failed', code: 1, cleanup: 0 }), 'subscription-failed');
  assert.equal(reason({ type: 'subscribe-failed', code: 1, cleanup: 1 }), 'cleanup-failed');
});
test('continuous event stream is bounded raw evidence, never authority', () => {
  const r = inspect(raw(ready, event(8), event(9), terminal), 0);
  assert.match(sourceProfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(r.source_profile_sha256, sourceProfileSha256);
  assert.equal(r.status, 'unknown'); assert.equal(r.authority, 'none'); assert.equal(r.reason, 'profile-unbound');
  assert.deepEqual(r.continuity, { first_sequence: '8', last_sequence: '9', event_count: 2, gaps: 0, dropped: 0, terminal: true });
  assert.equal(r.cleanup, 'success');
});
test('loss, gaps, regressions, unavailable counters and limits fail closed', () => {
  const r = inspect(raw(ready, event(4), event(7), terminal), 0);
  assert.equal(r.reason, 'sequence-gap'); assert.equal(r.continuity.dropped, 2);
  assert.equal(reason(ready, event(4), event(4), terminal), 'sequence-regression');
  assert.equal(reason(ready, event(1), { ...terminal, overflow: 1 }), 'overflow');
  assert.equal(reason(ready, { ...event(1), version: 4 }, terminal), 'malformed');
  assert.equal(reason(ready, terminal), 'sequence-unavailable');
  assert.equal(inspect('x'.repeat(1024 * 1024 + 1), 0).reason, 'malformed');
});
test('terminal, barrier, cleanup, exit and post-terminal data are mandatory', () => {
  assert.equal(reason(ready, event(1)), 'terminal-missing');
  assert.equal(reason(ready, event(1), { ...terminal, barrier: 0 }), 'closure-unproven');
  assert.equal(reason(ready, event(1), { ...terminal, stop: 0 }), 'closure-unproven');
  assert.equal(reason(ready, event(1), { ...terminal, unsubscribe: 1 }), 'cleanup-failed');
  assert.equal(reason(ready, event(1), { ...terminal, cleanup: 1 }), 'cleanup-failed');
  assert.equal(inspect(raw(ready, event(1), terminal), 1).reason, 'child-failed');
  assert.equal(reason(ready, event(1), terminal, event(2)), 'malformed');
  assert.equal(reason(ready, event(1), terminal, terminal), 'malformed');
});
test('reject unrecognized fields and malformed records', () => {
  assert.equal(reason(ready, { ...event(1), path: '/secret' }, terminal), 'malformed');
  assert.equal(reason(ready, { ...event(1), sequence: '01' }, terminal), 'malformed');
  assert.equal(inspect('{\n', 0).reason, 'malformed');
  assert.equal(inspect('{"type":"ready","type":"ready"}\n', 0).reason, 'malformed');
  assert.equal(inspect(raw(ready).slice(0, -1), 0).reason, 'malformed');
});
test('other hosts do not select or run an alternate source', { skip: process.platform === 'darwin' }, async () => {
  const session = await startMacObserver();
  assert.equal(session.ready, false); assert.equal((await session.finish()).reason, 'unsupported-host');
});
