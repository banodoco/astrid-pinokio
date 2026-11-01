#!/usr/bin/env node
/**
 * M4-6 slot coordinator.
 *
 * This is deliberately not a verifier.  It validates the immutable R-25
 * packet, launches a supplied real-engine provider only after all execution
 * bindings are present, and writes a sanitized raw receipt.  It never emits a
 * qualifying result: that decision belongs to the protected R-36 collector
 * and verifier.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const RC0_TUPLE = Object.freeze({
  runtime: '47e5949465cb6f3afdfd1cb8a0e90009fd9d4020',
  agent: '020877f12ea490308a9e5f9564c8f4a4bf77ede1',
  app: '9d3ccda1e81383082258943207745086da2aabe4',
  pinokio: '89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4',
});

export const PACKET_COMMIT = 'ca8b3bf6e6b2283c90e131c189e2ebd3e53148d6';
export const PACKET_FILES = Object.freeze({
  'RC-0-EXECUTOR-CONFIGS.json': '790afd81d1ea59179e0bb6c5c83dacfb40ad0309caa696e03993193b61756cf6',
  'SLOT-MAPPING.md': '5cb5ea6eed59932bb63cbd48bf8fa949eab9e037a036b1c5dee1a9dfe9c20b77',
  'R-21-R7-DISPATCH.md': '36779788a73034b6b25636d2c7fb9a08d3114b7a1b93bb90162d8c808be19d85',
  SHA256SUMS: 'd66f3f764ac7ed7503bd8af32bec6f55f874e36cb8f7271c4afb9b2f3109adfd',
  'REPORT.md': 'faa5670b2b63c4b841c4364dd8215d9112782a568ee08b53f12e55593229088d',
});

export const SCENARIO_GROUPS = Object.freeze([
  'interruption_recovery',
  'failed_candidate_rollback',
  'keep_data_uninstall',
  'stop_safety',
]);
export const STOP_OUTCOMES = Object.freeze(['refused', 'unknown']);

const SLOT_LAYOUT = Object.freeze([
  ['pinokio-backend-macos', 'macos', 'macos-14', 'sh', 'pinokio-backend', 'backend'],
  ['pinokio-backend-linux', 'linux', 'ubuntu-24.04', 'sh', 'pinokio-backend', 'backend'],
  ['pinokio-backend-windows', 'windows', 'windows-2022', 'powershell.exe', 'pinokio-backend', 'backend'],
  ['pinokio-fully-local-macos', 'macos', 'macos-14', 'sh', 'pinokio-fully-local', 'fully-local'],
  ['pinokio-fully-local-linux', 'linux', 'ubuntu-24.04', 'sh', 'pinokio-fully-local', 'fully-local'],
  ['pinokio-fully-local-windows', 'windows', 'windows-2022', 'powershell.exe', 'pinokio-fully-local', 'fully-local'],
]);

export const EXPECTED_SLOTS = Object.freeze(SLOT_LAYOUT.map(([slot_id, os, runner, shell, channel, mode]) => ({
  slot_id, os, runner, shell, channel, mode,
  request_id: `R-25-EXECUTOR-CONFIG-RC-0-${slot_id}`,
})));

const MAX_ARTIFACT_SIZE = 50 * 1024 * 1024;
const MAX_PROVIDER_OUTPUT = 1024 * 1024;
const AWAITING_EXIT = 78;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

function fail(message, code = 'INPUT_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function equalJson(left, right) {
  return stableJson(left) === stableJson(right);
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

/* JSON.parse accepts duplicate keys.  The packet and provider envelope are
 * security boundaries, so parse just enough JSON here to reject them. */
