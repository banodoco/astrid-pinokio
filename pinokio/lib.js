'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const posix = require('./platforms/posix');
const windows = require('./platforms/windows');
const environmentPolicy = require('./environment');

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
    child.stdout.on('data', (chunk) => { stdout += chunk; onOutput?.(chunk); checkBuffer(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; onOutput?.(chunk); checkBuffer(); });
    if (timeout) timer = setTimeout(() => abort('ETIMEDOUT', `${command} timed out.`), timeout);
    child.once('error', (failure) => { error ??= failure; settle(null, null); });
    child.once('close', (status, signal) => settle(status, signal));
  });
}

// The factory keeps platform command generation testable without executing a
// shell, querying the real ports, or writing into a real installation.
function createApp({ platform = process.platform, appDirectory = path.resolve(__dirname, '..'),
  environment = process.env, filesystem = fs, probe = probeDoor, lifecycle, execute, spawnProcess = spawn, getTemp } = {}) {
  const isWindows = platform === 'win32';
  const paths = isWindows ? path.win32 : path.posix;
  const APP_DIR = appDirectory;
  const PROGRAMS_DIR = paths.join(APP_DIR, 'app');
  const BACKEND_ROOT = paths.join(PROGRAMS_DIR, 'astrid');
  const EDITOR_DIR = paths.join(PROGRAMS_DIR, 'editor');
  const MODE_FILE = paths.join(PROGRAMS_DIR, 'install-mode.json');
  const shellName = isWindows ? 'powershell.exe' : 'bash';
  const q = isWindows ? windows.quotePowerShell : posix.quote;
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
        `git -C ${q(APP_DIR)} pull --ff-only`,
        `if ($LASTEXITCODE -ne 0) { throw ${q(failure)} }`,
        '} catch {',
        `Write-Output ${q(failure)}`,
        'throw',
        '}',
      ].join('\n');
    }
    return `git -C ${q(APP_DIR)} pull --ff-only || { printf '%s\\n' ${q(failure)} >&2; exit 1; }`;
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
  function assertSafeRemoval(snapshot = []) {
    if (hasPendingUpdate()) throw new Error('An Astrid update is interrupted. Choose Update to recover it before removing files.');
    const readOptional = (file) => {
      try { return JSON.parse(filesystem.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const install = readOptional(paths.join(BACKEND_ROOT, 'install.json'));
    if (!install && filesystem.existsSync(BACKEND_ROOT)) throw new Error('Cannot safely remove an unowned or incomplete Astrid installation.');
    if (install && (install.owner !== 'haus.astrid.runtime' || install.managed_by !== 'pinokio')) throw new Error('Cannot safely remove an unowned Astrid installation.');
    if (install && (typeof install.data_root !== 'string' || !paths.isAbsolute(install.data_root))) {
      throw new Error('Cannot safely remove Astrid files: the data root is unavailable.');
    }
    // Resolve existing ancestors as well as existing targets, so a symlink in
    // either path cannot hide an overlap even if the leaf is missing.
    const canonical = (value) => {
      let current = paths.resolve(value), suffix = [];
      const exists = (file) => {
        if (!filesystem.lstatSync) return filesystem.existsSync(file);
        try { filesystem.lstatSync(file); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      };
      while (!exists(current)) {
        const parent = paths.dirname(current);
        if (parent === current) break;
        suffix.unshift(paths.basename(current)); current = parent;
      }
      if (filesystem.realpathSync && exists(current)) current = filesystem.realpathSync(current);
      const result = paths.resolve(current, ...suffix);
      return isWindows ? result.toLowerCase() : result;
    };
    const overlaps = (a, b) => {
      const contains = (x, y) => { const rel = paths.relative(x, y); return !rel || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel)); };
      return contains(a, b) || contains(b, a);
    };
    const removal = canonical(PROGRAMS_DIR), protectedRoots = [...snapshot];
    const protect = (value, label) => {
      if (typeof value !== 'string' || !paths.isAbsolute(value)) throw new Error(`Cannot safely remove Astrid files: the ${label} root is unavailable.`);
      const root = canonical(value);
      if (overlaps(removal, root)) throw new Error(`Cannot remove Astrid files because the program and ${label} roots overlap.`);
      protectedRoots.push(value, root);
    };
    for (const root of snapshot) protect(root, 'workspace');
    if (install) protect(install.data_root, 'data');
    const safeEnv = environmentPolicy.buildEnvironment({ appDirectory: APP_DIR, platform, environment });
    const home = isWindows ? safeEnv.USERPROFILE || os.homedir() : safeEnv.HOME || os.homedir();
    const selectionParent = isWindows ? (safeEnv.LOCALAPPDATA || paths.join(home, 'AppData', 'Local')) : paths.join(home, '.local', 'share');
    const selection = readOptional(paths.join(selectionParent, 'astrid-install.json'));
    if (selection?.data_root !== undefined) protect(selection.data_root, 'data');
    if (selection?.realm_root !== undefined) protect(selection.realm_root, 'workspace');
    if (!install) return protectedRoots;
    const catalog = readOptional(paths.join(install.data_root, 'runtime', 'catalog.json'));
    if (!catalog) {
      if (!selection?.realm_root && filesystem.existsSync(paths.join(BACKEND_ROOT, 'current')) && filesystem.existsSync(install.data_root)) {
        throw new Error('Cannot safely remove Astrid files: the selected workspace root is unavailable.');
      }
      return protectedRoots;
    }
    if (!Array.isArray(catalog.realms) || !Object.hasOwn(catalog, 'selected_realm_id')) throw new Error('Cannot safely remove Astrid files: the workspace catalog is invalid.');
    if (catalog.selected_realm_id == null) return protectedRoots;
    const selected = Array.isArray(catalog.realms) && catalog.realms.filter((row) => row?.realm_id === catalog.selected_realm_id);
    if (!selected || selected.length !== 1 || typeof selected[0].data_root !== 'string' || !paths.isAbsolute(selected[0].data_root)) {
      throw new Error('Cannot safely remove Astrid files: the selected workspace root is unavailable.');
    }
    protect(selected[0].data_root, 'workspace');
    return protectedRoots;
  }
  async function stopForRemoval(req, ondata, kernel) {
    assertSafeRemoval();
    return stopOwnedStart(req, ondata, kernel);
  }
  async function stopForUninstall(req, ondata, kernel) {
    assertSafeRemoval();
    const uri = paths.join(APP_DIR, 'pinokio', 'start.js');
    const active = !kernel.api.running || Boolean(kernel.api.running[uri]);
    if (!active && !filesystem.existsSync(paths.join(BACKEND_ROOT, 'pinokio-control.json'))) {
      try {
        const { installationFiles } = await import('./session.mjs');
        installationFiles(BACKEND_ROOT, { platform, filesystem });
      } catch (error) {
        // Only an installer-owned partial installation may delegate its stop
        // and lock checks to the independently bootstrapped installer.
        const marker = JSON.parse(filesystem.readFileSync(paths.join(BACKEND_ROOT, 'install.json'), 'utf8'));
        if (marker.owner === 'haus.astrid.runtime' && marker.managed_by === 'pinokio') return { partial: true };
        throw error;
      }
    }
    return stopOwnedStart(req, ondata, kernel);
  }
  function finishUninstall(snapshot) {
    if (filesystem.existsSync(BACKEND_ROOT)) throw new Error('Astrid could not remove all program files. Retry Uninstall to finish cleanup.');
    if (!Array.isArray(snapshot)) throw new Error('Cannot safely finish uninstall without its preflight roots.');
    assertSafeRemoval(snapshot);
    removeProgramFiles();
  }
  function hasOwnedSupervisor() {
    try {
      const record = JSON.parse(filesystem.readFileSync(paths.join(BACKEND_ROOT, 'pinokio-control.json'), 'utf8'));
      return record.schema === 1 && Number.isInteger(record.pid) && record.pid > 0
        && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535;
    } catch { return false; }
  }
  async function localSessionReady() {
    try {
      const session = await import('./session.mjs');
      const installed = session.installation(BACKEND_ROOT, { platform, filesystem, environment, appDirectory: APP_DIR });
      return await session.localSessionReady({ root: BACKEND_ROOT, editor: EDITOR_DIR, platform, installed });
    } catch { return false; }
  }
  async function backendSessionReady(doorHealth) {
    try {
      const session = await import('./session.mjs');
      const installed = session.installation(BACKEND_ROOT, { platform, filesystem, environment, appDirectory: APP_DIR });
      return await session.backendSessionReady({ root: BACKEND_ROOT, editor: EDITOR_DIR, platform, installed, doorHealth });
    } catch { return false; }
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
    if (filesystem.readdirSync && filesystem.existsSync(PROGRAMS_DIR)) {
      const unexpected = filesystem.readdirSync(PROGRAMS_DIR).filter((name) => !['astrid', 'editor', 'install-mode.json'].includes(name));
      if (unexpected.length) throw new Error('Cannot remove Astrid program files: the app directory contains unrecognized files.');
    }
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
    if (active || hasOwnedSupervisor() || filesystem.existsSync(PROGRAMS_DIR)) {
      try { await operations.preflightStop(BACKEND_ROOT, options); }
      catch (error) {
        errors.push(error);
      }
    }
    if (active || hasOwnedSupervisor()) {
      // The controller's Runtime down is still the final authority and must
      // succeed before Pinokio may close the session.
      if (errors.length === 0) try {
        const stopped = await operations.requestGracefulStop(BACKEND_ROOT, options);
        if (active && stopped?.absent) throw new Error('The active Astrid session has no responsive stop controller. Retry after restoring its controller.');
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 0 && active) {
        try { await kernel.api.stop({ params: { uri } }); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 0) {
      try { await operations.waitForInstallerLock(BACKEND_ROOT, options); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) {
      const prefix = 'Astrid is still running. Stop it in Pinokio, then try again.';
      const first = errors[0];
      const runtimeRefusal = first.details !== undefined || /^Astrid is busy \(/.test(first.message)
        || /^Runtime stop preflight/.test(first.message);
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
  async function preflightStop(_req, ondata) {
    const operations = lifecycle || await import('./lifecycle.mjs');
    try {
      const report = await operations.preflightStop(BACKEND_ROOT, {
        filesystem, platform, environment, appDirectory: APP_DIR,
      });
      return { safe: true, report };
    } catch (error) {
      ondata?.({ raw: `${error.message}${error.details === undefined ? '' : `\r\n${JSON.stringify(error.details)}`}\r\n` });
      throw error;
    }
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
    pendingUpdateTransaction, hasPendingUpdate, recoverPendingUpdate, assertSafeRemoval, stopForRemoval, stopForUninstall, finishUninstall,
    stopHook, stopOwnedStart, preflightStop, hasOwnedSupervisor, localSessionReady, backendSessionReady, ensureDoorPortFree, probeDoor: probe, modeOpenTarget, localSetOpenTarget,
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
      if (response.status === 200 && body?.status === 'ok' && body?.protocol === 'workspace.v1') return { kind: 'astrid', health: body };
    } catch { /* An open socket with no Astrid response belongs to another program. */ }
  }
  return { kind: 'occupied' };
}
module.exports = { ...createApp(), createApp, probeDoor, tcpPortOpen };
