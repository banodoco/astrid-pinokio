import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const PINOKIO_PORT = 42000;
const EXPECTED_PINOKIO_COMMIT = process.env.PINOKIO_COMMIT || process.env.GITHUB_SHA || 'c5b42701641889ecb916c60cde09a717f83d62ff';
const EXPECTED_BASE_COMMIT = process.env.PINOKIO_BASE_COMMIT || 'c5b42701641889ecb916c60cde09a717f83d62ff';
const EXPECTED_PINOKIOD_REF = process.env.PINOKIOD_REF || 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const EXPECTED_PTERM_REF = process.env.PTERM_REF || '5be43718701c448b43daf0ce51d8935f170065bb';
const candidateRoot = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const pinokiodRoot = path.resolve(process.env.PINOKIOD_ROOT || path.join(os.tmpdir(), 'pinokiod'));
const ptermRoot = path.resolve(process.env.PTERM_ROOT || path.join(os.tmpdir(), 'pterm'));
const pinokioHome = path.resolve(process.env.PINOKIO_HOME || path.join(os.tmpdir(), 'pinokio-home'));
const evidenceDir = path.resolve(process.env.VENUE_EVIDENCE_DIR || path.join(os.tmpdir(), 'pinokio-venue-evidence'));
const appId = 'astrid-pinokio-venue-candidate';
const baseUrl = `http://127.0.0.1:${PINOKIO_PORT}`;
const selectedAppRoot = path.join(pinokioHome, 'api', appId);
const selectedStart = path.join(selectedAppRoot, 'pinokio', 'start.js');
const selectedRef = `pinokio://127.0.0.1:${PINOKIO_PORT}/api/${appId}`;
const actionFiles = ['pinokio/start.js', 'pinokio/stop.js', 'pinokio/update.js'];
const diagnosticDir = path.resolve(process.env.VENUE_DIAGNOSTIC_DIR || path.join(os.tmpdir(), 'pinokio-venue-diagnostics'));
const daemonLog = path.join(diagnosticDir, 'pinokiod.log');
const daemonPidFile = path.join(diagnosticDir, 'pinokiod.pid');
const actionPacketFile = path.join(diagnosticDir, 'engine-packets.jsonl');
const HTTP_HEADER_TIMEOUT_MS = 2_000;
const HTTP_BODY_TIMEOUT_MS = 3_000;
const READBACK_TIMEOUT_MS = 4_000;
const ENGINE_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 14_000;
const OBSERVATION_TIMEOUT_MS = 1_000;
const MAX_EXPORT_BYTES = 200_000;
const MAX_EXPORT_STRING_BYTES = 8_000;
const MAX_DIAGNOSTIC_BYTES = 500_000;
const SECRET_SHAPED = /(?:api[_-]?key|access[_-]?key|secret|token|password|authorization|bearer)\s*[:=]\s*[^\s,]{8,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PATH_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;
let daemonProcess = null;
let postSettlementCaptured = false;
let venuePostconditionsProven = false;

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(diagnosticDir, { recursive: true });
fs.mkdirSync(path.dirname(pinokioHome), { recursive: true });

const evidence = {
  status: 'UNKNOWN',
  immutable: {
    candidate_commit_expected: EXPECTED_PINOKIO_COMMIT,
    candidate_commit_observed: null,
    pinokiod_ref: EXPECTED_PINOKIOD_REF,
    pterm_ref: EXPECTED_PTERM_REF,
    actions: {},
  },
  venue: {
    platform: process.platform,
    node: process.version,
    pinokio_home: pinokioHome,
    port: PINOKIO_PORT,
    selected_app_id: appId,
    selected_ref: selectedRef,
    selected_root: null,
  },
  daemon: { pid: null, version: null, home: null, health: null },
  engine: {
    requested_uri: selectedStart,
    task_id: null,
    task_id_provenance: null,
    identity_failure: { failed: false, reason: null, observed_at: null },
    packets: [],
    settlement: 'not-attempted',
    boundary: null,
    readbacks: [],
    final_packet: null,
    transport: { closed: false, source: null, observed_at: null },
  },
  independent: {
    pre_settlement: null,
    post_settlement: null,
    post_cleanup: null,
  },
  cleanup: null,
  failures: [],
};

function recordFailure(message) {
  const text = typeof message === 'string' ? message : String(message);
  if (!evidence.failures.includes(text)) evidence.failures.push(text);
  evidence.status = 'UNKNOWN';
  evidence.engine.boundary ||= text;
}

function fail(message) {
  recordFailure(message);
  writeEvidence();
  throw new Error(message);
}

function redact(value, maxLength = 6000) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  for (const [needle, replacement] of [
    [candidateRoot, '$GITHUB_WORKSPACE'],
    [pinokiodRoot, '$PINOKIOD_ROOT'],
    [ptermRoot, '$PTERM_ROOT'],
    [pinokioHome, '$PINOKIO_HOME'],
    [selectedAppRoot, '$SELECTED_APP_ROOT'],
  ]) text = text.split(needle).join(replacement);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function redactJson(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child)]));
  }
  return value;
}

