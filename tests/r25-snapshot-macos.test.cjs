'use strict';

// Component checks only.  These tests do not qualify a hosted venue.
const assert = require('node:assert/strict');
const test = require('node:test');
const validator = require('../pinokio/providers/r25-snapshot-macos.cjs');

function observation(overrides = {}) {
  const value = {
    schema: validator.SCHEMA,
    source: validator.SOURCE,
    profile: validator.PROFILE,
    capture_utc: '2026-11-02T18:14:13.000000Z',
    capture_monotonic_ns: 123,
    collector_pid: 42,
    limits: {
      max_processes: 1024,
      max_targets: 64,
      max_ps_bytes: 1048576,
      max_command_line_bytes: 65536,
      max_service_print_bytes: 65536,
    },
    processes: [{
      pid: 101,
      parent_pid: 1,
      process_birth_id: 'Mon Jan  1 00:00:00 2024',
      command_line: '/usr/bin/example --full command',
      executable_path: '/usr/bin/example',
      state: 'present',
    }],
    services: [
      { target: 'gui/501/com.example.app', state: 'present', raw_print: 'gui/501/com.example.app\nstate = running\n', error: null },
      { target: 'gui/501/com.example.missing', state: 'absent', raw_print: null, error: null },
    ],
    collection_errors: [],
  };
  Object.assign(value, overrides);
  value.digest = validator.structuralDigest(value);
  return value;
}

test('validates macos-15/bash present and absent rows with a structural digest', () => {
  const value = observation();
  assert.equal(validator.validateObservation(value), value);
  assert.deepEqual(validator.MACOS_PROFILE, {
    id: 'macos-15/bash', runner: 'macos-15', shell: 'bash', source: validator.SOURCE,
  });
});

test('rejects duplicate PID and duplicate target rows', () => {
  const duplicatePid = observation();
  duplicatePid.processes.push({ ...duplicatePid.processes[0], command_line: '/other' });
  duplicatePid.digest = validator.structuralDigest(duplicatePid);
  assert.throws(() => validator.validateObservation(duplicatePid), /duplicate process PID/);

  const duplicateTarget = observation();
  duplicateTarget.services.push({ ...duplicateTarget.services[1] });
  duplicateTarget.digest = validator.structuralDigest(duplicateTarget);
  assert.throws(() => validator.validateObservation(duplicateTarget), /duplicate service target/);
});

test('rejects missing, unknown, malformed, and digest-mismatched data', () => {
  const missing = observation();
  delete missing.source;
  assert.throws(() => validator.validateObservation(missing), /missing or unknown/);

  const unknown = observation({ extra: true });
  assert.throws(() => validator.validateObservation(unknown), /missing or unknown/);

  const malformed = observation();
  malformed.processes[0].state = 'present';
  malformed.processes[0].executable_path = null;
  malformed.digest = validator.structuralDigest(malformed);
  assert.throws(() => validator.validateObservation(malformed), /lacks executable/);

  const mismatched = observation();
  mismatched.digest = '0'.repeat(64);
  assert.throws(() => validator.validateObservation(mismatched), /digest does not match/);
});

test('rejects malformed service error and unsafe targets', () => {
  const value = observation({
    services: [{ target: 'gui/501/../bad', state: 'absent', raw_print: null, error: null }],
  });
  value.digest = validator.structuralDigest(value);
  assert.throws(() => validator.validateObservation(value), /unsafe/);

  const error = observation({
    services: [{ target: 'gui/501/com.example.app', state: 'error', raw_print: null, error: 'denied' }],
    collection_errors: [],
  });
  error.digest = validator.structuralDigest(error);
  assert.throws(() => validator.validateObservation(error), /collection error is missing/);
});
