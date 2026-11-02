'use strict';

// Build the exact request consumed by astrid-agent's R-25 snapshot session.
// This module is a source/request binding, never a qualification verdict.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const macos = require('./r25-snapshot-macos.cjs');
const windows = require('./r25-snapshot-windows.cjs');

const SCHEMA = 'astrid.r25.pinokio-snapshot-request.v1';
const ROUTE_SCHEMA = 'astrid.r25.pinokio-snapshot-route.v1';
const AGENT_SOURCE_REF = '21a53a9c241f403a80b103cd136d6e785c12b3fc';
const R36_REF = '010e8f25c70109f0a93a6fccb0a16f7f40e06739';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const MAC_TARGET = /^(?:system|(?:gui|user|pid)\/[0-9]{1,20})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9_-])?$/;
const WINDOWS_TASK = /^\\(?:[^\\\u0000-\u001f]+\\)*[^\\\u0000-\u001f]+$/u;
const WINDOWS_SERVICE = /^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,255}$/;

const REQUIRED_ACTIONS = Object.freeze([
  'start', 'ready', 'stop', 'update', 'rollback', 'uninstall',
]);
const slots = Object.freeze([
  ['pinokio-backend-macos', 'macos', 'backend'],
  ['pinokio-fully-local-macos', 'macos', 'fully-local'],
  ['pinokio-backend-windows', 'windows', 'backend'],
  ['pinokio-fully-local-windows', 'windows', 'fully-local'],
].map(([id, os, mode]) => Object.freeze({ id, os, mode, channel: 'pinokio' })));
const profiles = Object.freeze({ macos: macos.PROFILE, windows: windows.PROFILE });
const sourceFiles = Object.freeze({
  agent: Object.freeze({
    'scripts/pinokio_snapshot_collector.py': 'a94ef58088702aba984c920a7d718ee6b03713a52d93b41298ccdd958a230a99',
    'scripts/pinokio_snapshot_macos.py': '086faf864e821ef53e7502179cdd322a7b86b462e4403e0f7af6abf789b2db6d',
    'scripts/pinokio_snapshot_windows.py': '6651f962034abe2522644beaf5c4258442f6933b2bcb5cd3cc83ee9a6f10fd6d',
  }),
  pinokio: Object.freeze({
    'pinokio/providers/r25-snapshot-macos.cjs': 'eceba872257c310f1ad638e475ee1954facef43866ee95f443170fda408631da',
    'pinokio/providers/r25-snapshot-windows.cjs': '2c3cbce7597f3440ded89c89eaf1b74f7eae6c1ba11e71e9d3d64fb2e70e67d8',
  }),
});
const flattenedSources = Object.freeze({ ...sourceFiles.agent, ...sourceFiles.pinokio });

function refuse(message) { throw new Error(`snapshot binding refused: ${message}`); }
function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
  return value;
}
function exact(value, fields, label) {
  const row = record(value, label);
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) refuse(`${label} fields differ`);
  return row;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) refuse(`${label} must be a non-empty string`);
  return value;
}
function digest(value, label, pattern = HEX64) {
  if (typeof value !== 'string' || !pattern.test(value)) refuse(`${label} must be an immutable digest`);
  return value;
}
function positive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) refuse(`${label} must be a positive safe integer`);
  return value;
}
function safeLabel(value, label) {
  text(value, label);
  if (!SAFE_LABEL.test(value)) refuse(`${label} must be a safe bounded label`);
  return value;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('canonical value contains a non-safe integer');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = record(value, 'canonical value');
  return `{${Object.keys(row).sort().map(key => `${canonical(key)}:${canonical(row[key])}`).join(',')}}`;
}
function requestSha256(request) { return sha256(Buffer.from(canonical(request), 'ascii')); }

function validateTuple(value) {
  const tuple = exact(value, ['app', 'agent', 'runtime', 'pinokio', 'manifest_sha256', 'artifacts', 'published_at'], 'tuple');
  for (const key of ['app', 'agent', 'runtime', 'pinokio']) digest(tuple[key], `tuple.${key}`, HEX40);
  digest(tuple.manifest_sha256, 'tuple.manifest_sha256');
  const artifacts = exact(tuple.artifacts, ['public/install', 'public/install.sh', 'public/install.ps1'], 'tuple.artifacts');
  for (const [name, valueDigest] of Object.entries(artifacts)) digest(valueDigest, `tuple.artifacts.${name}`);
  text(tuple.published_at, 'tuple.published_at');
  if (!UTC.test(tuple.published_at) || Number.isNaN(Date.parse(tuple.published_at))) refuse('tuple.published_at must be ISO-8601 with timezone');
  return tuple;
}

