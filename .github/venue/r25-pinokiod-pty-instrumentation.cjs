'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PINOKIOD_REF = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const PINOKIOD_SHELL_RELATIVE = 'kernel/shell.js';
const PINOKIOD_SHELL_SHA256 = 'e39ebef4ffcbd381cd1f3962b56ddfead3ed4354733d15d2d3a2d23ecf5a7da6';
const PTY_MARKERS = Object.freeze([
  'runtime-ready', 'prompt-pty-spawn-start', 'prompt-pty-spawn', 'prompt-first-output', 'prompt-followup-output', 'prompt-probe-write',
  'prompt-probe-write-return', 'prompt-post-probe-output', 'prompt-recognized',
  'prompt-kill-start', 'prompt-kill-end', 'prompt-native-exit',
  'exec-pty-spawn', 'exec-first-output', 'exec-prompt-recognized',
  'exec-command-write', 'exec-native-exit',
]);
const PRESERVED_MARKERS = Object.freeze(['prompt-probe-write-return', 'prompt-post-probe-output']);
const RETAINED_PROMPT_MARKERS = Object.freeze(['prompt-pty-spawn-start', 'prompt-pty-spawn', 'prompt-probe-write', ...PRESERVED_MARKERS]);
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
const __r25PtyRetainedPromptMarkers = new Set(${JSON.stringify(RETAINED_PROMPT_MARKERS)});
const __r25PtyRows = [];
let __r25PtyBytes = 0;
let __r25PtyLatestPromptOrdinal = null;
let __r25PtyNextPromptOrdinal = 0;
let __r25PtyPromptOrdinal = null;
let __r25PtyPromptPid = null;
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
  if (kind.startsWith('prompt-')) {
    row.prompt_ordinal = __r25PtyPid(fields.prompt_ordinal ?? __r25PtyPromptOrdinal);
    row.prompt_pid = __r25PtyPid(fields.prompt_pid ?? __r25PtyPromptPid);
  }
  if (kind === 'prompt-pty-spawn-start') {
    __r25PtyLatestPromptOrdinal = row.prompt_ordinal;
    for (let index = __r25PtyRows.length - 1; index >= 0; index -= 1) {
      const old = JSON.parse(__r25PtyRows[index]);
      if (__r25PtyRetainedPromptMarkers.has(old.kind) && old.prompt_ordinal !== __r25PtyLatestPromptOrdinal) {
        __r25PtyBytes -= Buffer.byteLength(__r25PtyRows[index], 'utf8');
        __r25PtyRows.splice(index, 1);
      }
    }
  }
  if (kind.endsWith('-pty-spawn') || kind === 'prompt-pty-spawn-start') {
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
  if (__r25PtyRetainedPromptMarkers.has(kind) && row.prompt_ordinal === __r25PtyLatestPromptOrdinal
      && __r25PtyRows.some(old => { const item = JSON.parse(old); return item.kind === kind && item.prompt_ordinal === row.prompt_ordinal; })) return;
  while (__r25PtyRows.length >= ${MAX_ROWS} || __r25PtyBytes + bytes > ${MAX_BYTES}) {
    const index = __r25PtyRows.findIndex(old => {
      const item = JSON.parse(old);
      return !(__r25PtyRetainedPromptMarkers.has(item.kind) && item.prompt_ordinal === __r25PtyLatestPromptOrdinal);
    });
    if (index < 0) return;
    const [old] = __r25PtyRows.splice(index, 1);
    __r25PtyBytes -= Buffer.byteLength(old, 'utf8');
  }
  __r25PtyRows.push(line);
  __r25PtyBytes += bytes;
  try {
    __r25PtyFs.mkdirSync(__r25PtyPath.dirname(file), { recursive: true });
    __r25PtyFs.writeFileSync(file, __r25PtyRows.join(''), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}
function __r25PtyBeginPrompt() {
  __r25PtyNextPromptOrdinal = Math.min(10001, __r25PtyNextPromptOrdinal + 1);
  __r25PtyPromptOrdinal = __r25PtyNextPromptOrdinal <= 10000 ? __r25PtyNextPromptOrdinal : null;
  __r25PtyPromptPid = null;
  __r25PtyCapture('prompt-pty-spawn-start', { prompt_ordinal: __r25PtyPromptOrdinal, ppid: process.pid });
}
function __r25PtySetPromptPid(value) { __r25PtyPromptPid = __r25PtyPid(value); }
function __r25PtyAttachExit(term, kind) {
  if (typeof term?.onExit !== 'function') return;
  term.onExit((event = {}) => __r25PtyCapture(kind, {
    requested_pid: term?.pid,
    code: event.exitCode,
    signal: event.signal,
  }));
}
__r25PtyCapture('runtime-ready');
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
      replacement: '      __r25PtyBeginPrompt()\n      let term = pty.spawn(this.shell, this.args, config)\n      __r25PtySetPromptPid(term?.pid)\n      __r25PtyCapture(\'prompt-pty-spawn\', { pid: term?.pid, ppid: process.pid })\n      __r25PtyAttachExit(term, \'prompt-native-exit\')\n      let __r25PromptFirstOutput = false\n      let __r25PromptFollowupOutput = false\n      let __r25PromptProbeWriteReturned = false\n      let __r25PromptPostProbeOutput = false\n',
    },
    {
      name: 'prompt-first-output',
      needle: '      term.onData((data) => {\n',
      replacement: '      term.onData((data) => {\n        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true; __r25PtyCapture(\'prompt-first-output\') }\n        else if (!__r25PromptFollowupOutput) { __r25PromptFollowupOutput = true; __r25PtyCapture(\'prompt-followup-output\') }\n        if (__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput) { __r25PromptPostProbeOutput = true; __r25PtyCapture(\'prompt-post-probe-output\') }\n',
    },
    {
      name: 'prompt-probe-write',
      needle: '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)\n',
      replacement: '                __r25PtyCapture(\'prompt-probe-write\')\n                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)\n                __r25PromptProbeWriteReturned = true\n                __r25PtyCapture(\'prompt-probe-write-return\')\n',
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
  let latestPromptOrdinal = null;
  function projectMarker(kind, fields = {}) {
    const row = { at: new Date().toISOString(), kind };
    if (kind.startsWith('prompt-')) {
      row.prompt_ordinal = Number.isInteger(fields.prompt_ordinal) && fields.prompt_ordinal >= 0 && fields.prompt_ordinal <= 10000 ? fields.prompt_ordinal : null;
      row.prompt_pid = Number.isInteger(fields.prompt_pid) && fields.prompt_pid > 0 && fields.prompt_pid <= 0xffffffff ? fields.prompt_pid : null;
    }
    if (kind.endsWith('-pty-spawn') || kind === 'prompt-pty-spawn-start') {
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
    if (kind === 'prompt-pty-spawn-start') {
      latestPromptOrdinal = row.prompt_ordinal;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const old = JSON.parse(rows[index]);
        if (RETAINED_PROMPT_MARKERS.includes(old.kind) && old.prompt_ordinal !== latestPromptOrdinal) {
          bytes -= Buffer.byteLength(rows[index], 'utf8');
          rows.splice(index, 1);
        }
      }
    }
    const line = `${JSON.stringify(row)}\n`;
    const size = Buffer.byteLength(line, 'utf8');
    if (size > maxBytes) return;
    if (RETAINED_PROMPT_MARKERS.includes(kind) && row.prompt_ordinal === latestPromptOrdinal
        && rows.some(old => { const item = JSON.parse(old); return item.kind === kind && item.prompt_ordinal === row.prompt_ordinal; })) return;
    while (rows.length >= maxRows || bytes + size > maxBytes) {
      const index = rows.findIndex(old => {
        const item = JSON.parse(old);
        return !(RETAINED_PROMPT_MARKERS.includes(item.kind) && item.prompt_ordinal === latestPromptOrdinal);
      });
      if (index < 0) return;
      const [old] = rows.splice(index, 1);
      bytes -= Buffer.byteLength(old, 'utf8');
    }
    rows.push(line);
    bytes += size;
    fs.writeFileSync(file, rows.join(''), { encoding: 'utf8', mode: 0o600 });
  }
  return { write, rows: () => rows.slice(), bytes: () => bytes };
}

module.exports = { MAX_BYTES, MAX_ROWS, PINOKIOD_REF, PINOKIOD_SHELL_RELATIVE, PINOKIOD_SHELL_SHA256, PRESERVED_MARKERS, PTY_MARKERS, RUNTIME, applyPinokiodPtyInstrumentation, createBoundedMarkerWriter, patchSource, sha256 };
