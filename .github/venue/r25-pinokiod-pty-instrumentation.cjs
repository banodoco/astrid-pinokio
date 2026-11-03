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
  'exec-input-write', 'exec-native-exit', 'prompt-processing',
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
const __r25PtyStageNames = new Set(['callback', 'filter', 'queue-worker', 'vt-write', 'vt-callback', 'serialize', 'regex', 'normalize', 'resolve']);
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
      if ((__r25PtyRetainedPromptMarkers.has(old.kind) || old.kind === 'prompt-processing') && old.prompt_ordinal !== __r25PtyLatestPromptOrdinal) {
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
      return !__r25PtyIsRetainedPromptRow(item);
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
function __r25PtyBound(value, max = 1000000) {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
}
function __r25PtyNewProcessing(promptOrdinal, promptPid) {
  return {
    ordinal: promptOrdinal, pid: promptPid, stage: 'callback', callback_count: 0,
    ready: false, done: false, input_length: 0, input_probe_count: 0,
    input_command_line_count: 0, input_command_line_carry: '',
    output_length: 0, output_probe_count: 0, serialize_length: 0, serialized_probe_count: 0,
    filtered_command_line_count: 0, filtered_command_line_carry: '',
    filter_calls: 0, queue_calls: 0, write_calls: 0, write_return_count: 0,
    write_callback_count: 0, serialize_count: 0, regex_count: 0, normalize_count: 0,
    match: null, error_stage: null, error_class: null,
    probe_command_count: 0, probe_command_line_count: 0, probe_output_line_count: 0, probe_command_output_sequence_count: 0,
    probe_command_separator_count: 0, probe_output_separator_count: 0,
    repeated_prefix_equal: false, repeated_prefix_check_count: 0, shape_scan_truncated: false,
  };
}
function __r25PtyErrorClass(error) {
  const name = error?.constructor?.name;
  return name === 'TypeError' || name === 'RangeError' || name === 'SyntaxError' || name === 'ReferenceError' ? name : 'Error';
}
function __r25PtyIsRetainedPromptRow(item) {
  return item.prompt_ordinal === __r25PtyLatestPromptOrdinal
    && (__r25PtyRetainedPromptMarkers.has(item.kind) || item.kind === 'prompt-processing');
}
function __r25PtyProbeCount(value) {
  if (typeof value !== 'string') return 0;
  let found = 0;
  let from = 0;
  while (found < 1000) {
    const index = value.indexOf('pinokio', from);
    if (index < 0) break;
    found += 1;
    from = index + 7;
  }
  return found;
}
function __r25PtyCountProbeCommandLines(state, side, value) {
  if (!state || typeof value !== 'string' || (side !== 'input' && side !== 'filtered')) return 0;
  const countField = side === 'input' ? 'input_command_line_count' : 'filtered_command_line_count';
  const carryField = side === 'input' ? 'input_command_line_carry' : 'filtered_command_line_carry';
  const carry = state[carryField];
  const combined = (typeof carry === 'string' ? carry : '') + value;
  let added = 0;
  const line = /(?:^|[\s>])echo pinokio(?=[\r\n])/g;
  let match;
  while (state[countField] + added < 1000 && (match = line.exec(combined)) !== null) {
    const terminator = match.index + match[0].length;
    if (terminator >= carry.length) added += 1;
  }
  state[countField] = Math.min(1000, state[countField] + added);
  state[carryField] = combined.slice(-13);
  return state[countField];
}
function __r25PtyRegexShape(value) {
  const shape = { probe_command_count: 0, probe_command_line_count: 0, probe_output_line_count: 0, probe_command_output_sequence_count: 0,
    probe_command_separator_count: 0, probe_output_separator_count: 0, repeated_prefix_equal: false,
    repeated_prefix_check_count: 0, shape_scan_truncated: false };
  if (typeof value !== 'string') return shape;
  const text = value.slice(0, 1000000);
  const limit = text.length;
  shape.shape_scan_truncated = limit < value.length;
  const cap = count => Math.min(1000, count);
  let from = 0;
  while (from < limit && shape.probe_command_count < 1000) {
    const index = text.indexOf('echo pinokio', from);
    if (index < 0) break;
    shape.probe_command_count += 1;
    const afterCommand = text[index + 12] || '';
    if (!afterCommand || afterCommand === '\r' || afterCommand === '\n') shape.probe_command_line_count = cap(shape.probe_command_line_count + 1);
    from = index + 12;
  }
  from = 0;
  while (from < limit && shape.probe_output_line_count < 1000) {
    const index = text.indexOf('pinokio', from);
    if (index < 0) break;
    const before = index === 0 ? '' : text[index - 1];
    const after = text[index + 7] || '';
    if ((!before || before === '\r' || before === '\n') && (!after || after === '\r' || after === '\n')) shape.probe_output_line_count += 1;
    from = index + 7;
  }
  from = 0;
  let prefixChecks = 0;
  while (from < limit && shape.probe_command_output_sequence_count < 1000) {
    const command = text.indexOf('echo pinokio', from);
    if (command < 0) break;
    const commandEnd = command + 12;
    let outputStart = commandEnd;
    while (outputStart < limit && (text[outputStart] === '\r' || text[outputStart] === '\n')) outputStart += 1;
    if (outputStart > commandEnd && text.startsWith('pinokio', outputStart)) {
      const outputEnd = outputStart + 7;
      const afterOutput = text[outputEnd] || '';
      if (!afterOutput || afterOutput === '\r' || afterOutput === '\n') {
        shape.probe_command_output_sequence_count += 1;
        shape.probe_command_separator_count = cap(shape.probe_command_separator_count + outputStart - commandEnd);
        let repeatedStart = outputEnd;
        while (repeatedStart < limit && (text[repeatedStart] === '\r' || text[repeatedStart] === '\n')) repeatedStart += 1;
        shape.probe_output_separator_count = cap(shape.probe_output_separator_count + repeatedStart - outputEnd);
        if (command > 0 && prefixChecks < 8) {
          prefixChecks += 1;
          shape.repeated_prefix_check_count = prefixChecks;
          if (repeatedStart + command <= limit && text.startsWith(text.slice(0, command), repeatedStart)) shape.repeated_prefix_equal = true;
        }
      }
    }
    from = commandEnd;
  }
  return shape;
}
function __r25PtyProcessing(state, stage, values = {}) {
  try {
    if (!state || !__r25PtyStageNames.has(stage) || state.ordinal !== __r25PtyLatestPromptOrdinal) return;
    for (const field of Object.keys(values)) {
      if (field === 'error') {
        if (!state.error_stage) {
          state.error_stage = stage;
          state.error_class = __r25PtyErrorClass(values.error);
        }
      } else if (field === 'match') state.match = values.match === true;
      else if (field === 'regex_shape') Object.assign(state, values.regex_shape);
      else if (field === 'ready' || field === 'done') state[field] = values[field] === true;
      else if (field.endsWith('_length') || field.endsWith('_count')) state[field] = __r25PtyBound(values[field]);
    }
    if (!((stage === 'vt-write' && values.write_return === true && state.write_callback_count > 0)
        || (values.error && state.error_stage))) state.stage = stage;
    const row = {
      at: new Date().toISOString(), kind: 'prompt-processing', prompt_ordinal: __r25PtyPid(state.ordinal), prompt_pid: __r25PtyPid(state.pid),
      stage: state.stage, callback_count: state.callback_count, ready: state.ready, done: state.done,
      input_length: state.input_length, input_probe_count: state.input_probe_count,
      input_command_line_count: state.input_command_line_count,
      output_length: state.output_length, output_probe_count: state.output_probe_count,
      filtered_command_line_count: state.filtered_command_line_count,
      serialize_length: state.serialize_length, serialized_probe_count: state.serialized_probe_count,
      probe_command_count: state.probe_command_count,
      probe_command_line_count: state.probe_command_line_count,
      probe_output_line_count: state.probe_output_line_count,
      probe_command_output_sequence_count: state.probe_command_output_sequence_count,
      probe_command_separator_count: state.probe_command_separator_count,
      probe_output_separator_count: state.probe_output_separator_count,
      repeated_prefix_equal: state.repeated_prefix_equal,
      repeated_prefix_check_count: state.repeated_prefix_check_count,
      shape_scan_truncated: state.shape_scan_truncated,
      filter_calls: state.filter_calls, queue_calls: state.queue_calls, write_calls: state.write_calls,
      write_return_count: state.write_return_count, write_callback_count: state.write_callback_count,
      serialize_count: state.serialize_count, regex_count: state.regex_count, normalize_count: state.normalize_count,
      match: state.match, error_stage: state.error_stage, error_class: state.error_class,
    };
    const line = JSON.stringify(row) + '\n';
    const size = Buffer.byteLength(line, 'utf8');
    let index = __r25PtyRows.findIndex(old => JSON.parse(old).kind === 'prompt-processing');
    if (index >= 0) {
      __r25PtyBytes -= Buffer.byteLength(__r25PtyRows[index], 'utf8');
      __r25PtyRows.splice(index, 1);
    }
    while (__r25PtyRows.length >= ${MAX_ROWS} || __r25PtyBytes + size > ${MAX_BYTES}) {
      index = __r25PtyRows.findIndex(old => {
        const item = JSON.parse(old);
        return !__r25PtyIsRetainedPromptRow(item);
      });
      if (index < 0) return;
      const [old] = __r25PtyRows.splice(index, 1);
      __r25PtyBytes -= Buffer.byteLength(old, 'utf8');
    }
    __r25PtyRows.push(line);
    __r25PtyBytes += size;
    const file = process.env.ASTRID_R25_PTY_CAPTURE_FILE;
    if (process.env.ASTRID_R25_SETUP_DIAGNOSTICS !== '1' || typeof file !== 'string' || !file) return;
    __r25PtyFs.mkdirSync(__r25PtyPath.dirname(file), { recursive: true });
    __r25PtyFs.writeFileSync(file, __r25PtyRows.join(''), { encoding: 'utf8', mode: 0o600 });
  } catch {}
}
function __r25PtyFailure(state, stage, error) { __r25PtyProcessing(state, stage, { error }); }
function __r25PtyBeginPrompt() {
  __r25PtyNextPromptOrdinal = Math.min(10001, __r25PtyNextPromptOrdinal + 1);
  __r25PtyPromptOrdinal = __r25PtyNextPromptOrdinal <= 10000 ? __r25PtyNextPromptOrdinal : null;
  __r25PtyPromptPid = null;
  __r25PtyCapture('prompt-pty-spawn-start', { prompt_ordinal: __r25PtyPromptOrdinal, ppid: process.pid });
}
function __r25PtySetPromptPid(value) { __r25PtyPromptPid = __r25PtyPid(value); }
function __r25PtyAttachExit(term, kind, promptOrdinal = __r25PtyPromptOrdinal, promptPid = __r25PtyPromptPid) {
  if (typeof term?.onExit !== 'function') return;
  term.onExit((event = {}) => __r25PtyCapture(kind, {
    prompt_ordinal: promptOrdinal,
    prompt_pid: promptPid,
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
      replacement: '      __r25PtyBeginPrompt()\n      const __r25PromptOrdinal = __r25PtyPromptOrdinal\n      let term = pty.spawn(this.shell, this.args, config)\n      __r25PtySetPromptPid(term?.pid)\n      const __r25PromptState = __r25PtyNewProcessing(__r25PromptOrdinal, term?.pid)\n      __r25PtyProcessing(__r25PromptState, \'callback\', { ready: this.prompt_ready, done: this.prompt_done })\n      __r25PtyCapture(\'prompt-pty-spawn\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid, pid: term?.pid, ppid: process.pid })\n      __r25PtyAttachExit(term, \'prompt-native-exit\', __r25PromptOrdinal, term?.pid)\n      let __r25PromptFirstOutput = false\n      let __r25PromptFollowupOutput = false\n      let __r25PromptProbeWriteReturned = false\n      let __r25PromptPostProbeOutput = false\n',
    },
    {
      name: 'prompt-first-output',
      needle: '      term.onData((data) => {\n',
      replacement: '      term.onData((data) => {\n        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true; __r25PtyCapture(\'prompt-first-output\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid }) }\n        else if (!__r25PromptFollowupOutput) { __r25PromptFollowupOutput = true; __r25PtyCapture(\'prompt-followup-output\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid }) }\n        if (__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput) { __r25PromptPostProbeOutput = true; __r25PtyCapture(\'prompt-post-probe-output\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid }) }\n        __r25PromptState.callback_count = Math.min(10000, __r25PromptState.callback_count + 1)\n        const __r25InputCommandLines = __r25PtyCountProbeCommandLines(__r25PromptState, \'input\', data)\n        __r25PtyProcessing(__r25PromptState, \'callback\', { ready: this.prompt_ready, done: this.prompt_done, input_length: typeof data === \'string\' ? data.length : 0, input_probe_count: __r25PtyProbeCount(data), input_command_line_count: __r25InputCommandLines })\n',
    },
    {
      name: 'prompt-probe-write',
      needle: '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)\n',
      replacement: '                __r25PtyCapture(\'prompt-probe-write\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })\n                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)\n                __r25PromptProbeWriteReturned = true\n                __r25PtyCapture(\'prompt-probe-write-return\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })\n',
    },
    {
      name: 'prompt-filter-and-queue',
      needle: '      let queue = fastq((data, cb) => {\n        if (this.prompt_ready) {\n          vt.write(data, () => {\n            let buf = vts.serialize()\n            let re = /(.+)echo pinokio[\\r\\n]+pinokio[\\r\\n]+(\\1)/gs\n            const match = re.exec(buf)\n            if (match && match.length > 0) {\n',
      replacement: '      let queue = fastq((data, cb) => {\n        __r25PtyProcessing(__r25PromptState, \'queue-worker\', { ready: this.prompt_ready, done: this.prompt_done })\n        if (this.prompt_ready) {\n          __r25PromptState.write_calls = Math.min(10000, __r25PromptState.write_calls + 1)\n          __r25PtyProcessing(__r25PromptState, \'vt-write\')\n          try { vt.write(data, () => {\n            __r25PromptState.write_callback_count = Math.min(10000, __r25PromptState.write_callback_count + 1)\n            __r25PtyProcessing(__r25PromptState, \'vt-callback\')\n            __r25PromptState.serialize_count = Math.min(10000, __r25PromptState.serialize_count + 1)\n            __r25PtyProcessing(__r25PromptState, \'serialize\')\n            let buf\n            try { buf = vts.serialize() } catch (error) { __r25PtyFailure(__r25PromptState, \'serialize\', error); throw error }\n            __r25PtyProcessing(__r25PromptState, \'serialize\', { serialize_length: typeof buf === \'string\' ? buf.length : 0, serialized_probe_count: __r25PtyProbeCount(buf) })\n            __r25PromptState.regex_count = Math.min(10000, __r25PromptState.regex_count + 1)\n            __r25PtyProcessing(__r25PromptState, \'regex\')\n            let re = /(.+)echo pinokio[\\r\\n]+pinokio[\\r\\n]+(\\1)/gs\n            let match\n            try { match = re.exec(buf) } catch (error) { __r25PtyFailure(__r25PromptState, \'regex\', error); throw error }\n            __r25PtyProcessing(__r25PromptState, \'regex\', { match: Boolean(match && match.length > 0), regex_shape: __r25PtyRegexShape(buf) })\n            if (match && match.length > 0) {\n',
    },
    {
      name: 'prompt-normalize-resolve',
      needle: '              let stripped = this.stripAnsi(match[1])\n              const p = stripped\n                .replaceAll(/[\\r\\n]/g, "")\n                .trim()\n                .replaceAll(/[.*+?^${}()|[\\]\\\\]/g, \'\\\\$&\');\n              term.kill()\n',
      replacement: '              __r25PromptState.normalize_count = Math.min(10000, __r25PromptState.normalize_count + 1)\n              __r25PtyProcessing(__r25PromptState, \'normalize\', { ready: this.prompt_ready, done: this.prompt_done })\n              let p\n              try {\n                let stripped = this.stripAnsi(match[1])\n                p = stripped.replaceAll(/[\\r\\n]/g, "").trim().replaceAll(/[.*+?^${}()|[\\]\\\\]/g, \'\\\\$$&\')\n              } catch (error) { __r25PtyFailure(__r25PromptState, \'normalize\', error); throw error }\n              __r25PtyProcessing(__r25PromptState, \'normalize\', { ready: this.prompt_ready, done: this.prompt_done })\n              term.kill()\n',
    },
    {
      name: 'prompt-filter-entry',
      needle: '            queue.push(this.filterDecsync(data))\n',
      replacement: '            __r25PromptState.filter_calls = Math.min(10000, __r25PromptState.filter_calls + 1)\n            __r25PtyProcessing(__r25PromptState, \'filter\')\n            let __r25FilteredData\n            try { __r25FilteredData = this.filterDecsync(data) } catch (error) { __r25PtyFailure(__r25PromptState, \'filter\', error); throw error }\n            const __r25FilteredCommandLines = __r25PtyCountProbeCommandLines(__r25PromptState, \'filtered\', __r25FilteredData)\n            __r25PtyProcessing(__r25PromptState, \'filter\', { output_length: typeof __r25FilteredData === \'string\' ? __r25FilteredData.length : 0, output_probe_count: __r25PtyProbeCount(__r25FilteredData), filtered_command_line_count: __r25FilteredCommandLines })\n            __r25PromptState.queue_calls = Math.min(10000, __r25PromptState.queue_calls + 1)\n            queue.push(__r25FilteredData)\n',
    },
    {
      name: 'prompt-vt-write-return',
      needle: '          })\n          cb()\n',
      replacement: '          })\n          __r25PromptState.write_return_count = Math.min(10000, __r25PromptState.write_return_count + 1)\n          __r25PtyProcessing(__r25PromptState, \'vt-write\', { write_return: true })\n          } catch (error) { __r25PtyFailure(__r25PromptState, \'vt-write\', error); throw error }\n          cb()\n',
    },
    {
      name: 'prompt-resolve',
      needle: '              queue.killAndDrain()\n              resolve(p)\n',
      replacement: '              queue.killAndDrain()\n              __r25PtyProcessing(__r25PromptState, \'resolve\')\n              resolve(p)\n',
    },
    {
      name: 'prompt-recognized-and-kill',
      needle: '              term.kill()\n              vt.dispose()\n',
      replacement: '              __r25PtyCapture(\'prompt-recognized\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })\n              __r25PtyCapture(\'prompt-kill-start\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid, requested_pid: term?.pid })\n              let __r25PromptKillError\n              try { term.kill() } catch (error) { __r25PromptKillError = error; throw error } finally {\n                __r25PtyCapture(\'prompt-kill-end\', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid, requested_pid: term?.pid, error: Boolean(__r25PromptKillError), error_value: __r25PromptKillError })\n              }\n              vt.dispose()\n',
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
      name: 'exec-input-write',
      needle: '              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)\n',
      replacement: '              __r25PtyCapture(\'exec-input-write\')\n              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)\n',
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
