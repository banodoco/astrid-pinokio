import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const { createInstallDiagnostics, projectInstallEvidence, ptermExit, terminateChild, INSTALL_TRACE_LIMIT } =
  createRequire(import.meta.url)('../.github/venue/r21-observer-diagnostics.cjs');
const binding = { request_id: 'R-21-PUBLISHED-TUPLE-R1', runner_ref: 'a'.repeat(40), run_id: '100', run_attempt: '1' };

test('native Install step activity and terminal errors are timestamped, bounded and sanitized', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; }, () => clock);
  recorder.packet({ type: 'start', data: { current: 2, total: 4, method: 'shell.run', secret: 'secret-command' } });
  clock += 1000;
  recorder.packet({ type: 'stream', index: 2, total: 4, data: { raw: 'token=secret-output' }, rpc: { method: 'shell.run' } });
  clock += 1000;
  recorder.packet({ type: 'stream', index: 2, total: 4, data: { raw: 'password=another-secret' }, rpc: { method: 'shell.run' } });
  clock += 1000;
  recorder.packet({ type: 'error', data: 'api_key=secret-error', rpc: { current: 2, total: 4, method: 'shell.run' } });
  recorder.packet({ type: 'event', data: 'stop' });
  recorder.packet({ type: 'disconnect' });
  assert.deepEqual(evidence.events.map(x => x.kind), ['start', 'stream', 'error', 'stop', 'disconnect']);
  assert.deepEqual(evidence.events[0], { timestamp: '2026-01-01T00:00:00.000Z', kind: 'start', index: 2, total: 4, method: 'shell.run' });
  assert.equal(evidence.events[1].timestamp, '2026-01-01T00:00:02.000Z');
  assert.equal(evidence.events[2].index, 2);
  assert.doesNotMatch(JSON.stringify(evidence), /secret/);
  for (let i = 0; i < 100; i++) { clock += 1000; recorder.packet({ type: 'result', index: i, total: 100, data: 'secret' }); }
  assert.equal(evidence.events.length, INSTALL_TRACE_LIMIT);
  assert.equal(evidence.events.at(-1).index, 99);
  assert.equal(evidence.last_error.kind, 'error');
  assert.equal(evidence.first_error.kind, 'error');
  assert.equal(evidence.last_terminal.kind, 'disconnect');
  assert.equal(evidence.last_activity.index, 99);
  recorder.packet({ type: 'stream', index: 2, data: { raw: 'ASTRID_PINOKIO_FAILURE token=secret-details' } });
  assert.equal(evidence.last_error.kind, 'installer-failure-marker');
  assert.doesNotMatch(JSON.stringify(evidence), /secret/);
  assert.deepEqual(evidence.binding, binding);
  assert.deepEqual(evidence.child, { spawn_error_at: null, exited_at: null, code: null, signal: null, signal_observed: null,
    close_at: null, close_code: null, close_signal: null, close_observed: null });
});

test('timer timeout records fire and unknown child until an actual exit is observed', async () => {
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; });
  const child = new EventEmitter();
  child.kill = signal => { child.sent = signal; return true; };
  await assert.rejects(ptermExit(child, 'historical install', 10, recorder.pterm), /PTerm timeout/);
  assert.equal(child.sent, 'SIGTERM');
  assert.equal(Date.parse(evidence.timer.deadline_at) - Date.parse(evidence.timer.started_at), 10);
  assert.ok(Date.parse(evidence.timer.fired_at) >= Date.parse(evidence.timer.started_at));
  assert.equal(evidence.child.exited_at, null);
  assert.equal(evidence.child.signal_observed, null);
  child.emit('exit', null, 'SIGTERM');
  child.emit('close', null, 'SIGTERM');
  assert.ok(evidence.child.exited_at);
  assert.equal(evidence.child.code, null);
  assert.equal(evidence.child.signal, 'SIGTERM');
  assert.equal(evidence.child.signal_observed, true);
  assert.equal(evidence.child.close_signal, 'SIGTERM');
  assert.equal(evidence.child.close_observed, true);
});