export function parseJsonUnique(text, label = 'JSON') {
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] || '')) at += 1; };
  const token = (pattern, description) => {
    const match = pattern.exec(text.slice(at));
    if (!match) fail(`${label}: expected ${description}`, 'JSON_INVALID');
    at += match[0].length;
    return match[0];
  };
  const string = () => {
    if (text[at] !== '"') fail(`${label}: expected string`, 'JSON_INVALID');
    const begin = at;
    at += 1;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return JSON.parse(text.slice(begin, at));
      if (char === '\\') {
        if (at >= text.length) fail(`${label}: incomplete escape`, 'JSON_INVALID');
        const escape = text[at++];
        if (escape === 'u') {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(`${label}: invalid unicode escape`, 'JSON_INVALID');
          at += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) fail(`${label}: invalid escape`, 'JSON_INVALID');
      } else if (char.charCodeAt(0) < 0x20) fail(`${label}: unescaped control character`, 'JSON_INVALID');
    }
    fail(`${label}: unterminated string`, 'JSON_INVALID');
  };
  const value = () => {
    whitespace();
    if (text[at] === '{') {
      at += 1;
      whitespace();
      const result = {};
      const keys = new Set();
      if (text[at] === '}') { at += 1; return result; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`${label}: duplicate key ${key}`, 'JSON_DUPLICATE_KEY');
        keys.add(key);
        whitespace();
        token(/^:/, ':');
        result[key] = value();
        whitespace();
        if (text[at] === '}') { at += 1; return result; }
        token(/^,/, ',');
      }
    }
    if (text[at] === '[') {
      at += 1;
      whitespace();
      const result = [];
      if (text[at] === ']') { at += 1; return result; }
      while (true) {
        result.push(value());
        whitespace();
        if (text[at] === ']') { at += 1; return result; }
        token(/^,/, ',');
      }
    }
    if (text[at] === '"') return string();
    if (text.startsWith('true', at)) { at += 4; return true; }
    if (text.startsWith('false', at)) { at += 5; return false; }
    if (text.startsWith('null', at)) { at += 4; return null; }
    const number = token(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/, 'value');
    return Number(number);
  };
  const result = value();
  whitespace();
  if (at !== text.length) fail(`${label}: trailing data`, 'JSON_INVALID');
  return result;
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\') || value.includes('\0') || value.includes(':')) return false;
  const pieces = value.split('/');
  return !path.posix.isAbsolute(value) && pieces.every((part) => part && part !== '.' && part !== '..');
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function platformName(value) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  if (value === 'linux') return 'linux';
  return value;
}

function readJsonFile(filename, label) {
  let text;
  try {
    text = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    fail(`${label} is unreadable: ${error.code || error.message}`, 'INPUT_MISSING');
  }
  return parseJsonUnique(text, label);
}

function parseChecksumFile(filename, expected) {
  const lines = fs.readFileSync(filename, 'utf8').trimEnd().split('\n');
  const seen = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || seen.has(match?.[2])) fail('SHA256SUMS is malformed', 'PACKET_HASH_MISMATCH');
    seen.set(match[2], match[1]);
  }
  const payloadNames = Object.keys(expected).filter((name) => name !== 'SHA256SUMS');
  if (seen.size !== payloadNames.length) fail('SHA256SUMS has an unexpected inventory', 'PACKET_HASH_MISMATCH');
  for (const name of payloadNames) {
    if (seen.get(name) !== expected[name]) fail(`SHA256SUMS does not bind ${name}`, 'PACKET_HASH_MISMATCH');
  }
}

function assertTuple(tuple, label) {
  requireObject(tuple, label);
  if (!equalJson(tuple, RC0_TUPLE)) fail(`${label} does not match the immutable RC-0 tuple`, 'TUPLE_MISMATCH');
}

function assertArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    fail(`${label} is not the required ordered inventory`, 'SCHEMA_INVALID');
  }
}