function safeExportText(value, label, maxBytes = MAX_EXPORT_STRING_BYTES) {
  if (typeof value !== 'string') throw new Error(`${label} was not a string`);
  const text = redact(value, maxBytes + 1);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeded export size limit`);
  if (CONTROL_CHARACTER.test(text)) throw new Error(`${label} contained a control character`);
  if (SECRET_SHAPED.test(text)) throw new Error(`${label} was secret-shaped`);
  if (PATH_TRAVERSAL.test(text)) throw new Error(`${label} contained path traversal`);
  return text;
}

const EXPORT_KEYS = new Set([
  'status', 'immutable', 'candidate_commit_expected', 'candidate_commit_observed', 'pinokiod_ref',
  'pterm_ref', 'actions', 'relative', 'source_sha256', 'ref_sha256', 'git_blob', 'selected_sha256',
  'selected_ref_match', 'deployed_match', 'venue', 'platform', 'node', 'pinokio_home', 'port',
  'selected_app_id', 'selected_ref', 'selected_root', 'daemon', 'pid', 'process_group', 'version',
  'home', 'health', 'ok', 'engine', 'requested_uri', 'task_id', 'task_id_provenance', 'source', 'observed_at',
  'requested_uri', 'identity_failure', 'failed', 'reason', 'packets', 'type', 'id', 'settlement',
  'boundary', 'readbacks', 'phase', 'matched_task_id', 'running_ids', 'assessment', 'valid', 'running',
  'task_present', 'task_id_matches_readback', 'resource_running', 'app_running', 'home_app_stopped',
  'final_packet', 'observed', 'bound_to_task_id', 'transport', 'closed', 'source', 'independent',
  'pre_settlement', 'post_settlement', 'before_cleanup', 'post_cleanup', 'captured_at', 'daemon_pid',
  'owned_process_group_id', 'process', 'available', 'present', 'observed_group_id', 'process_group',
  'owned_group_id', 'selection', 'members', 'member_pids', 'member_count', 'daemon_pid_member',
  'listener', 'cleanup', 'attempted', 'signals', 'forced', 'exited', 'group_absent', 'completed',
  'error', 'last_group_observation', 'process_group_id', 'failures', 'task_id_provenance', 'control', 'observation',
  'pinokio/start.js', 'pinokio/stop.js', 'pinokio/update.js',
]);

function validateExportValue(value, label = 'export') {
  if (typeof value === 'string') {
    safeExportText(value, label);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} exceeded array size limit`);
    value.forEach((child, index) => validateExportValue(child, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') throw new Error(`${label} had an unexpected value type`);
  for (const [key, child] of Object.entries(value)) {
    if (!EXPORT_KEYS.has(key)) throw new Error(`${label} contained unexpected field ${key}`);
    validateExportValue(child, `${label}.${key}`);
  }
}

function exportAssessment(assessment) {
  if (!assessment) return null;
  return {
    valid: Boolean(assessment.valid),
    running: Boolean(assessment.running),
    task_present: Boolean(assessment.task_present),
    task_id_matches_readback: Boolean(assessment.task_id_matches_readback),
    resource_running: assessment.resource_running ?? null,
    app_running: assessment.app_running ?? null,
    home_app_stopped: Boolean(assessment.home_app_stopped),
    running_ids: Array.isArray(assessment.running_ids) ? assessment.running_ids.slice(0, 32) : [],
  };
}

function exportObservation(observation) {
  if (!observation) return null;
  const processGroup = observation.process_group;
  return {
    captured_at: observation.captured_at || null,
    phase: observation.phase || null,
    daemon_pid: observation.daemon_pid || null,
    owned_process_group_id: observation.owned_process_group_id || null,
    process: observation.process ? {
      available: Boolean(observation.process.available),
      present: Boolean(observation.process.present),
      observed_group_id: observation.process.observed_group_id || null,
    } : null,
    process_group: processGroup ? {
      available: Boolean(processGroup.available),
      owned_group_id: processGroup.owned_group_id || null,
      selection: processGroup.selection || null,
      members: Array.isArray(processGroup.members) ? processGroup.members.slice(0, 128).map((member) => ({
        pid: member.pid || null,
        ppid: member.ppid || null,
        pgid: member.pgid || null,
        stat: member.stat || null,
      })) : [],
      member_pids: Array.isArray(processGroup.member_pids) ? processGroup.member_pids.slice(0, 128) : [],
      member_count: processGroup.member_count || 0,
      daemon_pid_member: Boolean(processGroup.daemon_pid_member),
    } : null,
    listener: observation.listener ? {
      available: Boolean(observation.listener.available),
      present: Boolean(observation.listener.present),
    } : null,
  };
}

function buildExport() {
  const exportValue = {
    status: evidence.status,
    immutable: {
      candidate_commit_expected: evidence.immutable.candidate_commit_expected,
      candidate_commit_observed: evidence.immutable.candidate_commit_observed,
      pinokiod_ref: evidence.immutable.pinokiod_ref,
      pterm_ref: evidence.immutable.pterm_ref,
      actions: Object.fromEntries(Object.entries(evidence.immutable.actions).map(([relative, descriptor]) => [relative, {
        relative,
        source_sha256: descriptor.source_sha256,
        ref_sha256: descriptor.ref_sha256,
        git_blob: descriptor.git_blob,
        selected_sha256: descriptor.selected_sha256,
        selected_ref_match: Boolean(descriptor.selected_ref_match),
        deployed_match: Boolean(descriptor.deployed_match),
      }])),
    },
    venue: {
      platform: process.platform,
      node: process.version,
      pinokio_home: pinokioHome,
      port: PINOKIO_PORT,
      selected_app_id: appId,
      selected_ref: selectedRef,
      selected_root: evidence.venue.selected_root,
    },
    daemon: {
      pid: evidence.daemon.pid ?? null,
      process_group: evidence.daemon.process_group ?? null,
      version: evidence.daemon.version ? { pinokiod: Boolean(evidence.daemon.version.pinokiod) } : null,
      home: evidence.daemon.home ? { path: evidence.daemon.home.path || null } : null,
      health: evidence.daemon.health ? { ok: evidence.daemon.health.ok === true } : null,
    },
    engine: {
      requested_uri: selectedStart,
      task_id: evidence.engine.task_id,
      task_id_provenance: evidence.engine.task_id_provenance ? {
        source: evidence.engine.task_id_provenance.source,
        observed_at: evidence.engine.task_id_provenance.observed_at,
        requested_uri: evidence.engine.task_id_provenance.requested_uri,
      } : null,
      identity_failure: {
        failed: Boolean(evidence.engine.identity_failure.failed),
        reason: evidence.engine.identity_failure.reason,
        observed_at: evidence.engine.identity_failure.observed_at,
      },
      packets: evidence.engine.packets.slice(-64).map((packet) => ({
        observed_at: packet.observed_at,
        type: packet.type,
        id: packet.id,
      })),
      settlement: evidence.engine.settlement,
      boundary: evidence.engine.boundary,
      readbacks: evidence.engine.readbacks.slice(-24).map((readback) => ({
        phase: readback.phase,
        matched_task_id: readback.matched_task_id ?? null,
        running_ids: Array.isArray(readback.running_ids) ? readback.running_ids : [],
        assessment: exportAssessment(readback.assessment),
      })),
      final_packet: evidence.engine.final_packet ? {
        observed: Boolean(evidence.engine.final_packet.observed),
        type: evidence.engine.final_packet.type,
        id: evidence.engine.final_packet.id,
        bound_to_task_id: Boolean(evidence.engine.final_packet.bound_to_task_id),
        observed_at: evidence.engine.final_packet.observed_at,
      } : null,
      transport: {
        closed: Boolean(evidence.engine.transport.closed),
        source: evidence.engine.transport.source,
        observed_at: evidence.engine.transport.observed_at,
      },
    },
    independent: {
      pre_settlement: exportObservation(evidence.independent.pre_settlement),
      post_settlement: exportObservation(evidence.independent.post_settlement),
      before_cleanup: exportObservation(evidence.independent.before_cleanup),
      post_cleanup: exportObservation(evidence.independent.post_cleanup),
    },
    cleanup: evidence.cleanup ? {
      attempted: Boolean(evidence.cleanup.attempted),
      pid: evidence.cleanup.pid || null,
      process_group_id: evidence.cleanup.process_group_id || null,
      signals: Array.isArray(evidence.cleanup.signals) ? evidence.cleanup.signals.slice(0, 8) : [],
      forced: Boolean(evidence.cleanup.forced),
      exited: Boolean(evidence.cleanup.exited),
      group_absent: Boolean(evidence.cleanup.group_absent),
      completed: Boolean(evidence.cleanup.completed),
      error: evidence.cleanup.error || null,
    } : null,
    failures: evidence.failures.slice(0, 64),
  };
  validateExportValue(exportValue);
  const serialized = JSON.stringify(exportValue, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EXPORT_BYTES) throw new Error('sanitized export exceeded size limit');
  return serialized;
}

function writeEvidence() {
  fs.writeFileSync(path.join(evidenceDir, 'venue-evidence.json'), `${buildExport()}\n`);
}

function writeLocalDiagnostics() {
  try {
    const serialized = JSON.stringify(evidence, null, 2);
    fs.writeFileSync(path.join(diagnosticDir, 'venue-diagnostics.json'), `${serialized.slice(0, MAX_DIAGNOSTIC_BYTES)}\n`);
  } catch (error) {
    recordFailure(`local diagnostics were not serializable: ${error.message}`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(args, options = {}) {
  return execFileSync('git', ['-C', candidateRoot, ...args], { encoding: 'utf8', ...options }).trim();
}

function fileDescriptor(relative) {
  const sourcePath = path.join(candidateRoot, relative);
  const sourceBytes = fs.readFileSync(sourcePath);
  const refBytes = execFileSync('git', ['-C', candidateRoot, 'cat-file', 'blob', `${EXPECTED_PINOKIO_COMMIT}:${relative}`]);
  const blob = git(['rev-parse', `${EXPECTED_PINOKIO_COMMIT}:${relative}`]);
  const selectedPath = path.join(selectedAppRoot, relative);
  const descriptor = {
    relative,
    source_sha256: sha256(sourceBytes),
    ref_sha256: sha256(refBytes),
    git_blob: blob,
    selected_sha256: null,
    selected_ref_match: sourceBytes.equals(refBytes),
    deployed_match: false,
  };
  evidence.immutable.actions[relative] = descriptor;
  if (!descriptor.selected_ref_match) fail(`candidate worktree bytes differ from immutable ref for ${relative}`);
  return { sourcePath, selectedPath, descriptor };
}

async function getJson(route) {
  const controller = new AbortController();
  let headerTimer = setTimeout(() => controller.abort(new Error('HTTP headers deadline exceeded')), HTTP_HEADER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      headers: { 'x-pinokio-client': 'm4-6-genuine-venue' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headerTimer);
    headerTimer = null;
  }
  const bodyTimer = setTimeout(() => controller.abort(new Error('HTTP body deadline exceeded')), HTTP_BODY_TIMEOUT_MS);
  let body;
  try {
    body = await response.text();
  } finally {
    clearTimeout(bodyTimer);
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: redact(body) }; }
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${redact(parsed)}`);
  return parsed;
}

async function readControlState() {
  const [health, home, homeStatus, resource, app] = await Promise.all([
    getJson('/check'),
    getJson('/pinokio/home'),
    getJson('/pinokio/home_status'),
    getJson(`/pinokio/resource/status?ref=${encodeURIComponent(selectedRef)}`),
    getJson(`/apps/status/${encodeURIComponent(appId)}`),
  ]);
  return {
    captured_at: new Date().toISOString(),
    health: redactJson(health),
    home: redactJson(home),
    home_status: redactJson(homeStatus),
    resource_status: redactJson(resource),
    app_status: redactJson(app),
    _raw: { health, home, homeStatus, resource, app },
  };
}

function withDeadline(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function withoutRaw(readback) {
  if (!readback) return null;
  const { _raw, ...safe } = readback;
  return safe;
}

function recordIdentityFailure(reason) {
  if (evidence.engine.identity_failure.failed) return;
  evidence.engine.identity_failure = {
    failed: true,
    reason: String(reason),
    observed_at: new Date().toISOString(),
  };
  recordFailure(`engine task identity failure: ${reason}`);
}

function engineAcceptance(terminalAssessment) {
  const taskId = evidence.engine.task_id;
  const finalPacket = evidence.engine.final_packet;
  const finalPacketValid = finalPacket?.observed === true &&
    finalPacket.type === 'disconnect' &&
    finalPacket.bound_to_task_id === true &&
    typeof taskId === 'string' && finalPacket.id === taskId;
  const transportClosed = evidence.engine.transport.closed === true;
  const signalValid = ['explicit-refusal', 'terminal-stop'].includes(evidence.engine.settlement);
  const preStopValid = evidence.engine.settlement === 'explicit-refusal' ||
    evidence.engine.pre_stop_readback?.matched_task_id === true;
  const valid = !evidence.engine.identity_failure.failed && signalValid && preStopValid &&
    finalPacketValid && transportClosed && terminalAssessment?.valid === true;
  return {
    valid,
    final_packet_valid: finalPacketValid,
    transport_closed: transportClosed,
    identity_failure: Boolean(evidence.engine.identity_failure.failed),
    pre_stop_valid: preStopValid,
    terminal_readback_valid: terminalAssessment?.valid === true,
  };
}

function runningIds(readback) {
  const ids = [];
  const homeScripts = readback?._raw?.homeStatus?.running_scripts;
  if (Array.isArray(homeScripts)) {
    for (const entry of homeScripts) {
      if (entry && typeof entry.id === 'string') ids.push(path.resolve(entry.id));
    }
  }
  for (const status of [readback?._raw?.resource, readback?._raw?.app]) {
    if (!Array.isArray(status?.running_scripts)) continue;
    for (const script of status.running_scripts) {
      if (typeof script === 'string' && script.trim()) ids.push(path.resolve(selectedAppRoot, script));
    }
  }
  return [...new Set(ids)];
}

function terminalReadback(readback, taskId) {
  if (!readback?._raw) return { valid: false, reason: 'missing control-plane readback' };
  const { homeStatus, resource, app } = readback._raw;
  const ids = runningIds(readback);
  const taskIdNormalized = typeof taskId === 'string' ? path.resolve(taskId) : null;
  const taskPresent = Boolean(taskIdNormalized && ids.includes(taskIdNormalized));
  const appRunning = resource.running === false && app.running === false;
  const homeStopped = Array.isArray(homeStatus.running_apps) && !homeStatus.running_apps.includes(appId) &&
    Array.isArray(homeStatus.running_scripts) && !homeStatus.running_scripts.some((entry) => entry?.app === appId);
  return {
    valid: appRunning && homeStopped && !taskPresent,
    running: Boolean(resource.running || app.running || taskPresent),
    task_present: taskPresent,
    task_id_matches_readback: taskPresent,
    resource_running: resource.running,
    app_running: app.running,
    home_app_stopped: homeStopped,
    running_ids: ids,
  };
}

async function waitForTerminalReadback(taskId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await withDeadline(readControlState(), READBACK_TIMEOUT_MS, 'control-plane readback deadline exceeded');
      const assessment = terminalReadback(last, taskId);
      evidence.engine.readbacks.push({ phase: 'terminal-poll', readback: withoutRaw(last), assessment });
      if (evidence.engine.readbacks.length > 24) evidence.engine.readbacks.shift();
      if (assessment.valid) return { readback: last, assessment };
    } catch (error) {
      evidence.engine.readbacks.push({ phase: 'terminal-poll-error', error: redact(error.message) });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { readback: last, assessment: terminalReadback(last, taskId) };
}

async function waitForTaskReadback(taskId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await withDeadline(readControlState(), READBACK_TIMEOUT_MS, 'control-plane readback deadline exceeded');
      const ids = runningIds(last);
      evidence.engine.readbacks.push({ phase: 'pre-stop-poll', readback: withoutRaw(last), running_ids: ids });
      if (evidence.engine.readbacks.length > 24) evidence.engine.readbacks.shift();
      if (ids.includes(path.resolve(taskId))) return { readback: last, matched: true, running_ids: ids };
    } catch (error) {
      evidence.engine.readbacks.push({ phase: 'pre-stop-poll-error', error: redact(error.message) });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { readback: last, matched: false, running_ids: runningIds(last) };
}

async function waitForDaemon() {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const version = await getJson('/pinokio/version');
      const home = await getJson('/pinokio/home');
      const health = await getJson('/check');
      evidence.daemon.version = redactJson(version);
      evidence.daemon.home = redactJson(home);
      evidence.daemon.health = redactJson(health);
      const expectedHome = fs.realpathSync(pinokioHome);
      if (path.resolve(home.path || '') !== path.resolve(expectedHome)) fail(`daemon home readback was not isolated: ${redact(home)}`);
      if (!version.pinokiod) fail('daemon version response did not report pinokiod');
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`real pinokiod did not become healthy: ${redact(lastError)}`);
}

function copyCandidateApp() {
  fs.rmSync(selectedAppRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(selectedAppRoot), { recursive: true });
  fs.cpSync(candidateRoot, selectedAppRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(candidateRoot, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`) &&
        relative !== 'node_modules' && !relative.startsWith(`node_modules${path.sep}`);
    },
  });
}

