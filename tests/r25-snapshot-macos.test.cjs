'use strict';

// Component checks only. These tests do not qualify a hosted venue.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const snapshot = require('../pinokio/providers/r25-snapshot-macos.cjs');

function observation() {
  const value = {
    schema: snapshot.SCHEMA,
    source_profile: snapshot.SOURCE_PROFILE,
    captured_at_utc: '2026-11-02T18:14:13.000000Z',
    capture_started_monotonic_ns: '100',
    capture_finished_monotonic_ns: '150',
    collector_pid: 700,
    limits: {
      command_timeout_seconds: 10,
      max_processes: 4096,
      max_ps_bytes: 4194304,
      max_service_bytes: 262144,
      max_service_targets: 64,
    },
    processes: [
      {
        birth_text: 'Mon Nov 02 18:00:01 2026',
        collection_state: 'present',
        command_line: '/Applications/Pinokio.app/Contents/MacOS/Pinokio --serve café',
        executable_path: '/Applications/Pinokio.app/Contents/MacOS/Pinokio',
        parent_pid: 1,
        pid: 42,
      },
      {
        birth_text: 'Mon Nov 02 18:00:02 2026',
        collection_state: 'vanished',
        command_line: '/usr/local/bin/node child.js',
        executable_path: null,
        parent_pid: 42,
        pid: 99,
      },
    ],
    launchd: [
      {
        error: null,
        raw_print: 'gui/501/com.pinokio.backend = {\n\tpid = 42\n}\n',
        returncode: 0,
        state: 'present',
        target: 'gui/501/com.pinokio.backend',
      },
      {
        error: 'not-found',
        raw_print: null,
        returncode: 113,
        state: 'absent',
        target: 'system/com.pinokio.missing',
      },
      {
        error: 'launchctl exited 77',
        raw_print: null,
        returncode: 77,
        state: 'error',
        target: 'system/com.pinokio.problem',
      },
    ],
  };
  value.structural_sha256 = snapshot.structuralDigest(value);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('profile identifies macos-15 and bash without the retired source', () => {
  assert.equal(snapshot.PROFILE.platform, 'macos-15');
  assert.equal(snapshot.PROFILE.shell, 'bash');
  assert.equal(snapshot.PROFILE.id, snapshot.SOURCE_PROFILE);
  assert.match(snapshot.PROFILE.process_source, /ps.*libproc/);
  assert.match(snapshot.PROFILE.service_source, /launchctl print/);
  const source = fs.readFileSync(require.resolve('../pinokio/providers/r25-snapshot-macos.cjs'), 'utf8');
  assert.doesNotMatch(source, /Endpoint\s+Security/i);
});

test('validates present, absent, error, and vanished rows with canonical digest', () => {
  const value = observation();
  assert.equal(snapshot.validateObservation(value), value);
  const bytes = snapshot.canonicalBytes(value);
  assert.match(bytes.toString('ascii'), /caf\\u00e9/);
  assert.deepEqual(snapshot.parseObservation(bytes), value);

  const unsigned = clone(value);
  delete unsigned.structural_sha256;
  assert.equal(
    value.structural_sha256,
    crypto.createHash('sha256').update(snapshot.canonicalBytes(unsigned)).digest('hex'),
  );
});

test('rejects missing and unknown root or row fields', () => {
  const missing = observation();
  delete missing.collector_pid;
  assert.throws(() => snapshot.validateObservation(missing), /missing=collector_pid/);

  const unknown = observation();
  unknown.processes[0].claim = 'qualified';
  unknown.structural_sha256 = snapshot.structuralDigest(unknown);
  assert.throws(() => snapshot.validateObservation(unknown), /unknown=claim/);
});

test('rejects duplicate or unsorted process and target rows', () => {
  const process = observation();
  process.processes[1].pid = 42;
  process.structural_sha256 = snapshot.structuralDigest(process);
  assert.throws(() => snapshot.validateObservation(process), /duplicate or unsorted PID/);

  const target = observation();
  target.launchd[1].target = target.launchd[0].target;
  target.structural_sha256 = snapshot.structuralDigest(target);
  assert.throws(() => snapshot.validateObservation(target), /duplicate or unsorted target/);
});

test('rejects malformed state, source, path, time, and bounded limits', () => {
  const mutations = [
    [value => { value.source_profile = 'alternate'; }, /unknown profile/],
    [value => { value.processes[0].executable_path = 'relative'; }, /absolute path/],
    [value => { value.processes[1].executable_path = '/stale'; }, /vanished process path/],
    [value => { value.launchd[0].returncode = 1; }, /present state fields differ/],
    [value => { value.launchd[1].error = 'maybe'; }, /absent state fields differ/],
    [value => { value.capture_finished_monotonic_ns = '99'; }, /ordered decimal/],
    [value => { value.limits.max_processes = 4097; }, /bounded integer/],
  ];
  for (const [mutate, expected] of mutations) {
    const value = observation();
    mutate(value);
    value.structural_sha256 = snapshot.structuralDigest(value);
    assert.throws(() => snapshot.validateObservation(value), expected);
  }
});

test('rejects a digest mismatch after otherwise valid mutation', () => {
  const value = observation();
  value.processes[0].command_line += ' --changed';
  assert.throws(() => snapshot.validateObservation(value), /digest mismatch/);
});

test('raw parser rejects duplicate object keys, invalid UTF-8, and trailing input', () => {
  assert.throws(() => snapshot.parseJsonNoDuplicates('{"schema":"one","schema":"two"}'), /duplicate JSON key/);
  assert.throws(() => snapshot.parseJsonNoDuplicates(Buffer.from([0xff])), /not UTF-8/);
  assert.throws(() => snapshot.parseJsonNoDuplicates('{}{}'), /trailing JSON input/);
});

test('parser rejects duplicate keys inside a full otherwise-valid observation', () => {
  const json = snapshot.canonicalBytes(observation()).toString('ascii');
  const duplicated = json.replace('{', '{"schema":"astrid.r25.snapshot.macos.v1",');
  assert.throws(() => snapshot.parseObservation(duplicated), /duplicate JSON key: schema/);
});
