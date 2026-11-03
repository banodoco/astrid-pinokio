'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PINOKIOD_REF = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const PINOKIOD_SHELL_RELATIVE = 'kernel/shell.js';
const PINOKIOD_SHELL_SHA256 = 'e39ebef4ffcbd381cd1f3962b56ddfead3ed4354733d15d2d3a2d23ecf5a7da6';
const PTY_MARKERS = Object.freeze([
  'prompt-pty-spawn', 'prompt-first-output', 'prompt-recognized',
  'prompt-kill-start', 'prompt-kill-end', 'prompt-native-exit',
  'exec-pty-spawn', 'exec-first-output', 'exec-prompt-recognized',
  'exec-command-write', 'exec-native-exit',
]);
const MAX_ROWS = 16;
const MAX_BYTES = 4096;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

// This code is injected into the disposable, exact-pinned daemon checkout.
// It never retains PTY bytes, command text, environment values, or errors.
const RUNTIME = String.raw`
const __r25PtyFs = require('fs');
const __r25PtyPath = require('path');
const __r25PtyMarkers = new Set(${JSON.stringify(PTY_MARKERS)});
const __r25PtyRows = [];
let __r25PtyBytes = 0;
function __r25PtyPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : null;
}
function __r25PtyCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}
function __r25PtySignal(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
}
function __r25PtyErrorCode(error) {
  return __r25PtyCode(error?.errno);
}
function __r25PtyCapture(kind, fields = {}) {
  const file = process.env.ASTRID_R25_PTY_CAPTURE_FILE;
  if (process.env.ASTRID_R25_SETUP_DIAGNOSTICS !== '1' || typeof file !== 'string' || !file || !__r25PtyMarkers.has(kind)) return;
  const row = { at: new Date().toISOString(), kind };
  if (kind.endsWith('-pty-spawn')) {
    row.pid = __r25PtyPid(fields.pid);
    row.ppid = __r25PtyPid(fields.ppid);
  } else if (kind.endsWith('-kill-start') || kind.endsWith('-kill-end')) {
    row.requested_pid = __r25PtyPid(fields.requested_pid);
    if (kind.endsWith('-kill-end')) {
      row.error = fields.error === true;
      row.native_error_code = __r25PtyErrorCode(fields.error_value);
    }
  } else if (kind.endsWith('-native-exit')) {
    row.requested_pid = __r25PtyPid(fields.requested_pid);
    row.code = __r25PtyCode(fields.code);
    row.signal = __r25PtySignal(fields.signal);
  }
  const line = JSON.stringify(row) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > ${MAX_BYTES}) return;
  while (__r25PtyRows.length >= ${MAX_ROWS} || __r25PtyBytes + bytes > ${MAX_BYTES}) {
    const old = __r25PtyRows.shift();
    if (!old) break;
    __r25PtyBytes -= Buffer.byteLength(old, 'utf8');
  }
  __r25PtyRows.push(line);
  __r25PtyBytes += bytes;
  try {
    __r25PtyFs.mkdirSync(__r25PtyPath.dirname(file), { recursive: true });
    __r25PtyFs.writeFileSync(file, __r25PtyRows.join(''), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}
function __r25PtyAttachExit(term, kind) {
  if (typeof term?.onExit !== 'function') return;
  term.onExit((event = {}) => __r25PtyCapture(kind, {
    requested_pid: term?.pid,
    code: event.exitCode,
    signal: event.signal,
  }));
}
`;

function patchSource(source, { expectedSha256 = PINOKIOD_SHELL_SHA256 } = {}) {
  if (sha256(Buffer.from(source, 'utf8')) !== expectedSha256) {
    throw new Error('pinokiod kernel/shell.js source hash differs; refusing diagnostic patch');
  }
  const replacements = [
    {
      name: 'runtime',
      needle: 'const path = require("path")\n',
      replacement: 'const path = require("path")\n' + RUNTIME,
    },
    {
      name: 'prompt-pty-spawn',
      needle: '      let term = pty.spawn(this.shell, this.args, config)\n',
      replacement: '      let term = pty.spawn(this.shell, this.args, config)\n      __r25PtyCapture(\'prompt-pty-spawn\', { pid: term?.pid, ppid: process.pid })\n      __r25PtyAttachExit(term, \'prompt-native-exit\')\n      let __r25PromptFirstOutput = false\n',
    },
    {
      name: 'prompt-first-output',
      needle: '      term.onData((data) => {\n',
      replacement: '      term.onData((data) => {\n        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true; __r25PtyCapture(\'prompt-first-output\') }\n',
    },
    {
      name: 'prompt-recognized-and-kill',
      needle: '              term.kill()\n',
      replacement: '              __r25PtyCapture(\'prompt-recognized\')\n              __r25PtyCapture(\'prompt-kill-start\', { requested_pid: term?.pid })\n              let __r25PromptKillError\n              try { term.kill() } catch (error) { __r25PromptKillError = error; throw error } finally {\n                __r25PtyCapture(\'prompt-kill-end\', { requested_pid: term?.pid, error: Boolean(__r25PromptKillError), error_value: __r25PromptKillError })\n              }\n',
    },
    {
      name: 'exec-pty-spawn',
      needle: '          this.ptyProcess = pty.spawn(this.shell, shellArgs, config)\n',
      replacement: '          this.ptyProcess = pty.spawn(this.shell, shellArgs, config)\n          __r25PtyCapture(\'exec-pty-spawn\', { pid: this.ptyProcess?.pid, ppid: process.pid })\n          __r25PtyAttachExit(this.ptyProcess, \'exec-native-exit\')\n          let __r25ExecFirstOutput = false\n',
    },
    {
      name: 'exec-first-output',
      needle: '          this.ptyProcess.onData((data) => {\n',
      replacement: '          this.ptyProcess.onData((data) => {\n            if (!__r25ExecFirstOutput) { __r25ExecFirstOutput = true; __r25PtyCapture(\'exec-first-output\') }\n',
    },
    {
      name: 'exec-prompt-recognized',
      needle: '            this.ready = true\n',
      replacement: '            __r25PtyCapture(\'exec-prompt-recognized\')\n            this.ready = true\n',
    },
    {
      name: 'exec-command-write',
      needle: '              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)\n',
      replacement: '              __r25PtyCapture(\'exec-command-write\')\n              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)\n',
    },
  ];
  let patched = source;
  for (const item of replacements) {
    if (count(patched, item.needle) !== 1) throw new Error(`pinokiod diagnostic patch anchor ${item.name} is not unique; refusing patch`);
    patched = patched.replace(item.needle, item.replacement);
  }
  return { sourceSha256: expectedSha256, patchedSha256: sha256(Buffer.from(patched, 'utf8')), replacements: replacements.map(item => item.name), source: patched };
}

