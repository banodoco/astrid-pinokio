import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { observeLinuxReset } from '../pinokio/providers/linux-action-settlement.mjs';

const uri = '/tmp/pinokio/api/astrid/pinokio/reset.js';
const packets = [
  { type: 'memory' }, { type: 'start', id: uri },
  { type: 'result', id: uri, index: 0, total: 2, data: { stopped: false, lockFree: true, secret: 'never-retain' } },
  { type: 'result', id: uri, index: 1, total: 2, data: { reset: true, dataKept: true } },
  { type: 'event', id: uri, data: 'stop' }, { type: 'disconnect', id: uri },
];
function venue(actionPackets, status = { data: false }) {
  const sent = [];
  let count = 0;
  class Socket {
    constructor(endpoint, options) {
      this.handlers = {}; this.index = count++; this.endpoint = endpoint; this.options = options;
      queueMicrotask(() => this.emit('open', {}));
    }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    emit(name, event) { for (const fn of this.handlers[name] || []) fn(event); }
    send(raw) {
      sent.push(JSON.parse(raw));
      if (this.index === 0) for (const p of actionPackets) this.emit('message', { data: JSON.stringify(p) });
      else if (status !== null) this.emit('message', { data: JSON.stringify(status) });
    }
    close() { this.emit('close', {}); }
  }
  return { Socket, sent };
}
async function run(events = packets, status) {
  const v = venue(events, status);
  const result = await observeLinuxReset({ WebSocket: v.Socket, endpoint: 'ws://127.0.0.1:42000', uri, daemonPid: process.pid, timeoutMs: 25 });
  return { ...result, sent: v.sent, records: result.payloads.map(p => JSON.parse(p.bytes)) };
}

test('dispatches the exact Reset request and retains ordered bounded source facts with hashes', async () => {
  const result = await run();
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.sent, [{ uri, source: 'pterm', client: { source: 'pterm' } }, { uri, status: true }]);
  assert.ok(result.issues.includes('engine-execution-id-unavailable'));
  assert.ok(result.issues.includes('subscription-and-source-continuity-unverified'));
  assert.ok(!result.issues.includes('terminal-unavailable'));
  assert.ok(!result.issues.includes('idle-not-observed'));
  assert.equal(result.records.find(r => r.kind === 'engine-request').request_utf8, JSON.stringify(result.sent[0]));
  assert.deepEqual(result.records.filter(r => r.packet).map(r => r.packet.type), packets.map(p => p.type));
  assert.equal(result.records.filter(r => r.kind === 'engine-terminal').length, 1);
  assert.equal(result.records.find(r => r.kind === 'idle-observation').running, false);
  assert.equal(result.records.find(r => r.kind === 'process-before').process.pid, process.pid);
  assert.equal(result.records.find(r => r.kind === 'process-after').process.pid, process.pid);
  for (const [i, payload] of result.payloads.entries()) {
    assert.equal(payload.sequence, i + 1);
    assert.equal(payload.sha256, createHash('sha256').update(payload.bytes).digest('hex'));
    assert.equal(JSON.parse(payload.bytes).source_sequence, i + 1);
    assert.ok(!payload.bytes.toString().includes('never-retain'));
  }
});

test('returns canonical settlement artifacts with matching collector references', async () => {
  const v = venue(packets);
  const result = await observeLinuxReset({ WebSocket: v.Socket, endpoint: 'ws://127.0.0.1:42000', uri,
    daemonPid: process.pid, timeoutMs: 25, sequence: 23 });
  assert.equal(result.observations[0].sequence, 23);
  assert.deepEqual(result.observations.map(({ id, kind, file, sha256, sequence }) => ({ id, kind, file, sha256, sequence })),
    result.payloads.map(({ id, kind, file, sha256, sequence }) => ({ id, kind, file, sha256, sequence })));
  assert.deepEqual(result.files.map(({ path, role, sha256, size }) => ({ path, role, sha256, size })),
    result.payloads.map(({ file, kind, sha256, bytes }) => ({ path: file, role: kind, sha256, size: bytes.length })));
  for (const payload of result.payloads) {
    const canonical = spawnSync('python3', ['-c', 'import json,sys; value=json.load(sys.stdin); sys.stdout.write(json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True,allow_nan=False))'], { input: payload.bytes });
    assert.equal(canonical.status, 0, canonical.stderr.toString());
    assert.deepEqual(canonical.stdout, payload.bytes);
  }
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.observations));
  assert.ok(Object.isFrozen(result.files));
});

test('missing, duplicate, foreign, post-terminal and unverifiable events remain unknown', async () => {
  const cases = [
    [packets.filter(p => p.type !== 'event'), 'terminal-unavailable'],
    [[...packets.slice(0, 5), packets[4], packets[5]], 'duplicate-terminal'],
    [packets.map(p => p.type === 'event' ? { ...p, id: '/other/reset.js' } : p), 'foreign-resource'],
    [packets.map(p => p.type === 'event' ? { type: 'event', data: 'stop' } : p), 'event-resource-unavailable'],
    [[...packets.slice(0, 5), { type: 'result', id: uri }, packets[5]], 'event-after-terminal'],
    [packets.filter(p => p.type !== 'disconnect'), 'action-timeout'],
  ];
  for (const [events, issue] of cases) {
    const result = await run(events);
    assert.equal(result.state, 'unknown');
    assert.ok(result.issues.includes(issue), issue);
  }
});

test('idle false is source-specific and cannot be inferred from a bad or missing response', async () => {
  for (const response of [{ data: true }, { data: 'false' }, null]) {
    const result = await run(packets, response);
    assert.equal(result.state, 'unknown');
    assert.ok(result.issues.includes('idle-not-observed'));
  }
});

test('rejects non-Reset actions and missing daemon identity before dispatch', async () => {
  const v = venue(packets);
  for (const params of [{ uri: '/tmp/pinokio/update.js', daemonPid: process.pid }, { uri, daemonPid: 0 },
    { uri: '/tmp/../pinokio/reset.js', daemonPid: process.pid }, { uri, daemonPid: process.pid, sequence: 0 },
    { uri, daemonPid: process.pid, sequence: 4096, reserveSequences: 1 }]) {
    await assert.rejects(observeLinuxReset({ WebSocket: v.Socket, endpoint: 'ws://127.0.0.1', ...params }), /invalid/);
  }
  assert.deepEqual(v.sent, []);
});

test('an unavailable daemon and a late socket open never dispatch the action', async () => {
  const v = venue(packets);
  await assert.rejects(observeLinuxReset({ WebSocket: v.Socket, endpoint: 'ws://127.0.0.1', uri, daemonPid: 2147483647, timeoutMs: 5 }), /not dispatched/);
  assert.deepEqual(v.sent, []);
  let first;
  const sent = [];
  class LateSocket {
    constructor() { this.handlers = {}; if (!first) first = this; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send(value) { sent.push(value); }
    close() {}
  }
  const result = await observeLinuxReset({ WebSocket: LateSocket, endpoint: 'ws://localhost:42000', uri, daemonPid: process.pid, timeoutMs: 5 });
  first.handlers.open();
  assert.deepEqual(sent, []);
  assert.ok(result.issues.includes('action-timeout'));
  assert.equal(result.state, 'unknown');
});