test('normal exit and spawn error stay distinct and projection rejects arbitrary payloads', async () => {
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; });
  const child = new EventEmitter();
  const pending = ptermExit(child, 'historical install', 1000, recorder.pterm);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.deepEqual(await pending, { code: 0, signal: null });
  assert.equal(evidence.timer.fired_at, null);
  assert.equal(evidence.child.code, 0);
  assert.equal(evidence.child.signal_observed, false);
  assert.equal(evidence.child.close_code, 0);
  const failed = new EventEmitter();
  const failure = ptermExit(failed, 'historical install', 1000, recorder.pterm);
  failed.emit('error', new Error('secret-error'));
  await assert.rejects(failure, /spawn failed/);
  assert.ok(evidence.child.spawn_error_at);
  const safe = projectInstallEvidence({ events: [{ timestamp: '2026-01-01T00:00:00.000Z', kind: 'start', method: 'secret', index: -1, total: 999999 }], child: { signal: 'secret' }, secret: 'secret' }, binding);
  assert.doesNotMatch(JSON.stringify(safe), /secret/);
  assert.equal(safe.events[0].method, null);
  assert.equal(safe.events[0].index, null);
  assert.equal(safe.child.signal, null);
});

test('setup timeout cleanup escalates in bounded time and retains the child signal', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = signal => {
    child.signals = [...(child.signals || []), signal];
    if (signal === 'SIGKILL') {
      child.signalCode = 'SIGKILL';
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
    }
    return true;
  };
  const result = await terminateChild(child, 5, 5);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(result, { code: null, signal: 'SIGKILL' });
  assert.equal(child.unrefCalled ?? false, false);
});

test('Install listener captures native packets while PTerm is pending', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const diagnostics = createRequire(import.meta.url)('../.github/venue/r21-observer-diagnostics.cjs');
  const source = fs.readFileSync('.github/venue/r21-observe.cjs', 'utf8');
  const constants = source.slice(source.indexOf('const ACTION_TIMEOUT_MS'), source.indexOf('let actionNumber'));
  const action = source.slice(source.indexOf('async function observeAction('), source.indexOf('\nasync function lockFree('));
  let handler;
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; });
  const packet = value => handler({ data: JSON.stringify(value) });
  const context = vm.createContext({ path, appRoot: '/app', ptermRoot: '/pterm', home: '/home', ENDPOINT: 'pinokio://test',
    FIRST_REFUSAL: 'refusal', actionNumber: 0, progress: {}, process, installDiagnostics: recorder,
    openSocket: async () => ({ addEventListener: (_, callback) => { handler = callback; }, send: () => {} }),
    delay: async () => {}, isObject: value => value && typeof value === 'object',
    spawn: () => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        packet({ type: 'start', data: { current: 2, total: 4, method: 'shell.run', params: 'sensitive' } });
        packet({ type: 'stream', index: 2, total: 4, data: { raw: 'token=sensitive' }, rpc: { method: 'shell.run' } });
        packet({ type: 'result', index: 2, total: 4, data: 'sensitive' });
        packet({ type: 'event', data: 'stop' });
        packet({ type: 'disconnect' });
        child.emit('exit', 0, null);
      });
      return child;
    }, setTimeout, clearTimeout, retainProgress: () => {}, io: { disposeSocket: () => {} }, status: async () => false,
    actionPhase: diagnostics.actionPhase, actionTracker: diagnostics.createActionTracker(), ptermExit });
  vm.runInContext(`${constants}\n${action}`, context);
  const result = await vm.runInContext("observeAction('historical install', 'pinokio/install.js')", context);
  assert.equal(result.inner_exit.code, 0);
  assert.deepEqual(evidence.events.map(event => event.kind), ['start', 'stream', 'result', 'stop', 'disconnect']);
  assert.equal(evidence.events[1].method, 'shell.run');
  assert.ok(evidence.timer.started_at);
  assert.ok(evidence.child.exited_at);
  assert.doesNotMatch(JSON.stringify(evidence), /sensitive/);
});

