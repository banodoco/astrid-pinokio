import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNativeObservation } from '../../tests/smoke/native-observation.mjs';
import { createKeepGoingRecorder, diagnosticKeepGoingEnabled } from '../../tests/smoke/keepgoing.mjs';
import { prepareDiagnosticFixture, verifyAppBranch, verifyInstalledEditor } from '../../tests/smoke/diagnostic-fixture.mjs';
import { trackDisposableChild, terminateDisposableChild, boundOwnedOperation } from '../../tests/smoke/owned-process.mjs';
import library from '../../pinokio/lib.js';

const require = createRequire(import.meta.url);
const { createObserverIO } = require('./r21-observer-io.cjs');
const ENGINE = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const PTERM = '5be43718701c448b43daf0ce51d8935f170065bb';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(process.env.PINOKIO_KEEPGOING_ROOT || path.join(process.env.RUNNER_TEMP || '.', 'pinokio-keepgoing'));
const mode = process.argv[2];
assert.ok(['backend', 'fully-local'].includes(mode), 'expected backend or fully-local');
assert.ok(diagnosticKeepGoingEnabled(), 'native continuation requires explicit diagnostic_keep_going');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'native execution requires a disposable hosted runner');
const recorder = createKeepGoingRecorder({ enabled: true, metadata: {
  slot: process.env.PINOKIO_KEEPGOING_SLOT, engine: 'native Pinokiod/PTerm',
  pinokiod_ref: ENGINE, pterm_ref: PTERM, workflow_sha: process.env.GITHUB_SHA,
  run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  inner_installer_exit: 'unknown unless independently captured; PTerm exit is not installer exit',
  c5_u1: 'not present in frozen published product tuple',
} });
const home = path.join(root, 'home');
const userHome = path.join(root, 'user-home');
const appRoot = path.join(home, 'api', 'astrid');
const engineRoot = path.join(root, 'pinokiod');
const ptermRoot = path.join(root, 'pterm');
const endpoint = 'pinokio://127.0.0.1:42000/api/astrid';
const timeout = Number(process.env.PINOKIO_DIAGNOSTIC_TIMEOUT_MS || 120000);
const cleanups = recorder.metadata.cleanups = [];
let daemon, io;
let fixtureOwned = false;
let selectionVerified = false;
let stageNumber = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safe = text => String(text).replace(/(bearer\s+|(?:token|secret|password)[=: ]+)[^\s"']+/ig, '$1<redacted>').slice(-8192);

async function command(argv, cwd, { env = process.env, deadline = timeout, label = 'command' } = {}) {
  assert.ok(fixtureOwned, 'refuse command outside a verified task-owned native fixture');
  const relative = path.relative(root, path.resolve(cwd));
  assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'command cwd escaped diagnostic fixture');
  const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout?.on('data', data => { output = (output + data).slice(-8192); });
  child.stderr?.on('data', data => { output = (output + data).slice(-8192); });
  const operation = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve({ code, signal, output: safe(output) })
      : reject(Object.assign(new Error(`${label}: ${signal || code}: ${safe(output)}`), { inner_exit: code })));
  });
  if (!child.pid) return operation;
  trackDisposableChild(child, { cwd, root });
  return boundOwnedOperation(child, operation, deadline, cleanup => { cleanups.push(cleanup); recorder.write(); });
}

async function clonePinned(name, repository, ref) {
  assert.ok(fixtureOwned, 'refuse dependency mutation without task-owned fixture');
  const cwd = path.join(root, name);
  fs.mkdirSync(cwd);
  await command(['git', 'init', '-q'], cwd);
  await command(['git', 'config', 'core.autocrlf', 'false'], cwd);
  await command(['git', 'remote', 'add', 'origin', repository], cwd);
  await command(['git', 'fetch', '--no-tags', '--depth=1', 'origin', ref], cwd);
  await command(['git', 'checkout', '--detach', 'FETCH_HEAD'], cwd);
  const actual = await command(['git', 'rev-parse', 'HEAD'], cwd);
  assert.equal(actual.output.trim(), ref, `${name} source drift`);
  return { ref, source: 'genuine pinned dependency' };
}
async function npmInstall(cwd) {
  const argv = process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', 'npm ci --omit=dev --loglevel=error']
    : ['npm', 'ci', '--omit=dev', '--loglevel=error'];
  return command(argv, cwd, { deadline: 300000, label: 'native engine npm ci' });
}

