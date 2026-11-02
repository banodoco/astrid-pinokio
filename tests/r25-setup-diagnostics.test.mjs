import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { instrumentWindowsBootstrap } from '../pinokio/shell.mjs';

const require = createRequire(import.meta.url);
const { createInstallDiagnostics } = require('../.github/venue/r21-observer-diagnostics.cjs');

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

test('retains bounded shell child lifecycle and bootstrap stage evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-setup-diagnostic-'));
  const shellLog = path.join(root, 'shell.jsonl');
  const output = path.join(root, 'diagnostics.json');
  fs.writeFileSync(shellLog, [
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:00.000Z', kind: 'shell-child-spawn', pid: 42 }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:01.000Z', kind: 'bootstrap-stage', stage: 'bootstrap.invoke-installer', status: 'start' }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:02.000Z', kind: 'shell-child-exit', code: null, signal: 'SIGTERM' }),
    JSON.stringify({ schema: 'astrid.r25.setup-shell.v1', at: '2026-11-02T22:00:02.000Z', kind: 'shell-child-close', code: null, signal: 'SIGTERM' }),
  ].join('\n'));
  let saved;
  const diagnostics = createInstallDiagnostics({ schema: 'astrid.r25.pinokio-setup-diagnostics.v1' }, value => { saved = value; });
  diagnostics.shell(shellLog);
  assert.deepEqual(saved.shell_events.map(item => item.kind), ['shell-child-spawn', 'bootstrap-stage', 'shell-child-exit', 'shell-child-close']);
  assert.equal(saved.shell_events[2].signal, 'SIGTERM');
  assert.equal(saved.shell_events[1].stage, 'bootstrap.invoke-installer');
  fs.rmSync(root, { recursive: true, force: true });
});
