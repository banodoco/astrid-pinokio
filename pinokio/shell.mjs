// Pinokio's shell.run env can add variables but cannot remove inherited ones.
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import policy from './environment.js';

const DIAGNOSTIC_KINDS = new Set([
  'shell-child-spawn', 'shell-child-error', 'shell-child-exit', 'shell-child-close',
  'bootstrap-stage',
]);
const DIAGNOSTIC_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV']);
const DIAGNOSTIC_STAGES = new Set([
  'bootstrap.download-installer', 'bootstrap.download-manifest',
  'bootstrap.invoke-installer', 'bootstrap.cleanup',
]);
const DIAGNOSTIC_STATUSES = new Set(['start', 'complete']);

function boundedCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}

function boundedSignal(value) {
  return DIAGNOSTIC_SIGNALS.has(value) ? value : null;
}

function appendDiagnostic(file, kind, fields = {}) {
  if (!file || !DIAGNOSTIC_KINDS.has(kind)) return;
  const row = { schema: 'astrid.r25.setup-shell.v1', at: new Date().toISOString(), kind, ...fields };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* Diagnostics must never change the native setup outcome. */ }
}

function stageCommand(stage, status) {
  return `Write-AstridR25Stage '${stage}' '${status}'`;
}

function instrumentBootstrapLine(line, stage) {
  const indent = line.match(/^\s*/)?.[0] || '';
  return `${indent}${stageCommand(stage, 'start')}\n${line}\n${indent}${stageCommand(stage, 'complete')}`;
}

// Add only fixed, non-secret markers around the pinned Windows bootstrap's
// known stages. The command bytes themselves remain the pinned bootstrap.
export function instrumentWindowsBootstrap(message) {
  const lines = String(message).split('\n');
  const instrumented = [];
  let found = false;
  for (const line of lines) {
    if (line.includes('Invoke-WebRequest') && line.includes("'install.ps1'")) {
      instrumented.push(instrumentBootstrapLine(line, 'bootstrap.download-installer'));
      found = true;
    } else if (line.includes('Invoke-WebRequest') && line.includes("'install-manifest.json'")) {
      instrumented.push(instrumentBootstrapLine(line, 'bootstrap.download-manifest'));
      found = true;
    } else if (line.includes('[scriptblock]::Create')) {
      instrumented.push(instrumentBootstrapLine(line, 'bootstrap.invoke-installer'));
      found = true;
    } else if (line.includes('finally { Remove-Item -LiteralPath $tmp -Recurse -Force }')) {
      instrumented.push(line.replace(
        'finally { Remove-Item -LiteralPath $tmp -Recurse -Force }',
        `finally { ${stageCommand('bootstrap.cleanup', 'start')}; Remove-Item -LiteralPath $tmp -Recurse -Force; ${stageCommand('bootstrap.cleanup', 'complete')}; }`,
      ));
      found = true;
    } else instrumented.push(line);
  }
  if (!found) return message;
  const helper = [
    'function Write-AstridR25Stage([string]$Stage, [string]$Status) {',
    "  if (-not $env:ASTRID_R25_SETUP_DIAGNOSTIC_FILE) { return }",
    "  if ($Stage -notin @('bootstrap.download-installer','bootstrap.download-manifest','bootstrap.invoke-installer','bootstrap.cleanup')) { return }",
    "  if ($Status -notin @('start','complete')) { return }",
    "  try { $row = @{ schema = 'astrid.r25.setup-shell.v1'; at = [DateTime]::UtcNow.ToString('o'); kind = 'bootstrap-stage'; stage = $Stage; status = $Status } | ConvertTo-Json -Compress; Add-Content -LiteralPath $env:ASTRID_R25_SETUP_DIAGNOSTIC_FILE -Value $row -Encoding utf8 } catch { }",
    '}',
  ].join('\n');
  return `${helper}\n${instrumented.join('\n')}`;
}

export function runShell({ appDirectory, message, explicit = {}, platform = process.platform,
  environment = process.env, spawnProcess = spawn, pinokioEnvironment = false, ...options }) {
  const inherited = { ...environment };
  for (const key of Object.keys(inherited)) if (key.toUpperCase() === 'ASTRID_PINOKIO_ENVIRONMENT') delete inherited[key];
  const env = pinokioEnvironment ? { ...inherited, ...explicit }
    : policy.buildEnvironment({ appDirectory, platform, environment: inherited, explicit, ...options });
  const win = platform === 'win32';
  const shell = win ? path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
  const diagnosticFile = environment.ASTRID_R25_SETUP_DIAGNOSTICS === '1'
    ? path.join(appDirectory, '_r25-setup-shell-diagnostics.jsonl') : null;
  if (diagnosticFile) env.ASTRID_R25_SETUP_DIAGNOSTIC_FILE = diagnosticFile;
  const nativeMessage = win && diagnosticFile ? instrumentWindowsBootstrap(message) : message;
  const args = win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n${nativeMessage}\nexit $LASTEXITCODE`]
    : ['--noprofile', '--norc', '-c', `set -eu\nunset PWD\n${message}`];
  // Nested installer shells recreate PWD. Run them outside Pinokio's home;
  // every launcher command uses absolute paths (including Git's -C).
  const child = spawnProcess(shell, args, { env, cwd: env.HOME || env.USERPROFILE, stdio: 'inherit' });
  appendDiagnostic(diagnosticFile, 'shell-child-spawn', { pid: Number.isInteger(child?.pid) ? child.pid : null });
  return new Promise((resolve, reject) => {
    child.once('error', () => {
      appendDiagnostic(diagnosticFile, 'shell-child-error', { error: true });
      reject(new Error('Pinokio shell child failed to spawn.'));
    });
    child.once('exit', (code, signal) => appendDiagnostic(diagnosticFile, 'shell-child-exit', {
      code: boundedCode(code), signal: boundedSignal(signal),
    }));
    child.once('close', (code, signal) => {
      appendDiagnostic(diagnosticFile, 'shell-child-close', { code: boundedCode(code), signal: boundedSignal(signal) });
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const [argument, message, explicit] = process.argv.slice(2);
  try {
    const prefix = '--pinokio-payload=';
    const options = argument?.startsWith(prefix)
      ? JSON.parse(Buffer.from(argument.slice(prefix.length), 'base64').toString('utf8'))
      : { appDirectory: argument, message, explicit: JSON.parse(explicit) };
    const pinokioEnvironment = process.env.ASTRID_PINOKIO_ENVIRONMENT === '1';
    process.exitCode = await runShell({ ...options, pinokioEnvironment });
  }
  catch (error) { console.error(`Astrid: ${error.message}`); process.exitCode = 1; }
}
