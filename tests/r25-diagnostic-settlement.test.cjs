'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticSettlement } = require('../.github/venue/r25-diagnostic-settlement.cjs');

test('rewritten sidecars preserve prompt-1 resolution and bound unanswered prompt-2 by its write timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-os-settlement-'));
  const captureFile = path.join(root, 'pty.jsonl');
  let time = Date.parse('2026-11-03T07:00:00.000Z');
  let due;
  let fire;
  const watch = createDiagnosticSettlement({ captureFile, now: () => time,
    setTimer: (callback, delay) => { fire = callback; due = time + delay; return 1; }, clearTimer: () => {} });
  const write = rows => fs.writeFileSync(captureFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  try {
    write([{kind: 'prompt-probe-write-return', prompt_ordinal: 1, at: new Date(time).toISOString()},
      {kind: 'prompt-recognized', prompt_ordinal: 1}]);
    watch.scan();
    assert.equal(watch.snapshot().probes[0].resolved, true);
    time += 7000;
    write([{kind: 'prompt-probe-write-return', prompt_ordinal: 2, at: new Date(time - 100).toISOString()}]);
    watch.scan();
    assert.equal(due, time - 100 + 90000);
    assert.equal(watch.signal.aborted, false);
    time = due;
    fire();
    assert.equal(watch.signal.aborted, true);
    assert.equal(watch.snapshot().failure.prompt_ordinal, 2);
    assert.equal(watch.snapshot().failure.native_exit, null);
  } finally { watch.stop(); fs.rmSync(root, {recursive: true, force: true}); }
});

for (const [chunks, reason] of [
  [[{type: 'error', data: 'private'}], 'error-event'],
  [[{type: 'installer-failure-marker'}], 'failure-marker'],
  [[{type:'stream',data:{raw:'ASTRID_PINO'}},{type:'stream',data:{raw:'KIO_FAILURE'}}], 'failure-marker'],
  [[{type:'stream',data:{raw:'Terminated '}},{type:'stream',data:{raw:'Shell 123'}}], 'terminated-shell'],
]) test(`diagnostic aborts immediately on ${reason}, including chunk boundaries`, () => {
  const watch = createDiagnosticSettlement();
  for (const chunk of chunks) watch.packet(chunk);
  assert.equal(watch.signal.aborted, true);
  assert.equal(watch.snapshot().failure.reason, reason);
  assert.doesNotMatch(JSON.stringify(watch.snapshot()), /private|123/);
  watch.stop();
});

test('terminal ledger distinguishes top-level PTerm stop/disconnect from event wrappers', () => {
  const watch = createDiagnosticSettlement();
  for (const packet of [{type:'event',data:'stop'},{type:'stop'},{type:'disconnect'}]) watch.packet(packet);
  assert.deepEqual(watch.snapshot().emitted, {stop:1, disconnect:1, event_stop:1, event_disconnect:0, error:0});
  assert.equal(watch.signal.aborted, false);
  watch.stop();
});

test('PTerm close alone cannot pass; diagnostic error rejects the child-exit wait immediately', async () => {
  const { EventEmitter } = require('node:events');
  const { ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');
  const child = new EventEmitter(); child.kill = () => { throw Error('unexpected qualification signal'); };
  const watch = createDiagnosticSettlement();
  let resolved = false;
  const pending = ptermExit(child, 'diagnostic', 30 * 60 * 1000, null, { signal: watch.signal }).then(value => { resolved=true; return value; });
  child.emit('close',0,null);
  await Promise.resolve(); assert.equal(resolved,false);
  watch.packet({type:'error'});
  await assert.rejects(pending,/R-25 diagnostic error-event/);
  assert.equal(watch.snapshot().failure.native_exit,null);
  watch.stop();
});