async function registerAndReadBack() {
  const resource = await getJson(`/pinokio/resource/status?ref=${encodeURIComponent(selectedRef)}`);
  const status = await getJson(`/apps/status/${encodeURIComponent(appId)}`);
  evidence.venue.selected_root = resource.path || status.path || null;
  evidence.venue.resource_readback = redactJson(resource);
  evidence.venue.app_readback = redactJson(status);
  if (resource.app_id !== appId || status.app_id !== appId) fail(`control-plane identity readback mismatch: ${redact({ resource, status })}`);
  if (path.resolve(resource.path || '') !== path.resolve(selectedAppRoot)) fail(`resource root readback mismatch: ${redact(resource)}`);
  if (path.resolve(status.path || '') !== path.resolve(selectedAppRoot)) fail(`app root readback mismatch: ${redact(status)}`);
}

function verifyDeployedActionBytes() {
  for (const relative of actionFiles) {
    const descriptor = evidence.immutable.actions[relative];
    const deployedBytes = fs.readFileSync(path.join(selectedAppRoot, relative));
    descriptor.selected_sha256 = sha256(deployedBytes);
    descriptor.deployed_match = descriptor.selected_sha256 === descriptor.ref_sha256;
    if (!descriptor.deployed_match) fail(`deployed action bytes differ from immutable ref for ${relative}`);
  }
}

