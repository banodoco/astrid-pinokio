'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const SCHEMA = 'astrid.r25.snapshot.macos.v1';
const SOURCE_PROFILE = 'astrid.r25.macos-15.bash.ps-libproc-launchctl.v1';
const MAX_OBSERVATION_BYTES = 32 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/;
const BIRTH = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;
const TARGET = /^(?:system|(?:gui|user|pid)\/[0-9]{1,20})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$/;

const PROFILE = Object.freeze({
  id: SOURCE_PROFILE,
  observation_schema: SCHEMA,
  platform: 'macos-15',
  shell: 'bash',
  process_source: '/bin/ps plus /usr/lib/libproc.dylib proc_pidpath',
  service_source: '/bin/launchctl print',
  capture_model: 'bounded-action-boundary-polling',
  qualification: 'component-observation-only',
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, at = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${at}: non-finite number is not canonical JSON`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${at}[${index}]`));
  if (!isRecord(value)) throw new Error(`${at}: value is not canonical JSON`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      value: canonicalValue(value[key], `${at}.${key}`), enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function canonicalBytes(value) {
  const json = JSON.stringify(canonicalValue(value));
  const ascii = json.replace(/[\u007f-\uffff]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Buffer.from(ascii, 'ascii');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function structuralDigest(observation) {
  if (!isRecord(observation)) throw new Error('observation must be an object');
  const unsigned = {};
  for (const [key, value] of Object.entries(observation)) {
    if (key !== 'structural_sha256') unsigned[key] = value;
  }
  return sha256(canonicalBytes(unsigned));
}

function parseJsonNoDuplicates(input) {
  const raw = Buffer.isBuffer(input) ? input :
    (typeof input === 'string' ? Buffer.from(input, 'utf8') : null);
  if (raw === null) throw new Error('observation input must be a string or Buffer');
  if (raw.length === 0 || raw.length > MAX_OBSERVATION_BYTES) {
    throw new Error('observation input is empty or exceeds bounded capacity');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
    throw new Error('observation input is not UTF-8');
  }
  let offset = 0;
  let depth = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[offset] || '')) offset += 1; };
  const string = () => {
    if (text[offset] !== '"') throw new Error(`JSON string expected at byte ${offset}`);
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        try { return JSON.parse(text.slice(start, offset)); } catch { throw new Error(`malformed JSON string at byte ${start}`); }
      }
      if (code < 0x20) throw new Error(`control character in JSON string at byte ${offset}`);
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length || !/["\\/bfnrtu]/.test(text[offset])) {
          throw new Error(`malformed JSON escape at byte ${offset}`);
        }
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) {
            throw new Error(`malformed JSON unicode escape at byte ${offset}`);
          }
          offset += 4;
        }
      }
      offset += 1;
    }
    throw new Error(`unterminated JSON string at byte ${start}`);
  };
  const value = () => {
    whitespace();
    depth += 1;
    if (depth > 64) throw new Error('JSON nesting exceeds bounded capacity');
    let result;
    if (text[offset] === '{') {
      offset += 1;
      whitespace();
      result = {};
      const keys = new Set();
      if (text[offset] !== '}') {
        while (true) {
          whitespace();
          const key = string();
          if (keys.has(key)) throw new Error(`duplicate JSON key: ${key}`);
          keys.add(key);
          whitespace();
          if (text[offset++] !== ':') throw new Error(`JSON colon expected at byte ${offset - 1}`);
          const item = value();
          Object.defineProperty(result, key, {
            value: item, enumerable: true, configurable: true, writable: true,
          });
          whitespace();
          if (text[offset] === '}') break;
          if (text[offset++] !== ',') throw new Error(`JSON comma expected at byte ${offset - 1}`);
        }
      }
      offset += 1;
    } else if (text[offset] === '[') {
      offset += 1;
      whitespace();
      result = [];
      if (text[offset] !== ']') {
        while (true) {
          result.push(value());
          whitespace();
          if (text[offset] === ']') break;
          if (text[offset++] !== ',') throw new Error(`JSON comma expected at byte ${offset - 1}`);
        }
      }
      offset += 1;
    } else if (text[offset] === '"') {
      result = string();
    } else {
      const rest = text.slice(offset);
      const literal = /^(?:true|false|null)/.exec(rest);
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
      const token = literal || number;
      if (!token) throw new Error(`JSON value expected at byte ${offset}`);
      offset += token[0].length;
      result = JSON.parse(token[0]);
    }
    depth -= 1;
    return result;
  };
  const parsed = value();
  whitespace();
  if (offset !== text.length) throw new Error(`trailing JSON input at byte ${offset}`);
  return parsed;
}

function exact(value, fields, at) {
  if (!isRecord(value)) throw new Error(`${at}: object required`);
  const expected = [...fields].sort();
  const actual = Object.keys(value).sort();
  const missing = expected.filter(key => !actual.includes(key));
  const unknown = actual.filter(key => !expected.includes(key));
  if (missing.length || unknown.length) {
    throw new Error(`${at}: closed shape differs (missing=${missing.join(',') || '-'} unknown=${unknown.join(',') || '-'})`);
  }
}

