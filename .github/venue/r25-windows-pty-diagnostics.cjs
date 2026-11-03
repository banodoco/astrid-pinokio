'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PINOKIOD_REF, PINOKIOD_SHELL_RELATIVE } = require('./r25-pinokiod-pty-instrumentation.cjs');

const MAX_CAPTURE_BYTES = 16384;
const MAX_ROWS = 24;
const RAW_BYTES = 1536;
const FAIL_FAST_MS = 90_000;
const ENV_KEYS = Object.freeze(['COMSPEC', 'ComSpec', 'PATHEXT', 'PROMPT', 'PSModulePath', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'CONDA_PREFIX', 'CONDA_SHLVL', 'CONDA_EXE']);
const FAILURE_MARKER = 'ASTRID_PINOKIO_FAILURE';

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function patchWindowsSource(source, { expectedHead = PINOKIOD_REF } = {}) {
  if (expectedHead !== PINOKIOD_REF) throw new Error('Windows PTY diagnostic requires the pinned pinokiod ref');
  const rows = [];
  const replaceOnce = (needle, replacement, label) => {
    const first = source.indexOf(needle);
    if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) throw new Error(`Windows PTY diagnostic anchor ${label} is not unique (${first < 0 ? 0 : 2}+ matches)`);
    source = source.slice(0, first) + replacement + source.slice(first + needle.length);
  };
  const helper = String.raw`
const __r25WinFs = require('fs');
const __r25WinPath = require('path');
const __r25WinCrypto = require('crypto');
const __r25WinRows = [];
const __r25WinRaw = new Map();
function __r25WinHash(value) { return __r25WinCrypto.createHash('sha256').update(String(value)).digest('hex'); }
function __r25WinRedact(value) {
  return value.replace(/((?:token|password|passwd|secret|authorization|api[-_ ]?key)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
function __r25WinCapture(kind, fields = {}) {
  if (process.platform !== 'win32' || process.env.ASTRID_R25_SETUP_DIAGNOSTICS !== '1') return;
  const file = process.env.ASTRID_R25_WINDOWS_PTY_CAPTURE_FILE;
  if (typeof file !== 'string' || !file) return;
  const role = fields.role;
  if (!['registry-check', 'prompt-1', 'prompt-2'].includes(role)) return;
  let row = __r25WinRows.find(item => item.kind === kind && item.role === role);
  if (!row) { row = { at: new Date().toISOString(), kind, role }; __r25WinRows.push(row); }
  if (kind === 'spawn') {
    row.pid = Number.isInteger(fields.pid) ? fields.pid : null;
    row.shell = typeof fields.shell === 'string' ? __r25WinPath.win32.basename(fields.shell).slice(0, 80) : null;
    row.shell_sha256 = __r25WinHash(fields.shell || '');
    row.args = Array.isArray(fields.args) ? fields.args.slice(0, 12).map(value => /^\/[a-z]$/i.test(String(value)) ? String(value) : 'sha256:' + __r25WinHash(value)) : [];
    row.cwd_sha256 = __r25WinHash(fields.cwd || '');
    row.env = {};
    for (const key of ${JSON.stringify(ENV_KEYS)}) {
      const value = fields.env && fields.env[key];
      row.env[key] = typeof value === 'string' ? { present: true, sha256: __r25WinHash(value), length: value.length } : { present: false };
    }
    if (role === 'registry-check' || role === 'prompt-2') {
      const prior = __r25WinRows.find(item => item.kind === 'spawn' && item.role === (role === 'registry-check' ? 'prompt-2' : 'registry-check'));
      if (prior) row.diff = { shell_equal: row.shell_sha256 === prior.shell_sha256,
        args_equal: JSON.stringify(row.args) === JSON.stringify(prior.args), cwd_equal: row.cwd_sha256 === prior.cwd_sha256,
        env_changed: Object.keys(row.env).filter(key => JSON.stringify(row.env[key]) !== JSON.stringify(prior.env[key])) };
    }
  } else if (kind === 'raw-ondata' && role !== 'prompt-1') {
    const text = typeof fields.data === 'string' ? fields.data : '';
    const previous = __r25WinRaw.get(role) || { data: Buffer.alloc(0), carry: '', bytes_seen: 0 };
    const combined = previous.carry + text;
    previous.bytes_seen += Buffer.byteLength(text, 'utf8');
    previous.data = Buffer.concat([previous.data, Buffer.from(text, 'utf8')]).subarray(0, ${RAW_BYTES});
    previous.carry = combined.slice(-64);
    __r25WinRaw.set(role, previous);
    row.raw = __r25WinRedact(previous.data.toString('utf8'));
    row.raw_bytes = Buffer.byteLength(row.raw, 'utf8');
    row.bytes_seen = previous.bytes_seen;
    row.truncated = previous.bytes_seen > ${RAW_BYTES};
    row.echo_probe_observed = row.echo_probe_observed === true || /(?:^|[\s>])echo pinokio(?=[\r\n])/i.test(combined);
    const echoState = /(?:^|[\r\n])ECHO is (on|off)\.?(?=[\r\n]|$)/i.exec(combined);
    row.cmd_echo_state = echoState ? echoState[1].toLowerCase() : row.cmd_echo_state || null;
  }
  const serialized = __r25WinRows.map(item => JSON.stringify(item) + '\n').join('');
  if (__r25WinRows.length > ${MAX_ROWS} || Buffer.byteLength(serialized, 'utf8') > ${MAX_CAPTURE_BYTES}) return;
  try { __r25WinFs.mkdirSync(__r25WinPath.dirname(file), { recursive: true }); __r25WinFs.writeFileSync(file, serialized, { encoding: 'utf8', mode: 0o600 }); } catch {}
}
`;
  replaceOnce("const __r25PtyFs = require('fs');\n", helper + "\nconst __r25PtyFs = require('fs');\n", 'runtime-helper');
  replaceOnce("      __r25PtySetPromptPid(term?.pid)\n", "      __r25PtySetPromptPid(term?.pid)\n      __r25WinCapture('spawn', { role: __r25PromptOrdinal === 2 ? 'prompt-2' : 'prompt-1', shell: this.shell, args: this.args, cwd: config.cwd || this.path, env: config.env })\n", 'prompt-spawn');
  replaceOnce("        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;", "        __r25WinCapture('raw-ondata', { data, role: __r25PromptOrdinal === 2 ? 'prompt-2' : 'prompt-1' })\n        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;", 'raw-ondata');
  replaceOnce("          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })\n", "          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })\n          const __r25RegistryCheck = String(this.exec_cmd || this.cmd || '').includes('LongPathsEnabled') && /reg query/i.test(String(this.exec_cmd || this.cmd || ''))\n          if (__r25RegistryCheck) __r25WinCapture('spawn', { role: 'registry-check', pid: this.ptyProcess?.pid, shell: this.shell, args: shellArgs, cwd: config.cwd, env: config.env })\n", 'registry-control-spawn');
  replaceOnce("          this.ptyProcess.onData((data) => {\n", "          this.ptyProcess.onData((data) => {\n            __r25WinCapture('raw-ondata', { data, role: __r25RegistryCheck ? 'registry-check' : 'exec' })\n", 'registry-control-raw-ondata');
  return { source, patchedSha256: sha(source), replacements: ['runtime-helper', 'prompt-spawn', 'raw-ondata', 'registry-control-spawn', 'registry-control-raw-ondata'] };
}

