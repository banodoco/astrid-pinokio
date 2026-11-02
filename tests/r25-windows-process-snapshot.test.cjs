'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const snapshot = require('../.github/venue/r25-windows-process-snapshot.cjs');

function fakeExec(output, error = null, inspect = () => {}) {
  return (executable, args, options, callback) => {
    inspect(executable, args, options);
    callback(error, output);
  };
}

test('captures only bounded PID and parent PID rows, sorted and with a fixed schema', async () => {
  let command;
  const result = await snapshot.captureWindowsProcessTree({
    platform: 'win32', rootPids: [40, 10], now: () => '2026-11-02T18:20:00Z',
    execFile: fakeExec('{"processes":[{"pid":51,"parent_pid":40},{"pid":10,"parent_pid":4},{"pid":40,"parent_pid":10}]}', null,
      (executable, args, options) => { command = { executable, args, options }; }),
  });

  assert.deepEqual(result, {
    schema: snapshot.SCHEMA, captured_at_utc: '2026-11-02T18:20:00Z', root_pids: [10, 40],
    processes: [{ pid: 10, parent_pid: 4 }, { pid: 40, parent_pid: 10 }, { pid: 51, parent_pid: 40 }], status: 'captured', error: null,
  });
  assert.equal(command.executable, snapshot.POWERSHELL);
  assert.equal(command.options.timeout, 5000);
  assert.equal(command.options.maxBuffer, 128 * 1024 + 1);
  assert.match(command.args.at(-1), /Get-CimInstance -ClassName Win32_Process/);
  assert.match(command.args.at(-1), /ProcessId,ParentProcessId/);
  assert.match(command.args.at(-1), /Select-Object -First 2049/);
  assert.doesNotMatch(command.args.at(-1), /CommandLine|ExecutablePath|Environment/);
});

test('returns stable errors without retaining command output or exception text', async t => {
  await t.test('unsupported platform', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'linux', rootPids: [7] });
    assert.equal(result.error, 'unsupported-platform');
    assert.deepEqual(result.processes, []);
  });
  await t.test('invalid roots', async () => {
    let called = false;
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1, 1], execFile: () => { called = true; } });
    assert.equal(result.error, 'invalid-request');
    assert.equal(called, false);
  });
  await t.test('timeout', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], execFile: fakeExec('', Object.assign(new Error('sensitive stderr text'), { killed: true })) });
    assert.equal(result.error, 'timeout');
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
  });
  await t.test('command failure', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], execFile: fakeExec('private process path', Object.assign(new Error('private output'), { code: 3 })) });
    assert.equal(result.error, 'command-error');
    assert.equal(JSON.stringify(result).includes('private'), false);
  });
  await t.test('output bound', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], maxOutputBytes: 128, execFile: fakeExec(`{"processes":[]} ${'x'.repeat(150)}`) });
    assert.equal(result.error, 'output-limit');
  });
  await t.test('child output overflow is not classified as timeout', async () => {
    const result = await snapshot.captureWindowsProcessTree({
      platform: 'win32', rootPids: [1],
      execFile: fakeExec('', Object.assign(new Error('private output'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })),
    });
    assert.equal(result.error, 'output-limit');
  });
  await t.test('process bound', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], maxProcesses: 1, execFile: fakeExec('{"error":"process-limit"}') });
    assert.equal(result.error, 'process-limit');
  });
  await t.test('malformed rows do not leak fields', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], execFile: fakeExec('{"processes":[{"pid":1,"parent_pid":0,"command_line":"secret"}]}') });
    assert.equal(result.error, 'malformed-output');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
  await t.test('zero PID is not a process fact', async () => {
    const result = await snapshot.captureWindowsProcessTree({ platform: 'win32', rootPids: [1], execFile: fakeExec('{"processes":[{"pid":0,"parent_pid":0}]}') });
    assert.equal(result.error, 'malformed-output');
    assert.deepEqual(result.processes, []);
  });
});