async function action(name, script) {
  assert.ok(io, 'native transport unavailable after dependency/readiness failure');
  verifyAppBranch();
  const socket = await io.openSocket();
  const view = createNativeObservation(script, safe);
  const observed = view.observation;
  observed.request = ++stageNumber;
  const event = event => {
    try {
      const first = observed.engine_error;
      view.packet(JSON.parse(String(event.data)));
      if (!first && observed.engine_error) recorder.captureFirstError(name, new Error(observed.engine_error.first_error));
    }
    catch { observed.engine_error ??= { type: 'malformed-packet', first_error: 'engine packet was not JSON' }; }
  };
  socket.addEventListener('message', event);
  try {
    socket.send(JSON.stringify({ uri: path.join(appRoot, script), mode: 'listen' }));
    recorder.metadata.current_action = observed;
    recorder.write();
    try {
      observed.pterm_exit = await command([process.execPath, path.join(ptermRoot, 'index.js'), 'start', script, '--ref', endpoint], home,
        { env: { ...process.env, HOME: userHome, USERPROFILE: userHome, PINOKIO_HOME: home }, label: `PTerm ${name}` });
    } catch (error) {
      observed.pterm_exit = { code: error.inner_exit ?? null, cleanup: error.cleanup ?? null };
      if (observed.engine_error) error.message = `${observed.engine_error.first_error}; ${error.message}`;
      throw error;
    } finally { (recorder.metadata.actions ??= []).push(observed); }
    await pause(500);
    view.validate();
    observed.status_after = await io.status(path.join(appRoot, script), name);
    assert.notEqual(observed.status_after, 'unknown', 'engine status after action is unknown');
    verifyInstalledEditor(library.createApp({ platform: process.platform, appDirectory: appRoot, environment: { ...process.env, HOME: userHome } }));
    return observed;
  } finally { socket.removeEventListener('message', event); io.disposeSocket(socket); }
}

