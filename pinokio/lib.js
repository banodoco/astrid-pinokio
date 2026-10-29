'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const posix = require('./platforms/posix');
const windows = require('./platforms/windows');
const environmentPolicy = require('./environment');

// Runs an Update child without blocking Pinokio's own event loop. Each chunk is
// passed to onOutput as it arrives. The result has spawnSync's shape (status,
// signal, error, stdout, stderr), so the exit-code and error handling is unchanged.
function runStreamed(spawnChild, command, args, { onOutput, timeout, maxBuffer, ...options }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let error;
    let settled = false;
    let timer;
    const child = spawnChild(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, error, stdout, stderr });
    };
    const abort = (code, message) => {
      if (error) return;
      error = Object.assign(new Error(message), { code });
      child.kill();
    };
    const checkBuffer = () => {
      if (maxBuffer && stdout.length + stderr.length > maxBuffer) abort('ENOBUFS', `${command} wrote more output than Astrid keeps.`);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; onOutput?.(text); checkBuffer(); });
    child.stderr.on('data', (text) => { stderr += text; onOutput?.(text); checkBuffer(); });
    if (timeout) timer = setTimeout(() => abort('ETIMEDOUT', `${command} timed out.`), timeout);
    child.once('error', (failure) => { error ??= failure; settle(null, null); });
    child.once('close', (status, signal) => settle(status, signal));
  });
}