export function validatePacketConfig(config) {
  requireObject(config, 'packet config');
  if (config.schema_version !== 'r25-executor-config.v1') fail('packet schema version is unsupported', 'SCHEMA_INVALID');
  if (config.packet_id !== 'R-25-EXECUTOR-CONFIG-RC-0-M4-6') fail('packet id is not canonical', 'SCHEMA_INVALID');
  assertTuple(config.immutable_rc0_tuple, 'packet tuple');
  assertArray(config.required_scenario_groups, SCENARIO_GROUPS, 'packet scenario groups');
  assertArray(config.required_stop_safety_outcomes, STOP_OUTCOMES, 'packet stop outcomes');
  if (!Array.isArray(config.records) || config.records.length !== EXPECTED_SLOTS.length) fail('packet must contain exactly six records', 'SCHEMA_INVALID');
  const bySlot = new Map();
  const requestIds = new Set();
  for (const record of config.records) {
    requireObject(record, 'packet record');
    const expected = EXPECTED_SLOTS.find((slot) => slot.slot_id === record.slot_id);
    if (!expected || bySlot.has(record.slot_id)) fail('packet has an unknown or duplicate slot', 'SCHEMA_INVALID');
    bySlot.set(record.slot_id, record);
    for (const key of ['slot_id', 'request_id', 'os', 'runner', 'shell', 'channel', 'mode']) {
      if (record[key] !== expected[key]) fail(`${record.slot_id}: ${key} does not match the canonical slot`, 'SCHEMA_INVALID');
    }
    if (requestIds.has(record.request_id)) fail('packet has a duplicate request id', 'SCHEMA_INVALID');
    requestIds.add(record.request_id);
    if (record.venue !== 'M-VENUE' || record.immutable_pinokio_sha !== RC0_TUPLE.pinokio) fail(`${record.slot_id}: venue or Pinokio binding is wrong`, 'TUPLE_MISMATCH');
    assertTuple(record.rc0_tuple, `${record.slot_id}: tuple`);
    assertArray(record.required_scenario_groups, SCENARIO_GROUPS, `${record.slot_id}: scenario groups`);
    assertArray(record.required_stop_safety_outcomes, STOP_OUTCOMES, `${record.slot_id}: stop outcomes`);
  }
  if (bySlot.size !== EXPECTED_SLOTS.length) fail('packet does not cover every canonical slot', 'SCHEMA_INVALID');
  return { ...config, records: config.records.map((record) => ({ ...record })) };
}

export function loadPacket(packetDirectory, expectedHashes = PACKET_FILES) {
  const directory = path.resolve(requireString(packetDirectory, 'packet directory'));
  requireObject(expectedHashes, 'packet hash inventory');
  for (const [name, digest] of Object.entries(expectedHashes)) {
    requireDigest(digest, `packet hash for ${name}`);
    const filename = path.join(directory, name);
    let stat;
    try { stat = fs.lstatSync(filename); } catch { fail(`packet file is missing: ${name}`, 'INPUT_MISSING'); }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`packet file is unsafe: ${name}`, 'INPUT_INVALID');
    if (sha256File(filename) !== digest) fail(`packet hash mismatch: ${name}`, 'PACKET_HASH_MISMATCH');
  }
  parseChecksumFile(path.join(directory, 'SHA256SUMS'), expectedHashes);
  const config = validatePacketConfig(readJsonFile(path.join(directory, 'RC-0-EXECUTOR-CONFIGS.json'), 'packet config'));
  return { directory, config, hashes: { ...expectedHashes }, commit: PACKET_COMMIT };
}

function noBindings(slot) {
  return {
    valid: false,
    reason: 'AWAITING_BINDINGS',
    missing: ['r24_provider', 'fixture_profile', 'installed_product', 'r36_collector', 'r36_verifier'],
    receipt: bindingReceipt(null, slot),
  };
}