function parseProcessRows(output) {
  return output.split('\n').map((line) => {
    const fields = line.trim().split(/\s+/, 5);
    if (fields.length < 5 || fields.slice(0, 3).some((field) => !/^\d+$/.test(field))) return null;
    const [pid, ppid, pgid, stat, command] = fields;
    return { pid, ppid, pgid, stat, command };
  }).filter(Boolean);
}

function ownedProcessGroupObservation() {
  const ownedGroupId = String(evidence.daemon.process_group || '');
  const snapshot = {
    available: false,
    owned_group_id: ownedGroupId || null,
    selection: 'exact-pgid',
    members: [],
    member_pids: [],
    member_count: 0,
    present: false,
    daemon_pid_member: false,
  };
  if (!/^\d+$/.test(ownedGroupId)) {
    snapshot.error = 'owned process-group identifier was unavailable';
    return snapshot;
  }
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,command='], {
      encoding: 'utf8', timeout: OBSERVATION_TIMEOUT_MS,
    });
    const members = parseProcessRows(output).filter((row) => row.pgid === ownedGroupId);
    snapshot.available = true;
    snapshot.members = members;
    snapshot.member_pids = members.map((row) => row.pid);
    snapshot.member_count = members.length;
    snapshot.present = members.length > 0;
    snapshot.daemon_pid_member = members.some((row) => row.pid === String(evidence.daemon.pid));
    snapshot.source = 'ps -eo filtered by exact owned pgid; other runner process groups excluded';
  } catch (error) {
    snapshot.error = redact(error.message);
  }
  return snapshot;
}