function integer(value, at, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${at}: bounded integer required`);
  }
}

function nonEmpty(value, at, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maximum) {
    throw new Error(`${at}: bounded non-empty string required`);
  }
}

function validateLimits(limits) {
  exact(limits, [
    'command_timeout_seconds', 'max_processes', 'max_ps_bytes',
    'max_service_bytes', 'max_service_targets',
  ], '$.limits');
  integer(limits.max_processes, '$.limits.max_processes', { minimum: 1, maximum: 4096 });
  integer(limits.max_ps_bytes, '$.limits.max_ps_bytes', { minimum: 1, maximum: 4 * 1024 * 1024 });
  integer(limits.max_service_targets, '$.limits.max_service_targets', { minimum: 1, maximum: 64 });
  integer(limits.max_service_bytes, '$.limits.max_service_bytes', { minimum: 1, maximum: 256 * 1024 });
  integer(limits.command_timeout_seconds, '$.limits.command_timeout_seconds', { minimum: 1, maximum: 30 });
}

function validateProcesses(processes, limits) {
  if (!Array.isArray(processes) || processes.length === 0 || processes.length > limits.max_processes) {
    throw new Error('$.processes: non-empty bounded array required');
  }
  let prior = 0;
  for (let index = 0; index < processes.length; index += 1) {
    const row = processes[index];
    const at = `$.processes[${index}]`;
    exact(row, ['birth_text', 'collection_state', 'command_line', 'executable_path', 'parent_pid', 'pid'], at);
    integer(row.pid, `${at}.pid`, { minimum: 1 });
    integer(row.parent_pid, `${at}.parent_pid`);
    if (row.pid <= prior) throw new Error(`${at}.pid: duplicate or unsorted PID`);
    prior = row.pid;
    if (typeof row.birth_text !== 'string' || !BIRTH.test(row.birth_text)) {
      throw new Error(`${at}.birth_text: normalized ps birth text required`);
    }
    nonEmpty(row.command_line, `${at}.command_line`, limits.max_ps_bytes);
    if (!['present', 'vanished'].includes(row.collection_state)) {
      throw new Error(`${at}.collection_state: unknown process state`);
    }
    if (row.collection_state === 'present') {
      nonEmpty(row.executable_path, `${at}.executable_path`, 4096);
      if (!path.posix.isAbsolute(row.executable_path)) throw new Error(`${at}.executable_path: absolute path required`);
    } else if (row.executable_path !== null) {
      throw new Error(`${at}.executable_path: vanished process path must be null`);
    }
  }
}

function validateLaunchd(rows, limits) {
  if (!Array.isArray(rows) || rows.length > limits.max_service_targets) {
    throw new Error('$.launchd: bounded array required');
  }
  let prior = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const at = `$.launchd[${index}]`;
    exact(row, ['error', 'raw_print', 'returncode', 'state', 'target'], at);
    if (typeof row.target !== 'string' || !TARGET.test(row.target)) throw new Error(`${at}.target: unsafe target`);
    if (prior !== null && row.target <= prior) throw new Error(`${at}.target: duplicate or unsorted target`);
    prior = row.target;
    if (!['present', 'absent', 'error'].includes(row.state)) throw new Error(`${at}.state: unknown state`);
    if (row.state === 'present') {
      if (row.returncode !== 0 || row.error !== null) throw new Error(`${at}: present state fields differ`);
      nonEmpty(row.raw_print, `${at}.raw_print`, limits.max_service_bytes);
    } else if (row.state === 'absent') {
      if (!Number.isSafeInteger(row.returncode) || row.returncode === 0 || row.raw_print !== null || row.error !== 'not-found') {
        throw new Error(`${at}: absent state fields differ`);
      }
    } else {
      if (row.returncode !== null && !Number.isSafeInteger(row.returncode)) throw new Error(`${at}.returncode: integer or null required`);
      if (row.raw_print !== null) throw new Error(`${at}.raw_print: error state must not retain raw output`);
      nonEmpty(row.error, `${at}.error`, 1024);
    }
  }
}

function validateObservation(observation) {
  exact(observation, [
    'capture_finished_monotonic_ns', 'capture_started_monotonic_ns', 'captured_at_utc',
    'collector_pid', 'launchd', 'limits', 'processes', 'schema', 'source_profile',
    'structural_sha256',
  ], '$');
  if (observation.schema !== SCHEMA) throw new Error('$.schema: unknown schema');
  if (observation.source_profile !== SOURCE_PROFILE) throw new Error('$.source_profile: unknown profile');
  if (typeof observation.captured_at_utc !== 'string' || !UTC.test(observation.captured_at_utc) ||
      Number.isNaN(Date.parse(observation.captured_at_utc))) throw new Error('$.captured_at_utc: UTC timestamp required');
  if (typeof observation.capture_started_monotonic_ns !== 'string' ||
      !DECIMAL.test(observation.capture_started_monotonic_ns)) throw new Error('$.capture_started_monotonic_ns: decimal string required');
  if (typeof observation.capture_finished_monotonic_ns !== 'string' ||
      !DECIMAL.test(observation.capture_finished_monotonic_ns) ||
      BigInt(observation.capture_finished_monotonic_ns) < BigInt(observation.capture_started_monotonic_ns)) {
    throw new Error('$.capture_finished_monotonic_ns: ordered decimal string required');
  }
  integer(observation.collector_pid, '$.collector_pid', { minimum: 1 });
  validateLimits(observation.limits);
  validateProcesses(observation.processes, observation.limits);
  validateLaunchd(observation.launchd, observation.limits);
  if (typeof observation.structural_sha256 !== 'string' || !HEX64.test(observation.structural_sha256)) {
    throw new Error('$.structural_sha256: lowercase SHA-256 required');
  }
  const actual = structuralDigest(observation);
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'ascii'), Buffer.from(observation.structural_sha256, 'ascii'))) {
    throw new Error('$.structural_sha256: digest mismatch');
  }
  return observation;
}

function parseObservation(input) {
  return validateObservation(parseJsonNoDuplicates(input));
}

module.exports = {
  MAX_OBSERVATION_BYTES,
  PROFILE,
  SCHEMA,
  SOURCE_PROFILE,
  canonicalBytes,
  parseJsonNoDuplicates,
  parseObservation,
  sha256,
  structuralDigest,
  validateObservation,
};