function bindingReceipt(binding, slot) {
  const has = (key) => isPlainObject(binding?.[key]);
  return {
    r24_provider: has('provider') ? 'declared-unverified' : 'missing',
    fixture_profile: has('fixture_profile') ? 'declared-unverified' : 'missing',
    installed_product: has('installed_product') ? 'declared-unverified' : 'missing',
    r36_collector: isPlainObject(binding?.r36?.collector) ? 'declared-unverified' : 'missing',
    r36_verifier: isPlainObject(binding?.r36?.verifier) ? 'declared-unverified' : 'missing',
    accepted_r24_provider_binding: null,
    trusted_r36_collector_disposition: 'unknown',
    trusted_r36_verifier_result: 'unknown',
    required_slot: slot.slot_id,
  };
}

function assertBindingRef(value, label) {
  requireObject(value, label);
  if (!safeId(value.id)) fail(`${label}.id is invalid`, 'BINDING_INVALID');
  requireDigest(value.sha256, `${label}.sha256`);
}

function validateProviderCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.length > 16 || command.some((item) => typeof item !== 'string' || !item || item.length > 1024)) {
    fail('provider.command must be a bounded argv array', 'BINDING_INVALID');
  }
  const program = path.basename(command[0]).toLowerCase();
  if (['sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(program)) {
    fail('provider.command may not invoke a shell', 'BINDING_INVALID');
  }
  if (command.some((part) => part === '-e' || part === '--eval' || part === '-EncodedCommand')) fail('provider.command may not use inline evaluation', 'BINDING_INVALID');
}

export function validateBindings(binding, slot, bindingDirectory) {
  if (!binding) return noBindings(slot);
  if (!isPlainObject(binding)) return { valid: false, reason: 'BINDING_INVALID', missing: [], receipt: bindingReceipt(null, slot) };
  const missing = [];
  if (!isPlainObject(binding.provider)) missing.push('r24_provider');
  if (!isPlainObject(binding.fixture_profile)) missing.push('fixture_profile');
  if (!isPlainObject(binding.installed_product)) missing.push('installed_product');
  if (!isPlainObject(binding.r36?.collector)) missing.push('r36_collector');
  if (!isPlainObject(binding.r36?.verifier)) missing.push('r36_verifier');
  if (missing.length) return { valid: false, reason: 'AWAITING_BINDINGS', missing, receipt: bindingReceipt(binding, slot) };
  try {
    requireObject(binding, 'binding');
    if (binding.schema_version !== 'r25-m4-6-execution-binding.v1') fail('binding schema version is unsupported', 'BINDING_INVALID');
    if (binding.slot_id !== slot.slot_id) fail('binding slot does not match requested slot', 'BINDING_TUPLE_MISMATCH');
    assertTuple(binding.tuple, 'binding tuple');
    assertBindingRef(binding.provider, 'binding.provider');
    validateProviderCommand(binding.provider.command);
    assertBindingRef(binding.fixture_profile, 'binding.fixture_profile');
    assertBindingRef(binding.installed_product, 'binding.installed_product');
    requireObject(binding.r36, 'binding.r36');
    assertBindingRef(binding.r36.collector, 'binding.r36.collector');
    assertBindingRef(binding.r36.verifier, 'binding.r36.verifier');
    requireObject(binding.real_engine, 'binding.real_engine');
    if (binding.real_engine.kind !== 'pinokio-real-engine' || binding.real_engine.kernel !== 'pinokio-daemon' || binding.real_engine.fake_kernel !== false || binding.real_engine.mode !== slot.mode) {
      fail('binding does not name the required real Pinokio engine for this mode', 'BINDING_INVALID');
    }
    const installedPath = path.resolve(bindingDirectory, requireString(binding.installed_product.path, 'installed product path'));
    let installedStat;
    try { installedStat = fs.lstatSync(installedPath); } catch { fail('installed product binding does not exist', 'BINDING_MISSING'); }
    if (!installedStat.isFile() || installedStat.isSymbolicLink()) fail('installed product binding is not a regular file', 'BINDING_INVALID');
    if (sha256File(installedPath) !== binding.installed_product.sha256) fail('installed product digest does not match its binding', 'BINDING_INVALID');
    return { valid: true, binding, installedPath, receipt: bindingReceipt(binding, slot), missing: [] };
  } catch (error) {
    return {
      valid: false,
      reason: error.code || 'BINDING_INVALID',
      missing: [],
      receipt: bindingReceipt(binding, slot),
    };
  }
}