function groupEvidenceContract(snapshot, phase, requireDaemonMember = false) {
  const group = snapshot?.process_group;
  const expectedGroupId = String(evidence.daemon.process_group || '');
  const valid = group?.available === true &&
    group.owned_group_id === expectedGroupId &&
    group.selection === 'exact-pgid' &&
    Array.isArray(group.members) &&
    Array.isArray(group.member_pids) &&
    group.member_count === group.members.length &&
    group.member_pids.length === group.member_count &&
    group.members.every((member) => member.pgid === expectedGroupId) &&
    (!requireDaemonMember || group.daemon_pid_member === true);
  if (!valid) evidence.engine.boundary ||= `${phase} independent owned process-group evidence was missing or ambiguous`;
  return valid;
}

function independentObservation(phase) {
  const pid = evidence.daemon.pid;
  const snapshot = {
    captured_at: new Date().toISOString(),
    phase,
    daemon_pid: pid,
    owned_process_group_id: evidence.daemon.process_group,
    process: null,
    process_group: ownedProcessGroupObservation(),
    listener: null,
  };
  try {
    const processList = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,command='], {
      encoding: 'utf8', timeout: OBSERVATION_TIMEOUT_MS,
    });
    const groupId = processList.trim().split(/\s+/)[2] || String(pid);
    snapshot.process = {
      available: true,
      present: Boolean(processList.trim()),
      output: redact(processList),
      observed_group_id: groupId,
    };
  } catch (error) {
    snapshot.process = { available: error.status === 1, present: false, error: redact(error.message) };
  }
  try {
    const listenerList = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: OBSERVATION_TIMEOUT_MS });
    const selected = listenerList.split('\n').filter((line) => line.includes(`:${PINOKIO_PORT}`)).join('\n');
    snapshot.listener = { available: true, present: Boolean(selected.trim()), output: redact(selected || listenerList) };
  } catch (error) { snapshot.listener = { available: false, present: false, error: redact(error.message) }; }
  evidence.independent[phase] = snapshot;
  return snapshot;
}

