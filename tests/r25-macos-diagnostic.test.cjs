'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { condaPresence, createMacPtyDiagnostics, RAW_LIMIT } = require('../.github/venue/r25-macos-diagnostic.cjs');

test('records isolated Miniforge and Conda presence without consulting global installations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-macos-conda-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'pinokio-home');
  assert.deepEqual(condaPresence(home, { PATH: '/usr/bin' }), {
    schema: 'astrid.r25.macos-conda-presence.v1', miniforge_root_exists: false,
    conda_path_exists: false, conda_executable: false, conda_directory_on_path: false,
  });
  const conda = path.join(home, 'bin', 'miniforge', 'bin', 'conda');
  fs.mkdirSync(path.dirname(conda), { recursive: true });
  fs.writeFileSync(conda, '#!/bin/sh\n');
  fs.chmodSync(conda, 0o755);
  assert.deepEqual(condaPresence(home, { PATH: `${path.dirname(conda)}:/usr/bin` }), {
    schema: 'astrid.r25.macos-conda-presence.v1', miniforge_root_exists: true,
    conda_path_exists: true, conda_executable: true, conda_directory_on_path: true,
  });
});

test('captures bounded raw onData bytes and records echo state', () => {
  let clock = 10;
  let failTimer;
  const diagnostics = createMacPtyDiagnostics({ probe: 'probe-token', now: () => clock,
    setTimer: fn => { failTimer = fn; return 1; }, clearTimer: () => {} });
  diagnostics.probeWritten();
  diagnostics.onData(Buffer.from('banner probe-token\n'));
  clock += 1;
  diagnostics.promptResolved();
  const value = diagnostics.snapshot();
  assert.equal(value.echo, 'observed');
  assert.equal(value.raw_on_data.bytes_seen, 19);
  assert.equal(Buffer.from(value.raw_on_data.data, 'base64').toString(), 'banner probe-token\n');
  assert.equal(value.prompt_resolved_at_ms, 11);
  assert.equal(typeof failTimer, 'function');
  diagnostics.dispose();
});

test('diagnostic fail-fast fires only for unanswered probe and marker/error/terminated events', () => {
  const failures = [];
  let timer;
  const diagnostics = createMacPtyDiagnostics({ probe: 'nonce', onFailure: value => failures.push(value),
    setTimer: fn => { timer = fn; return 1; }, clearTimer: () => {} });
  diagnostics.probeWritten();
  timer();
  diagnostics.packet({ type: 'error', index: 2 });
  diagnostics.onData('Terminated Shell');
  assert.deepEqual(failures, ['probe-prompt-timeout']);
  assert.equal(diagnostics.snapshot().failure, 'probe-prompt-timeout');
  diagnostics.dispose();

  const marker = createMacPtyDiagnostics({ probe: 'nonce', onFailure: value => failures.push(value) });
  marker.packet({ type: 'stream', index: 2, data: { raw: 'ASTRID_PINOKIO_FAILURE' } });
  assert.equal(failures.at(-1), 'failure-marker');
  const error = createMacPtyDiagnostics({ probe: 'nonce', onFailure: value => failures.push(value) });
  error.packet({ type: 'error' });
  assert.equal(failures.at(-1), 'error-event');
});

test('detects split echo and failure text after the retained raw-byte limit', () => {
  const failures = [];
  const diag = createMacPtyDiagnostics({ probe: 'echo-nonce', rawLimit: 4, onFailure: value => failures.push(value) });
  diag.probeWritten();
  diag.onData('banner echo-');
  diag.onData('nonce');
  assert.equal(diag.snapshot().echo, 'observed');
  diag.onData('0123456789ASTRID_PINOKIO_');
  diag.onData('FAILURE');
  assert.equal(failures.at(-1), 'failure-marker');
  assert.equal(diag.snapshot().raw_on_data.bytes_retained, 4);
  diag.dispose();
});

test('records PTerm wait and daemon terminal emission independently, with bounded raw payload', () => {
  const diag = createMacPtyDiagnostics({ probe: 'nonce', rawLimit: 8 });
  diag.terminalWait('child-exit');
  diag.daemonTerminal('disconnect', true);
  diag.onData(Buffer.from('0123456789abcdef'));
  const value = diag.snapshot();
  assert.equal(value.terminal_wait, 'child-exit');
  assert.deepEqual(value.daemon_terminal_emitted, { event: 'disconnect', emitted: true });
  assert.equal(value.raw_on_data.bytes_seen, 16);
  assert.equal(value.raw_on_data.bytes_retained, 8);
  assert.equal(value.raw_on_data.truncated, true);
  assert.equal(Buffer.from(value.raw_on_data.data, 'base64').toString(), '01234567');
  assert.ok(RAW_LIMIT >= 1024);
  diag.dispose();
});
