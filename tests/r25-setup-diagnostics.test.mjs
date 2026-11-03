import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { instrumentWindowsBootstrap } from '../pinokio/shell.mjs';

const require = createRequire(import.meta.url);
const { createInstallDiagnostics } = require('../.github/venue/r21-observer-diagnostics.cjs');
const { createBoundedCapture, copyBoundedTail, ptyCaptureStatus } = require('../.github/venue/r25-snapshot-runner.cjs');
const runner = fs.readFileSync(new URL('../.github/venue/r25-snapshot-runner.cjs', import.meta.url), 'utf8');

const bootstrap = [
  "Invoke-WebRequest -UseBasicParsing 'https://example.invalid/install.ps1' -OutFile (Join-Path $tmp 'install.ps1')",
  "Invoke-WebRequest -UseBasicParsing 'https://example.invalid/install-manifest.json' -OutFile (Join-Path $tmp 'install-manifest.json')",
  "& ([scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $tmp 'install.ps1')))) --root 'C:\\Astrid'",
  'finally { Remove-Item -LiteralPath $tmp -Recurse -Force }',
].join('\n');

test('instruments only bounded Windows bootstrap stages', () => {
  const value = instrumentWindowsBootstrap(bootstrap);
  for (const stage of ['bootstrap.download-installer', 'bootstrap.download-manifest', 'bootstrap.invoke-installer', 'bootstrap.cleanup']) {
    assert.match(value, new RegExp(stage.replaceAll('.', '\\.') + "'.*'start"));
    assert.match(value, new RegExp(stage.replaceAll('.', '\\.') + "'.*'complete"));
  }
  assert.match(value, /example\.invalid/);
  assert.match(value, /C:\\Astrid/);
});

test('leaves an unknown native message unchanged', () => {
  const value = 'Write-Output \'native\'';
  assert.equal(instrumentWindowsBootstrap(value), value);
});

test('seeds setup-only diagnostics in the daemon environment before shell.run', () => {
  const setupOnly = runner.indexOf("const setupOnly = cli['setup-only'] === 'true';");
  const recorder = runner.indexOf('const setupDiagnostics = createInstallDiagnostics', setupOnly);
  const daemonFlag = runner.indexOf("...(setupOnly ? { ASTRID_R25_SETUP_DIAGNOSTICS: '1' } : {})", recorder);
  const daemon = runner.indexOf('const daemon = spawn', setupOnly);
  const setupAction = runner.indexOf('preparation = await observeAction', daemonFlag);
  assert.ok(setupOnly >= 0);
  assert.ok(recorder > setupOnly);
  assert.ok(daemonFlag > recorder);
  assert.ok(daemon > daemonFlag);
  assert.ok(setupAction > daemonFlag);
});

test('retains bounded shell child lifecycle and bootstrap stage evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-setup-diagnostic-'));
  const shellLog = path.join(root, 'shell.jsonl');
  fs.writeFileSync(shellLog, [
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T21:59:59.000Z', kind: 'shell-helper-start', pid: 41, ppid: 40 }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:00.000Z', kind: 'shell-child-spawn', pid: 42, ppid: 41 }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:01.000Z', kind: 'bootstrap-stage', stage: 'bootstrap.invoke-installer', status: 'start' }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:02.000Z', kind: 'shell-child-exit', code: null, signal: 'SIGTERM' }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:02.000Z', kind: 'shell-child-close', code: null, signal: 'SIGTERM' }),
  ].join('\n'));
  let saved;
  const diagnostics = createInstallDiagnostics({ schema: 'astrid.r25.pinokio-setup-diagnostics.v1' }, value => { saved = value; });
  diagnostics.shell(shellLog);
  assert.deepEqual(saved.shell_events.map(item => item.kind), ['shell-helper-start', 'shell-child-spawn', 'bootstrap-stage', 'shell-child-exit', 'shell-child-close']);
  assert.deepEqual(saved.shell_events[0], { at: '2026-11-02T21:59:59.000Z', kind: 'shell-helper-start', pid: 41, ppid: 40 });
  assert.equal(saved.shell_events[3].signal, 'SIGTERM');
  assert.equal(saved.shell_events[2].stage, 'bootstrap.invoke-installer');
  fs.rmSync(root, { recursive: true, force: true });
});

test('daemon and PTerm output capture is byte-bounded and redacts secrets split across chunks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-setup-output-'));
  try {
    const file = path.join(root, 'pterm.stdout.log');
    const capture = createBoundedCapture(file, 128);
    capture.append('x'.repeat(300));
    capture.append('installer: token=super-');
    capture.append('secret\nhttps://example.test/install?credential=private\n');
    const stats = capture.close();
    const output = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 128);
    assert.equal(stats.truncated, true);
    assert.doesNotMatch(output, /super-secret|credential=private/);
    assert.match(output, /\[REDACTED\]/);
    // Node exposes POSIX mode bits on Unix; Windows reports inherited ACL-backed
    // mode bits instead, so this check is not portable. Redaction and byte
    // bounds above remain required on every platform.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer output copy keeps only a bounded redacted tail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-installer-output-'));
  try {
    const source = path.join(root, 'install.log');
    const destination = path.join(root, 'diagnostics', 'installer-output.log');
    fs.writeFileSync(source, `${'old\n'.repeat(100)}password=private\ninstaller frame 42\n`);
    const result = copyBoundedTail(source, destination, 128);
    const output = fs.readFileSync(destination, 'utf8');
    assert.equal(result.status, 'captured');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 128);
    assert.doesNotMatch(output, /password=private/);
    assert.match(output, /installer frame 42/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('projects PTY sidecar health as present, empty, missing, or invalid with byte count and hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-capture-status-'));
  try {
    const file = path.join(root, 'r25-pty-diagnostics.jsonl');
    assert.deepEqual(ptyCaptureStatus(file), { status: 'missing', bytes: 0, sha256: null, runtime_ready: false });
    fs.writeFileSync(file, '');
    const empty = ptyCaptureStatus(file);
    assert.equal(empty.status, 'empty');
    assert.equal(empty.bytes, 0);
    assert.match(empty.sha256, /^[a-f0-9]{64}$/);
    const row = `${JSON.stringify({ at: '2026-11-03T00:00:00.000Z', kind: 'runtime-ready' })}\n`;
    fs.writeFileSync(file, row);
    const present = ptyCaptureStatus(file);
    assert.equal(present.status, 'present');
    assert.equal(present.bytes, Buffer.byteLength(row));
    assert.equal(present.runtime_ready, true);
    assert.match(present.sha256, /^[a-f0-9]{64}$/);
    fs.writeFileSync(file, '{invalid}\n');
    assert.equal(ptyCaptureStatus(file).status, 'invalid');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