async function invokeThroughPterm() {
  const rpcModule = await import(path.join(ptermRoot, 'rpc.js'));
  const RPC = rpcModule.default || rpcModule;
  const rpc = new RPC(`ws://127.0.0.1:${PINOKIO_PORT}`);
  const packets = [];
  fs.writeFileSync(actionPacketFile, '');
  const request = {
    uri: selectedStart,
    source: 'pterm',
    client: { source: 'pterm', venue: 'm4-6-genuine-pinokio-venue' },
  };
  let stopRequested = false;
  let signal = null;
  let signalResolve;
  let finalPacketResolve;
  const signalPromise = new Promise((resolveSignal) => { signalResolve = resolveSignal; });
  const finalPacketPromise = new Promise((resolveFinal) => { finalPacketResolve = resolveFinal; });
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    try {
      rpc.stop({ uri: selectedStart });
    } catch (error) {
      recordFailure(`pterm stop request failed: ${error.message}`);
    }
  };
  const signalOnce = (kind, boundary = null) => {
    if (signal) return;
    signal = { kind, boundary };
    if (boundary) evidence.engine.boundary ||= boundary;
    signalResolve(signal);
  };
  const observePacketIdentity = (packet) => {
    const id = packet?.id;
    if (typeof id !== 'string' || !id.trim()) {
      recordIdentityFailure('engine packet omitted a task identifier');
      return false;
    }
    let normalizedId;
    try {
      normalizedId = path.resolve(id);
    } catch {
      recordIdentityFailure('engine packet task identifier was not path-like');
      return false;
    }
    if (evidence.engine.task_id === null && normalizedId === path.resolve(selectedStart) && id === selectedStart) {
      evidence.engine.task_id = id;
      evidence.engine.task_id_provenance = {
        source: 'real-pterm-pinokio-response.packet.id',
        observed_at: new Date().toISOString(),
        requested_uri: selectedStart,
      };
    }
    if (evidence.engine.task_id !== id || normalizedId !== path.resolve(selectedStart)) {
      recordIdentityFailure(`engine task identity mismatch: observed ${redact(id)} for ${redact(selectedStart)}`);
      return false;
    }
    return true;
  };
  const onPacket = (packet) => {
    const identityValid = observePacketIdentity(packet);
    const safePacket = {
      observed_at: new Date().toISOString(),
      type: packet?.type || null,
      id: packet?.id || null,
      data: redactJson(packet?.data),
      raw_redacted: redactJson(packet),
    };
    packets.push(safePacket);
    fs.appendFileSync(actionPacketFile, `${JSON.stringify(safePacket)}\n`);
    if (packet?.type === 'disconnect') {
      if (identityValid && packet.id === evidence.engine.task_id) {
        evidence.engine.final_packet = {
          observed: true,
          type: packet.type,
          id: packet.id,
          bound_to_task_id: true,
          observed_at: safePacket.observed_at,
        };
        signalOnce('final-disconnect', 'source-defined final disconnect packet observed');
        finalPacketResolve();
        rpc.close();
      } else {
        recordIdentityFailure('source-defined final disconnect packet was not bound to the observed task identifier');
        signalOnce('invalid-final-packet', evidence.engine.identity_failure.reason);
      }
      return;
    }
    if (packet?.type === 'error') {
      const text = String(packet.data || '');
      const refusal = /fully installed|choose reset|not installed|refus|unavailable|requires/i.test(text);
      signalOnce(refusal ? 'explicit-refusal' : 'engine-error', redact(text));
      requestStop();
    } else if (packet?.type === 'start' && !stopRequested) {
      void (async () => {
        const preStop = await waitForTaskReadback(evidence.engine.task_id);
        evidence.engine.pre_stop_readback = {
          matched_task_id: preStop.matched,
          running_ids: preStop.running_ids,
          readback: withoutRaw(preStop.readback),
        };
        if (!preStop.matched) recordFailure('engine-owned task was not observed in pre-stop control-plane readback');
        requestStop();
      })().catch((error) => {
        recordFailure(`pre-stop readback failed: ${error.message}`);
        requestStop();
      });
    } else if (packet?.type === 'event' && packet.data === 'stop') {
      signalOnce('engine-stop-event', 'engine stop event requires final disconnect packet and transport closure');
    }
  };
  let transportPromise;
  try {
    transportPromise = rpc.run(request, onPacket);
    transportPromise.then(() => {
      evidence.engine.transport = {
        closed: true,
        source: 'pterm-rpc.run-close',
        observed_at: new Date().toISOString(),
      };
      if (!evidence.engine.final_packet?.observed) {
        recordFailure('pterm transport closed without the source-defined final disconnect packet');
      }
    });
    await withDeadline(Promise.all([signalPromise, finalPacketPromise, transportPromise]), ENGINE_TIMEOUT_MS,
      'engine did not provide final packet and transport closure within deadline');
  } catch (error) {
    evidence.engine.settlement = 'unknown-timeout';
    recordFailure(error.message);
  } finally {
    if (rpc.ws) rpc.close();
    if (transportPromise) {
      try { await withDeadline(transportPromise, 1_000, 'pterm transport close deadline exceeded'); } catch (error) {
        recordFailure(error.message);
      }
    }
  }
  if (!signal) signal = { kind: 'transport-timeout', boundary: 'no terminal engine signal was observed' };
  if (!evidence.engine.transport.closed) {
    evidence.engine.transport = { closed: false, source: 'pterm-rpc.run-close', observed_at: null };
  }
  const terminal = await waitForTerminalReadback(evidence.engine.task_id);
  evidence.engine.terminal_readback = {
    signal,
    assessment: terminal.assessment,
    readback: withoutRaw(terminal.readback),
  };
  const taskMatchedBeforeStop = evidence.engine.pre_stop_readback?.matched_task_id === true;
  if (terminal.assessment.valid && evidence.engine.final_packet?.observed && evidence.engine.transport.closed &&
      !evidence.engine.identity_failure.failed && signal.kind === 'explicit-refusal') {
    evidence.engine.settlement = 'explicit-refusal';
  } else if (terminal.assessment.valid && evidence.engine.final_packet?.observed && evidence.engine.transport.closed &&
      !evidence.engine.identity_failure.failed && taskMatchedBeforeStop &&
      ['engine-stop-event', 'final-disconnect'].includes(signal.kind)) {
    evidence.engine.settlement = 'terminal-stop';
  } else if (evidence.engine.settlement === 'not-attempted') {
    evidence.engine.settlement = 'unknown-terminal-readback';
    recordFailure(signal.boundary || 'final engine packet, transport closure, and stopped readback were not all proven');
  }
  evidence.engine.packets = packets;
}