function applyPinokiodPtyInstrumentation(pinokiodRoot, { diagnosticFile, verifyGit = true, expectedSha256 = PINOKIOD_SHELL_SHA256 } = {}) {
  if (typeof pinokiodRoot !== 'string' || !pinokiodRoot) throw new Error('pinokiod root is required');
  if (typeof diagnosticFile !== 'string' || !diagnosticFile) throw new Error('PTY diagnostic file is required');
  if (verifyGit) {
    let head;
    try { head = execFileSync('git', ['-C', pinokiodRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { throw new Error('pinokiod checkout identity unavailable; refusing diagnostic patch'); }
    if (head !== PINOKIOD_REF) throw new Error('pinokiod checkout is not the exact pinned ref; refusing diagnostic patch');
  }
  const file = path.join(pinokiodRoot, PINOKIOD_SHELL_RELATIVE);
  const source = fs.readFileSync(file, 'utf8');
  const result = patchSource(source, { expectedSha256 });
  fs.writeFileSync(file, result.source, { encoding: 'utf8', flag: 'w' });
  if (sha256(fs.readFileSync(file)) !== result.patchedSha256) throw new Error('pinokiod diagnostic patch verification failed');
  return { enabled: true, pinokiod_ref: PINOKIOD_REF, source_sha256: result.sourceSha256, patched_sha256: result.patchedSha256, replacements: result.replacements, marker_count: PTY_MARKERS.length, diagnostic_file_bound: true };
}

function createBoundedMarkerWriter(file, { maxRows = MAX_ROWS, maxBytes = MAX_BYTES } = {}) {
  const rows = [];
  let bytes = 0;
  function projectMarker(kind, fields = {}) {
    const row = { at: new Date().toISOString(), kind };
    if (kind.endsWith('-pty-spawn')) {
      row.pid = Number.isInteger(fields.pid) && fields.pid > 0 ? fields.pid : null;
      row.ppid = Number.isInteger(fields.ppid) && fields.ppid > 0 ? fields.ppid : null;
    } else if (kind.endsWith('-kill-start') || kind.endsWith('-kill-end')) {
      row.requested_pid = Number.isInteger(fields.requested_pid) && fields.requested_pid > 0 ? fields.requested_pid : null;
      if (kind.endsWith('-kill-end')) {
        row.error = fields.error === true;
        row.native_error_code = Number.isInteger(fields.native_error_code) && fields.native_error_code >= 0 ? fields.native_error_code : null;
      }
    } else if (kind.endsWith('-native-exit')) {
      row.requested_pid = Number.isInteger(fields.requested_pid) && fields.requested_pid > 0 ? fields.requested_pid : null;
      row.code = Number.isInteger(fields.code) && fields.code >= 0 ? fields.code : null;
      row.signal = Number.isInteger(fields.signal) && fields.signal >= 0 ? fields.signal : null;
    }
    return row;
  }
  function write(kind, fields = {}) {
    if (!PTY_MARKERS.includes(kind)) throw new Error('unknown PTY marker');
    const row = projectMarker(kind, fields);
    const line = `${JSON.stringify(row)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (size > maxBytes) return;
    while (rows.length >= maxRows || bytes + size > maxBytes) {
      const old = rows.shift();
      if (!old) break;
      bytes -= Buffer.byteLength(old, 'utf8');
    }
    rows.push(line);
    bytes += size;
    fs.writeFileSync(file, rows.join(''), { encoding: 'utf8', mode: 0o600 });
  }
  return { write, rows: () => rows.slice(), bytes: () => bytes };
}

module.exports = { MAX_BYTES, MAX_ROWS, PINOKIOD_REF, PINOKIOD_SHELL_RELATIVE, PINOKIOD_SHELL_SHA256, PTY_MARKERS, RUNTIME, applyPinokiodPtyInstrumentation, createBoundedMarkerWriter, patchSource, sha256 };