function emptyScenarios(reason) {
  return Object.fromEntries(SCENARIO_GROUPS.map((group) => [group, group === 'stop_safety'
    ? { state: 'unknown', reason, inner_exit_code: null, outcomes: { refused: 'unknown', unknown: 'unknown' }, artifacts: [] }
    : { state: 'unknown', reason, inner_exit_code: null, artifacts: [] }]));
}

function safeHostedValue(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

function receiptCheckouts(checkouts) {
  if (!isPlainObject(checkouts)) return null;
  const sanitize = (value) => isPlainObject(value) ? {
    head: typeof value.head === 'string' && SHA.test(value.head) ? value.head : null,
    clean: value.clean === true,
  } : null;
  return { driver: sanitize(checkouts.driver), product: sanitize(checkouts.product) };
}

function makeReceipt({ slot, packet, checkouts, actualPlatform, hosted, disposition, binding, scenarios, reason, artifacts = [] }) {
  const exits = Object.values(scenarios).map((scenario) => scenario.inner_exit_code).filter((code) => Number.isInteger(code));
  return {
    schema_version: 'r25-m4-6-driver-receipt.v1',
    receipt_kind: 'sanitized-m4-6-execution-receipt',
    generated_at: new Date().toISOString(),
    qualification: 'NOT_QUALIFIED',
    disposition,
    reason: reason || null,
    slot: {
      id: slot.slot_id,
      request_id: slot.request_id,
      os: slot.os,
      runner: slot.runner,
      shell: slot.shell,
      channel: slot.channel,
      mode: slot.mode,
    },
    immutable_tuple: { ...RC0_TUPLE },
    packet: packet ? { commit: packet.commit, hashes: packet.hashes } : null,
    checkout: receiptCheckouts(checkouts),
    execution_environment: { observed_platform: actualPlatform || null },
    hosted: { run_id: safeHostedValue(hosted?.run_id), job_id: safeHostedValue(hosted?.job_id) },
    inner_exit_code: exits.length === SCENARIO_GROUPS.length && exits.every((code) => code === 0) ? 0 : null,
    bindings: binding || bindingReceipt(null, slot),
    scenarios,
    artifact_hashes: artifacts,
    trusted_r36_collector_disposition: 'unknown',
    trusted_r36_verifier_result: 'unknown',
  };
}

function validateProviderEnvelope(value, group) {
  requireObject(value, 'provider result');
  if (value.schema_version !== 'r25-m4-6-provider-result.v1' || value.scenario_group !== group) fail('provider result does not bind this scenario', 'PROVIDER_INVALID');
  if (!['pass', 'fail', 'unknown'].includes(value.state)) fail('provider result has an invalid state', 'PROVIDER_INVALID');
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0 || value.artifacts.length > 128 || value.artifacts.some((artifact) => !safeRelative(artifact))) {
    fail('provider result has an unsafe artifact inventory', 'PROVIDER_INVALID');
  }
  if (group === 'stop_safety') {
    requireObject(value.stop_safety, 'provider stop safety');
    for (const outcome of STOP_OUTCOMES) if (!['pass', 'fail', 'unknown'].includes(value.stop_safety[outcome])) fail(`provider stop outcome ${outcome} is invalid`, 'PROVIDER_INVALID');
  }
  return value;
}