function validateOrigin(value, slotId) {
  const origin = exact(value, [
    'repository_id', 'repository_full_name', 'workflow_id', 'workflow_ref', 'workflow_sha',
    'run_id', 'run_attempt', 'head_sha', 'producer_job_id', 'producer_job_name',
    'artifact_id', 'artifact_name',
  ], 'origin');
  for (const name of ['repository_id', 'workflow_id', 'run_id', 'run_attempt', 'producer_job_id']) positive(origin[name], `origin.${name}`);
  if (text(origin.repository_full_name, 'origin.repository_full_name').split('/').length !== 2) refuse('origin.repository_full_name must be owner/name');
  text(origin.workflow_ref, 'origin.workflow_ref');
  digest(origin.workflow_sha, 'origin.workflow_sha', HEX40);
  digest(origin.head_sha, 'origin.head_sha', HEX40);
  text(origin.producer_job_name, 'origin.producer_job_name');
  if (origin.artifact_id !== null) positive(origin.artifact_id, 'origin.artifact_id');
  safeLabel(origin.artifact_name, 'origin.artifact_name');
  if (!origin.artifact_name.startsWith(`r25-snapshots-${slotId}-`)) refuse('origin.artifact_name is not bound to the slot');
  return origin;
}

function validateActions(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_ACTIONS.length) refuse('actions must bind the exact six action boundaries');
  const seen = new Set();
  return value.map((item, index) => {
    const row = exact(item, ['action', 'action_id', 'action_sha256'], `actions[${index}]`);
    if (row.action !== REQUIRED_ACTIONS[index]) refuse('actions are missing, duplicated, or out of order');
    safeLabel(row.action_id, `actions[${index}].action_id`);
    if (seen.has(row.action_id)) refuse('action IDs must be unique');
    seen.add(row.action_id);
    digest(row.action_sha256, `actions[${index}].action_sha256`);
    return row;
  });
}

function uniqueTargets(value, label, pattern) {
  if (!Array.isArray(value) || value.length > 64) refuse(`${label} must be a bounded list`);
  const seen = new Set();
  return value.map((item, index) => {
    if (typeof item !== 'string' || !pattern.test(item) || item !== item.trim()) refuse(`${label}[${index}] is unsafe`);
    const key = item.toLocaleLowerCase('en-US');
    if (seen.has(key)) refuse(`${label} contains a duplicate target`);
    seen.add(key);
    return item;
  });
}

function validateTargets(value, os) {
  if (os === 'macos') {
    const targets = exact(value, ['os', 'launchd_targets'], 'targets');
    if (targets.os !== os) refuse('targets.os differs from slot');
    uniqueTargets(targets.launchd_targets, 'targets.launchd_targets', MAC_TARGET);
    return targets;
  }
  const targets = exact(value, ['os', 'scheduled_task_paths', 'service_names'], 'targets');
  if (targets.os !== os) refuse('targets.os differs from slot');
  const tasks = uniqueTargets(targets.scheduled_task_paths, 'targets.scheduled_task_paths', WINDOWS_TASK);
  const services = uniqueTargets(targets.service_names, 'targets.service_names', WINDOWS_SERVICE);
  if (tasks.length + services.length > 64) refuse('combined Windows target capacity exceeded');
  return targets;
}

function validateRequest(value) {
  const request = exact(value, ['schema', 'slot_id', 'tuple', 'origin', 'collector', 'actions', 'targets'], 'request');
  if (request.schema !== SCHEMA) refuse('request schema differs');
  const slot = slots.find(item => item.id === request.slot_id);
  if (!slot) refuse('request slot is not one of the four macOS/Windows slots');
  validateTuple(request.tuple);
  validateOrigin(request.origin, slot.id);
  const collector = exact(request.collector, ['agent_ref', 'pinokio_ref', 'sources'], 'collector');
  if (collector.agent_ref !== AGENT_SOURCE_REF) refuse(`collector.agent_ref must be ${AGENT_SOURCE_REF}`);
  digest(collector.pinokio_ref, 'collector.pinokio_ref', HEX40);
  const sources = exact(collector.sources, Object.keys(flattenedSources), 'collector.sources');
  for (const [name, expected] of Object.entries(flattenedSources)) {
    if (sources[name] !== expected) refuse(`collector.sources.${name} differs`);
  }
  validateActions(request.actions);
  validateTargets(request.targets, slot.os);
  return request;
}

