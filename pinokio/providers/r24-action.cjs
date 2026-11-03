'use strict';

// Exact-request Pinokio action controller for the Linux R-24 producer. The
// dispatch socket is subscribed by pinokiod before process() is called, and
// every accepted packet must carry the unique request id.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LIVE_URI = '~/api/astrid/pinokio/providers/r24-live-action.js';
const STOP_URI = '~/api/astrid/pinokio/stop.js';
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error('invalid control');
}
function readControl(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid control file');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  exact(value, ['schema', 'pterm', 'session', 'request_sha256', 'live_uri', 'stop_uri', 'lifecycle',
    'lifecycle_sha256', 'backend_root', 'python', 'python_target', 'python_sha256', 'data_root', 'control_dir']);
  if (value.schema !== 'astrid.r24.live-control.v1' || !HEX32.test(value.session) ||
      !HEX64.test(value.request_sha256) || !HEX64.test(value.lifecycle_sha256) || !HEX64.test(value.python_sha256)) {
    throw new Error('invalid control identity');
  }
  if (value.live_uri !== LIVE_URI || value.stop_uri !== STOP_URI) throw new Error('invalid engine endpoint');
  for (const key of ['pterm', 'lifecycle', 'backend_root', 'python', 'python_target', 'data_root', 'control_dir']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw new Error('invalid control path');
  }
  return value;
}
function socketFactory(control) {
  const { WebSocket } = require(path.join(control.pterm, 'node_modules/unws/src/node.cjs'));
  return () => new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'pterm' } });
}
function openSocket(create, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = create();
    const timer = setTimeout(() => { try { socket.close(); } catch (_) {} reject(new Error('socket open timeout')); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('socket open failed')); });
  });
}
async function status(create, id, uri) {
  const socket = await openSocket(create);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('status timeout')); }, 5000);
    socket.addEventListener('message', event => {
      try {
        const packet = JSON.parse(String(event.data));
        if (!packet || typeof packet.data !== 'boolean') throw new Error('invalid status');
        clearTimeout(timer); socket.close(); resolve(packet.data);
      } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
    });
    socket.send(JSON.stringify({ uri, id, status: true }));
  });
}
async function fence(create, id, uri) {
  const socket = await openSocket(create);
  await new Promise((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => { socket.close(); reject(new Error('fence timeout')); }, 10000);
    socket.addEventListener('message', event => {
      try {
        const packet = JSON.parse(String(event.data));
        if (!packet || packet.id !== id || typeof packet.type !== 'string') throw new Error('foreign fence packet');
        if (packet.type === 'connect' && !sent) {
          sent = true;
          socket.send(JSON.stringify({ uri, id, stop: true }));
        } else if (packet.type === 'disconnect') {
          clearTimeout(timer); socket.close(); resolve();
        }
      } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
    });
    socket.send(JSON.stringify({ uri, id, mode: 'listen' }));
  });
  if (await status(create, id, uri) !== false) throw new Error('request remained active after fence');
  return { request_id: id, connect_observed: true, disconnect_observed: true, idle_observed: true };
}
function inputFor(control, mode) {
  return { schema: 'astrid.r24.live-action-input.v1', mode, session: control.session,
    request_sha256: control.request_sha256, lifecycle: control.lifecycle,
    lifecycle_sha256: control.lifecycle_sha256, backend_root: control.backend_root,
    python: control.python, python_target: control.python_target, python_sha256: control.python_sha256,
    data_root: control.data_root, control_dir: control.control_dir };
}
function requestId(uri, session, phase) {
  if (![LIVE_URI, STOP_URI].includes(uri) || !HEX32.test(session) || !/^[a-z-]+$/.test(phase)) {
    throw new Error('invalid request identity');
  }
  return `${uri}?r24-session=${session}-${phase}`;
}
function runAction(create, { id, uri, input, closeOnStart = false, onObserverLost }) {
  return openSocket(create).then(socket => new Promise((resolve, reject) => {
    const packets = [];
    let closedForFault = false;
    const timer = setTimeout(() => { try { socket.close(); } catch (_) {} reject(new Error('action timeout')); }, 30000);
    const fail = error => { clearTimeout(timer); try { socket.close(); } catch (_) {} reject(error); };
    socket.addEventListener('message', event => {
      try {
        const packet = JSON.parse(String(event.data));
        if (!packet || packet.id !== id || typeof packet.type !== 'string') throw new Error('foreign action packet');
        packets.push(packet);
        if (closeOnStart && packet.type === 'start' && !closedForFault) {
          closedForFault = true; socket.close(); return;
        }
        if (packet.type === 'error') { clearTimeout(timer); socket.close(); resolve({ id, packets, error: packet.data }); return; }
        if (packet.type === 'disconnect') { clearTimeout(timer); socket.close(); resolve({ id, packets }); }
      } catch (error) { fail(error); }
    });
    socket.addEventListener('close', () => {
      if (closedForFault) {
        try {
          onObserverLost(); clearTimeout(timer);
          resolve({ id, packets, observer_lost: true });
        } catch (error) { fail(error); }
      } else if (!packets.some(packet => packet.type === 'disconnect' || packet.type === 'error')) {
        fail(new Error('premature close'));
      }
    });
    socket.send(JSON.stringify({ uri, id, source: 'pterm', client: { source: 'pterm' }, ...(input ? { input } : {}) }));
  }));
}
function terminalProjection(run, expected) {
  const results = run.packets.filter(packet => packet.type === 'result');
  const result = results.length === 1 ? results[0].data : null;
  if (!result || expected(result) !== true || !run.packets.some(packet => packet.type === 'event' && packet.data === 'stop') ||
      !run.packets.some(packet => packet.type === 'disconnect') || run.packets.some(packet => packet.type === 'error')) {
    throw new Error('action terminal mismatch');
  }
  return { request_id: run.id, results: 1, stop_observed: true, disconnect_observed: true };
}
function busyProjection(value, control, mode) {
  if (!value || value.schema !== 'astrid.r24.preflight.v1' || value.session !== control.session ||
      value.request_sha256 !== control.request_sha256 || value.mode !== mode || value.safe !== false ||
      !Number.isSafeInteger(value.task_count) || value.task_count < 1 || !Array.isArray(value.blockers) || !value.blockers.length) {
    throw new Error('genuine busy preflight not observed');
  }
  const blockers = value.blockers.map(row => {
    exact(row, ['task_id', 'blocker_kind', 'kind', 'state']);
    if (!row.task_id || !row.blocker_kind || !row.state) throw new Error('invalid busy blocker');
    return { task_id: row.task_id, blocker_kind: row.blocker_kind, kind: row.kind, state: row.state };
  });
  return { task_count: value.task_count, blockers,
    headline_sha256: crypto.createHash('sha256').update(value.headline).digest('hex') };
}
async function waitForDrained(control) {
  const readyFile = path.join(control.control_dir, 'ready.json');
  const drainedFile = path.join(control.control_dir, 'drained.json');
  const deadline = Date.now() + 15000;
  let ready;
  while (Date.now() < deadline) {
    try { ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')); break; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!ready || ready.schema !== 'astrid.r24.fault-ready.v1' || ready.session !== control.session ||
      !Number.isSafeInteger(ready.pid) || ready.python_sha256 !== control.python_sha256) throw new Error('fault ready record unavailable');
  while (Date.now() < deadline) {
    try {
      const drained = JSON.parse(fs.readFileSync(drainedFile, 'utf8'));
      if (drained.schema !== 'astrid.r24.fault-drained.v1' || drained.session !== control.session ||
          drained.pid !== ready.pid || drained.armed !== true || drained.signal !== 'SIGKILL') throw new Error('fault drain mismatch');
      return { child_pid: ready.pid, python_sha256: ready.python_sha256, armed: true, drained: true, signal: 'SIGKILL' };
    } catch (error) { if (error && error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fault drain timeout');
}
async function collect(control, create = socketFactory(control)) {
  const probe = await runAction(create, { id: requestId(control.live_uri, control.session, 'probe'),
    uri: control.live_uri, input: inputFor(control, 'probe') });
  const binding = terminalProjection(probe, value => value && value.schema === 'astrid.r24.engine-binding.v1' &&
    value.session === control.session && value.request_sha256 === control.request_sha256 && value.mode === 'probe');
  if (await status(create, probe.id, control.live_uri) !== false) throw new Error('probe remained active');
  const busyRun = await runAction(create, { id: requestId(control.live_uri, control.session, 'busy-read'),
    uri: control.live_uri, input: inputFor(control, 'busy') });
  let busy;
  terminalProjection(busyRun, value => { busy = busyProjection(value, control, 'busy'); return true; });
  const stopRun = await runAction(create, { id: requestId(control.stop_uri, control.session, 'busy-stop'),
    uri: control.stop_uri });
  if (!stopRun.error || !busy.blockers.every(row => String(stopRun.error).includes(row.task_id))) {
    throw new Error('Stop did not preserve busy refusal');
  }
  const busyFence = await fence(create, stopRun.id, control.stop_uri);
  const unknownId = requestId(control.live_uri, control.session, 'unknown');
  const unknownRun = await runAction(create, { id: unknownId, uri: control.live_uri,
    input: inputFor(control, 'unknown'), closeOnStart: true,
    onObserverLost: () => fs.writeFileSync(path.join(control.control_dir, 'arm'), control.session + '\n', { flag: 'wx', mode: 0o600 }) });
  if (!unknownRun.observer_lost) throw new Error('observer loss not established');
  const drain = await waitForDrained(control);
  const unknownFence = await fence(create, unknownId, control.live_uri);
  const restoreRun = await runAction(create, { id: requestId(control.live_uri, control.session, 'restoration'),
    uri: control.live_uri,
    input: inputFor(control, 'restoration') });
  let restored;
  const restoration = terminalProjection(restoreRun, value => {
    restored = busyProjection(value, control, 'restoration');
    return JSON.stringify(restored.blockers) === JSON.stringify(busy.blockers);
  });
  if (await status(create, restoreRun.id, control.live_uri) !== false) throw new Error('restoration probe remained active');
  return { schema: 'astrid.r24.live-action-result.v1', session: control.session,
    request_sha256: control.request_sha256, binding,
    busy: { ...busy, stop_refused: true, fence: busyFence },
    unknown: { observer_lost: true, preflight: drain, fence: unknownFence },
    restoration: { ...restoration, preflight: restored, observer_usable: true } };
}
async function main() {
  if (process.argv.length !== 3) throw new Error('control file required');
  process.stdout.write(JSON.stringify(await collect(readControl(process.argv[2]))));
}
if (require.main === module) main().catch(() => {
  process.stderr.write(JSON.stringify({ schema: 'astrid.r24.live-action-error.v1', status: 'unknown' }) + '\n');
  process.exitCode = 1;
});
module.exports = { LIVE_URI, STOP_URI, requestId, readControl, status, fence, runAction,
  terminalProjection, busyProjection, collect };
