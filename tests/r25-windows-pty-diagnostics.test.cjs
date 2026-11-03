'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_CAPTURE_BYTES, RAW_BYTES, createWindowsProbeFailFast, patchWindowsSource } = require('../.github/venue/r25-windows-pty-diagnostics.cjs');

function patchedFixture() {
  return [
    "const __r25PtyFs = require('fs');",
    "      __r25PtySetPromptPid(term?.pid)",
    "        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;",
    "          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })",
    "          this.ptyProcess.onData((data) => {",
    '          if (!__r25ExecFirstOutput) { __r25ExecFirstOutput = true; __r25PtyCapture(\'exec-first-output\') }',
  ].join('\n');
}

test('Windows overlay captures raw callbacks and registry-control versus prompt-2 spawn identity', () => {
  const result = patchWindowsSource(patchedFixture());
  assert.deepEqual(result.replacements, ['runtime-helper', 'prompt-spawn', 'raw-ondata', 'registry-control-spawn', 'registry-control-raw-ondata']);
  assert.match(result.source, /__r25WinCapture\('raw-ondata', \{ data \}\)/);
  assert.match(result.source, /role: 'registry-check'/);
  assert.match(result.source, /role: __r25PromptOrdinal === 2 \? 'prompt-2'/);
  assert.match(result.source, /env_changed/);
  assert.ok(result.patchedSha256.length === 64);
  assert.equal(MAX_CAPTURE_BYTES, 4096);
  assert.equal(RAW_BYTES, 1536);
});

test('Windows fail-fast expires 90 seconds after unanswered prompt probe write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-windows-probe-timeout-'));
  try {
    const file = path.join(root, 'pty.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ kind: 'prompt-probe-write-return' })}\n`);
    let killed = 0;
    const watchdog = createWindowsProbeFailFast({ captureFile: file, timeoutMs: 20, intervalMs: 2, onFail: () => {} });
    watchdog.start({ kill() { killed += 1; } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(watchdog.result().reason, 'probe-unanswered-90s');
    assert.equal(killed, 1);
    watchdog.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows fail-fast stops PTerm on an engine failure marker or Terminated Shell text', () => {
  for (const [packet, expected] of [
    [{ type: 'stream', data: { raw: 'ASTRID_PINOKIO_FAILURE: probe' } }, 'failure-marker'],
    [{ type: 'stream', data: { raw: '██ Terminated Shell 123' } }, 'terminated-shell'],
    [{ type: 'error', data: 'failure' }, 'error'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-windows-probe-marker-'));
    try {
      let killed = 0;
      const watchdog = createWindowsProbeFailFast({ captureFile: path.join(root, 'missing.jsonl') });
      watchdog.start({ kill() { killed += 1; } });
      watchdog.packet(packet);
      assert.equal(watchdog.result().reason, expected);
      assert.equal(killed, 1);
      watchdog.stop();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
