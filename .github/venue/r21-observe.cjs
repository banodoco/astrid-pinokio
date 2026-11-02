'use strict';

// The runner deliberately uses PTerm for every Pinokio action.  A PTerm exit
// is retained but is never enough: PTerm 5be4371 exits zero after both a
// normal terminal packet and an engine error, so the selected packets and a
// fresh engine status query are independently checked as well.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createObserverIO } = require('./r21-observer-io.cjs');
const {
  ACTIONS, ENDPOINT, FIRST_REFUSAL, TUPLE, verifyReceipt,
} = require('./r21-verify.cjs');

const [requestPath, output] = process.argv.slice(2);
if (!requestPath || !output) throw new Error('usage: node r21-observe.cjs <request.json> <evidence-dir>');

const appRoot = process.env.R21_APP_ROOT;
const ptermRoot = process.env.R21_PTERM_ROOT;
const home = process.env.R21_VENUE_HOME;
if (!appRoot || !ptermRoot || !home) throw new Error('R21_APP_ROOT, R21_PTERM_ROOT, and R21_VENUE_HOME are required');

const { WebSocket } = require(path.join(ptermRoot, 'node_modules/unws'));
const ACTION_TIMEOUT_MS = 20 * 60 * 1000;
let actionNumber = 0;
const progress = {};
function substage(value) {
  const dir = process.env.R21_PROGRESS_DIR;
  if (!dir) return;
  const file = path.join(dir, 'progress.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ stage: 'run-r21-journey', substage: value,
    elapsed_ms: Math.max(0, Date.now() - Number(process.env.R21_STARTED_MS)) }));
  fs.renameSync(`${file}.tmp`, file);
}
const retainProgress = () => write('r21-progress.json', progress);

function write(name, value) {
  const file = path.join(output, name);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function digestTree(target) {
  const hash = crypto.createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(target, relative);
    let entry;
    try { entry = await fsp.lstat(absolute); }
    catch (error) {
      if (error.code === 'ENOENT') { hash.update(`missing\\0${relative}\\0`); return; }
      throw error;
    }
    if (entry.isDirectory()) {
      hash.update(`directory\\0${relative}\\0`);
      const names = (await fsp.readdir(absolute)).sort();
      for (const name of names) await visit(path.join(relative, name));
    } else if (entry.isFile()) {
      hash.update(`file\\0${relative}\\0${sha256(await fsp.readFile(absolute))}\\0`);
    } else if (entry.isSymbolicLink()) {
      hash.update(`symlink\\0${relative}\\0${await fsp.readlink(absolute)}\\0`);
    } else {
      hash.update(`other\\0${relative}\\0`);
    }
  }
  await visit('');
  return hash.digest('hex');
}

async function digestProtectedState() {
  const root = path.join(appRoot, 'app', 'astrid');
  const program = crypto.createHash('sha256');
  for (const name of ['current', 'install.json', 'update-transaction.json']) {
    const file = path.join(root, name);
    try { program.update(`${name}\\0${sha256(await fsp.readFile(file))}\\0`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      program.update(`${name}\\0missing\\0`);
    }
  }
  let selected = 'missing';
  try { selected = sha256(await fsp.readFile(path.join(root, 'current'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let dataRoot;
  try {
    const install = JSON.parse(await fsp.readFile(path.join(root, 'install.json'), 'utf8'));
    dataRoot = path.resolve(install.data_root);
  } catch {
    throw new Error('installed data root cannot be read for protected-state observation');
  }
  if (path.relative(home, dataRoot).startsWith('..') || path.isAbsolute(path.relative(home, dataRoot)) === true) {
    throw new Error('installed data root escaped the disposable Pinokio home');
  }
  return {
    program: program.digest('hex'),
    selected_version: selected,
    // This full digest has no paths, names, contents, timestamps, or raw logs.
    user_data: await digestTree(dataRoot),
  };
}

const io = createObserverIO({ WebSocket, fetch, spawn, appRoot, ptermRoot, home, endpoint: ENDPOINT,
  record: value => write('r21-observer-operation.json', value) });
const { openSocket, status, waitForReadiness, runtimeReady, applicationReady, startOldLauncher } = io;

function ptermExit(child, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label} PTerm timeout`));
    }, ACTION_TIMEOUT_MS);
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${label} PTerm spawn failed`)); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal: signal || null }); });
  });
}