async function readiness() {
  const url = mode === 'backend' ? library.DOOR_HEALTH_URL
    : 'http://127.0.0.1:5180/api/runtime/v1/health';
  const response = await fetch(url, { headers: mode === 'backend' ? { Origin: 'https://astrid.haus' } : {}, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, 'native route health is not ready');
  const value = await response.json();
  if (mode === 'backend') assert.equal(value.install?.managed_by, 'pinokio', 'health ownership differs');
  else assert.equal(value.protocol, 'workspace.v1', 'Runtime proxy protocol differs');
  return { http_status: response.status, qualification_eligible: false };
}

try {
  await recorder.run('disposable native fixture', async () => {
    const runnerTemp = path.resolve(process.env.RUNNER_TEMP || '');
    const relative = path.relative(runnerTemp, root);
    assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'native fixture must be below disposable RUNNER_TEMP');
    assert.ok(!fs.existsSync(root), 'refuse reuse of a native diagnostic scratch root');
    fs.mkdirSync(root, { recursive: true });
    fixtureOwned = true;
    fs.mkdirSync(path.dirname(appRoot), { recursive: true });
    fs.mkdirSync(userHome);
    await command(['git', 'clone', '--no-hardlinks', source, appRoot], root);
    const selection = await prepareDiagnosticFixture(appRoot, process.env, source);
    selectionVerified = true;
    Object.assign(recorder.metadata, selection, { engine: 'native Pinokiod/PTerm', fixture: 'genuine run-owned native app and user home' });
    return { app: appRoot, selection };
  }, { needs: [], produces: ['fresh native Pinokio app and isolated user home', 'frozen manifest and installer hashes'] });
  await recorder.run('pinokiod source', () => clonePinned('pinokiod', 'https://github.com/pinokiocomputer/pinokiod', ENGINE), { needs: ['disposable native fixture'], produces: ['pinned Pinokiod source'] });
  await recorder.run('pterm source', () => clonePinned('pterm', 'https://github.com/pinokiocomputer/pterm', PTERM), { needs: ['disposable native fixture'], produces: ['pinned PTerm source'] });
  await recorder.run('pinokiod dependencies', () => npmInstall(engineRoot), { needs: ['pinokiod source'], produces: ['native daemon dependencies'] });
  await recorder.run('pterm dependencies', () => npmInstall(ptermRoot), { needs: ['pterm source'], produces: ['native PTerm dependencies'] });
  await recorder.run('native daemon ready', async () => {
    assert.ok(fixtureOwned && selectionVerified, 'refuse native launch without verified disposable fixture and exact tuple');
    const server = await import('node:net');
    await new Promise((resolve, reject) => { const probe = server.createServer(); probe.once('error', reject); probe.listen(42000, '127.0.0.1', () => probe.close(resolve)); });
    const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, PINOKIO_HOME: home,
      XDG_DATA_HOME: path.join(userHome, 'data'), PINOKIO_HTTPS_ACTIVE: '0', PINOKIO_NETWORK_ACTIVE: '0' };
    if (process.platform === 'win32') Object.assign(env, { APPDATA: path.join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(userHome, 'AppData', 'Local') });
    daemon = spawn(process.execPath, [path.join(engineRoot, 'script', 'index.js')], { cwd: engineRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    trackDisposableChild(daemon, { cwd: engineRoot, root });
    let tail = '';
    daemon.stdout.on('data', data => { tail = safe(tail + data); });
    daemon.stderr.on('data', data => { tail = safe(tail + data); });
    for (let n = 0; n < 60; n++) {
      assert.equal(daemon.exitCode, null, `daemon exited: ${tail}`);
      try { if ((await fetch('http://127.0.0.1:42000/pinokio/version', { signal: AbortSignal.timeout(1000) })).ok) {
        const { WebSocket } = require(path.join(ptermRoot, 'node_modules', 'unws'));
        io = createObserverIO({ WebSocket, fetch, spawn, record() {}, appRoot, ptermRoot, home, endpoint, connectMs: 3000, responseMs: 3000 });
        return { pid: daemon.pid, daemon_tail: tail };
      } } catch {}
      await pause(1000);
    }
    throw new Error(`native daemon readiness timeout: ${tail}`);
  }, { needs: ['pinokiod dependencies', 'pterm dependencies'], produces: ['run-owned daemon on reserved local port', 'native observer transport'] });
  const installScript = mode === 'backend' ? 'pinokio/install.js' : 'pinokio/install-local.js';
  for (const [name, script, needs] of [
    ['install', installScript, ['native daemon ready']],
    ['start', 'pinokio/start.js', ['install']],
    ['ready after start', null, ['start']],
    ['stop', 'pinokio/stop.js', ['start']],
    ['update', 'pinokio/update.js', ['stop']],
    ['ready after update', null, ['update']],
    ['stop after update', 'pinokio/stop.js', ['update']],
    ['rollback reset', 'pinokio/reset.js', ['stop after update']],
    ['rollback reinstall', installScript, ['rollback reset']],
    ['restart', 'pinokio/start.js', ['rollback reinstall']],
    ['ready after restart', null, ['restart']],
    ['final stop', 'pinokio/stop.js', ['restart']],
    ['uninstall', 'pinokio/uninstall.js', ['final stop']],
  ]) await recorder.run(name, () => script ? action(name, script) : readiness(), { needs, produces: [script ? 'PTerm exit and engine terminal/status observed; installer exit remains unknown' : 'native Runtime health observed'] });
} finally {
  if (daemon) await recorder.run('native daemon cleanup', async () => {
    const cleanup = await terminateDisposableChild(daemon);
    cleanups.push(cleanup);
    return cleanup;
  }, { needs: [], produces: ['only spawned daemon handle stopped; descendants unknown'] });
  recorder.metadata.residuals = 'all scratch retained for hosted runner disposal; unknown descendants never signalled';
  recorder.write();
  if (recorder.report().first_error) process.exitCode = 1;
}
