'use strict';

// Strict shape and digest validation for the bounded Windows snapshot seam.
const crypto = require('node:crypto');

const SCHEMA = 'astrid.r25.snapshot.windows.v1';
const SOURCE_PROFILE = 'windows-cim-task-service-snapshot-v1';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const MAX_PID = 0xffffffff;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 32768;
const TASK_PATH = /^\\(?:[^\\\u0000-\u001f]+\\)*[^\\\u0000-\u001f]+$/u;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,255}$/;
const PROFILE = Object.freeze({
  profile: SOURCE_PROFILE,
  platform: 'windows',
  runner: 'windows-2022',
  shell: 'powershell.exe',
  executable: POWERSHELL,
  process_interface: 'Get-CimInstance Win32_Process',
  task_interface: 'Task Scheduler COM',
  service_interface: 'Get-CimInstance Win32_Service',
  continuity: 'bounded-snapshot',
});

function refuse(message) { throw new Error(`Windows snapshot refused: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
  return value;
}
function exact(value, keys, label) {
  const row = object(value, label);
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) refuse(`${label} has missing or unknown fields`);
  return row;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) refuse(`${label} is malformed`);
  return value;
}
function text(value, label, { nullable = false, allowEmpty = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > MAX_TEXT || value.includes('\0')) refuse(`${label} is malformed`);
  return value;
}
function utc(value, label) {
  text(value, label);
  if (!/(?:Z|\+00:00)$/.test(value) || Number.isNaN(Date.parse(value))) refuse(`${label} must be UTC`);
}
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return asciiJson(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('canonical data contains an unsafe number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = object(value, 'canonical data');
  return `{${Object.keys(row).sort().map(key => `${asciiJson(key)}:${canonical(row[key])}`).join(',')}}`;
}
function structuralDigest(observation) {
  const unsigned = { ...object(observation, 'observation') };
  delete unsigned.structural_sha256;
  return crypto.createHash('sha256').update(canonical(unsigned), 'ascii').digest('hex');
}
function targetKey(value) { return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/ß/g, 'ss').replace(/ς/g, 'σ'); }
function targetList(value, label, validate, maximum) {
  if (!Array.isArray(value) || value.length > maximum) refuse(`${label} exceeds capacity or is not a list`);
  const seen = new Set();
  return value.map((item, index) => {
    const parsed = validate(item, `${label}[${index}]`);
    const key = targetKey(parsed);
    if (seen.has(key)) refuse(`${label} contains a duplicate target`);
    seen.add(key);
    return parsed;
  });
}
function taskTarget(value, label) {
  if (typeof value !== 'string' || !TASK_PATH.test(value) || value !== value.trim() || value.length > 512) refuse(`${label} is unsafe`);
  return value;
}
function serviceTarget(value, label) {
  if (typeof value !== 'string' || !SERVICE_NAME.test(value) || value !== value.trim()) refuse(`${label} is unsafe`);
  return value;
}
function validateError(value, label) {
  const row = exact(value, ['type', 'hresult', 'fully_qualified_error_id', 'category'], label);
  text(row.type, `${label}.type`);
  integer(row.hresult, `${label}.hresult`, -(2 ** 31), (2 ** 31) - 1);
  text(row.fully_qualified_error_id, `${label}.fully_qualified_error_id`);
  text(row.category, `${label}.category`);
}
function validateProcesses(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) refuse('processes exceed capacity or are not a list');
  const seen = new Set();
  let previous = -1;
  value.forEach((item, index) => {
    const row = exact(item, ['pid', 'parent_pid', 'command_line', 'creation_time_utc', 'executable_path'], `processes[${index}]`);
    integer(row.pid, `processes[${index}].pid`, 0, MAX_PID);
    integer(row.parent_pid, `processes[${index}].parent_pid`, 0, MAX_PID);
    text(row.command_line, `processes[${index}].command_line`, { nullable: true });
    utc(row.creation_time_utc, `processes[${index}].creation_time_utc`);
    text(row.executable_path, `processes[${index}].executable_path`, { nullable: true });
    if (seen.has(row.pid)) refuse('processes contain a duplicate PID');
    if (row.pid < previous) refuse('processes are not in canonical PID order');
    seen.add(row.pid); previous = row.pid;
  });
}
function validateAction(value, label) {
  const row = exact(value, ['type', 'execute', 'arguments', 'working_directory'], label);
  integer(row.type, `${label}.type`, 0, 255);
  text(row.execute, `${label}.execute`, { nullable: true, allowEmpty: true });
  text(row.arguments, `${label}.arguments`, { nullable: true, allowEmpty: true });
  text(row.working_directory, `${label}.working_directory`, { nullable: true, allowEmpty: true });
}
function validateTaskRows(value, targets, maximumActions) {
  if (!Array.isArray(value) || value.length !== targets.length) refuse('scheduled-task rows differ from targets');
  const seen = new Set();
  value.forEach((item, index) => {
    const target = taskTarget(item && item.target, `scheduled_tasks[${index}].target`);
    const key = targetKey(target);
    if (seen.has(key) || key !== targetKey(targets[index])) refuse('scheduled-task rows contain a duplicate or unexpected target');
    seen.add(key);
    if (item.status === 'absent') exact(item, ['target', 'status'], `scheduled_tasks[${index}]`);
    else if (item.status === 'collection-error') { exact(item, ['target', 'status', 'error'], `scheduled_tasks[${index}]`); validateError(item.error, `scheduled_tasks[${index}].error`); }
    else if (item.status === 'present') {
      const row = exact(item, ['target', 'status', 'state', 'enabled', 'actions'], `scheduled_tasks[${index}]`);
      if (!['unknown', 'disabled', 'queued', 'ready', 'running'].includes(row.state) || typeof row.enabled !== 'boolean' || !Array.isArray(row.actions) || row.actions.length > maximumActions) refuse(`scheduled_tasks[${index}] is malformed`);
      row.actions.forEach((action, actionIndex) => validateAction(action, `scheduled_tasks[${index}].actions[${actionIndex}]`));
    } else refuse(`scheduled_tasks[${index}].status is malformed`);
  });
}
function validateServiceRows(value, targets) {
  if (!Array.isArray(value) || value.length !== targets.length) refuse('service rows differ from targets');
  const seen = new Set();
  value.forEach((item, index) => {
    const target = serviceTarget(item && item.target, `services[${index}].target`);
    const key = targetKey(target);
    if (seen.has(key) || key !== targetKey(targets[index])) refuse('service rows contain a duplicate or unexpected target');
    seen.add(key);
    if (item.status === 'absent') exact(item, ['target', 'status'], `services[${index}]`);
    else if (item.status === 'collection-error') { exact(item, ['target', 'status', 'error'], `services[${index}]`); validateError(item.error, `services[${index}].error`); }
    else if (item.status === 'present') {
      const row = exact(item, ['target', 'status', 'state', 'start_type', 'process_id'], `services[${index}]`);
      text(row.state, `services[${index}].state`); text(row.start_type, `services[${index}].start_type`); integer(row.process_id, `services[${index}].process_id`, 0, MAX_PID);
    } else refuse(`services[${index}].status is malformed`);
  });
}
function validateObservation(value) {
  const observation = exact(value, ['schema', 'source', 'capture', 'limits', 'targets', 'processes', 'scheduled_tasks', 'services', 'structural_sha256'], 'observation');
  if (observation.schema !== SCHEMA) refuse('schema differs');
  exact(observation.source, Object.keys(PROFILE), 'source');
  for (const key of Object.keys(PROFILE)) if (observation.source[key] !== PROFILE[key]) refuse(`source.${key} differs`);
  const capture = exact(observation.capture, ['started_at_utc', 'completed_at_utc', 'started_monotonic_ns', 'completed_monotonic_ns', 'collector_pid'], 'capture');
  utc(capture.started_at_utc, 'capture.started_at_utc'); utc(capture.completed_at_utc, 'capture.completed_at_utc');
  integer(capture.started_monotonic_ns, 'capture.started_monotonic_ns'); integer(capture.completed_monotonic_ns, 'capture.completed_monotonic_ns'); integer(capture.collector_pid, 'capture.collector_pid', 1, MAX_PID);
  const limits = exact(observation.limits, ['max_processes', 'max_targets', 'max_task_actions', 'max_output_bytes', 'timeout_seconds'], 'limits');
  for (const key of Object.keys(limits)) integer(limits[key], `limits.${key}`, 1);
  const targets = exact(observation.targets, ['scheduled_task_paths', 'service_names'], 'targets');
  const tasks = targetList(targets.scheduled_task_paths, 'targets.scheduled_task_paths', taskTarget, limits.max_targets);
  const services = targetList(targets.service_names, 'targets.service_names', serviceTarget, limits.max_targets);
  if (tasks.length + services.length > limits.max_targets) refuse('combined target capacity exceeded');
  validateProcesses(observation.processes, limits.max_processes); validateTaskRows(observation.scheduled_tasks, tasks, limits.max_task_actions); validateServiceRows(observation.services, services);
  if (typeof observation.structural_sha256 !== 'string' || !HEX64.test(observation.structural_sha256) || structuralDigest(observation) !== observation.structural_sha256) refuse('structural_sha256 differs from canonical observation');
  return observation;
}

module.exports = { POWERSHELL, PROFILE, SCHEMA, SOURCE_PROFILE, canonical, structuralDigest, validateObservation };
