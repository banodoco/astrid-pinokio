'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  PTY_MARKERS,
  RUNTIME,
  applyPinokiodPtyInstrumentation,
  createBoundedMarkerWriter,
  patchSource,
  sha256,
  PRESERVED_MARKERS,
} = require('../.github/venue/r25-pinokiod-pty-instrumentation.cjs');

function sourceFixture() {
  return [
    'const path = require("path")',
    '      let term = pty.spawn(this.shell, this.args, config)',
    '      term.onData((data) => {',
    '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)',
    '              term.kill()',
    '          this.ptyProcess = pty.spawn(this.shell, shellArgs, config)',
    '          this.ptyProcess.onData((data) => {',
    '            this.ready = true',
    '              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)',
  ];
}

test('patches the exact source anchors and exposes every bounded PTY boundary marker', () => {
  const source = sourceFixture().join('\n') + '\n';
  const result = patchSource(source, { expectedSha256: sha256(Buffer.from(source, 'utf8')) });
  assert.equal(result.replacements.length, 9);
  for (const marker of PTY_MARKERS) assert.match(result.source, new RegExp(marker));
  assert.match(result.source, /__r25PromptFirstOutput = true; __r25PtyCapture\('prompt-first-output'\)[\s\S]*else if \(!__r25PromptFollowupOutput\)[\s\S]*prompt-followup-output/);
  const preProbe = result.source.indexOf("__r25PtyCapture('prompt-probe-write')");
  const write = result.source.indexOf('term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)', preProbe);
  const returned = result.source.indexOf('__r25PromptProbeWriteReturned = true', write);
  const returnMarker = result.source.indexOf("__r25PtyCapture('prompt-probe-write-return')", returned);
  const postCallback = result.source.indexOf("if (__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput)");
  const postMarker = result.source.indexOf("__r25PtyCapture('prompt-post-probe-output')", postCallback);
  assert.ok(preProbe >= 0 && preProbe < write && write < returned && returned < returnMarker);
  assert.ok(postCallback >= 0 && postMarker > postCallback);
  assert.match(result.source, /if \(__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput\) \{ __r25PromptPostProbeOutput = true; __r25PtyCapture\('prompt-post-probe-output'\) \}/);
  assert.deepEqual(PRESERVED_MARKERS, ['prompt-probe-write-return', 'prompt-post-probe-output']);
  assert.notEqual(result.patchedSha256, result.sourceSha256);
});

test('fails closed on a source mismatch without modifying the checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-patch-mismatch-'));
  try {
    const source = sourceFixture().join('\n') + '\n';
    const file = path.join(root, 'kernel', 'shell.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    assert.throws(() => applyPinokiodPtyInstrumentation(root, {
      diagnosticFile: path.join(root, 'markers.jsonl'), verifyGit: false, expectedSha256: '0'.repeat(64),
    }), /source hash differs/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('redacts arbitrary fields and keeps marker output bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-marker-bounds-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const writer = createBoundedMarkerWriter(file, { maxRows: 16, maxBytes: 512 });
    writer.write('exec-command-write', { command: 'do-not-retain', token: 'secret-value' });
    for (let index = 0; index < 30; index += 1) writer.write('prompt-pty-spawn', { pid: index + 1, ppid: 99 });
    const output = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 512);
    assert.ok(output.split('\n').filter(Boolean).length <= 16);
    assert.doesNotMatch(output, /do-not-retain|secret-value|command|token/);
    assert.match(output, /prompt-pty-spawn/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the two probe boundary markers survive ring overflow without duplication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-marker-preservation-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const writer = createBoundedMarkerWriter(file, { maxRows: 16, maxBytes: 512 });
    writer.write('prompt-probe-write-return');
    writer.write('prompt-post-probe-output');
    for (let index = 0; index < 40; index += 1) writer.write('exec-pty-spawn', { pid: index + 1, ppid: 99 });
    writer.write('prompt-probe-write-return');
    const output = fs.readFileSync(file, 'utf8');
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(Buffer.byteLength(output, 'utf8') <= 512);
    assert.ok(rows.length <= 16);
    for (const marker of PRESERVED_MARKERS) assert.equal(rows.filter(row => row.kind === marker).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected runtime keeps the actual marker file bounded and command-free', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-runtime-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    vm.runInNewContext(`${RUNTIME}\n__r25PtyCapture('prompt-probe-write-return');\n__r25PtyCapture('prompt-post-probe-output');\n__r25PtyCapture('exec-command-write', { command: 'do-not-retain', token: 'secret-value' });\nfor (let i = 0; i < 30; i += 1) __r25PtyCapture('prompt-pty-spawn', { pid: i + 1, ppid: 99 });`, {
      Buffer, Date, JSON, Set,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
      require,
    });
    const output = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 4096);
    assert.ok(output.split('\n').filter(Boolean).length <= 16);
    assert.doesNotMatch(output, /do-not-retain|secret-value|command|token/);
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const marker of PRESERVED_MARKERS) assert.equal(rows.filter(row => row.kind === marker).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