// The factory keeps platform command generation testable without executing a
// shell, querying the real ports, or writing into a real installation.
function createApp({ platform = process.platform, appDirectory = path.resolve(__dirname, '..'),
  environment = process.env, filesystem = fs, probe = probeDoor, lifecycle, execute, getTemp,
  spawnProcess = spawn, startSessionForUpdate, processAlive = (pid) => { process.kill(pid, 0); return true; },
  sessionReadyCheck, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const isWindows = platform === 'win32';
  const paths = isWindows ? path.win32 : path.posix;
  const APP_DIR = appDirectory;
  const PROGRAMS_DIR = paths.join(APP_DIR, 'app');
  const BACKEND_ROOT = paths.join(PROGRAMS_DIR, 'astrid');
  const EDITOR_DIR = paths.join(PROGRAMS_DIR, 'editor');
  const MODE_FILE = paths.join(PROGRAMS_DIR, 'install-mode.json');
  const shellName = isWindows ? 'powershell.exe' : 'bash';
  const q = isWindows ? windows.quotePowerShell : posix.quote;
  // An injected `execute` stands in for both runners. The git check stays
  // synchronous because its callers need the answer immediately; the Update
  // children run asynchronously so Pinokio's event loop keeps moving.
  const runSync = execute ?? spawnSync;
  const runUpdateChild = execute ?? ((command, args, options) => runStreamed(spawnProcess, command, args, options));

  function setting(name, fallback = '') {
    if (environment[name] !== undefined) return environment[name];
    for (const file of ['ENVIRONMENT', '_ENVIRONMENT']) {
      try {
        const lines = filesystem.readFileSync(paths.join(APP_DIR, file), 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
          if (match?.[1] === name) return match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_all, a, b) => a ?? b);
        }
      } catch { /* Either Pinokio environment file is optional. */ }
    }
    return fallback;
  }

  function launcherPullMessage() {
    const failure = CONSTANTS.LAUNCHER_PULL_FAILURE;
    if (isWindows) {
      return [
        'try {',
        `$before = git -C ${q(APP_DIR)} rev-parse HEAD`,
        `if ($LASTEXITCODE -ne 0) { throw ${q(failure)} }`,
        `git -C ${q(APP_DIR)} pull --ff-only`,
        `if ($LASTEXITCODE -ne 0) { throw ${q(failure)} }`,
        `$after = git -C ${q(APP_DIR)} rev-parse HEAD`,
        `if ($LASTEXITCODE -ne 0) { throw ${q(failure)} }`,
        `if ($before -ne $after) { Write-Output 'Astrid launcher updated. Restart Astrid when convenient.' }`,
        '} catch {',
        `Write-Output ${q(failure)}`,
        'throw',
        '}',
      ].join('\n');
    }
    const quotedApp = q(APP_DIR);
    return [
      `before=$(git -C ${quotedApp} rev-parse HEAD) || { printf '%s\\n' ${q(failure)} >&2; exit 1; }`,
      `git -C ${quotedApp} pull --ff-only || { printf '%s\\n' ${q(failure)} >&2; exit 1; }`,
      `after=$(git -C ${quotedApp} rev-parse HEAD) || { printf '%s\\n' ${q(failure)} >&2; exit 1; }`,
      `if [ "$before" != "$after" ]; then printf '%s\\n' 'Astrid launcher updated. Restart Astrid when convenient.'; fi`,
    ].join('\n');
  }

  function shellStep(message, { cwd = APP_DIR, env, on, pinokioEnvironment = false } = {}) {
    // Pinokio resolves a shell at its prompt even after a nonzero exit. Emit
    // a dedicated failure event so the next step (especially local.set/save)
    // cannot run after a failed command. Split the marker in source to avoid
    // matching the terminal's echo of the submitted command itself.
    const helper = paths.join(APP_DIR, 'pinokio', 'shell.mjs');
    const command = isWindows
      ? `node ${q(helper)} ${q(`--pinokio-payload=${Buffer.from(JSON.stringify({ appDirectory: APP_DIR, message, explicit: env || {} })).toString('base64')}`)}`
      : `node ${[helper, APP_DIR, message, JSON.stringify(env || {})].map(q).join(' ')}`;
    const wrapped = isWindows
      ? `& {\n$ErrorActionPreference = 'Stop'\ntry {\n${command}\nif ($LASTEXITCODE -ne 0) { throw 'Astrid process failed.' }\n} catch {\nWrite-Output ('ASTRID_PINOKIO_' + 'FAILURE')\nthrow\n}\n}`
      : `${command}\nstatus=$?\nif [ "$status" -ne 0 ]; then printf 'ASTRID_PINOKIO_%s\\n' FAILURE; fi\n(exit "$status")`;
    return { method: 'shell.run', params: { shell: shellName, path: cwd, message: wrapped, input: false,
      ...(pinokioEnvironment ? { env: { ASTRID_PINOKIO_ENVIRONMENT: '1' } } : {}),
      on: [{ event: '/ASTRID_PINOKIO_FAILURE/', break: true }, ...(on || [])] } };
  }

  const gitShellStep = (message) => shellStep(message, { pinokioEnvironment: true });

  function appRef() {
    const ref = setting('ASTRID_APP_REF').trim();
    if (ref && (ref.startsWith('-') || /[\s\\?#\x00-\x1f]/.test(ref) || ref.split('/').some((part) => !part || part === '..' || part === '.'))) {
      throw new Error('ASTRID_APP_REF must be a Git branch or tag, such as main.');
    }
    return ref;
  }

  function bootstrapScript(action = 'install', manifest, deleteData = false) {
    if (!['install', 'update', 'update-app', 'uninstall'].includes(action)) throw new Error('Unknown installer action.');
    if (deleteData && action !== 'uninstall') throw new Error('Data deletion requires uninstall.');
    const ref = appRef();
    const raw = ref ? `https://raw.githubusercontent.com/banodoco/astrid-app/${ref.split('/').map(encodeURIComponent).join('/')}/public` : null;
    return (isWindows ? windows : posix).bootstrap({
      root: BACKEND_ROOT, action, deleteData,
      ...(manifest ? { manifest, installerFile: paths.join(EDITOR_DIR, 'public', isWindows ? 'install.ps1' : 'install') }
        : { installerUrl: raw ? `${raw}/install${isWindows ? '.ps1' : ''}` : `https://astrid.haus/install${isWindows ? '.ps1' : ''}`,
          ...(raw ? { manifestUrl: `${raw}/install-manifest.json` } : {}) }),
    });
  }

  const customStep = (method) => ({ method });
  const ensureProgramDirectory = () => filesystem.mkdirSync(PROGRAMS_DIR, { recursive: true });
  function readInstallMode() {
    try {
      const record = JSON.parse(filesystem.readFileSync(MODE_FILE, 'utf8'));
      return record?.schema_version === 1 && ['backend', 'local'].includes(record.mode) ? record.mode : null;
    } catch { return null; }
  }
  function pendingUpdateTransaction() {
    const file = paths.join(BACKEND_ROOT, 'update-transaction.json');
    try {
      const transaction = JSON.parse(filesystem.readFileSync(file, 'utf8'));
      if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
        throw new Error('The interrupted Astrid update record is invalid.');
      }
      return transaction;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  function hasPendingUpdate() {
    const transaction = pendingUpdateTransaction();
    if (!transaction) return false;
    return transaction.step !== 'complete' && transaction.step !== 'rolled_back';
  }
  function hasPendingLocalUpdate() {
    const transaction = pendingUpdateTransaction();
    return Boolean(transaction && transaction.step !== 'complete' && transaction.step !== 'rolled_back'
      && transaction.transaction_context?.owner === 'local-update');
  }
  async function recoverPendingUpdate(_req, ondata) {
    const transaction = pendingUpdateTransaction();
    if (!transaction || transaction.step === 'complete' || transaction.step === 'rolled_back') return { recovered: false };
    const { installationFiles } = await import('./session.mjs');
    let versionOverride;
    const candidate = transaction.candidate;
    if (candidate?.root !== undefined) {
      const candidateRoot = typeof candidate.root === 'string' ? paths.resolve(candidate.root) : '';
      const versionsRoot = paths.resolve(BACKEND_ROOT, 'versions');
      const relative = candidateRoot ? paths.relative(versionsRoot, candidateRoot) : '';
      if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)
        || relative.includes(paths.sep) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(relative)) {
        throw new Error('The interrupted Astrid update candidate is outside the installed versions directory.');
      }
      versionOverride = relative;
    }
    const installed = installationFiles(BACKEND_ROOT, { platform, filesystem, ...(versionOverride ? { versionOverride } : {}) });
    if (candidate) {
      const sort = (value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
        : value;
      const record = installed.record;
      if (candidate.root !== record.root || candidate.python !== record.python || candidate.profile !== record.profile
        || JSON.stringify(sort(candidate.env)) !== JSON.stringify(sort(record.env))
        || JSON.stringify(sort(candidate.identity)) !== JSON.stringify(sort(record.identity))) {
        throw new Error('The interrupted Astrid update candidate does not match its installed version record.');
      }
    }
    let streamed = false;
    const result = await runUpdateChild(installed.python, ['-I', '-m', 'astrid', 'install', '--root', BACKEND_ROOT, '--managed-by', 'pinokio'], {
      env: environmentPolicy.buildEnvironment({ appDirectory: APP_DIR, platform, environment }),
      cwd: APP_DIR, encoding: 'utf8', timeout: 600_000, maxBuffer: 1024 * 1024, windowsHide: true,
      onOutput: (raw) => { streamed = true; ondata?.({ raw }); },
    });
    // An injected runner returns its output whole; the default one has streamed it already.
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (output && !streamed) ondata?.({ raw: output });
    if (result.error || result.status !== 0) {
      const message = output.trim() || result.error?.message || `Installer recovery failed (exit ${result.status}).`;
      const failure = new Error(message);
      if (result.error?.details !== undefined) failure.details = result.error.details;
      throw failure;
    }
    return { recovered: true };
  }
  function hasOwnedSupervisor() {
    try {
      const record = JSON.parse(filesystem.readFileSync(paths.join(BACKEND_ROOT, 'pinokio-control.json'), 'utf8'));
      if (record.schema !== 1 || !Number.isInteger(record.pid) || record.pid < 1
        || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
        || !/^[a-f0-9]{64}$/.test(record.token ?? '')) return false;
      try { return processAlive(record.pid) !== false; }
      catch (error) { return error?.code !== 'ESRCH'; }
    } catch { return false; }
  }
  async function localSessionReady() {
    if (sessionReadyCheck) return Boolean(await sessionReadyCheck());
    try {
      const session = await import('./session.mjs');
      const installed = session.installation(BACKEND_ROOT, { platform, filesystem, environment, appDirectory: APP_DIR });
      return await session.localSessionReady({ root: BACKEND_ROOT, editor: EDITOR_DIR, platform, installed });
    } catch { return false; }
  }
  async function startLocalSessionForUpdate(recoverLocalUpdate, ondata) {
    const { installation } = await import('./session.mjs');
    const installed = installation(BACKEND_ROOT, { platform, filesystem, environment, appDirectory: APP_DIR, getTemp });
    const helper = paths.join(APP_DIR, 'pinokio', 'session.mjs');
    const options = JSON.stringify({ recoverLocalUpdate });
    const child = spawnProcess(installed.node, [helper, 'serve', BACKEND_ROOT, EDITOR_DIR, 'local', options], {
      cwd: APP_DIR, env: installed.env, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true,
    });
    child.unref?.();
    // The session outlives this Update step and keeps writing while Runtime restarts.
    // Its output goes to a log file that Pinokio drains, so no Pinokio callback can
    // leave the session blocked on a full pipe.
    const log = filesystem.createWriteStream(paths.join(PROGRAMS_DIR, 'local-update-session.log'), { flags: 'w', mode: 0o600 });
    // A log that cannot be written must not stop the pipe from being drained: the
    // data listeners below keep the child's stdout and stderr flowing either way.
    log.on('error', () => {});
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    let pending = '';
    let output = '';
    let announced = false;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Astrid's fully local session did not become ready in time.")), 180_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', (error) => { log.end(); finish(error); });
      child.once('close', (code, signal) => { log.end(); finish(new Error(`Astrid's fully local session exited before READY (${signal || code}): ${output.trim()}`)); });
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString('utf8'); output = (output + text).slice(-8000); pending += text;
        if (!announced) ondata?.({ raw: text });
        if (pending.includes('ASTRID_PINOKIO_READY')) { announced = true; finish(null, true); }
        if (pending.length > 256) pending = pending.slice(-128);
      });
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8'); output = (output + text).slice(-8000);
        if (!announced) ondata?.({ raw: text });
      });
    });
    await ready;
    return { started: true, ready: true, recovering: recoverLocalUpdate };
  }
  async function ensureLocalSessionForUpdate(_req, ondata) {
    if (readInstallMode() !== 'local') throw new Error('Astrid must be installed fully local to use the Pinokio update caller.');
    const hasController = hasOwnedSupervisor();
    const recovering = hasPendingLocalUpdate();
    if (hasController && recovering) {
      // A failed local update can leave the editor stopped while its Pinokio
      // session controller remains alive and owns the C2 journal. Authenticate to
      // that controller before handing the retry to the installed updater;
      // requiring editor readiness here would prevent the updater from
      // reaching the recovery path that restores it.
      await localUpdateControl('begin');
      return { started: false, ready: true, recovering: true };
    }
    if (hasController && await localSessionReady()) return { started: false, ready: true };
    if (!hasController) await (startSessionForUpdate
      ? startSessionForUpdate({ root: BACKEND_ROOT, editor: EDITOR_DIR, recoverLocalUpdate: recovering, ondata })
      : startLocalSessionForUpdate(recovering, ondata));
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (await localSessionReady()) return { started: !hasController, ready: true, recovering };
      await pause(500);
    }
    ondata?.({ raw: "Astrid's fully local session did not become ready. Check Start, then choose Update again.\r\n" });
    throw new Error("Astrid's fully local session did not become ready. Check Start, then choose Update again.");
  }
  async function runLocalUpdate(_req, ondata) {
    if (readInstallMode() !== 'local') throw new Error('The Pinokio Update caller requires a fully local install.');
    const { installation } = await import('./session.mjs');
    const installed = installation(BACKEND_ROOT, { platform, filesystem, environment, appDirectory: APP_DIR, getTemp });
    const npmCli = platform === 'win32'
      ? paths.join(paths.dirname(installed.node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : paths.resolve(paths.dirname(installed.node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    let streamed = false;
    const result = await runUpdateChild(installed.node, [npmCli, 'run', 'update'], {
      env: installed.env, cwd: EDITOR_DIR, encoding: 'utf8', timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      onOutput: (raw) => { streamed = true; ondata?.({ raw }); },
    });
    // An injected runner returns its output whole; the default one has streamed it already.
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (output && !streamed) ondata?.({ raw: output });
    if (result.error || result.status !== 0) {
      const message = output.trim() || result.error?.message || `Astrid update failed (exit ${result.status}).`;
      throw new Error(message);
    }
    return { updated: true };
  }
  async function localUpdateControl(action, payload = {}) {
    const operations = lifecycle || await import('./lifecycle.mjs');
    return operations.requestLocalUpdate(BACKEND_ROOT, action, payload, { platform, filesystem });
  }
  function saveModeStep(mode) {
    return customStep(async () => {
      ensureProgramDirectory();
      filesystem.writeFileSync(MODE_FILE, `${JSON.stringify({ schema_version: 1, mode }, null, 2)}\n`, { mode: 0o600 });
      return { mode };
    });
  }
  function removeProgramFiles() {
    if (paths.dirname(PROGRAMS_DIR) !== APP_DIR) throw new Error('Refusing to remove files outside the Pinokio app.');
    filesystem.rmSync(PROGRAMS_DIR, { recursive: true, force: true });
  }
  function validateExistingEditorCheckout() {
    if (!filesystem.existsSync(EDITOR_DIR)) return false;
    if (!filesystem.existsSync(paths.join(EDITOR_DIR, '.git'))) throw new Error("Astrid's editor files are damaged. Choose Reset, then install again.");
    const result = runSync('git', ['-C', EDITOR_DIR, 'remote', 'get-url', 'origin'], {
      env: environment, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || result.stdout.trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase() !== EDITOR_REPOSITORY.toLowerCase()) {
      throw new Error(`Astrid's editor folder doesn't come from ${EDITOR_REPOSITORY}. Choose Reset, then install again.`);
    }
    return true;
  }
  function cloneEditorMessage() {
    return checkedNative(`git clone --branch ${q(appRef() || 'main')} --single-branch -- ${q(EDITOR_REPOSITORY)} ${q(EDITOR_DIR)}`, 'Editor clone');
  }
  function pullEditorMessage() {
    // Fail if the test ref changed since install; never silently build old pins.
    const ref = appRef() || 'main';
    const check = isWindows
      ? `$branch = (& git -C ${q(EDITOR_DIR)} branch --show-current).Trim()\nif ($LASTEXITCODE -ne 0 -or $branch -ne ${q(ref)}) { throw 'Editor branch differs from ASTRID_APP_REF. Reset and reinstall to change refs.' }`
      : `[ "$(git -C ${q(EDITOR_DIR)} branch --show-current)" = ${q(ref)} ] || { echo 'Editor branch differs from ASTRID_APP_REF. Reset and reinstall to change refs.' >&2; exit 1; }`;
    return `${isWindows ? "$ErrorActionPreference = 'Stop'" : 'set -eu'}\n${check}\n${checkedNative(`git -C ${q(EDITOR_DIR)} pull --ff-only`, 'Editor update')}`;
  }
  function checkedNative(command, label) {
    return isWindows ? `${command}\nif ($LASTEXITCODE -ne 0) { throw '${label} failed.' }` : command;
  }

  function sessionMessage(action, mode = 'local', options = {}) {
    // Resolve at shell execution time: install/update may have just changed current.
    const helper = paths.join(APP_DIR, 'pinokio', action === 'stop' ? 'lifecycle.mjs' : 'session.mjs');
    const sessionArgs = action === 'stop' ? [helper, action, BACKEND_ROOT]
      : [helper, action, BACKEND_ROOT, EDITOR_DIR, mode, ...(Object.keys(options).length ? [JSON.stringify(options)] : [])];
    const args = sessionArgs.map(q).join(' ');
    if (isWindows) return [
      "$ErrorActionPreference = 'Stop'",
      `$version = (Get-Content -Raw -LiteralPath ${q(paths.join(BACKEND_ROOT, 'current'))}).Trim()`,
      "if ($version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Invalid Astrid version pointer.' }",
      `$versionRoot = Join-Path ${q(paths.join(BACKEND_ROOT, 'versions'))} $version`,
      "$record = Get-Content -Raw -LiteralPath (Join-Path $versionRoot 'version.json') | ConvertFrom-Json",
      '$node = [IO.Path]::GetFullPath([string]$record.env.ASTRID_NODE_EXECUTABLE)',
      '$prefix = [IO.Path]::GetFullPath($versionRoot) + [IO.Path]::DirectorySeparatorChar',
      "if (-not $node.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Pinned Node is outside the installed version.' }",
      `& $node ${args}`,
      "if ($LASTEXITCODE -ne 0) { throw 'Astrid process failed.' }",
    ].join('\n');
    return [
      'set -eu',
      `version=$(cat ${q(paths.join(BACKEND_ROOT, 'current'))})`,
      `case "$version" in ''|*[!A-Za-z0-9._-]*) echo 'Invalid Astrid version pointer.' >&2; exit 2 ;; esac`,
      `version_root=${q(paths.join(BACKEND_ROOT, 'versions'))}/"$version"`,
      `node=$("$version_root/py/bin/python" -I -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["env"]["ASTRID_NODE_EXECUTABLE"])' "$version_root/version.json")`,
      'case "$node" in "$version_root"/*) ;; *) echo "Pinned Node is outside the installed version." >&2; exit 2 ;; esac',
      `exec "$node" ${args}`,
    ].join('\n');
  }
  function sessionStep(action, mode, options = {}) {
    return shellStep(sessionMessage(action, mode, options), { env: { ASTRID_INSTALL_MANAGED_BY: 'pinokio' },
      ...(action === 'serve' ? { on: [{ event: '/ASTRID_PINOKIO_READY/', done: true }] } : {}) });
  }
  function stopHook() {
    // A URI on.stop is only queued by api.process. A direct shell.run is awaited.
    return shellStep(sessionMessage('stop'));
  }
  async function stopOwnedStart(_req, ondata, kernel) {
    const uri = paths.join(APP_DIR, 'pinokio', 'start.js');
    const active = !kernel.api.running || Boolean(kernel.api.running[uri]);
    const operations = lifecycle || await import('./lifecycle.mjs');
    const options = { filesystem, platform, environment, appDirectory: APP_DIR };
    const errors = [];
    try {
      let controllerStopped = false;
      if (active || hasOwnedSupervisor()) {
        const stopped = await operations.requestGracefulStop(BACKEND_ROOT, options);
        if (active && stopped?.absent) throw new Error('The active Astrid session has no responsive stop controller. Retry after restoring its controller.');
        controllerStopped = !stopped?.absent;
      }
      // A dead/missing controller cannot vouch for durable Runtime work. Use
      // the selected installed Runtime before allowing maintenance or lock admission.
      if (!controllerStopped && filesystem.existsSync(PROGRAMS_DIR)) {
        await operations.stopRuntime(BACKEND_ROOT, options);
      }
      if (active) await kernel.api.stop({ params: { uri } });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try { await operations.waitForInstallerLock(BACKEND_ROOT, options); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) {
      const prefix = 'Astrid is still running. Stop it in Pinokio, then try again.';
      const first = errors[0];
      const runtimeRefusal = first.details !== undefined;
      const format = (error) => `${error.message}${error.details === undefined ? '' : `\n${JSON.stringify(error.details)}`}`;
      const message = runtimeRefusal ? format(first)
        : `${prefix}${errors.map(format).filter((value) => !value.includes(prefix)).join(' ') ? ` ${errors.map(format).filter((value) => !value.includes(prefix)).join(' ')}` : ''}`;
      ondata?.({ raw: `${message}\r\n` });
      const refusal = new Error(message);
      if (first.details !== undefined) refusal.details = first.details;
      throw refusal;
    }
    ondata?.({ raw: 'Astrid stopped.\r\n' });
    return { stopped: active, lockFree: true };
  }
  async function ensureDoorPortFree(_req, ondata) {
    const result = await probe();
    if (result.kind === 'free') return { free: true };
    const message = result.kind === 'astrid'
      ? 'Astrid is already running on this computer. Stop it, then try again.'
      : "Another program is using port 17340, so Astrid can't start. Close it, then try again.";
    ondata?.({ raw: message });
    throw new Error(message);
  }
  return { APP_DIR, PROGRAMS_DIR, BACKEND_ROOT, EDITOR_DIR, MODE_FILE, isWindows, shellName, paths,
    getPaths: () => ({ root: BACKEND_ROOT, editor: EDITOR_DIR }), setting, appRef, bootstrapScript,
    shellStep, gitShellStep, launcherPullMessage, customStep, ensureProgramDirectory, readInstallMode, saveModeStep, removeProgramFiles,
    validateExistingEditorCheckout, cloneEditorMessage, pullEditorMessage, sessionMessage, sessionStep,
    pendingUpdateTransaction, hasPendingUpdate, hasPendingLocalUpdate, recoverPendingUpdate,
    stopHook, stopOwnedStart, hasOwnedSupervisor, localSessionReady, ensureLocalSessionForUpdate, runLocalUpdate, localUpdateControl, ensureDoorPortFree, probeDoor: probe, modeOpenTarget, localSetOpenTarget,
    runScript: (root, args) => (isWindows ? windows : posix).run(root, args),
    ...CONSTANTS };
}

const EDITOR_REPOSITORY = 'https://github.com/banodoco/astrid-app';
const DOOR_HEALTH_URL = 'http://127.0.0.1:17340/api/runtime/v1/health';
const HOSTED_OPEN_URL = 'https://astrid.haus/?connect=1';
const LOCAL_OPEN_URL = 'http://127.0.0.1:5180/tools/video-editor?connect=1';
const CONSTANTS = { EDITOR_REPOSITORY, DOOR_HEALTH_URL, HOSTED_OPEN_URL, LOCAL_OPEN_URL,
  LAUNCHER_PULL_FAILURE: "Couldn't update the Pinokio launcher. If you edited its files, undo those edits, then choose Update again." };
function modeOpenTarget(mode) {
  return { href: mode === 'local' ? LOCAL_OPEN_URL : HOSTED_OPEN_URL, popout: mode !== 'local' };
}
const localSetOpenTarget = (mode) => ({ url: modeOpenTarget(mode).href, mode });
function tcpPortOpen(port, { connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(800, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function probeDoor({ portOpen = tcpPortOpen, request = fetch } = {}) {
  if (!(await portOpen(17340))) return { kind: 'free' };
  for (const origin of ['https://astrid.haus', 'http://127.0.0.1:5180', null]) {
    try {
      const response = await request(DOOR_HEALTH_URL, { headers: { Accept: 'application/json', ...(origin ? { Origin: origin } : {}) }, signal: AbortSignal.timeout(1500) });
      const body = await response.json().catch(() => null);
      if ((response.status === 200 && body?.protocol === 'workspace.v1')
        || (response.status === 503 && ['runtime_unavailable', 'runtime_identity_mismatch'].includes(body?.error))
        || (response.status === 403 && body?.error === 'hosted_origin_required')) return { kind: 'astrid' };
    } catch { /* An open socket with no Astrid response belongs to another program. */ }
  }
  return { kind: 'occupied' };
}
module.exports = { ...createApp(), createApp, probeDoor, tcpPortOpen };