function buildRequest(tuple, { slotId, candidateRef, agentRef = AGENT_SOURCE_REF, origin, actions, targets } = {}) {
  if (agentRef !== AGENT_SOURCE_REF) refuse(`agent_ref must be ${AGENT_SOURCE_REF}`);
  digest(candidateRef, 'candidate_ref', HEX40);
  const request = {
    schema: SCHEMA,
    slot_id: slotId,
    tuple,
    origin,
    collector: { agent_ref: agentRef, pinokio_ref: candidateRef, sources: flattenedSources },
    actions,
    targets,
  };
  return validateRequest(request);
}

function selectedSlots(targetOs = 'both', mode = 'both') {
  const oses = targetOs === 'both' ? ['macos', 'windows'] : [targetOs];
  const modes = mode === 'both' ? ['backend', 'fully-local'] : [mode];
  if (!oses.every(os => ['macos', 'windows'].includes(os))) refuse('target_os must be macos, windows, or both');
  if (!modes.every(item => ['backend', 'fully-local'].includes(item))) refuse('mode must be backend, fully-local, or both');
  return slots.filter(slot => oses.includes(slot.os) && modes.includes(slot.mode));
}

function validateSourceRoots({ agentRoot, pinokioRoot, agentRef = AGENT_SOURCE_REF } = {}) {
  if (agentRef !== AGENT_SOURCE_REF) refuse(`agent_ref must be ${AGENT_SOURCE_REF}`);
  const roots = { agent: agentRoot, pinokio: pinokioRoot };
  const failures = [];
  for (const [repository, files] of Object.entries(sourceFiles)) {
    const root = roots[repository];
    if (typeof root !== 'string' || !path.isAbsolute(root)) refuse(`${repository}Root must be absolute`);
    for (const [relative, expected] of Object.entries(files)) {
      const file = path.join(root, relative);
      let actual;
      try { actual = sha256(fs.readFileSync(file)); } catch { failures.push(`${repository}:${relative}: missing`); continue; }
      if (actual !== expected) failures.push(`${repository}:${relative}: sha256 ${actual} != ${expected}`);
    }
  }
  if (failures.length) refuse(`collector source mismatch: ${failures.join('; ')}`);
  return {
    schema: ROUTE_SCHEMA,
    agent_ref: agentRef,
    r36_ref: R36_REF,
    files: sourceFiles,
    qualification: 'component-observation-only; requires-r36-verifier',
    m4_6_acceptance: false,
  };
}

function main(argv) {
  const pairs = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) pairs[argv[index].slice(2)] = argv[index + 1];
  }
  if (pairs['validate-source-only'] === 'true') {
    const result = validateSourceRoots({
      agentRoot: pairs['agent-root'], pinokioRoot: pairs['pinokio-root'],
      agentRef: pairs['agent-ref'] || AGENT_SOURCE_REF,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const request = buildRequest(JSON.parse(pairs['tuple-json'] || '{}'), {
    slotId: pairs['slot-id'], candidateRef: pairs['candidate-ref'],
    agentRef: pairs['agent-ref'] || AGENT_SOURCE_REF,
    origin: JSON.parse(pairs['origin-json'] || '{}'),
    actions: JSON.parse(pairs['actions-json'] || '[]'),
    targets: JSON.parse(pairs['targets-json'] || '{}'),
  });
  const output = `${JSON.stringify(request, null, 2)}\n`;
  if (pairs.output) fs.writeFileSync(pairs.output, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(output);
}

module.exports = {
  AGENT_SOURCE_REF, R36_REF, REQUIRED_ACTIONS, ROUTE_SCHEMA, SCHEMA, buildRequest,
  canonical, flattenedSources, profiles, requestSha256, selectedSlots, sha256,
  slots, sourceFiles, validateRequest, validateSourceRoots,
};

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