function collectArtifacts(scenarioDirectory, relativePaths, group) {
  const artifacts = [];
  const seen = new Set();
  const directoryStat = fs.lstatSync(scenarioDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('provider evidence directory is unsafe', 'PROVIDER_INVALID');
  const realDirectory = fs.realpathSync.native(scenarioDirectory);
  for (const relative of relativePaths) {
    if (seen.has(relative)) fail('provider result repeats an artifact path', 'PROVIDER_INVALID');
    seen.add(relative);
    const filename = path.resolve(scenarioDirectory, relative);
    const contained = path.relative(scenarioDirectory, filename);
    if (!safeRelative(contained)) fail('provider artifact escapes its evidence directory', 'PROVIDER_INVALID');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_SIZE) fail('provider artifact is unsafe or too large', 'PROVIDER_INVALID');
    const realFile = fs.realpathSync.native(filename);
    const realRelative = path.relative(realDirectory, realFile);
    if (!safeRelative(realRelative)) fail('provider artifact resolves outside its evidence directory', 'PROVIDER_INVALID');
    artifacts.push({ scenario: group, path: `artifacts/${group}/${relative}`, sha256: sha256File(filename), size: stat.size });
  }
  return artifacts;
}

function runProvider(argv, input, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
        WINDIR: process.env.WINDIR || '',
        PATHEXT: process.env.PATHEXT || '',
        HOME: process.env.HOME || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let oversized = false;
    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_PROVIDER_OUTPUT) { oversized = true; return current; }
      return Buffer.concat([current, chunk]);
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error: error.code || 'spawn-error', stdout, stderr, timedOut, oversized }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut, oversized }); });
    child.stdin.end(stableJson(input));
  });
}

async function executeScenarios(binding, slot, options) {
  const scenarios = {};
  const artifacts = [];
  const timeoutMs = Number.isSafeInteger(binding.provider.timeout_ms) && binding.provider.timeout_ms >= 1000 && binding.provider.timeout_ms <= 30 * 60 * 1000
    ? binding.provider.timeout_ms : 10 * 60 * 1000;
  for (const group of SCENARIO_GROUPS) {
    const scenarioDirectory = path.join(options.evidenceDirectory, 'artifacts', group);
    fs.mkdirSync(scenarioDirectory, { recursive: true, mode: 0o700 });
    const result = await runProvider(binding.provider.command, {
      schema_version: 'r25-m4-6-provider-request.v1',
      slot: { id: slot.slot_id, os: slot.os, channel: slot.channel, mode: slot.mode },
      immutable_tuple: RC0_TUPLE,
      scenario_group: group,
      required_stop_safety_outcomes: group === 'stop_safety' ? STOP_OUTCOMES : [],
      product_checkout: options.productCheckout,
      installed_product: options.installedPath,
      evidence_directory: scenarioDirectory,
    }, options.bindingDirectory, timeoutMs);
    if (result.code !== 0 || result.timedOut || result.oversized) {
      scenarios[group] = group === 'stop_safety'
        ? { state: 'failed', reason: result.timedOut ? 'provider-timeout' : 'provider-exit', inner_exit_code: Number.isInteger(result.code) ? result.code : null, outcomes: { refused: 'unknown', unknown: 'unknown' }, artifacts: [] }
        : { state: 'failed', reason: result.timedOut ? 'provider-timeout' : 'provider-exit', inner_exit_code: Number.isInteger(result.code) ? result.code : null, artifacts: [] };
      continue;
    }
    try {
      const envelope = validateProviderEnvelope(parseJsonUnique(result.stdout.toString('utf8'), 'provider result'), group);
      const groupArtifacts = collectArtifacts(scenarioDirectory, envelope.artifacts, group);
      artifacts.push(...groupArtifacts);
      scenarios[group] = group === 'stop_safety'
        ? { state: envelope.state, reason: null, inner_exit_code: result.code, outcomes: { ...envelope.stop_safety }, artifacts: groupArtifacts }
        : { state: envelope.state, reason: null, inner_exit_code: result.code, artifacts: groupArtifacts };
    } catch (error) {
      scenarios[group] = group === 'stop_safety'
        ? { state: 'failed', reason: error.code || 'provider-invalid', inner_exit_code: result.code, outcomes: { refused: 'unknown', unknown: 'unknown' }, artifacts: [] }
        : { state: 'failed', reason: error.code || 'provider-invalid', inner_exit_code: result.code, artifacts: [] };
    }
  }
  return { scenarios, artifacts };
}

