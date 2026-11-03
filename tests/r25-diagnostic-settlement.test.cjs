'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticSettlement, SCHEDULE_MARGIN_MS } = require('../.github/venue/r25-diagnostic-settlement.cjs');

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
    assert.equal(due, time - 100 + 90000 - SCHEDULE_MARGIN_MS);
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
]) test(`diagnostic aborts immediately on ${reason}, including chunk boundaries`, () => {
  const watch = createDiagnosticSettlement();
  for (const chunk of chunks) watch.packet(chunk);
  assert.equal(watch.signal.aborted, true);
  assert.equal(watch.snapshot().failure.reason, reason);
  assert.doesNotMatch(JSON.stringify(watch.snapshot()), /private|123/);
  watch.stop();
});

test('Terminated Shell is retained as bounded context and observation continues to PTerm exit', async () => {
  const { EventEmitter } = require('node:events');
  const { ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');
  const watch = createDiagnosticSettlement();
  const child = new EventEmitter();
  child.pid = 12;
  const pending = ptermExit(child, 'diagnostic', 1000, { pterm: (event, value) => watch.pterm(event, value) }, { signal: watch.signal });
  watch.packet({type:'stream',data:{raw:`prefix ${'x'.repeat(400)} token=private-marker-secret Terminated `}});
  watch.packet({type:'stream',data:{raw:'Shell tail'}});
  assert.equal(watch.signal.aborted, false);
  assert.equal(watch.snapshot().marker_observations.length, 1);
  assert.equal(Buffer.byteLength(watch.snapshot().marker_observations[0].context, 'utf8') <= 256, true);
  assert.match(watch.snapshot().marker_observations[0].context, /Terminated Shell/);
  assert.doesNotMatch(watch.snapshot().marker_observations[0].context, /private-marker-secret/);
  child.emit('exit', 0, null);
  assert.deepEqual(await pending, { code: 0, signal: null });
  assert.equal(watch.snapshot().failure, null);
  assert.equal(watch.snapshot().pterm.some(row => row.event === 'child-exit' && row.code === 0), true);
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

test('bounded PTerm timeout remains a refusal and signals only its observer child', async () => {
  const { EventEmitter } = require('node:events');
  const { ptermExit } = require('../.github/venue/r21-observer-diagnostics.cjs');
  const watch = createDiagnosticSettlement();
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  await assert.rejects(ptermExit(child, 'diagnostic', 5, null, { signal: watch.signal }), /PTerm timeout/);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(watch.snapshot().failure, null);
  watch.stop();
});

test('probe journal retains an earlier resolution when prompt-2 replaces the legacy ring', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r25-probe-journal-'));
 const captureFile=path.join(root,'journal.json');
 const time=Date.parse('2026-11-03T07:00:00.000Z');let due;
 const watch=createDiagnosticSettlement({captureFile,now:()=>time,setTimer:(_,delay)=>{due=time+delay;return 1;},clearTimer:()=>{}});
 try {
  fs.writeFileSync(captureFile,JSON.stringify({prompt_probes:[
   {prompt_ordinal:1,written_at:new Date(time-100000).toISOString(),resolved_at:new Date(time-99900).toISOString()},
   {prompt_ordinal:2,written_at:new Date(time-500).toISOString()},
  ]}));
  watch.scan();
  assert.equal(watch.snapshot().probes[0].resolved,true);
  assert.equal(watch.signal.aborted,false);
  assert.equal(due,time-500+90000-SCHEDULE_MARGIN_MS);
 } finally {watch.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('terminal packets remain observable after a lifecycle marker until cleanup stops the recorder', () => {
 const watch=createDiagnosticSettlement();
 watch.packet({type:'stream',data:{raw:'Terminated Shell'}});
 watch.packet({type:'disconnect'});
 assert.equal(watch.snapshot().failure,null);
 assert.equal(watch.snapshot().marker_observations.length,1);
 assert.equal(watch.snapshot().emitted.disconnect,1);
 watch.stop();
});