function appendDaemonOutput(label, chunk) {
  fs.appendFileSync(daemonLog, redact(`${label}${chunk}`));
}

async function cleanupDaemon() {
  const pid = evidence.daemon.pid;
  const cleanup = {
    attempted: Boolean(pid && daemonProcess),
    pid,
    process_group_id: evidence.daemon.process_group,
    signals: [],
    forced: false,
    exited: false,
    group_absent: false,
    completed: false,
  };
  evidence.cleanup = cleanup;
  if (!pid || !daemonProcess) {
    cleanup.error = 'daemon was not started; no cleanup process was available';
    return;
  }
  const cleanupDeadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const waitForExit = async (timeoutMs) => {
    const deadline = Math.min(Date.now() + timeoutMs, cleanupDeadline);
    while (Date.now() < deadline) {
      if (daemonProcess.exitCode !== null || daemonProcess.signalCode !== null) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return daemonProcess.exitCode !== null || daemonProcess.signalCode !== null;
  };
  const waitForGroupAbsence = async (timeoutMs) => {
    const deadline = Math.min(Date.now() + timeoutMs, cleanupDeadline);
    while (Date.now() < deadline) {
      const group = ownedProcessGroupObservation();
      cleanup.last_group_observation = group;
      if (group.available && !group.present && group.member_count === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const group = ownedProcessGroupObservation();
    cleanup.last_group_observation = group;
    return group.available && !group.present && group.member_count === 0;
  };
  try {
    if (daemonProcess.exitCode === null && daemonProcess.signalCode === null) {
      process.kill(-pid, 'SIGTERM');
      cleanup.signals.push('SIGTERM(process-group)');
    }
    cleanup.exited = await waitForExit(5_000);
    cleanup.group_absent = await waitForGroupAbsence(5_000);
    if (!cleanup.group_absent) {
      cleanup.forced = true;
      process.kill(-pid, 'SIGKILL');
      cleanup.signals.push('SIGKILL(process-group)');
      cleanup.exited = await waitForExit(2_000);
      cleanup.group_absent = await waitForGroupAbsence(2_000);
    }
    cleanup.completed = cleanup.exited && cleanup.group_absent;
  } catch (error) {
    cleanup.error = redact(error.message);
  }
  if (!cleanup.completed && !cleanup.error) cleanup.error = 'bounded cleanup did not prove daemon exit and exact-PGID absence';
}

async function main() {
  let primaryError = null;
  try {
    evidence.immutable.candidate_commit_observed = git(['rev-parse', 'HEAD']);
    if (evidence.immutable.candidate_commit_observed !== EXPECTED_PINOKIO_COMMIT) fail('workflow checkout is not the expected clean Pinokio candidate');
    try {
      execFileSync('git', ['-C', candidateRoot, 'merge-base', '--is-ancestor', EXPECTED_BASE_COMMIT, 'HEAD'], { stdio: 'ignore' });
    } catch {
      fail('workflow checkout is not based on the clean Pinokio candidate');
    }
    if (git(['status', '--porcelain'])) fail('workflow checkout is dirty before venue probe');

    for (const relative of actionFiles) fileDescriptor(relative);
    copyCandidateApp();
    verifyDeployedActionBytes();
    writeEvidence();

    const daemonEntry = path.join(pinokiodRoot, 'script', 'index');
    if (!fs.existsSync(daemonEntry)) fail(`pinned pinokiod entry is missing: ${redact(daemonEntry)}`);
    fs.writeFileSync(daemonLog, '');
    fs.writeFileSync(actionPacketFile, '');
    daemonProcess = spawn(process.execPath, [daemonEntry], {
      cwd: pinokiodRoot,
      env: { ...process.env, HOME: process.env.HOME || os.homedir(), PINOKIO_HOME: pinokioHome },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    evidence.daemon.pid = daemonProcess.pid;
    evidence.daemon.process_group = String(daemonProcess.pid);
    fs.writeFileSync(daemonPidFile, `${daemonProcess.pid}\n`);
    daemonProcess.stdout.on('data', (chunk) => appendDaemonOutput('[stdout] ', chunk));
    daemonProcess.stderr.on('data', (chunk) => appendDaemonOutput('[stderr] ', chunk));
    daemonProcess.once('error', (error) => {
      evidence.daemon.exit = { error: redact(error.message) };
    });
    daemonProcess.once('exit', (code, signal) => {
      if (!evidence.daemon.health) evidence.daemon.exit = { code, signal };
    });
    await waitForDaemon();
    await registerAndReadBack();
    verifyDeployedActionBytes();
    independentObservation('pre_settlement');
    writeEvidence();
    await invokeThroughPterm();
  } catch (error) {
    primaryError = error;
    recordFailure(error.message || String(error));
  }

  if (daemonProcess && !postSettlementCaptured) {
    try {
      const postReadback = await withDeadline(readControlState(), READBACK_TIMEOUT_MS, 'post-settlement readback deadline exceeded');
      const postAssessment = terminalReadback(postReadback, evidence.engine.task_id);
      const postObservation = independentObservation('post_settlement');
      evidence.independent.post_settlement.control = withoutRaw(postReadback);
      evidence.independent.post_settlement.assessment = postAssessment;
      evidence.independent.post_settlement.observation = postObservation;
      postSettlementCaptured = true;
    } catch (error) {
      recordFailure(`post-settlement readback failed: ${error.message}`);
      evidence.independent.post_settlement = {
        error: redact(error.message),
        observation: independentObservation('post_settlement'),
      };
      postSettlementCaptured = true;
    }
  }

  if (daemonProcess) {
    const beforeCleanupObservation = independentObservation('before_cleanup');
    groupEvidenceContract(beforeCleanupObservation, 'before_cleanup');
  }
  await cleanupDaemon();
  if (daemonProcess) {
    const cleanupObservation = independentObservation('post_cleanup');
    evidence.independent.post_cleanup = cleanupObservation;
  }
  const postReadbackAssessment = evidence.independent.post_settlement?.assessment || null;
  const engineResult = engineAcceptance(postReadbackAssessment);
  const observersComplete = evidence.independent.pre_settlement?.process?.available &&
    evidence.independent.pre_settlement?.process?.present &&
    evidence.independent.pre_settlement?.listener?.available &&
    evidence.independent.pre_settlement?.listener?.present &&
    evidence.independent.post_settlement?.process?.available &&
    evidence.independent.post_settlement?.process?.present &&
    evidence.independent.post_settlement?.listener?.available &&
    evidence.independent.post_settlement?.listener?.present &&
    groupEvidenceContract(evidence.independent.pre_settlement, 'pre_settlement', true) &&
    groupEvidenceContract(evidence.independent.post_settlement, 'post_settlement');
  const beforeCleanupObservation = evidence.independent.before_cleanup;
  const cleanupObservation = evidence.independent.post_cleanup;
  const groupEvidenceComplete = groupEvidenceContract(evidence.independent.pre_settlement, 'pre_settlement', true) &&
    groupEvidenceContract(evidence.independent.post_settlement, 'post_settlement') &&
    groupEvidenceContract(beforeCleanupObservation, 'before_cleanup') &&
    groupEvidenceContract(cleanupObservation, 'post_cleanup');
  const cleanupComplete = Boolean(evidence.cleanup?.completed) && cleanupObservation?.process?.available &&
    !cleanupObservation.process.present && cleanupObservation.process_group?.available &&
    !cleanupObservation.process_group.present && cleanupObservation.process_group.member_count === 0 &&
    cleanupObservation.listener?.available && !cleanupObservation.listener.present;
  venuePostconditionsProven = evidence.engine.settlement !== 'explicit-refusal' &&
    engineResult.valid && observersComplete;
  const passPredicate = !primaryError && evidence.failures.length === 0 && venuePostconditionsProven &&
    groupEvidenceComplete && cleanupComplete && !evidence.engine.identity_failure.failed;
  if (!passPredicate && !evidence.engine.boundary) recordFailure('one or more venue acceptance conditions were unsuccessful');
  evidence.status = passPredicate ? 'PASS' : 'UNKNOWN';
  writeLocalDiagnostics();
  writeEvidence();
  console.log(JSON.stringify({ status: evidence.status, task_id: evidence.engine.task_id, settlement: evidence.engine.settlement }));
  process.exitCode = passPredicate ? 0 : 1;
}

if (process.argv.includes('--self-test')) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalFailure = evidence.engine.identity_failure;
  recordIdentityFailure('self-test invalid packet');
  assert(evidence.engine.identity_failure.failed, 'identity failure was not sticky');
  assert(!engineAcceptance({ valid: true }).valid, 'identity failure did not block acceptance');
  evidence.engine.identity_failure = originalFailure;
  assert(!engineAcceptance({ valid: true }).valid, 'missing final packet did not block acceptance');
  const invalidValues = [
    ['secret-shaped', 'token=abcdefghijklmnop'],
    ['control-character', 'bad\u0000value'],
    ['path-traversal', '../escape'],
    ['oversized', 'x'.repeat(MAX_EXPORT_STRING_BYTES + 1)],
  ];
  for (const [label, value] of invalidValues) {
    let rejected = false;
    try { validateExportValue({ boundary: value }); } catch { rejected = true; }
    assert(rejected, `${label} export input was accepted`);
  }
  let unexpectedRejected = false;
  try { validateExportValue({ unexpected: true }); } catch { unexpectedRejected = true; }
  assert(unexpectedRejected, 'unexpected export field was accepted');
  for (const relative of actionFiles) {
    evidence.immutable.actions[relative] = {
      source_sha256: 'a'.repeat(64), ref_sha256: 'b'.repeat(64), git_blob: 'c'.repeat(40),
      selected_sha256: null, selected_ref_match: true, deployed_match: false,
    };
  }
  assert(JSON.stringify(JSON.parse(buildExport())).length < MAX_EXPORT_BYTES, 'final evidence was not serializable and bounded');
  assert(parseProcessRows('1 2 7 S daemon\n8 9 8 S other').filter((row) => row.pgid === '7').length === 1,
    'exact-PGID process selection regression failed');
  console.log('genuine Pinokio venue self-tests: PASS');
} else {
  main().catch((error) => {
    console.error(`genuine Pinokio venue: ${redact(error.stack || error.message)}`);
    process.exitCode = 1;
  });
}
