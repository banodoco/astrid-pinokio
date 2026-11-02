'use strict';

// Component checks only; these tests make no hosted qualification claim.
const assert = require('node:assert/strict');
const test = require('node:test');
const provider = require('../pinokio/providers/r25-snapshot-windows.cjs');

const TASK = '\\Astrid Runtime';
const SERVICE = 'AstridRuntime';

function payload() {
  return {
    processes: [
      { pid: 88, parent_pid: 4, command_line: null, creation_time_utc: '2026-11-02T18:14:12Z', executable_path: null },
      { pid: 412, parent_pid: 88, command_line: 'runtime.exe serve', creation_time_utc: '2026-11-02T18:14:13.1234567Z', executable_path: 'C:\\Astrid\\runtime.exe' },
    ],
    scheduled_tasks: [{ target: TASK, status: 'present', state: 'running', enabled: true, actions: [{ type: 0, execute: 'runtime.exe', arguments: '', working_directory: null }] }],
    services: [{ target: SERVICE, status: 'present', state: 'Running', start_type: 'Auto', process_id: 412 }],
  };
}

function signed(overrides = {}) {
  const value = {
    schema: provider.SCHEMA,
    source: { ...provider.PROFILE },
    capture: { started_at_utc: '2026-11-02T18:20:00Z', completed_at_utc: '2026-11-02T18:20:01Z', started_monotonic_ns: 1, completed_monotonic_ns: 2, collector_pid: 99 },
    limits: { max_processes: 4096, max_targets: 64, max_task_actions: 32, max_output_bytes: 8388608, timeout_seconds: 30 },
    targets: { scheduled_task_paths: [TASK], service_names: [SERVICE] },
    ...payload(),
    ...overrides,
  };
  value.structural_sha256 = provider.structuralDigest(value);
  return value;
}

test('validates the Windows profile and present observation', () => {
  const value = signed();
  assert.equal(provider.PROFILE.runner, 'windows-2022');
  assert.equal(provider.PROFILE.shell, 'powershell.exe');
  assert.equal(provider.validateObservation(value), value);
});

test('retains absent and collection-error target rows', () => {
  const value = signed({
    scheduled_tasks: [{ target: TASK, status: 'absent' }],
    services: [{ target: SERVICE, status: 'collection-error', error: { type: 'CimException', hresult: -1, fully_qualified_error_id: 'PermissionDenied', category: 'PermissionDenied' } }],
  });
  assert.equal(provider.validateObservation(value).services[0].status, 'collection-error');
});

test('rejects duplicate PID, duplicate target, and unknown fields', () => {
  const duplicatePid = signed();
  duplicatePid.processes[1].pid = duplicatePid.processes[0].pid;
  duplicatePid.structural_sha256 = provider.structuralDigest(duplicatePid);
  assert.throws(() => provider.validateObservation(duplicatePid), /duplicate PID/);
  const duplicateTarget = signed({ targets: { scheduled_task_paths: [TASK, TASK.toLowerCase()], service_names: [SERVICE] } });
  duplicateTarget.structural_sha256 = provider.structuralDigest(duplicateTarget);
  assert.throws(() => provider.validateObservation(duplicateTarget), /duplicate target/);
  const unknown = signed();
  unknown.processes[0].extra = true;
  unknown.structural_sha256 = provider.structuralDigest(unknown);
  assert.throws(() => provider.validateObservation(unknown), /missing or unknown fields/);
});

test('rejects malformed creation time, capacity, and digest', () => {
  const malformed = signed();
  malformed.processes[0].creation_time_utc = null;
  malformed.structural_sha256 = provider.structuralDigest(malformed);
  assert.throws(() => provider.validateObservation(malformed), /creation_time_utc/);
  const capacity = signed({ limits: { max_processes: 1, max_targets: 64, max_task_actions: 32, max_output_bytes: 8388608, timeout_seconds: 30 } });
  capacity.structural_sha256 = provider.structuralDigest(capacity);
  assert.throws(() => provider.validateObservation(capacity), /processes exceed capacity/);
  const digest = signed();
  digest.structural_sha256 = '0'.repeat(64);
  assert.throws(() => provider.validateObservation(digest), /structural_sha256/);

  const reversed = signed();
  reversed.capture.completed_monotonic_ns = 0;
  reversed.structural_sha256 = provider.structuralDigest(reversed);
  assert.throws(() => provider.validateObservation(reversed), /completion precedes/);

  const unbounded = signed();
  unbounded.limits.max_targets = 65;
  unbounded.structural_sha256 = provider.structuralDigest(unbounded);
  assert.throws(() => provider.validateObservation(unbounded), /max_targets/);
});
