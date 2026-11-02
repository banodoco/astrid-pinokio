'use strict';

// Hosted macOS/Windows R-25 route.  This is a producer only: it binds the exact
// request and records real engine outcomes, but it never grants qualification.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const binding = require('../../pinokio/providers/r25-native-collector-binding.cjs');
const { createObserverIO } = require('./r21-observer-io.cjs');
const { ptermExit } = require('./r21-observer-diagnostics.cjs');

const AGENT_REF = binding.AGENT_SOURCE_REF;
const PINOKIO_SOURCE_REF = '95aafb5a029c3f53cb2268d8596909eab0deb3c4';
const PINOKIO_TUPLE_REF = '3a6a98ae251ca126505245286e2d3e760f4348e9';
const APP_REF = 'lane/M-APP/PINOKIO-APP-BINDING';
const APP_TUPLE_REF = '79f7e5397c044c4c97dc7e97b20ad96f787e5247';
const APP_URL = 'https://raw.githubusercontent.com/banodoco/astrid-app/';
const ACTIONS = binding.REQUIRED_ACTIONS;
const TARGET_OS = process.env.R25_TARGET_OS || 'windows';
const SLOT = process.env.R25_SLOT_ID || (TARGET_OS === 'macos' ? 'pinokio-fully-local-macos' : 'pinokio-fully-local-windows');
function routeConfig(targetOs, slot, launchdTarget) {
  if (targetOs === 'macos' && ['pinokio-backend-macos', 'pinokio-fully-local-macos'].includes(slot)) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const target = launchdTarget || (Number.isSafeInteger(uid) && uid > 0 ? `gui/${uid}/haus.astrid.runtime` : null);
    if (!target) throw new Error('macOS launchd target requires a positive dynamic uid');
    const fullyLocal = slot === 'pinokio-fully-local-macos';
    return {
      targets: { os: 'macos', launchd_targets: [target] },
      installScript: fullyLocal ? 'pinokio/install-local.js' : 'pinokio/install.js',
      installMode: fullyLocal ? 'local' : 'backend',
    };
  }
  if (targetOs === 'windows' && ['pinokio-backend-windows', 'pinokio-fully-local-windows'].includes(slot)) {
    const fullyLocal = slot === 'pinokio-fully-local-windows';
    return {
      targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
      installScript: fullyLocal ? 'pinokio/install-local.js' : 'pinokio/install.js',
      installMode: fullyLocal ? 'local' : 'backend',
    };
  }
  throw new Error('R25_TARGET_OS and R25_SLOT_ID are incompatible');
}
const ROUTE = routeConfig(TARGET_OS, SLOT, process.env.R25_LAUNCHD_TARGET);
const TARGETS = ROUTE.targets;
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
function jsonDigest(value) { return digest(Buffer.from(`${canonical(value)}\n`, 'ascii')); }
function writeCanonical(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonical(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function readInstallModeReceipt(appRoot, expectedMode) {
  const value = readJson(path.join(appRoot, 'app', 'install-mode.json'));
  const fields = Object.keys(value || {}).sort();
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || fields.join('\0') !== ['mode', 'schema_version'].join('\0')
      || value.schema_version !== 1
      || !['backend', 'local'].includes(value.mode)
      || value.mode !== expectedMode) {
    throw new Error(`installed Pinokio mode receipt differs from the ${expectedMode} route`);
  }
  // Retain the parsed installed record; the route label is only a binding
  // check and must never be used to manufacture this receipt.
  return value;
}
function envInt(name) { const value = Number.parseInt(process.env[name] || '', 10); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is not a positive integer`); return value; }
function fail(message, extra = {}) {
  const diagnostics = { schema: 'astrid.r25.pinokio-action-diagnostics.v1', first_error: String(message).slice(0, 240), ...extra };
  const file = path.join(process.env.R25_DIAGNOSTICS || process.cwd(), 'r25-failure.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(diagnostics, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
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

function resolveLocalOrigin(file, artifactName) {
  const origin = readJson(path.resolve(file));
  if (origin.artifact_name !== artifactName) throw new Error('local origin artifact name differs');
  if (!String(origin.workflow_ref || '').startsWith('local-macos:')) throw new Error('local origin must be explicitly labeled local-macos');
  if (!String(origin.producer_job_name || '').startsWith('local-macos-')) throw new Error('local producer job must be explicitly labeled local-macos');
  return origin;
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

function captureMacCensus(agentRoot, target) {
  const output = execFileSync(process.env.PYTHON || 'python', [
    path.join(agentRoot, 'scripts', 'pinokio_snapshot_macos.py'), '--launchd-target', target,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  return JSON.parse(output);
}

async function filesystemState(home, appRoot, protectedData) {
  const files = ['app/install-mode.json', 'app/astrid/current', 'app/astrid/install.json', 'app/astrid/update-transaction.json'];
  const rows = [];
  for (const relative of files) {
    const file = path.join(home, relative);
    try { const data = await fsp.readFile(file); rows.push([relative, digest(data), data.length]); } catch { rows.push([relative, null, null]); }
  }
  let data = null;
  if (protectedData) {
    let sentinel = null;
    try { sentinel = digest(await fsp.readFile(protectedData.sentinel)); } catch {}
    data = {
      root: protectedData.root,
      sentinel: protectedData.sentinel,
      sentinel_sha256: sentinel,
      sentinel_expected_sha256: protectedData.sha256,
      sentinel_preserved: sentinel === protectedData.sha256,
      tree: await digestTree(protectedData.root),
    };
  }
  return { schema: 'astrid.r25.pinokio-filesystem-record.v1', protected: rows, app_tree: await digestTree(appRoot), data };
}

function portFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      if (['ECONNREFUSED', 'EHOSTUNREACH'].includes(error.code)) resolve(true);
      else reject(error);
    });
  });
}

async function waitForRouteReadiness(trace, timeoutMs = 120000) {
  if (ROUTE.installMode === 'backend') return trace.waitForReadiness();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [page, health, hostedDoorFree] = await Promise.all([
        fetch('http://127.0.0.1:5180/tools/video-editor', { signal: AbortSignal.timeout(5000) }),
        fetch('http://127.0.0.1:5180/api/runtime/v1/health', { signal: AbortSignal.timeout(5000) }),
        portFree(17340),
      ]);
      const pageBody = await page.text().catch(() => '');
      const body = await health.json().catch(() => null);
      if (await trace.engineResourceReady() && page.status === 200 && /<html/i.test(pageBody) && body?.protocol === 'workspace.v1'
          && health.status === 200 && hostedDoorFree) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('independent fully-local editor/Runtime readiness timeout');
}

async function observeAction({ io, ptermRoot, home, endpoint, appRoot, script, action, logRoot, timeoutMs = 30 * 60 * 1000 }) {
  const socket = await io.openSocket();
  let terminal = { stop: false, disconnect: false, error: false };
  let firstError = null;
  const onMessage = event => {
    try {
      const packet = JSON.parse(String(event.data));
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
    fs.mkdirSync(logRoot, { recursive: true });
    const stdoutPath = path.join(logRoot, `${action}.stdout.log`);
    const stderrPath = path.join(logRoot, `${action}.stderr.log`);
    const stdout = fs.openSync(stdoutPath, 'wx', 0o600);
    const stderr = fs.openSync(stderrPath, 'wx', 0o600);
    const child = spawn(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', script, '--ref', endpoint], {
      cwd: home, env: process.env, stdio: ['ignore', stdout, stderr],
    });
    let innerExit;
    try { innerExit = await ptermExit(child, `R-25 ${action}`, timeoutMs); }
    finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    await new Promise(resolve => setTimeout(resolve, 500));
    return { script, inner_exit: innerExit, terminal, first_error: firstError,
      logs: { stdout: stdoutPath, stderr: stderrPath },
      status_after: await io.status(path.join(appRoot, script), `${action}-status`) };
  } finally {
    io.disposeSocket(socket);
  }
}
async function workerSend(worker, value) { worker.stdin.write(`${JSON.stringify(value)}\n`); return new Promise((resolve, reject) => {
  const onData = chunk => { const line = String(chunk).trim().split('\n')[0]; if (!line) return; worker.stdout.off('data', onData); try { const result = JSON.parse(line); if (!result.ok) reject(new Error(result.error || 'snapshot worker refused')); else resolve(result); } catch (error) { reject(error); } };
  worker.stdout.on('data', onData);
}); }
function actionPlan(action, index, tuple, origin) {
  const script = ({ start: 'pinokio/start.js', ready: null, stop: 'pinokio/stop.js', update: 'pinokio/update.js', rollback: `pinokio/reset.js + ${ROUTE.installScript}`, uninstall: 'pinokio/uninstall.js' })[action];
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
  let artifactName;
  let origin;
  if (cli['local-origin']) {
    const candidate = readJson(path.resolve(cli['local-origin']));
    artifactName = candidate.artifact_name;
    origin = resolveLocalOrigin(cli['local-origin'], artifactName);
    if (TARGET_OS !== 'macos' || process.platform !== 'darwin') throw new Error('local origin route requires a real macOS host');
  } else {
    artifactName = `r25-snapshots-${SLOT}-${envInt('GITHUB_RUN_ID')}-${envInt('GITHUB_RUN_ATTEMPT')}`;
    origin = await resolveOrigin(artifactName);
  }
  const plans = ACTIONS.map((action, index) => actionPlan(action, index, tuple, origin));
  const actions = plans.map(item => ({ action: item.plan.action, action_id: item.plan.action_id, action_sha256: item.action_sha256 }));
  const request = binding.buildRequest(tuple, { slotId: SLOT, candidateRef: PINOKIO_SOURCE_REF, origin, actions, targets: TARGETS });
  // SnapshotSession owns the artifact's request.json and requires its output
  // directory to be absent. Keep the worker input beside (not inside) it.
  const requestPath = path.join(path.dirname(output), 'r25-request.json');
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  const productRoot = path.join(path.dirname(output), 'pinokio-product');
  const home = path.join(path.dirname(output), 'pinokio-home');
  const isolatedUserHome = path.join(path.dirname(output), 'user-home');
  const isolatedDataHome = path.join(path.dirname(output), 'data-home');
  const appRoot = path.join(home, 'api', 'astrid');
  const ptermRoot = cli.pterm || process.env.PTERM_ROOT;
  const pinokiodRoot = cli.pinokiod || process.env.PINOKIOD_ROOT;
  if (!ptermRoot || !pinokiodRoot || !cli['agent-root']) throw new Error('runner roots are incomplete');
  await verifyAppCandidate(tuple);
  binding.validateSourceRoots({ agentRoot: path.resolve(cli['agent-root']), pinokioRoot: process.cwd(), agentRef: AGENT_REF });
  materializeProduct(productRoot, appRoot);
  const environment = path.join(appRoot, '_ENVIRONMENT');
  fs.writeFileSync(environment, '# R-25 run-owned candidate pin\nASTRID_APP_REF=lane/M-APP/PINOKIO-APP-BINDING\n', { encoding: 'utf8', flag: 'w', mode: 0o600 });
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.mkdirSync(isolatedUserHome, { recursive: true });
  fs.mkdirSync(isolatedDataHome, { recursive: true });
  const daemon = spawn(process.execPath, [path.join(pinokiodRoot, 'script', 'index.js')], {
    cwd: pinokiodRoot,
    env: { ...process.env, HOME: isolatedUserHome, XDG_DATA_HOME: isolatedDataHome, PINOKIO_HOME: home, PINOKIO_HTTPS_ACTIVE: '0', PINOKIO_NETWORK_ACTIVE: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.once('exit', () => { if (daemon.exitCode === null) daemon.kill(); });
  let daemonReady = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (daemon.exitCode !== null) break;
    try { const response = await fetch('http://127.0.0.1:42000/pinokio/version'); if (response.ok) { daemonReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!daemonReady) throw new Error('native pinokiod did not reach readiness');
  const { WebSocket } = require(path.join(ptermRoot, 'node_modules', 'unws'));
  const trace = createObserverIO({ WebSocket, fetch, spawn, record: () => {}, appRoot, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', pollMs: 120000 });
  // Installation is disposable preparation, outside the six measured
  // boundaries. It is still driven through the real Pinokio engine and is
  // allowed to fail closed before an evidence session can begin.
  const logRoot = path.join(diagnostics, 'engine-logs');
  const preparation = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: ROUTE.installScript, action: 'setup-install', logRoot, timeoutMs: 45 * 60 * 1000 });
  if (preparation.first_error || preparation.inner_exit.code !== 0 || preparation.terminal.error) throw new Error('disposable Pinokio install preparation failed');
  readInstallModeReceipt(appRoot, ROUTE.installMode);
  const install = readJson(path.join(appRoot, 'app', 'astrid', 'install.json'));
  const dataRoot = path.resolve(install.data_root || '');
  const isolatedRoot = path.resolve(path.dirname(output));
  if (!path.isAbsolute(install.data_root || '') || (dataRoot !== isolatedRoot && !dataRoot.startsWith(`${isolatedRoot}${path.sep}`))) {
    throw new Error('installed data root escaped the isolated run root');
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, 'r25-option-b-sentinel.json');
  const sentinelBytes = Buffer.from(`${canonical({ schema: 'astrid.r25.option-b-sentinel.v1', slot_id: SLOT, tuple })}\n`, 'ascii');
  fs.writeFileSync(sentinel, sentinelBytes, { flag: 'wx', mode: 0o600 });
  const protectedData = { root: dataRoot, sentinel, sha256: digest(sentinelBytes) };
  const initialCensus = TARGET_OS === 'macos'
    ? captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]) : null;
  if (initialCensus) writeCanonical(path.join(diagnostics, 'census', 'initial.json'), initialCensus);
  const worker = spawn(process.env.PYTHON || 'python', [path.join(process.cwd(), '.github', 'venue', 'r25-snapshot-worker.py'), requestPath, output], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: path.resolve(cli['agent-root']) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const results = [];
  let finalCensus = null;
  try {
    for (const item of plans) {
      const action = item.plan.action;
      await workerSend(worker, { op: 'open', action });
      const before = await filesystemState(home, appRoot, protectedData);
      let engine;
      if (action === 'ready') {
        await waitForRouteReadiness(trace);
        engine = { script: null, execution_kind: 'engine-readiness-probe', inner_exit: { code: 0, signal: null }, terminal: { stop: true, disconnect: true, error: false }, first_error: null, status_after: true };
      } else if (action === 'rollback') {
        const reset = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: 'pinokio/reset.js', action: 'rollback-reset', logRoot });
        const reinstall = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: ROUTE.installScript, action: 'rollback-reinstall', logRoot });
        readInstallModeReceipt(appRoot, ROUTE.installMode);
        engine = { execution_kind: 'real-engine-reset-and-reinstall', steps: [reset, reinstall], inner_exit: reinstall.inner_exit, terminal: reinstall.terminal, first_error: reset.first_error || reinstall.first_error, status_after: reinstall.status_after };
      } else {
        engine = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: item.plan.script, action, logRoot });
      }
      const after = await filesystemState(home, appRoot, protectedData);
      const failed = Boolean(engine.first_error || engine.inner_exit?.code !== 0 || engine.terminal?.error || !after.data?.sentinel_preserved || engine.steps?.some(step => step.inner_exit?.code !== 0 || step.first_error));
      const record = { schema: 'astrid.r25.pinokio-filesystem-record.v1', action, action_id: item.plan.action_id, action_sha256: item.action_sha256, slot_id: SLOT, tuple, origin: { run_id: origin.run_id, run_attempt: origin.run_attempt, producer_job_id: origin.producer_job_id }, pinokio_install_mode_receipt: readInstallModeReceipt(appRoot, ROUTE.installMode), before, after, engine, status: failed ? 'failed' : 'completed' };
      results.push(record);
      writeCanonical(path.join(diagnostics, 'action-records', `${String(item.plan.action_index).padStart(2, '0')}-${action}.json`), record);
      await workerSend(worker, { op: 'close', failed });
      if (failed) throw new Error(`${action} real engine boundary failed`);
    }
    finalCensus = TARGET_OS === 'macos'
      ? captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]) : null;
    if (finalCensus) writeCanonical(path.join(diagnostics, 'census', 'final.json'), finalCensus);
    await workerSend(worker, { op: 'finalize' });
    for (const item of plans) writeCanonical(path.join(output, 'actions', `${String(item.plan.action_index).padStart(2, '0')}-${item.plan.action}.json`), item.plan);
    for (const record of results) writeCanonical(path.join(output, 'filesystem', `${record.action}.json`), record);
    if (initialCensus) writeCanonical(path.join(output, 'census', 'initial.json'), initialCensus);
    if (finalCensus) writeCanonical(path.join(output, 'census', 'final.json'), finalCensus);
  } finally {
    if (TARGET_OS === 'macos' && !finalCensus) {
      try {
        finalCensus = captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]);
        writeCanonical(path.join(diagnostics, 'census', 'final.json'), finalCensus);
      } catch {}
    }
    await trace.cleanup();
    if (worker.exitCode === null) worker.kill();
    if (daemon.exitCode === null) daemon.kill();
  }
}

module.exports = { actionPlan, readInstallModeReceipt, routeConfig };
if (require.main === module) {
  main().catch(error => { fail(error.message, { run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null }); process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; });
}
