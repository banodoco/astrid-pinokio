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
const daemonLog = path.join(evidenceDir, 'pinokiod.log');
const daemonPidFile = path.join(evidenceDir, 'pinokiod.pid');
const actionPacketFile = path.join(evidenceDir, 'engine-packets.jsonl');
let daemonProcess = null;
let postSettlementCaptured = false;

fs.mkdirSync(evidenceDir, { recursive: true });
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
    packets: [],
    settlement: 'not-attempted',
    boundary: null,
    readbacks: [],
  },
  independent: {
    pre_settlement: null,
    post_settlement: null,
    post_cleanup: null,
  },
  cleanup: null,
};

function writeEvidence() {
  fs.writeFileSync(path.join(evidenceDir, 'venue-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function fail(message) {
  evidence.status = 'UNKNOWN';
  evidence.engine.boundary ||= message;
  writeEvidence();
  throw new Error(message);
}

function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  for (const [needle, replacement] of [
    [candidateRoot, '$GITHUB_WORKSPACE'],
    [pinokiodRoot, '$PINOKIOD_ROOT'],
    [ptermRoot, '$PTERM_ROOT'],
    [pinokioHome, '$PINOKIO_HOME'],
    [selectedAppRoot, '$SELECTED_APP_ROOT'],
  ]) text = text.split(needle).join(replacement);
  return text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
}

function redactJson(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJson(child)]));
  }
  return value;
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
  const response = await fetch(`${baseUrl}${route}`, { headers: { 'x-pinokio-client': 'm4-6-genuine-venue' } });
  const body = await response.text();
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