export async function runSlot({ packet, slotId, outputDirectory, binding = null, bindingDirectory = process.cwd(), checkouts = null, actualPlatform = platformName(process.platform), hosted = null }) {
  if (!packet?.config) fail('packet was not loaded', 'INPUT_MISSING');
  const slot = packet.config.records.find((record) => record.slot_id === slotId);
  if (!slot) fail('requested slot is not in the canonical packet', 'SCHEMA_INVALID');
  if (actualPlatform !== slot.os) {
    return makeReceipt({ slot, packet, checkouts, actualPlatform, hosted, disposition: 'REFUSED_PLATFORM_MISMATCH', binding: bindingReceipt(binding, slot), scenarios: emptyScenarios('platform-mismatch'), reason: 'runner OS does not match canonical slot' });
  }
  if (!checkouts?.product || checkouts.product.head !== RC0_TUPLE.pinokio || checkouts.product.clean !== true) {
    return makeReceipt({ slot, packet, checkouts, actualPlatform, hosted, disposition: 'REFUSED_CHECKOUT_IDENTITY', binding: bindingReceipt(binding, slot), scenarios: emptyScenarios('checkout-identity'), reason: 'product checkout is not the clean immutable Pinokio base' });
  }
  const bindingState = validateBindings(binding, slot, bindingDirectory);
  if (!bindingState.valid) {
    return makeReceipt({ slot, packet, checkouts, actualPlatform, hosted, disposition: bindingState.reason === 'AWAITING_BINDINGS' ? 'AWAITING_BINDINGS' : 'REFUSED_BINDING', binding: bindingState.receipt, scenarios: emptyScenarios(bindingState.reason || 'binding-invalid'), reason: bindingState.reason || 'binding-invalid' });
  }
  const evidenceDirectory = path.resolve(outputDirectory);
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const execution = await executeScenarios(bindingState.binding, slot, {
    evidenceDirectory,
    bindingDirectory: path.resolve(bindingDirectory),
    productCheckout: checkouts.product.path || null,
    installedPath: bindingState.installedPath,
  });
  const failed = Object.values(execution.scenarios).some((scenario) => scenario.state !== 'pass' || (scenario.outcomes && STOP_OUTCOMES.some((outcome) => scenario.outcomes[outcome] !== 'pass')));
  return makeReceipt({
    slot, packet, checkouts, actualPlatform, hosted,
    disposition: failed ? 'EXECUTION_INCOMPLETE' : 'AWAITING_R36_VERIFICATION',
    binding: bindingState.receipt,
    scenarios: execution.scenarios,
    reason: failed ? 'one-or-more-unverified-scenarios-did-not-pass' : 'external R-36 authority is required for any qualification decision',
    artifacts: execution.artifacts,
  });
}

export function writeReceipt(outputDirectory, slotId, receipt) {
  const directory = path.resolve(outputDirectory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const basename = `m4-6-receipt-${slotId}.json`;
  const receiptPath = path.join(directory, basename);
  fs.writeFileSync(receiptPath, `${stableJson(receipt)}\n`, { mode: 0o600 });
  const hash = sha256File(receiptPath);
  const inventory = [{ path: basename, sha256: hash }, ...receipt.artifact_hashes.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))]
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of inventory) {
    if (!safeRelative(entry.path)) fail('receipt has an unsafe artifact inventory path', 'RECEIPT_INVALID');
    const filename = path.resolve(directory, entry.path);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(filename) !== entry.sha256) fail('receipt artifact inventory does not match output bytes', 'RECEIPT_INVALID');
  }
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), inventory.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n', { mode: 0o600 });
  return { receiptPath, hash };
}