test('last native operation survives settlement; result is observed, not inferred success', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; }, () => clock);
  assert.equal(evidence.last_native_event, null);
  assert.equal(evidence.last_start, null);
  assert.equal(evidence.last_result, null);
  assert.equal(evidence.last_error, null);
  assert.equal(evidence.last_terminal, null);
  recorder.packet({ type: 'start', data: { current: 2, total: 4, method: 'shell.run' } });
  recorder.packet({ type: 'result', index: 2, total: 4, data: { secret: 'credential' } });
  clock++;
  recorder.packet({ type: 'event', data: 'stop' });
  recorder.packet({ type: 'disconnect' });
  assert.equal(evidence.last_native_event.kind, 'result');
  assert.equal(evidence.last_start.method, 'shell.run');
  assert.deepEqual(evidence.last_native_event, evidence.last_result);
  assert.equal(evidence.last_terminal.kind, 'disconnect');
  assert.equal(evidence.last_error, null);
  assert.doesNotMatch(JSON.stringify(evidence), /credential|success/);
});

test('split installer failure marker and the latest sampled operation are retained without output', () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let evidence;
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; }, () => clock);
  recorder.packet({ type: 'stream', index: 2, data: { raw: 'token=credential ASTRID_PINOKIO_' }, rpc: { method: 'shell.run' } });
  clock += 1;
  recorder.packet({ type: 'stream', index: 2, data: { raw: 'FAILURE more password=credential' }, rpc: { method: 'shell.run' } });
  assert.equal(evidence.last_error.kind, 'installer-failure-marker');
  assert.equal(evidence.last_native_event.kind, 'installer-failure-marker');
  clock += 1;
  recorder.packet({ type: 'stream', index: 3, data: { raw: 'token=credential' }, rpc: { method: 'shell.run' } });
  clock += 1;
  recorder.packet({ type: 'stream', index: 3, data: { raw: 'token=credential' }, rpc: { method: 'shell.run' } });
  recorder.pterm('timer-fire', { at: clock });
  assert.equal(evidence.last_native_event.index, 3);
  assert.equal(evidence.last_native_event.timestamp, new Date(clock).toISOString());
  assert.equal(evidence.last_result, null);
  assert.equal(evidence.last_error.kind, 'installer-failure-marker');
  assert.doesNotMatch(JSON.stringify(evidence), /credential|ASTRID_PINOKIO_FAILURE/);
});

test('pre-timeout observation completes before cleanup signal and retains only bounded fixed facts', async () => {
  let evidence;
  const order = [];
  const recorder = createInstallDiagnostics(binding, value => { evidence = value; });
  const child = new EventEmitter();
  child.pid = 321;
  child.kill = signal => { order.push(`kill:${signal}`); return true; };
  await assert.rejects(ptermExit(child, 'historical install', 5, {
    pterm: recorder.pterm,
    async beforeTimeout(value) {
      order.push('snapshot:start');
      await new Promise(resolve => setTimeout(resolve, 5));
      recorder.stage('process-snapshot-before-timeout');
      recorder.beforeTimeout({ at: value.at, pterm_pid: value.pid, pterm_ppid: value.ppid,
        daemon_pid: 222, daemon_ppid: 111, process_snapshot: 'captured', installer_output: 'unavailable',
        pterm_output: 'captured', daemon_output: 'captured' });
      order.push('snapshot:end');
    },
  }), /PTerm timeout/);
  assert.deepEqual(order, ['snapshot:start', 'snapshot:end', 'kill:SIGTERM']);
  assert.equal(evidence.pre_cleanup.pterm_pid, 321);
  assert.equal(evidence.pre_cleanup.process_snapshot, 'captured');
  assert.equal(evidence.pre_cleanup.installer_output, 'unavailable');
  assert.equal(evidence.stages.some(item => item.stage === 'process-snapshot-before-timeout'), true);
});
