import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWindowsCapture, openWindowsObservation, sourceProfileSha256 } from '../pinokio/windows-observer/adapter.mjs';

const capture = () => ({ start: 0, enable: 0, opened: true, process: 0, stop: 0, close: 0, timed_out: false, events_lost: 0, buffers_lost: 0, realtime_buffers_lost: 0, consumer_buffers_lost: 0, overflow: 0, terminal: true, events: [{ sequence: 1, emitter_pid: 123, event_id: 1, opcode: 1, version: 2 }] });

test('bounded header observations remain unknown even after clean closure', () => {
  const result = evaluateWindowsCapture(capture());
  assert.match(sourceProfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.reason, 'unapproved-source-profile');
  assert.equal(result.status, 'unknown');
  assert.equal(result.authority, 'none');
  assert.equal(result.cleanup, 'complete');
  assert.equal(result.continuity.source_sequence_available, false);
  assert.equal(result.continuity.last_sequence, 1);
  assert.deepEqual(result.observations, capture().events);
});
test('permission, loss counters, terminal, timeout, and cleanup all fail closed', () => {
  for (const [field, value, reason] of [['start', 5, 'source-unavailable'], ['enable', 5, 'source-unavailable'], ['opened', false, 'source-unavailable'], ['events_lost', 1, 'source-loss'], ['buffers_lost', 1, 'source-loss'], ['realtime_buffers_lost', 1, 'source-loss'], ['consumer_buffers_lost', 1, 'source-loss'], ['overflow', 1, 'source-loss'], ['terminal', false, 'terminal-missing'], ['timed_out', true, 'consumer-incomplete'], ['process', 1, 'consumer-incomplete'], ['stop', 5, 'cleanup-failed'], ['close', 5, 'cleanup-failed']]) {
    const valueCapture = capture(); valueCapture[field] = value;
    const result = evaluateWindowsCapture(valueCapture);
    assert.equal(result.status, 'unknown', field); assert.equal(result.reason, reason, field);
  }
});
test('gaps, duplicates, extra fields, malformed types and oversized captures are rejected', () => {
  for (const events of [[{ ...capture().events[0], sequence: 2 }], [capture().events[0], capture().events[0]], [{ ...capture().events[0], extra: 'secret' }], Array(1025).fill(capture().events[0])]) {
    const value = capture(); value.events = events;
    assert.equal(evaluateWindowsCapture(value).status, 'unknown');
    assert.deepEqual(evaluateWindowsCapture(value).observations, []);
  }
  assert.equal(evaluateWindowsCapture({ ...capture(), extra: 1 }).reason, 'malformed');
  assert.equal(evaluateWindowsCapture({ ...capture(), events_lost: -1 }).reason, 'malformed');
});
test('unsupported host refuses without running a caller-chosen source', { skip: process.platform === 'win32' }, async () => {
  const session = openWindowsObservation();
  assert.equal(await session.ready, false);
  assert.equal((await session.result).reason, 'unsupported-platform');
  session.stop();
});

test('Windows hosted capability: compile and attempt bounded ETW capture', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = dirname(fileURLToPath(new URL('../pinokio/windows-observer/adapter.mjs', import.meta.url)));
  const exe = join(directory, 'etw-observer.exe');
  const scratch = mkdtempSync(join(tmpdir(), 'r25-win-'));
  try {
    const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
    const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.ok(vs && !/["\r\n]/.test(vs), 'Visual Studio C++ toolchain is required');
    const setup = join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
    const build = `call "${setup}" >nul && cl /nologo /EHsc /W4 /O2 /Fo"${join(scratch, 'observer.obj')}" /Fe"${exe}" "${join(directory, 'etw-observer.cpp')}" /link advapi32.lib ole32.lib`;
    const compiled = spawnSync('cmd.exe', ['/d', '/s', '/c', build], { windowsHide: true, encoding: 'utf8', timeout: 45000 });
    assert.equal(compiled.status, 0, `native build failed: ${compiled.error?.code || compiled.status}`);
    const session = openWindowsObservation();
    const ready = await session.ready;
    if (ready) {
      spawnSync('cmd.exe', ['/d', '/c', 'exit', '0'], { windowsHide: true, timeout: 5000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      session.stop();
    }
    const result = await session.result;
    t.diagnostic(JSON.stringify({ ready, status: result.status, reason: result.reason, cleanup: result.cleanup, event_count: result.continuity?.event_count ?? null, dropped: result.continuity?.dropped ?? null, terminal: result.continuity?.terminal ?? null }));
    assert.equal(result.status, 'unknown');
    assert.equal(result.authority, 'none');
  } finally { rmSync(exe, { force: true }); rmSync(scratch, { recursive: true, force: true }); }
});
