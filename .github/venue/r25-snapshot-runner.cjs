'use strict';

// Hosted Windows R-25 route.  This is a producer only: it binds the exact
// request and records real engine outcomes, but it never grants qualification.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const binding = require('../../pinokio/providers/r25-native-collector-binding.cjs');
const { createObserverIO } = require('./r21-observer-io.cjs');
const { ptermExit, createInstallDiagnostics, terminateChild, redactDiagnosticText } = require('./r21-observer-diagnostics.cjs');
const { captureWindowsProcessTree } = require('./r25-windows-process-snapshot.cjs');
const { MAX_BYTES: PTY_CAPTURE_MAX_BYTES, MAX_ROWS: PTY_CAPTURE_MAX_ROWS, PTY_MARKERS, applyPinokiodPtyInstrumentation } = require('./r25-pinokiod-pty-instrumentation.cjs');
const { applyWindowsPtyDiagnostics, createWindowsProbeFailFast } = require('./r25-windows-pty-diagnostics.cjs');

const AGENT_REF = binding.AGENT_SOURCE_REF;
const PINOKIO_SOURCE_REF = '95aafb5a029c3f53cb2268d8596909eab0deb3c4';
const PINOKIO_TUPLE_REF = '3a6a98ae251ca126505245286e2d3e760f4348e9';
const APP_REF = 'lane/M-APP/PINOKIO-APP-BINDING';
const APP_TUPLE_REF = '79f7e5397c044c4c97dc7e97b20ad96f787e5247';
const APP_URL = 'https://raw.githubusercontent.com/banodoco/astrid-app/';
const ACTIONS = binding.REQUIRED_ACTIONS;
const SLOT = 'pinokio-fully-local-windows';
const TARGETS = { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] };
const tupleExpected = {
  app: APP_TUPLE_REF, agent: 'ab43bad818ef65ca1e929b973a2f61cd9fc4bf61',
  runtime: '2776ba973b6c8f3555b5629b0840d9691a98d3c2', pinokio: PINOKIO_TUPLE_REF,
  manifest_sha256: 'b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f',
  artifacts: {
    'public/install': '100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d',
    'public/install.sh': '591c4c51b148fccef2a7d1c45782d9ff949d5fd03d46cd82b5591e3a23d1b285',
    'public/install.ps1': 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258',
  }, published_at: '2026-11-02T17:55:27Z',
};

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) result[argv[i].slice(2)] = argv[i + 1];
  return result;
}
function canonical(value) { return binding.canonical(value); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function ptyCaptureStatus(file) {
  let contents;
  try { contents = fs.readFileSync(file); }
  catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'invalid', bytes: 0, sha256: null, runtime_ready: false };
  }
  const base = { bytes: contents.length, sha256: digest(contents), runtime_ready: false };
  if (contents.length === 0) return { status: 'empty', ...base };
  if (contents.length > PTY_CAPTURE_MAX_BYTES) return { status: 'invalid', ...base };
  let rows;
  try {
    const text = contents.toString('utf8');
    if (!text.endsWith('\n')) throw new Error('incomplete JSONL row');
    rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
    if (rows.length > PTY_CAPTURE_MAX_ROWS || rows.some(row => !row || typeof row !== 'object'
        || !PTY_MARKERS.includes(row.kind) || typeof row.at !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at)
        || Number.isNaN(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at)) throw new Error('invalid marker row');
  } catch { return { status: 'invalid', ...base }; }
  return { status: 'present', ...base, runtime_ready: rows.some(row => row.kind === 'runtime-ready') };
}
function jsonDigest(value) { return digest(Buffer.from(`${canonical(value)}\n`, 'ascii')); }
function writeCanonical(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonical(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function envInt(name) { const value = Number.parseInt(process.env[name] || '', 10); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is not a positive integer`); return value; }
function fail(message, extra = {}) {
  const diagnostics = { schema: 'astrid.r25.pinokio-action-diagnostics.v1', first_error: String(message).slice(0, 240), ...extra };
  const file = path.join(process.env.R25_DIAGNOSTICS || process.cwd(), 'r25-failure.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(diagnostics, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

const DIAGNOSTIC_CAPTURE_LIMIT = 64 * 1024;
function createBoundedCapture(file, limit = DIAGNOSTIC_CAPTURE_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 64 || limit > DIAGNOSTIC_CAPTURE_LIMIT) throw new Error('diagnostic capture limit is invalid');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '', { encoding: 'utf8', flag: 'w', mode: 0o600 });
  const rawLimit = limit * 2;
  let raw = Buffer.alloc(0);
  let rawTruncated = false;
  let closed = false;
  let last = { bytes: 0, truncated: false };
  const flush = () => {
    const safe = redactDiagnosticText(raw.toString('utf8'), limit) || '';
    fs.writeFileSync(file, safe, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    last = { bytes: Buffer.byteLength(safe, 'utf8'), truncated: rawTruncated || Buffer.byteLength(raw, 'utf8') > limit };
    return { ...last };
  };
  return {
    append(value) {
      if (closed || value === undefined || value === null) return;
      raw = Buffer.concat([raw, Buffer.from(String(value), 'utf8')]);
      if (raw.length > rawLimit) { raw = raw.subarray(raw.length - rawLimit); rawTruncated = true; }
    },
    flush,
    close() { if (!closed) { flush(); closed = true; } return { ...last }; },
    stats() { return { ...last, closed }; },
  };
}

function flushCaptures(captures) {
  if (!captures) return 'unavailable';
  captures.stdout.flush();
  captures.stderr.flush();
  return 'captured';
}

function copyBoundedTail(source, destination, limit = DIAGNOSTIC_CAPTURE_LIMIT) {
  try {
    const size = fs.statSync(source).size;
    const length = Math.min(size, limit * 2);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(source, 'r');
    try { fs.readSync(fd, buffer, 0, length, Math.max(0, size - length)); } finally { fs.closeSync(fd); }
    const capture = createBoundedCapture(destination, limit);
    capture.append(buffer);
    const stats = capture.close();
    return { status: 'captured', ...stats };
  } catch {
    return { status: 'unavailable', bytes: 0, truncated: false };
  }
}

function copyFirstInstallerLog(candidates, destination, limit = DIAGNOSTIC_CAPTURE_LIMIT) {
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const result = copyBoundedTail(candidate, destination, limit);
    if (result.status === 'captured') return result;
  }
  return { status: 'unavailable', bytes: 0, truncated: false };
}

function copyPreTimeoutCapture(source, destination) {
  try {
    fs.copyFileSync(source, destination);
    return 'captured';
  } catch {
    return 'unavailable';
  }
}

async function githubJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}` } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}
async function resolveOrigin(artifactName) {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const [repo, workflowList] = await Promise.all([
    githubJson(base), githubJson(`${base}/actions/workflows?per_page=100`),
  ]);
  const workflow = (workflowList.workflows || []).find(item => item.path === '.github/workflows/r25-snapshot-journey.yml');
  if (!workflow) throw new Error('workflow id was not independently resolved');
  let jobs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    jobs = await githubJson(`${base}/actions/runs/${envInt('GITHUB_RUN_ID')}/jobs?per_page=100`);
    const job = (jobs.jobs || []).find(item => item.name === process.env.GITHUB_JOB || item.name.startsWith(`${process.env.GITHUB_JOB} `));
    if (job) {
      return {
        repository_id: repo.id, repository_full_name: process.env.GITHUB_REPOSITORY,
        workflow_id: workflow.id, workflow_ref: process.env.GITHUB_WORKFLOW_REF,
        workflow_sha: process.env.GITHUB_WORKFLOW_SHA || process.env.GITHUB_SHA,
        run_id: envInt('GITHUB_RUN_ID'), run_attempt: envInt('GITHUB_RUN_ATTEMPT'),
        head_sha: process.env.GITHUB_SHA, producer_job_id: job.id, producer_job_name: job.name,
        artifact_id: null, artifact_name: artifactName,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('producer job id was not independently resolved');
}

function materializeProduct(productRoot, appRoot) {
  fs.mkdirSync(path.dirname(productRoot), { recursive: true });
  execFileSync('git', ['init', productRoot], { stdio: 'ignore' });
  execFileSync('git', ['-C', productRoot, 'remote', 'add', 'origin', 'https://github.com/banodoco/astrid-pinokio.git'], { stdio: 'ignore' });
  execFileSync('git', ['-C', productRoot, 'fetch', '--filter=blob:none', '--no-tags', '--depth=1', 'origin', PINOKIO_TUPLE_REF], { stdio: 'inherit' });
  execFileSync('git', ['-C', productRoot, 'checkout', '--detach', 'FETCH_HEAD'], { stdio: 'ignore' });
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.cpSync(productRoot, appRoot, { recursive: true });
  if (execFileSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== PINOKIO_TUPLE_REF) throw new Error('Pinokio product checkout differs from CURRENT-TUPLE');
  const overlay = path.join(process.cwd(), 'pinokio', 'shell.mjs');
  fs.copyFileSync(overlay, path.join(appRoot, 'pinokio', 'shell.mjs'));
  return { engine_ref: PINOKIO_TUPLE_REF, overlay: { path: 'pinokio/shell.mjs', sha256: digest(fs.readFileSync(overlay)) } };
}
async function fetchHash(url) { const response = await fetch(url); if (!response.ok) throw new Error(`App candidate fetch ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
async function verifyAppCandidate(tuple) {
  if (tuple.app !== APP_TUPLE_REF) throw new Error('App tuple is not the approved current candidate');
  const manifest = await fetchHash(`${APP_URL}${APP_REF}/public/install-manifest.json`);
  if (digest(manifest) !== tuple.manifest_sha256) throw new Error('App manifest hash differs from CURRENT-TUPLE');
  for (const file of ['public/install', 'public/install.ps1']) {
    if (digest(await fetchHash(`${APP_URL}${APP_REF}/${file}`)) !== tuple.artifacts[file]) throw new Error(`${file} hash differs from CURRENT-TUPLE`);
  }
}

async function digestTree(root) {
  const rows = [];
  async function visit(current, relative = '') {
    let entries = [];
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name).replaceAll('\\', '/');
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) {
        const data = await fsp.readFile(full); rows.push([rel, digest(data), data.length]);
      }
    }
  }
  await visit(root);
  return { sha256: jsonDigest(rows), files: rows.length };
}
async function filesystemState(home, appRoot) {
  const files = ['app/astrid/current', 'app/astrid/install.json', 'app/astrid/update-transaction.json'];
  const rows = [];
  for (const relative of files) {
    const file = path.join(home, relative);
    try { const data = await fsp.readFile(file); rows.push([relative, digest(data), data.length]); } catch { rows.push([relative, null, null]); }
  }
  return { schema: 'astrid.r25.pinokio-filesystem-record.v1', protected: rows, app_tree: await digestTree(appRoot) };
}

async function observeAction({ io, ptermRoot, home, endpoint, appRoot, script, action, timeoutMs = 30 * 60 * 1000, diagnostic = null }) {
  const socket = await io.openSocket();
  diagnostic?.stage?.('observer-open');
  let child;
  let terminal = { stop: false, disconnect: false, error: false };
  let firstError = null;
  const windowsFailFast = diagnostic?.windows_pty_capture_file && process.platform === 'win32'
    ? createWindowsProbeFailFast({ captureFile: diagnostic.windows_pty_capture_file, onFail: failure => {
      terminal.error = true;
      terminal.windows_failure = failure.reason;
      if (!firstError) firstError = { kind: `windows-diagnostic-${failure.reason}` };
    } }) : null;
  const onMessage = event => {
    try {
      const packet = JSON.parse(String(event.data));
      try { diagnostic?.packet(packet); } catch {}
      windowsFailFast?.packet(packet);
      if (packet?.type === 'event' && packet.data === 'stop') terminal.stop = true;
      if (packet?.type === 'event' && packet.data === 'disconnect') terminal.disconnect = true;
      if (packet?.type === 'error' || packet?.type === 'installer-failure-marker') {
        terminal.error = true;
        if (!firstError) firstError = { kind: packet.type === 'error' ? 'engine-error' : 'installer-failure-marker' };
      }
    } catch { if (!firstError) firstError = { kind: 'malformed-engine-packet' }; }
  };
  socket.addEventListener('message', onMessage);
  try {
    socket.send(JSON.stringify({ uri: path.join(appRoot, script), mode: 'listen' }));
    diagnostic?.stage?.('observer-subscribe');
    const stdio = diagnostic?.stdio || null;
    child = spawn(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', script, '--ref', endpoint], {
      cwd: home, env: process.env, stdio: stdio ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    });
    windowsFailFast?.start(child);
    diagnostic?.stage?.('pterm-spawn', { pid: child.pid, ppid: process.pid });
    if (stdio) {
      child.stdout.on('data', chunk => stdio.stdout.append(chunk));
      child.stderr.on('data', chunk => stdio.stderr.append(chunk));
      child.stdout.on('close', () => stdio.stdout.close());
      child.stderr.on('close', () => stdio.stderr.close());
    }
    const innerExit = await ptermExit(child, `R-25 ${action}`, timeoutMs, diagnostic
      ? { pterm: diagnostic.pterm, beforeTimeout: diagnostic.beforeTimeout } : null);
    await new Promise(resolve => setTimeout(resolve, 500));
    return { script, inner_exit: innerExit, terminal, first_error: firstError,
      windows_diagnostic_failure: windowsFailFast?.result() || null,
      status_after: await io.status(path.join(appRoot, script), `${action}-status`) };
  } finally {
    windowsFailFast?.stop();
    const shellDiagnosticFile = path.join(appRoot, '_r25-setup-shell-diagnostics.jsonl');
    flushCaptures(diagnostic?.stdio);
    diagnostic?.shell?.(shellDiagnosticFile);
    await terminateChild(child);
    diagnostic?.shell?.(shellDiagnosticFile);
    io.disposeSocket(socket);
  }
}
async function workerSend(worker, value) { worker.stdin.write(`${JSON.stringify(value)}\n`); return new Promise((resolve, reject) => {
  const onData = chunk => { const line = String(chunk).trim().split('\n')[0]; if (!line) return; worker.stdout.off('data', onData); try { const result = JSON.parse(line); if (!result.ok) reject(new Error(result.error || 'snapshot worker refused')); else resolve(result); } catch (error) { reject(error); } };
  worker.stdout.on('data', onData);
}); }
function actionPlan(action, index, tuple, origin) {
  const script = ({ start: 'pinokio/start.js', ready: null, stop: 'pinokio/stop.js', update: 'pinokio/update.js', rollback: 'pinokio/reset.js + pinokio/install.js', uninstall: 'pinokio/uninstall.js' })[action];
  const plan = { schema: 'astrid.r25.pinokio-action-plan.v1', action, action_id: `r25-${action}-${origin.run_id}-${origin.run_attempt}`, action_index: index, slot_id: SLOT, tuple, origin: { run_id: origin.run_id, run_attempt: origin.run_attempt, producer_job_id: origin.producer_job_id }, operation: action === 'rollback' ? 'reset-and-reinstall-recovery-boundary' : action, script };
  return { plan, action_sha256: jsonDigest(plan) };
}

async function main() {
  const cli = args(process.argv.slice(2));
  const tuple = JSON.parse(cli.tuple || process.env.R25_TUPLE_JSON || '{}');
  binding.validateRequest({ schema: 'astrid.r25.pinokio-snapshot-request.v1', slot_id: SLOT, tuple, origin: { repository_id: 1, repository_full_name: 'x/y', workflow_id: 1, workflow_ref: 'x', workflow_sha: '0000000000000000000000000000000000000000', run_id: 1, run_attempt: 1, head_sha: '0000000000000000000000000000000000000000', producer_job_id: 1, producer_job_name: 'x', artifact_id: null, artifact_name: `r25-snapshots-${SLOT}-x` }, collector: { agent_ref: AGENT_REF, pinokio_ref: PINOKIO_SOURCE_REF, sources: binding.flattenedSources }, actions: ACTIONS.map((action, index) => ({ action, action_id: `x-${index}`, action_sha256: '0'.repeat(64) })), targets: TARGETS });
  if (canonical(tuple) !== canonical(tupleExpected)) throw new Error('tuple differs from pinned CURRENT-TUPLE');
  const output = path.resolve(cli.output || process.env.R25_OUTPUT || path.join(process.env.TEMP || '.', 'r25-snapshot-output'));
  const diagnostics = process.env.R25_DIAGNOSTICS || path.join(path.dirname(output), 'r25-diagnostics');
  fs.mkdirSync(diagnostics, { recursive: true });
  const artifactName = `r25-snapshots-${SLOT}-${envInt('GITHUB_RUN_ID')}-${envInt('GITHUB_RUN_ATTEMPT')}`;
  const origin = await resolveOrigin(artifactName);
  const plans = ACTIONS.map((action, index) => actionPlan(action, index, tuple, origin));
  const actions = plans.map(item => ({ action: item.plan.action, action_id: item.plan.action_id, action_sha256: item.action_sha256 }));
  const request = binding.buildRequest(tuple, { slotId: SLOT, candidateRef: PINOKIO_SOURCE_REF, origin, actions, targets: TARGETS });
  // SnapshotSession owns the artifact's request.json and requires its output
  // directory to be absent. Keep the worker input beside (not inside) it.
  const requestPath = path.join(path.dirname(output), 'r25-request.json');
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  const productRoot = path.join(path.dirname(output), 'pinokio-product');
  const home = path.join(path.dirname(output), 'pinokio-home');
  const appRoot = path.join(home, 'api', 'astrid');
  const setupOnly = cli['setup-only'] === 'true';
  const ptermRoot = cli.pterm || process.env.PTERM_ROOT;
  const pinokiodRoot = cli.pinokiod || process.env.PINOKIOD_ROOT;
  if (!ptermRoot || !pinokiodRoot || !cli['agent-root']) throw new Error('runner roots are incomplete');
  await verifyAppCandidate(tuple);
  binding.validateSourceRoots({ agentRoot: path.resolve(cli['agent-root']), pinokioRoot: process.cwd(), agentRef: AGENT_REF });
  const ptyInstrumentation = setupOnly ? applyPinokiodPtyInstrumentation(pinokiodRoot, {
    diagnosticFile: path.join(diagnostics, 'r25-pty-diagnostics.jsonl'),
  }) : { enabled: false, diagnostic_file_bound: false };
  const windowsPtyInstrumentation = setupOnly && process.platform === 'win32'
    ? applyWindowsPtyDiagnostics(pinokiodRoot, { diagnosticFile: path.join(diagnostics, 'r25-windows-pty-diagnostics.jsonl') })
    : { enabled: false, reason: 'not-windows-setup-diagnostic' };
  const ptyCaptureFile = path.join(diagnostics, 'r25-pty-diagnostics.jsonl');
  const refreshPtyCaptureStatus = () => { if (setupOnly) ptyInstrumentation.capture_status = ptyCaptureStatus(ptyCaptureFile); };
  const engineBinding = materializeProduct(productRoot, appRoot);
  engineBinding.pinokiod_pty = ptyInstrumentation;
  engineBinding.windows_pty = windowsPtyInstrumentation;
  const environment = path.join(appRoot, '_ENVIRONMENT');
  fs.writeFileSync(environment, '# R-25 run-owned candidate pin\nASTRID_APP_REF=lane/M-APP/PINOKIO-APP-BINDING\n', { encoding: 'utf8', flag: 'w', mode: 0o600 });
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const userHome = path.join(home, 'user-home');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  // Create the recorder and its first fixed-label stage before the daemon
  // snapshots its environment. This boundary must remain observable even if
  // daemon spawn/readiness is the first failure.
  const setupDiagnostics = createInstallDiagnostics({
    schema: 'astrid.r25.pinokio-setup-diagnostics.v2',
    run_id: process.env.GITHUB_RUN_ID || null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
    phase: 'setup-install',
    pinokio_engine_ref: engineBinding.engine_ref,
    pterm_ref: process.env.PTERM_REF || null,
    pinokiod_ref: process.env.PINOKIOD_REF || null,
    shell_overlay: engineBinding.overlay,
    pinokiod_pty: engineBinding.pinokiod_pty,
    windows_pty: engineBinding.windows_pty,
  }, value => {
    const file = path.join(diagnostics, 'r25-install-diagnostics.json');
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  });
  const daemonEnv = { ...process.env, HOME: userHome, XDG_DATA_HOME: path.join(home, 'data'), PINOKIO_HOME: home,
    PINOKIO_HTTPS_ACTIVE: '0', PINOKIO_NETWORK_ACTIVE: '0',
    ...(setupOnly ? { ASTRID_R25_SETUP_DIAGNOSTICS: '1' } : {}),
    ...(setupOnly ? { ASTRID_R25_PTY_CAPTURE_FILE: path.join(diagnostics, 'r25-pty-diagnostics.jsonl') } : {}) };
  if (setupOnly && process.platform === 'win32') daemonEnv.ASTRID_R25_WINDOWS_PTY_CAPTURE_FILE = path.join(diagnostics, 'r25-windows-pty-diagnostics.jsonl');
  const daemonOutput = setupOnly ? {
    stdout: createBoundedCapture(path.join(diagnostics, 'daemon.stdout.log')),
    stderr: createBoundedCapture(path.join(diagnostics, 'daemon.stderr.log')),
  } : null;
  setupDiagnostics.stage('daemon-spawn-start', { pid: process.pid, ppid: process.ppid });
  let daemonSpawnFailed = false;
  const daemon = spawn(process.execPath, [path.join(pinokiodRoot, 'script', 'index.js')], {
    cwd: pinokiodRoot,
    // The daemon owns shell.run and snapshots its environment at spawn. Seed
    // the bounded setup-only capture here so the overlaid shell can emit its
    // child/stage trace; setting process.env after readiness cannot reach it.
    env: daemonEnv,
    stdio: daemonOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
  });
  setupDiagnostics.stage('daemon-spawn', { pid: daemon.pid, ppid: process.pid });
  daemon.once('error', () => { daemonSpawnFailed = true; setupDiagnostics.stage('daemon-error', { pid: daemon.pid, ppid: process.pid }); });
  if (daemonOutput) {
    daemon.stdout.on('data', chunk => daemonOutput.stdout.append(chunk));
    daemon.stderr.on('data', chunk => daemonOutput.stderr.append(chunk));
    daemon.stdout.on('close', () => daemonOutput.stdout.close());
    daemon.stderr.on('close', () => daemonOutput.stderr.close());
  }
  process.once('exit', () => { if (daemon.exitCode === null) daemon.kill(); });
  let daemonReady = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (daemonSpawnFailed || daemon.exitCode !== null) break;
    try { const response = await fetch('http://127.0.0.1:42000/pinokio/version'); if (response.ok) { daemonReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!daemonReady) {
    flushCaptures(daemonOutput);
    await terminateChild(daemon);
    daemonOutput?.stdout.close();
    daemonOutput?.stderr.close();
    throw new Error('native pinokiod did not reach readiness');
  }
  refreshPtyCaptureStatus();
  setupDiagnostics.stage('daemon-ready', { pid: daemon.pid, ppid: process.pid });
  const { WebSocket } = require(path.join(ptermRoot, 'node_modules', 'unws'));
  const trace = createObserverIO({ WebSocket, fetch, spawn, record: () => {}, appRoot, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', pollMs: 120000 });
  const ptermOutput = setupOnly ? {
    stdout: createBoundedCapture(path.join(diagnostics, 'pterm.stdout.log')),
    stderr: createBoundedCapture(path.join(diagnostics, 'pterm.stderr.log')),
  } : null;
  const installerCandidates = [
    path.join(daemonEnv.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'), 'Astrid Runtime', 'logs', 'install.log'),
    path.join(userHome, 'AppData', 'Local', 'Astrid Runtime', 'logs', 'install.log'),
  ];
  const shellDiagnosticFile = path.join(appRoot, '_r25-setup-shell-diagnostics.jsonl');
  const setupDiagnosticView = setupOnly ? Object.assign({}, setupDiagnostics, {
    stdio: ptermOutput,
    windows_pty_capture_file: process.platform === 'win32' ? ptyCaptureFile : null,
    async beforeTimeout(value) {
      refreshPtyCaptureStatus();
      setupDiagnostics.shell(shellDiagnosticFile);
      const ptermStatus = flushCaptures(ptermOutput);
      const daemonStatus = flushCaptures(daemonOutput);
      const preTimeoutPtermStdout = copyPreTimeoutCapture(path.join(diagnostics, 'pterm.stdout.log'), path.join(diagnostics, 'pterm.stdout.before-timeout.log'));
      const preTimeoutPtermStderr = copyPreTimeoutCapture(path.join(diagnostics, 'pterm.stderr.log'), path.join(diagnostics, 'pterm.stderr.before-timeout.log'));
      const preTimeoutDaemonStdout = copyPreTimeoutCapture(path.join(diagnostics, 'daemon.stdout.log'), path.join(diagnostics, 'daemon.stdout.before-timeout.log'));
      const preTimeoutDaemonStderr = copyPreTimeoutCapture(path.join(diagnostics, 'daemon.stderr.log'), path.join(diagnostics, 'daemon.stderr.before-timeout.log'));
      const snapshot = await captureWindowsProcessTree({ rootPids: [...new Set([value.pid, daemon.pid].filter(Number.isInteger))] });
      fs.writeFileSync(path.join(diagnostics, 'process-tree-before-timeout.json'), `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: 'utf8', flag: 'w', mode: 0o600,
      });
      setupDiagnostics.stage('process-snapshot-before-timeout');
      const installerOutput = copyFirstInstallerLog(installerCandidates, path.join(diagnostics, 'installer-output.log'));
      setupDiagnostics.stage('installer-output-before-timeout');
      setupDiagnostics.beforeTimeout({ at: value.at, pterm_pid: value.pid, pterm_ppid: value.ppid,
        daemon_pid: daemon.pid, daemon_ppid: process.pid, process_snapshot: snapshot.status,
        process_snapshot_error: snapshot.error, installer_output: installerOutput.status,
        pterm_output: ptermStatus, daemon_output: daemonStatus,
        pre_timeout_pterm_stdout: preTimeoutPtermStdout, pre_timeout_pterm_stderr: preTimeoutPtermStderr,
        pre_timeout_daemon_stdout: preTimeoutDaemonStdout, pre_timeout_daemon_stderr: preTimeoutDaemonStderr });
    },
  }) : setupDiagnostics;
  let worker;
  const results = [];
  try {
    // Installation is disposable preparation, outside the six measured
    // boundaries. It is still driven through the real Pinokio engine and is
    // allowed to fail closed before an evidence session can begin. Keep its
    // bounded native trace even when PTerm times out before returning an exit.
    const requestedTimeout = Number.parseInt(cli['setup-timeout-ms'] || '', 10);
    const setupTimeoutMs = setupOnly && Number.isSafeInteger(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 15 * 60 * 1000
      ? requestedTimeout : setupOnly ? 10 * 60 * 1000 : 45 * 60 * 1000;
    const priorDiagnosticFlag = process.env.ASTRID_R25_SETUP_DIAGNOSTICS;
    process.env.ASTRID_R25_SETUP_DIAGNOSTICS = '1';
    let preparation;
    try {
      preparation = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: 'pinokio/install.js', action: 'setup-install', timeoutMs: setupTimeoutMs, diagnostic: setupDiagnosticView });
      refreshPtyCaptureStatus();
    } finally {
      if (priorDiagnosticFlag === undefined) delete process.env.ASTRID_R25_SETUP_DIAGNOSTICS;
      else process.env.ASTRID_R25_SETUP_DIAGNOSTICS = priorDiagnosticFlag;
    }
    flushCaptures(ptermOutput);
    flushCaptures(daemonOutput);
    copyFirstInstallerLog(installerCandidates, path.join(diagnostics, 'installer-output.log'));
    if (preparation.first_error || preparation.inner_exit.code !== 0 || preparation.terminal.error) throw new Error('disposable Pinokio install preparation failed');
    setupDiagnostics.stage('setup-complete');
    if (setupOnly) {
      writeCanonical(path.join(diagnostics, 'r25-setup-result.json'), {
        schema: 'astrid.r25.pinokio-setup-result.v1', status: 'completed', setup_timeout_ms: setupTimeoutMs,
        tuple, pinned_refs: { pinokio_engine: PINOKIO_TUPLE_REF, pinokiod: process.env.PINOKIOD_REF || null, pterm: process.env.PTERM_REF || null },
        preparation,
      });
      return;
    }
    try { fs.rmSync(path.join(appRoot, '_r25-setup-shell-diagnostics.jsonl'), { force: true }); } catch {}
    worker = spawn(process.env.PYTHON || 'python', [path.join(process.cwd(), '.github', 'venue', 'r25-snapshot-worker.py'), requestPath, output], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: path.resolve(cli['agent-root']) }, stdio: ['pipe', 'pipe', 'ignore'] });
    for (const item of plans) {
      const action = item.plan.action;
      await workerSend(worker, { op: 'open', action });
      const before = await filesystemState(home, appRoot);
      let engine;
      if (action === 'ready') {
        await trace.waitForReadiness();
        engine = { script: null, execution_kind: 'engine-readiness-probe', inner_exit: { code: 0, signal: null }, terminal: { stop: true, disconnect: true, error: false }, first_error: null, status_after: true };
      } else if (action === 'rollback') {
        const reset = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: 'pinokio/reset.js', action: 'rollback-reset' });
        const reinstall = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: 'pinokio/install.js', action: 'rollback-reinstall' });
        engine = { execution_kind: 'real-engine-reset-and-reinstall', steps: [reset, reinstall], inner_exit: reinstall.inner_exit, terminal: reinstall.terminal, first_error: reset.first_error || reinstall.first_error, status_after: reinstall.status_after };
      } else {
        engine = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: item.plan.script, action });
      }
      const after = await filesystemState(home, appRoot);
      const failed = Boolean(engine.first_error || engine.inner_exit?.code !== 0 || engine.terminal?.error || engine.steps?.some(step => step.inner_exit?.code !== 0 || step.first_error));
      const record = { schema: 'astrid.r25.pinokio-filesystem-record.v1', action, action_id: item.plan.action_id, action_sha256: item.action_sha256, tuple, origin: { run_id: origin.run_id, run_attempt: origin.run_attempt, producer_job_id: origin.producer_job_id }, before, after, engine, status: failed ? 'failed' : 'completed' };
      results.push(record);
      await workerSend(worker, { op: 'close', failed });
      if (failed) throw new Error(`${action} real engine boundary failed`);
    }
    await workerSend(worker, { op: 'finalize' });
    for (const item of plans) writeCanonical(path.join(output, 'actions', `${String(item.plan.action_index).padStart(2, '0')}-${item.plan.action}.json`), item.plan);
    for (const record of results) writeCanonical(path.join(output, 'filesystem', `${record.action}.json`), record);
  } finally {
    setupDiagnostics.stage('cleanup-start');
    await trace.cleanup();
    if (worker && worker.exitCode === null) worker.kill();
    await terminateChild(daemon);
    ptermOutput?.stdout.close();
    ptermOutput?.stderr.close();
    daemonOutput?.stdout.close();
    daemonOutput?.stderr.close();
  }
}

module.exports = { actionPlan, createBoundedCapture, copyBoundedTail, copyFirstInstallerLog, ptyCaptureStatus };
if (require.main === module) {
  main().catch(error => { fail(error.message, { run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null }); process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; });
}