function readCheckout(directory, label) {
  const absolute = path.resolve(directory);
  const command = (args) => spawnSync('git', ['-C', absolute, ...args], { encoding: 'utf8' });
  const head = command(['rev-parse', 'HEAD']);
  const worktree = command(['diff', '--quiet']);
  const index = command(['diff', '--cached', '--quiet']);
  if (head.status !== 0 || !SHA.test(head.stdout.trim())) fail(`${label} checkout is not a Git commit`, 'CHECKOUT_INVALID');
  return { head: head.stdout.trim(), clean: worktree.status === 0 && index.status === 0 };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`, 'INPUT_INVALID');
    if (Object.hasOwn(args, key)) fail(`duplicate argument ${key}`, 'INPUT_INVALID');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`missing value for ${key}`, 'INPUT_INVALID');
    args[key] = value;
    index += 1;
  }
  for (const key of ['--packet-dir', '--slot', '--output-dir', '--product-checkout', '--driver-checkout']) if (!args[key]) fail(`missing ${key}`, 'INPUT_MISSING');
  return args;
}

function minimalReceipt(slotId, code, message) {
  const expected = EXPECTED_SLOTS.find((slot) => slot.slot_id === slotId);
  const slot = expected || { slot_id: safeId(slotId) ? slotId : 'unknown', request_id: null, os: null, runner: null, shell: null, channel: null, mode: null };
  return makeReceipt({ slot, packet: null, checkouts: null, actualPlatform: platformName(process.platform), hosted: null, disposition: 'INPUT_REJECTED', binding: bindingReceipt(null, slot), scenarios: emptyScenarios(code || 'INPUT_INVALID'), reason: message });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const packet = loadPacket(args['--packet-dir']);
    const bindingPath = args['--binding'] || process.env.R25_M4_6_BINDING || null;
    const binding = bindingPath ? readJsonFile(bindingPath, 'execution binding') : null;
    const driver = readCheckout(args['--driver-checkout'], 'driver');
    const product = readCheckout(args['--product-checkout'], 'product');
    const receipt = await runSlot({
      packet,
      slotId: args['--slot'],
      outputDirectory: args['--output-dir'],
      binding,
      bindingDirectory: bindingPath ? path.dirname(path.resolve(bindingPath)) : process.cwd(),
      checkouts: { driver, product: { ...product, path: path.resolve(args['--product-checkout']) } },
      hosted: { run_id: process.env.GITHUB_RUN_ID, job_id: process.env.GITHUB_JOB },
    });
    // The provider is untrusted with the worktrees. Re-measure both after it
    // returns so a locally successful command cannot hide checkout mutation.
    const driverAfter = readCheckout(args['--driver-checkout'], 'driver');
    const productAfter = readCheckout(args['--product-checkout'], 'product');
    receipt.checkout.after = { driver: driverAfter, product: productAfter };
    if (driverAfter.head !== driver.head || !driverAfter.clean || productAfter.head !== RC0_TUPLE.pinokio || !productAfter.clean) {
      receipt.disposition = 'REFUSED_CHECKOUT_MUTATION';
      receipt.reason = 'provider changed a driver or immutable product checkout';
      receipt.qualification = 'NOT_QUALIFIED';
    }
    writeReceipt(args['--output-dir'], args['--slot'], receipt);
    process.stdout.write(`${receipt.disposition} ${args['--slot']}\n`);
    process.exitCode = receipt.disposition === 'EXECUTION_INCOMPLETE' ? 1 : AWAITING_EXIT;
  } catch (error) {
    const output = args?.['--output-dir'];
    if (output) writeReceipt(output, args['--slot'] || 'unknown', minimalReceipt(args['--slot'], error.code || 'INPUT_INVALID', error.message));
    process.stderr.write(`${error.code || 'INPUT_INVALID'}: ${error.message}\n`);
    process.exitCode = AWAITING_EXIT;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