async function observeAction(label, script) {
  const localPath = path.join(appRoot, script);
  const socket = await openSocket();
  const observation = {
    action_id: ++actionNumber,
    action_uri: `${ENDPOINT}/${script}`,
    terminal: { stop: false, disconnect: false, expected_refusal: false },
    installer_dispatch: false,
    stopped: false,
    lock_free: false,
  };
  let disconnected;
  const done = new Promise((resolve) => { disconnected = resolve; });
  socket.addEventListener('message', (event) => {
    let packet;
    try { packet = JSON.parse(String(event.data)); }
    catch { return; }
    // Do not retain raw engine output.  These booleans are the entire
    // sanitised packet projection used by the verifier.
    if (packet.type === 'event' && packet.data === 'stop') observation.terminal.stop = true;
    if (packet.type === 'disconnect') { observation.terminal.disconnect = true; disconnected(); }
    if (packet.type === 'error' && String(packet.data || '').includes(FIRST_REFUSAL)) {
      observation.terminal.expected_refusal = true;
    }
    if (packet.type === 'stream' && typeof packet.data?.raw === 'string') {
      const raw = packet.data.raw;
      if (raw.includes('--managed-by') && raw.includes('pinokio')) observation.installer_dispatch = true;
      if (raw.includes(FIRST_REFUSAL)) observation.terminal.expected_refusal = true;
    }
    if (packet.type === 'result' && isObject(packet.data)) {
      if (packet.data.stopped === true) observation.stopped = true;
      if (packet.data.lockFree === true) observation.lock_free = true;
    }
    // Historical backend Update has exactly two engine steps: its retained
    // launcher pull and the bootstrap shell.  A terminal result for step two
    // is a packet-level proof that the fresh retry dispatched that bootstrap,
    // without retaining shell text or installer output.
    if (packet.type === 'result' && packet.index === 1 && packet.total === 2) {
      observation.installer_dispatch = true;
    }
  });
  socket.send(JSON.stringify({ uri: localPath, mode: 'listen' }));
  await delay(1000); // a missing subscription is an evidence failure, not a pass
  const child = spawn(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', script, '--ref', ENDPOINT], {
    cwd: home, env: process.env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  observation.inner_exit = await ptermExit(child, label);
  const progressKey = { 'historical install': 'install', 'first Update': 'first_click',
    'historical Stop': 'stop', 'fresh Update retry': 'retry', 'bounded cleanup Stop': 'cleanup' }[label];
  progress[progressKey] = observation;
  retainProgress();
  let disconnectTimer;
  await Promise.race([done, new Promise(resolve => { disconnectTimer = setTimeout(resolve, 5000); })]);
  clearTimeout(disconnectTimer);
  io.disposeSocket(socket);
  observation.running_after = await status(localPath);
  return observation;
}

async function lockFree() {
  const root = path.join(appRoot, 'app', 'astrid');
  const install = JSON.parse(await fsp.readFile(path.join(root, 'install.json'), 'utf8'));
  const dataRoot = path.resolve(install.data_root);
  if (path.relative(home, dataRoot).startsWith('..') || path.isAbsolute(path.relative(home, dataRoot)) === true) {
    throw new Error('installed data root escaped the disposable Pinokio home');
  }
  const code = [
    'import fcntl, os, pathlib, sys',
    'root = pathlib.Path(sys.argv[1])',
    'home = pathlib.Path(sys.argv[2])',
    'data = pathlib.Path(sys.argv[3])',
    "paths = [root / '.app-update.lock', home / '.local/share/astrid-install.lock', data.parent / 'astrid-install.lock']",
    'paths = list(dict.fromkeys(path.resolve() for path in paths))',
    'streams = []',
    'try:',
    '  for item in paths:',
    '    item.parent.mkdir(parents=True, exist_ok=True)',
    "    stream = item.open('a+b')",
    '    streams.append(stream)',
    '    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '  sys.exit(0)',
    'except BlockingIOError:',
    '  sys.exit(1)',
    'finally:',
    '  for stream in streams:',
    '    try: fcntl.flock(stream.fileno(), fcntl.LOCK_UN); stream.close()',
    '    except OSError: pass',
  ].join('\n');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-I', '-c', code, root, home, dataRoot], { stdio: 'ignore' });
    child.once('error', () => reject(new Error('independent lock observer could not start')));
    child.once('exit', (status) => resolve(status));
  });
  return result === 0;
}