function withoutRaw(readback) {
  if (!readback) return null;
  const { _raw, ...safe } = readback;
  return safe;
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
      last = await readControlState();
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
      last = await readControlState();
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

function independentObservation(phase) {
  const pid = evidence.daemon.pid;
  const snapshot = { captured_at: new Date().toISOString(), phase, daemon_pid: pid, process: null, listener: null };
  try {
    const processList = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
    const groupId = processList.trim().split(/\s+/)[2] || String(pid);
    let groupList = '';
    try {
      groupList = execFileSync('ps', ['-g', groupId, '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    snapshot.process = {
      available: true,
      present: Boolean(processList.trim()),
      process_group_present: Boolean(groupList.trim()),
      output: redact(processList),
      process_group_output: redact(groupList),
    };
  } catch (error) {
    snapshot.process = { available: error.status === 1, present: false, process_group_present: false, error: redact(error.message) };
  }
  try {
    const listenerList = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
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
  let rpcClosed = false;
  await new Promise((resolve) => {
    let finished = false;
    let stopRequested = false;
    let signal = null;
    let signalResolve;
    const signalPromise = new Promise((resolveSignal) => { signalResolve = resolveSignal; });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      evidence.engine.settlement = 'unknown-timeout';
      evidence.engine.boundary = 'engine did not emit a terminal packet within 15 seconds';
      signalResolve(null);
    }, 15_000);
    const observePacketIdentity = (packet) => {
      const id = packet?.id;
      if (typeof id !== 'string' || !id.trim()) {
        evidence.engine.boundary = 'engine packet omitted a task identifier';
        return false;
      }
      const normalizedId = path.resolve(id);
      if (evidence.engine.task_id === null) {
        evidence.engine.task_id = id;
        evidence.engine.task_id_provenance = {
          source: 'real-pterm-pinokio-response.packet.id',
          observed_at: new Date().toISOString(),
          requested_uri: selectedStart,
        };
      }
      if (evidence.engine.task_id !== id || normalizedId !== path.resolve(selectedStart)) {
        evidence.engine.boundary = `engine task identity mismatch: observed ${redact(id)} for ${redact(selectedStart)}`;
        return false;
      }
      return true;
    };
    const signalOnce = (kind, boundary = null) => {
      if (signal) return;
      signal = { kind, boundary };
      signalResolve(signal);
    };
    rpc.run(request, (packet) => {
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
      if (!identityValid) {
        signalOnce('unknown-identity', evidence.engine.boundary);
        return;
      }
      if (packet?.type === 'error') {
        const text = String(packet.data || '');
        const refusal = /fully installed|choose reset|not installed|refus|unavailable|requires/i.test(text);
        signalOnce(refusal ? 'explicit-refusal' : 'engine-error', redact(text));
      } else if (packet?.type === 'start' && !stopRequested) {
        void (async () => {
          const preStop = await waitForTaskReadback(evidence.engine.task_id);
          evidence.engine.pre_stop_readback = {
            matched_task_id: preStop.matched,
            running_ids: preStop.running_ids,
            readback: withoutRaw(preStop.readback),
          };
          if (!signal && !stopRequested) {
            stopRequested = true;
            rpc.stop({ uri: selectedStart });
          }
        })();
      } else if (packet?.type === 'disconnect') {
        signalOnce('transport-disconnect', 'WebSocket disconnect is not terminal evidence');
      } else if (packet?.type === 'event' && packet.data === 'stop') {
        signalOnce('engine-stop-event', 'engine stop event precedes cleanup; awaiting control-plane readback');
      }
    });
    void (async () => {
      const observed = await signalPromise;
      clearTimeout(timer);
      if (!observed) {
        resolve();
        return;
      }
      const terminal = await waitForTerminalReadback(evidence.engine.task_id);
      evidence.engine.terminal_readback = {
        signal: observed,
        assessment: terminal.assessment,
        readback: withoutRaw(terminal.readback),
      };
      const taskMatchedBeforeStop = evidence.engine.pre_stop_readback?.matched_task_id === true;
      if (terminal.assessment.valid && observed.kind === 'explicit-refusal') {
        evidence.engine.settlement = 'explicit-refusal';
      } else if (terminal.assessment.valid && taskMatchedBeforeStop && ['engine-stop-event', 'transport-disconnect'].includes(observed.kind)) {
        evidence.engine.settlement = 'terminal-stop';
      } else {
        evidence.engine.settlement = 'unknown-terminal-readback';
        evidence.engine.boundary = observed.boundary ||
          (!taskMatchedBeforeStop ? 'terminal task identity was not matched by a pre-stop engine-owned readback' :
            'terminal control-plane readback was absent or ambiguous');
      }
      resolve();
    })();
  });
  evidence.engine.packets = packets;
  if (rpc.ws) {
    rpc.close();
    rpcClosed = true;
  }
  if (!rpcClosed) evidence.engine.boundary ||= 'pterm RPC socket was not available for close/readback audit';
}

function appendDaemonOutput(label, chunk) {
  fs.appendFileSync(daemonLog, redact(`${label}${chunk}`));
}

async function cleanupDaemon() {
  const pid = evidence.daemon.pid;
  if (!pid || !daemonProcess) return;
  const cleanup = { pid, signals: [], forced: false, exited: false };
  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (daemonProcess.exitCode !== null || daemonProcess.signalCode !== null) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return daemonProcess.exitCode !== null || daemonProcess.signalCode !== null;
  };
  try {
    if (daemonProcess.exitCode === null && daemonProcess.signalCode === null) {
      process.kill(-pid, 'SIGTERM');
      cleanup.signals.push('SIGTERM(process-group)');
      cleanup.exited = await waitForExit(5_000);
    } else {
      cleanup.exited = true;
    }
    if (!cleanup.exited) {
      cleanup.forced = true;
      process.kill(-pid, 'SIGKILL');
      cleanup.signals.push('SIGKILL(process-group)');
      cleanup.exited = await waitForExit(2_000);
    }
  } catch (error) {
    cleanup.error = redact(error.message);
  }
  evidence.cleanup = cleanup;
}

async function main() {
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
  daemonProcess = spawn(process.execPath, [daemonEntry], {
    cwd: pinokiodRoot,
    env: { ...process.env, HOME: process.env.HOME || os.homedir(), PINOKIO_HOME: pinokioHome },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  evidence.daemon.pid = daemonProcess.pid;
  evidence.daemon.process_group = daemonProcess.pid;
  fs.writeFileSync(daemonPidFile, `${daemonProcess.pid}\n`);
  daemonProcess.stdout.on('data', (chunk) => appendDaemonOutput('[stdout] ', chunk));
  daemonProcess.stderr.on('data', (chunk) => appendDaemonOutput('[stderr] ', chunk));
  daemonProcess.once('error', (error) => {
    evidence.daemon.exit = { error: redact(error.message) };
  });
  daemonProcess.once('exit', (code, signal) => {
    if (!evidence.daemon.health) evidence.daemon.exit = { code, signal };
  });
  try {
    await waitForDaemon();
    await registerAndReadBack();
    verifyDeployedActionBytes();
    independentObservation('pre_settlement');
    writeEvidence();
    await invokeThroughPterm();
    const postReadback = await readControlState();
    const postAssessment = terminalReadback(postReadback, evidence.engine.task_id);
    const postObservation = independentObservation('post_settlement');
    evidence.independent.post_settlement.control = withoutRaw(postReadback);
    evidence.independent.post_settlement.assessment = postAssessment;
    postSettlementCaptured = true;
    verifyDeployedActionBytes();
    const observersComplete = evidence.independent.pre_settlement?.process?.available &&
      evidence.independent.pre_settlement?.process?.present &&
      evidence.independent.pre_settlement?.listener?.available &&
      evidence.independent.pre_settlement?.listener?.present &&
      postObservation.process.available && postObservation.process.present &&
      postObservation.listener.available && postObservation.listener.present;
    const terminalSettled = ['explicit-refusal', 'terminal-stop'].includes(evidence.engine.settlement) && postAssessment.valid;
    evidence.status = evidence.engine.settlement === 'explicit-refusal' ? 'UNKNOWN' :
      (terminalSettled && observersComplete ? 'PASS' : 'UNKNOWN');
    if (!terminalSettled || !observersComplete) {
      fail(`venue postconditions were not proven: ${redact({ settlement: evidence.engine.settlement, postAssessment, observersComplete })}`);
    }
    if (evidence.engine.settlement === 'explicit-refusal') {
      evidence.engine.boundary = 'real engine explicitly refused the uninstalled candidate; no hosted qualification is claimed';
    }
    writeEvidence();
    console.log(JSON.stringify({ status: evidence.status, task_id: evidence.engine.task_id, settlement: evidence.engine.settlement }));
  } finally {
    if (!postSettlementCaptured && daemonProcess) {
      try {
        const postReadback = await readControlState();
        const postAssessment = terminalReadback(postReadback, evidence.engine.task_id);
        const postObservation = independentObservation('post_settlement');
        evidence.independent.post_settlement.control = withoutRaw(postReadback);
        evidence.independent.post_settlement.assessment = postAssessment;
        evidence.independent.post_settlement.observation = postObservation;
        postSettlementCaptured = true;
      } catch (error) {
        evidence.independent.post_settlement = {
          error: redact(error.message),
          observation: independentObservation('post_settlement'),
        };
      }
    }
    await cleanupDaemon();
    const cleanupObservation = independentObservation('post_cleanup');
    const cleanupComplete = cleanupObservation.process.available && !cleanupObservation.process.present &&
      cleanupObservation.listener.available && !cleanupObservation.listener.present;
    if (evidence.status === 'PASS' && !cleanupComplete) {
      evidence.status = 'UNKNOWN';
      evidence.engine.boundary ||= 'bounded cleanup did not prove owned process-group and listener disappearance';
    }
    writeEvidence();
  }
}

main().catch((error) => {
  console.error(`genuine Pinokio venue: ${redact(error.stack || error.message)}`);
  process.exitCode = 1;
});
