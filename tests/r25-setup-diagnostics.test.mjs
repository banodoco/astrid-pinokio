import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentWindowsBootstrap } from '../pinokio/shell.mjs';

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
  assert.doesNotMatch(value, /example\.invalid|C:\\Astrid/);
});

test('leaves an unknown native message unchanged', () => {
  const value = 'Write-Output \'native\'';
  assert.equal(instrumentWindowsBootstrap(value), value);
});