function applyWindowsPtyDiagnostics(pinokiodRoot, { verifyGit = true, diagnosticFile } = {}) {
  if (process.platform !== 'win32') return { enabled: false, reason: 'non-windows-platform' };
  if (verifyGit) {
    const { execFileSync } = require('node:child_process');
    const head = execFileSync('git', ['-C', pinokiodRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== PINOKIOD_REF) throw new Error('Windows PTY diagnostic requires exact pinokiod ref');
  }
  const file = path.join(pinokiodRoot, PINOKIOD_SHELL_RELATIVE);
  const source = fs.readFileSync(file, 'utf8');
  const result = patchWindowsSource(source);
  fs.writeFileSync(file, result.source, { encoding: 'utf8', flag: 'w' });
  if (sha(fs.readFileSync(file)) !== result.patchedSha256) throw new Error('Windows PTY diagnostic patch verification failed');
  return { enabled: true, patched_sha256: result.patchedSha256, diagnostic_file: diagnosticFile || null, replacements: result.replacements, max_capture_bytes: MAX_CAPTURE_BYTES, raw_bytes: RAW_BYTES };
}

module.exports = { FAIL_FAST_MS, MAX_CAPTURE_BYTES, RAW_BYTES, applyWindowsPtyDiagnostics, patchWindowsSource };
