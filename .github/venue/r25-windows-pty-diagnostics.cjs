'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PINOKIOD_REF, PINOKIOD_SHELL_RELATIVE } = require('./r25-pinokiod-pty-instrumentation.cjs');

const MAX_CAPTURE_BYTES = 4096;
const MAX_ROWS = 24;
const RAW_BYTES = 1536;
const FAIL_FAST_MS = 90_000;
const ENV_KEYS = Object.freeze(['COMSPEC', 'ComSpec', 'PATHEXT', 'PROMPT', 'PSModulePath', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']);
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
let __r25WinBytes = 0;
let __r25WinRawBytes = 0;
function __r25WinCapture(kind, fields = {}) {
  if (process.platform !== 'win32' || process.env.ASTRID_R25_SETUP_DIAGNOSTICS !== '1') return;
  const file = process.env.ASTRID_R25_WINDOWS_PTY_CAPTURE_FILE;
  if (typeof file !== 'string' || !file) return;
  const row = { at: new Date().toISOString(), kind };
  if (kind === 'spawn') {
    row.role = fields.role;
    row.shell = typeof fields.shell === 'string' ? __r25WinPath.basename(fields.shell).slice(0, 80) : null;
    row.args = Array.isArray(fields.args) ? fields.args.slice(0, 12).map(value => String(value).slice(0, 120)) : [];
    row.cwd = typeof fields.cwd === 'string' ? __r25WinPath.basename(fields.cwd).slice(0, 80) : null;
    row.env = {};
    for (const key of ${JSON.stringify(ENV_KEYS)}) {
      const value = fields.env && fields.env[key];
      row.env[key] = typeof value === 'string' ? { present: true, sha256: __r25WinCrypto.createHash('sha256').update(value).digest('hex'), length: value.length } : { present: false };
    }
    if (fields.role === 'registry-check' || fields.role === 'prompt-2') {
      const prior = __r25WinRows.find(item => item.kind === 'spawn' && item.role === (fields.role === 'registry-check' ? 'prompt-2' : 'registry-check'));
      if (prior) {
        row.diff = { shell_equal: row.shell === prior.shell, args_equal: JSON.stringify(row.args) === JSON.stringify(prior.args), cwd_equal: row.cwd === prior.cwd,
          env_changed: Object.keys(row.env).filter(key => JSON.stringify(row.env[key]) !== JSON.stringify(prior.env[key])) };
      }
    }
  } else if (kind === 'raw-ondata') {
    row.role = fields.role || null;
    const text = typeof fields.data === 'string' ? fields.data : '';
    const room = Math.max(0, ${RAW_BYTES} - __r25WinRawBytes);
    row.raw = Buffer.from(text, 'utf8').subarray(0, room).toString('utf8');
    row.raw_bytes = Buffer.byteLength(row.raw, 'utf8');
    row.truncated = row.raw.length < text.length;
    __r25WinRawBytes += row.raw_bytes;
    row.echo_probe_count = (text.match(/(?:^|[\s>])echo pinokio(?=[\r\n])/gi) || []).length;
    const echoState = /(?:^|[\r\n])ECHO is (on|off)\.?(?=[\r\n]|$)/i.exec(text);
    row.cmd_echo_state = echoState ? echoState[1].toLowerCase() : null;
  }
  const line = JSON.stringify(row) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  while (__r25WinRows.length >= ${MAX_ROWS} || __r25WinBytes + bytes > ${MAX_CAPTURE_BYTES}) {
    const index = __r25WinRows.findIndex(item => item.kind === 'raw-ondata');
    if (index < 0) return;
    __r25WinBytes -= Buffer.byteLength(__r25WinRows[index], 'utf8');
    __r25WinRows.splice(index, 1);
  }
  __r25WinRows.push(line);
  __r25WinBytes += bytes;
  try { __r25WinFs.mkdirSync(__r25WinPath.dirname(file), { recursive: true }); __r25WinFs.writeFileSync(file, __r25WinRows.join(''), { encoding: 'utf8', mode: 0o600 }); } catch {}
}
`;
  replaceOnce("const __r25PtyFs = require('fs');\n", helper + "\nconst __r25PtyFs = require('fs');\n", 'runtime-helper');
  replaceOnce("      __r25PtySetPromptPid(term?.pid)\n", "      __r25PtySetPromptPid(term?.pid)\n      __r25WinCapture('spawn', { role: __r25PromptOrdinal === 2 ? 'prompt-2' : 'prompt-1', shell: this.shell, args: this.args, cwd: config.cwd || this.path, env: config.env })\n", 'prompt-spawn');
  replaceOnce("        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;", "        __r25WinCapture('raw-ondata', { data })\n        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;", 'raw-ondata');
  replaceOnce("          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })\n", "          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })\n          const __r25RegistryCheck = /reg query HKLM\\\\SYSTEM\\\\CurrentControlSet\\\\Control\\\\FileSystem\\s+\\/v\\s+LongPathsEnabled/i.test(String(this.exec_cmd || this.cmd || this.command || ''))\n          if (__r25RegistryCheck) __r25WinCapture('spawn', { role: 'registry-check', shell: this.shell, args: shellArgs, cwd: config.cwd, env: config.env })\n", 'registry-control-spawn');
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

function createWindowsProbeFailFast({ captureFile, onFail, now = () => Date.now(), intervalMs = 250, timeoutMs = FAIL_FAST_MS } = {}) {
  let child = null;
  let timer = null;
  let interval = null;
  let probeAt = null;
  let stopped = false;
  let failure = null;
  let offset = 0;
  let fileTail = '';
  let streamTail = '';
  const fail = reason => {
    if (stopped || failure) return;
    failure = { reason, at: new Date(now()).toISOString() };
    try { onFail?.(failure); } catch {}
    try { child?.kill('SIGTERM'); } catch {}
  };
  const scan = () => {
    if (stopped || failure) return;
    try {
      const stat = fs.statSync(captureFile);
      if (stat.size > MAX_CAPTURE_BYTES) return fail('capture-overflow');
      if (stat.size > offset) {
        const fd = fs.openSync(captureFile, 'r');
        const buffer = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        const text = fileTail + buffer.toString('utf8');
        const lines = text.split('\n');
        fileTail = lines.pop() || '';
        for (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.kind === 'prompt-probe-write-return' && probeAt === null) {
            probeAt = now();
            timer = setTimeout(() => fail('probe-unanswered-90s'), timeoutMs);
          }
          if (row.kind === 'prompt-recognized') { clearTimeout(timer); timer = null; }
        }
      }
    } catch (error) { if (error?.code !== 'ENOENT') fail('capture-read-error'); }
  };
  return {
    start(value) { child = value; interval = setInterval(scan, intervalMs); scan(); },
    packet(packet) {
      if (packet?.type === 'error' || packet?.type === 'installer-failure-marker') fail(packet.type);
      const raw = typeof packet?.data?.raw === 'string' ? packet.data.raw : '';
      const combined = streamTail + raw;
      if (combined.includes(FAILURE_MARKER)) fail('failure-marker');
      if (/Terminated Shell\b/.test(combined)) fail('terminated-shell');
      streamTail = combined.slice(-Math.max(FAILURE_MARKER.length, 32));
    },
    stop() { stopped = true; clearTimeout(timer); clearInterval(interval); },
    result() { return failure ? { ...failure } : null; },
  };
}

module.exports = { FAIL_FAST_MS, MAX_CAPTURE_BYTES, RAW_BYTES, applyWindowsPtyDiagnostics, createWindowsProbeFailFast, patchWindowsSource };