async function main() {
  await fsp.mkdir(output, { recursive: true });
  const request = JSON.parse(await fsp.readFile(requestPath, 'utf8'));
  if (request.endpoint !== ENDPOINT || JSON.stringify(request.tuple) !== JSON.stringify(TUPLE)) {
    throw new Error('request did not retain the immutable R-21 tuple');
  }
  substage('install');
  const install = await observeAction('historical install', 'pinokio/install.js');
  progress.install = install; retainProgress();
  if (install.inner_exit.code !== 0 || install.terminal.disconnect !== true || install.terminal.stop !== true) {
    throw new Error('historical installation did not settle');
  }
  substage('initial-start-readiness');
  await startOldLauncher();
  substage('state-before');
  const before = await digestProtectedState();
  substage('first-click');
  const first = await observeAction('first Update', 'pinokio/update.js');
  // The exact refusal originates in the R-17 installer after the old action's
  // bootstrap dispatch.  Unlike a raw terminal echo, this boolean is safe to
  // retain and proves that the first click reached the real installer fence.
  first.installer_dispatch = first.terminal.expected_refusal;
  progress.first_click = first; retainProgress();
  substage('state-after-first-click');
  const afterFirst = await digestProtectedState();
  substage('stop');
  const stopped = await observeAction('historical Stop', 'pinokio/stop.js');
  stopped.start_running_after = await status(path.join(appRoot, 'pinokio/start.js'));
  stopped.lock_free = stopped.lock_free && await lockFree();
  progress.stop = stopped; retainProgress();
  substage('retry');
  const retry = await observeAction('fresh Update retry', 'pinokio/update.js');
  progress.retry = retry; retainProgress();
  // Backend Update is not a Start action. Exercise a fresh Start after the
  // retry, and observe its engine status and independent readiness separately.
  substage('retry-start-readiness');
  await startOldLauncher();
  retry.start_running_after_retry = await status(path.join(appRoot, 'pinokio/start.js'));
  await waitForReadiness();
  retry.runtime_ready = await runtimeReady();
  retry.application_ready = await applicationReady();
  retry.start_to_ready = retry.start_running_after_retry === true && retry.runtime_ready && retry.application_ready;
  substage('state-after-retry');
  const afterRetry = await digestProtectedState();
  substage('cleanup');
  const cleanup = await observeAction('bounded cleanup Stop', 'pinokio/stop.js');
  cleanup.start_running_after = await status(path.join(appRoot, 'pinokio/start.js'));
  cleanup.lock_free = cleanup.lock_free && await lockFree();
  cleanup.daemon_idle = await status(path.join(appRoot, 'pinokio/update.js'));
  progress.cleanup = cleanup; retainProgress();
  substage('verify-receipt');
  const receipt = {
    schema: 1,
    request_id: request.request_id,
    endpoint: ENDPOINT,
    tuple: TUPLE,
    first_click: first,
    protected_state: { before, after_first_click: afterFirst, after_retry: afterRetry },
    stop: stopped,
    retry,
    cleanup,
  };
  write('r21-receipt.json', receipt);
  write('r21-verdict.json', verifyReceipt(receipt));
}

main().then(() => io.cleanup()).catch(async (error) => {
  // Hosted job logs retain diagnostics for the venue owner.  Artifacts remain
  // sanitised: no raw daemon, installer, user-data, or command output leaves
  // the runner on failure.
  process.exitCode = 1;
  try {
    fs.mkdirSync(output, { recursive: true });
    let lastOperation = null;
    try { lastOperation = JSON.parse(fs.readFileSync(path.join(output, 'r21-observer-operation.json'), 'utf8')); } catch {}
    write('r21-failure.json', { schema: 1, status: 'blocked', category: /timeout/i.test(error.message) ? 'timeout' : 'engine-or-observer', last_operation: lastOperation });
  } finally { await io.cleanup(); }
});
