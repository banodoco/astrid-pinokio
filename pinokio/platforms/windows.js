'use strict';

const path = require('node:path').win32;
const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;

function bootstrap({ root, installerUrl, installerFile, manifest, manifestUrl, action = 'install', deleteData = false, yes = false }) {
  const q = quotePowerShell;
  const args = ['--root', q(root), '--managed-by', 'pinokio'];
  if (yes) args.push('--yes');
  if (action !== 'install') args.push(`--${action}`);
  if (deleteData) args.push('--delete-data');
  if (manifest) args.push('--manifest', q(manifest));
  const invoke = (file, extra = '') => [
    `& ${file} ${args.join(' ')}${extra}`,
    "if ($LASTEXITCODE -ne 0) { throw \"Astrid installer failed (exit $LASTEXITCODE).\" }",
  ];
  if (installerFile) return ["$ErrorActionPreference = 'Stop'", `& powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${q(installerFile)} ${args.join(' ')}`, "if ($LASTEXITCODE -ne 0) { throw 'Astrid installer failed.' }"].join('\n');
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    "$tmp = Join-Path ([IO.Path]::GetTempPath()) ('astrid-pinokio-' + [Guid]::NewGuid().ToString('N'))",
    'New-Item -ItemType Directory -Path $tmp | Out-Null',
    'try {',
    `  Invoke-WebRequest -UseBasicParsing ${q(installerUrl)} -OutFile (Join-Path $tmp 'install.ps1')`,
    ...(manifestUrl ? [`  Invoke-WebRequest -UseBasicParsing ${q(manifestUrl)} -OutFile (Join-Path $tmp 'install-manifest.json')`] : []),
    '  $global:LASTEXITCODE = 0',
    // ScriptBlock invocation matches the production interface, including its
    // exception-based failure path. The downloaded file is also reviewable.
    ...invoke("([scriptblock]::Create((Get-Content -Raw -LiteralPath (Join-Path $tmp 'install.ps1'))))", manifestUrl ? " --manifest (Join-Path $tmp 'install-manifest.json')" : '').map((line) => `  ${line}`),
    '} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }',
  ].join('\n');
}

function run(root, args = []) {
  return `& ${quotePowerShell(path.join(root, 'run.cmd'))}${args.length ? ` ${args.map(quotePowerShell).join(' ')}` : ''}`;
}

module.exports = { quotePowerShell, bootstrap, run };
