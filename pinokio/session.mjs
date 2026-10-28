// One foreground shell owns the Runtime and (when selected) the editor. Build
// uses the same owner temporarily and always releases it in finally.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import app from './lib.js';
import policy from './environment.js';
import { bounded, createController, DOWN_MS, runCommand } from './lifecycle.mjs';

export function installationFiles(root, { platform = process.platform, filesystem = fs, versionOverride } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const read = (file) => JSON.parse(filesystem.readFileSync(file, 'utf8'));
  const version = versionOverride ?? filesystem.readFileSync(p.join(root, 'current'), 'utf8').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error('Invalid Astrid version pointer.');
  const versionRoot = p.join(root, 'versions', version);
  const record = read(p.join(versionRoot, 'version.json'));
  const install = read(p.join(root, 'install.json'));
  if (install.owner !== 'haus.astrid.runtime' || install.managed_by !== 'pinokio') throw new Error("This copy of Astrid wasn't installed with Pinokio.");
  for (const value of [record.root, record.python, record.profile, record.env?.ASTRID_NODE_EXECUTABLE, install.data_root]) {
    if (typeof value !== 'string' || !p.isAbsolute(value)) throw new Error('Incomplete Astrid installation record.');
  }
  if (p.resolve(record.root) !== p.resolve(versionRoot)) throw new Error('Astrid version points outside the program root.');
  const node = record.env.ASTRID_NODE_EXECUTABLE;
  const relative = p.relative(versionRoot, node);
  if (!relative || relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) throw new Error('Pinned Node is outside the installed version.');
  const npm = platform === 'win32'
    ? p.join(p.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : p.resolve(p.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npx = p.join(p.dirname(npm), 'npx-cli.js');
  for (const file of [node, npm, npx, record.python, record.profile]) {
    if (!filesystem.existsSync(file)) throw new Error(`Astrid installed file is missing: ${file}`);
  }
  return { node, npm, npx, python: record.python, profile: record.profile, data: install.data_root, env: record.env, record };
}

export function installation(root, { platform = process.platform, filesystem = fs, environment = process.env,
  appDirectory, getTemp } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const installed = installationFiles(root, { platform, filesystem });
  const { node, npm } = installed;
  const env = policy.buildEnvironment({ appDirectory: appDirectory || p.resolve(root, '..', '..'),
    platform, environment, getTemp, recordEnv: { ...installed.env,
    ASTRID_INSTALL_MANAGED_BY: 'pinokio', ASTRID_RUNTIME_DOOR_PORT: '17340',
    ASTRID_RUNTIME_DATA_ROOT: installed.data, ASTRID_SUPPORT_ROOT: installed.data,
    ASTRID_WORKSPACE_DISCOVERY: p.join(installed.data, 'runtime', 'discovery.json'),
    ASTRID_RUNTIME_PYTHON: installed.python, ASTRID_RUNTIME_SOURCE_MANIFEST: installed.profile,
    // These are explicitly empty so .env.local cannot restore a checkout.
    ASTRID_RUNTIME_CHECKOUT: '', ASTRID_CHECKOUT: '', ASTRID_PUBLIC_CHECKOUT: '',
    ASTRID_START_COMMAND: p.join(root, platform === 'win32' ? 'run.cmd' : 'run'),
    npm_execpath: npm, npm_node_execpath: node,
    PORT: '5180', VITE_ASTRID_DYNAMIC_PROXY_PORT: '17336',
  } });
  const recordedPath = Object.entries(installed.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  if (env.ASTRID_RUNTIME_DATA_ROOT !== installed.data || (recordedPath !== undefined && env.PATH !== recordedPath)
    || Object.keys(installed.env).some((key) => key.toUpperCase() !== 'PATH' && !(key in env))) {
    throw new Error("Astrid's installed environment points into Pinokio's home. Choose Reset, then Install again.");
  }
  const pathKey = platform === 'win32' ? Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path' : 'PATH';
  const previousPath = env[pathKey] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[pathKey] = `${p.dirname(node)}${platform === 'win32' ? ';' : ':'}${previousPath}`;
  return { ...installed, env };
}

export function commands(root, editor, mode, installed, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const off = mode === 'local';
  const runtimeArgs = off ? ['--hosted-origin', 'off'] : [];
  let runtime;
  if (platform === 'win32') {
    const entry = p.join(root, 'run.cmd');
    if (/[\r\n"%]/.test(entry)) throw new Error('The Windows install path cannot contain quotes, % or newlines.');
    runtime = { command: environmentCmd(installed.env), args: ['/d', '/s', '/c', `""${entry}"${runtimeArgs.length ? ` ${runtimeArgs.join(' ')}` : ''}"`], windowsVerbatimArguments: true };
  } else runtime = { command: p.join(root, 'run'), args: runtimeArgs };
  return {
    runtime,
    down: { command: installed.python, args: ['-I', '-m', 'astrid_runtime', 'down', '--profile', 'astrid', '--data-root', installed.data, '--source-manifest', installed.profile, '--json'] },
    status: { command: installed.python, args: ['-I', '-m', 'astrid_runtime', 'status', '--data-root', installed.data, '--json'] },
    dependencies: { command: installed.node, args: [installed.npx, '-y', 'npm@11', 'ci', '--no-audit', '--no-fund'] },
    build: { command: installed.node, args: ['scripts/dev-local-workspace.mjs', '--build'] },
    preview: { command: installed.node, args: ['scripts/dev-local-workspace.mjs', '--preview', '--preview-dir', p.join(editor, 'dist')] },
  };
}
const environmentCmd = (env) => env.ComSpec || env.COMSPEC || path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe');

export function runtimeStatusHealthy(status) {
  return status?.support?.healthy === true && !status.stale_discovery && status.health?.status === 'ok'
    && Boolean(status.discovery?.active_realm) && Boolean(status.discovery?.runtime_instance_id)
    && status.health?.runtime_instance_id === status.discovery.runtime_instance_id;
}

export async function localPreviewReady(discovery, { request = fetch } = {}) {
  try {
    const response = await request('http://127.0.0.1:5180/tools/video-editor', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const config = await request('http://127.0.0.1:5180/runtime-config/v1/workspace.json', { signal: AbortSignal.timeout(2500) });
    const binding = await config.json();
    return config.ok && binding.schemaVersion === 1 && Boolean(discovery?.runtime_instance_id)
      && Boolean(discovery?.active_realm)
      && binding.runtimeInstanceId === discovery.runtime_instance_id && binding.realmId === discovery.active_realm;
  } catch { return false; }
}

export async function localSessionReady({ root, editor, platform = process.platform,
  installed = installation(root, { platform }), request = fetch, run = runCommand } = {}) {
  try {
    const statusOutput = await run(commands(root, editor, 'local', installed, platform).status,
      { env: installed.env, cwd: root, timeoutMs: 5000 });
    const status = JSON.parse(statusOutput);
    if (!runtimeStatusHealthy(status)) return false;
    return localPreviewReady(status.discovery, { request });
  } catch { return false; }
}

export function parseSessionOptions(argument = '{}') {
  let options;
  try { options = JSON.parse(argument); }
  catch { throw new Error('Invalid session options.'); }
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !['prepareEditor', 'recoverLocalUpdate'].includes(key))
    || (Object.hasOwn(options, 'prepareEditor') && typeof options.prepareEditor !== 'boolean')
    || (Object.hasOwn(options, 'recoverLocalUpdate') && typeof options.recoverLocalUpdate !== 'boolean')) {
    throw new Error('Invalid session options.');
  }
  return { prepareEditor: options.prepareEditor ?? false, recoverLocalUpdate: options.recoverLocalUpdate ?? false };
}

// On macOS a disappearing/zombie-only process group can report EPERM rather
// than ESRCH. Ignore that only after ps confirms no live group members remain.
export function signalGroup(pid, signal, { killProcess = process.kill.bind(process),
  snapshot = () => spawnSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' }) } = {}) {
  try { killProcess(-pid, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'EPERM') {
      const result = snapshot();
      if (result.status === 0 && !result.stdout.trim().split('\n').some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && state && !state.startsWith('Z');
      })) return;
    }
    throw error;
  }
}

export async function runSession({ action, root, editor, mode, platform = process.platform,
  installed: initialInstalled = installation(root), resolveInstallation = () => installation(root, { platform, filesystem, environment: process.env }),
  spawnProcess = spawn, request = fetch,
  filesystem = fs,
  portOpen = app.tcpPortOpen, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  killProcess = process.kill.bind(process), signals = process, output = console.log,
  startupDeadlineMs = 180_000, openController = createController, gracefulDown = runCommand,
  limit = bounded, prepareEditor = false, recoverLocalUpdate = false } = {}) {
  if (!['serve', 'build'].includes(action) || !['backend', 'local'].includes(mode)) throw new Error('Invalid Astrid session arguments.');
  if (prepareEditor && (action !== 'serve' || mode !== 'local')) throw new Error('Editor preparation requires a local serve session.');
  if (recoverLocalUpdate && (action !== 'serve' || mode !== 'local')) throw new Error('Local update recovery requires a local serve session.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let installed = initialInstalled;
  let specs = commands(root, editor, mode, installed, platform);
  let env = { ...installed.env };
  delete env.ASTRID_INSTALLER_OPERATION_ID;
  if (mode === 'local') env.ASTRID_APP_LOOPBACK_ORIGIN = 'off';
  else delete env.ASTRID_APP_LOOPBACK_ORIGIN;
  const children = [];
  let stopping = false;
  let updateInProgress = recoverLocalUpdate;
  let downInProgress = false;
  let runtimeDown = false;
  let discovery;
  let runtimeItem;
  let controller;
  let stopComplete = false;
  let shutdownPromise;
  let stopRequestPromise;
  let stopRequested = false;
  let serveInterruptedByStop = false;
  let finishStop;
  const stopFinished = new Promise((resolve) => { finishStop = resolve; });
  let failure;
  let runtimeExitFailure;
  let wakeFailure;
  const failed = new Promise((_, reject) => { wakeFailure = reject; });
  failed.catch(() => {});
  const fail = (error) => { failure ??= error; wakeFailure(failure); };

  function launch(spec, { cwd = root, capture = false, persistent = false, childEnv = env } = {}) {
    if (stopping) throw new Error('Astrid start cancelled.');
    const child = spawnProcess(spec.command, spec.args, { cwd, env: childEnv, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: platform !== 'win32', ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    const item = { child, done: null, closed: false, released: false, stdout: '' };
    children.push(item);
    if (capture) { child.stdout?.on('data', (chunk) => { item.stdout += chunk; }); child.stderr?.on('data', () => {}); }
    item.done = new Promise((resolve, reject) => {
      child.once('error', (error) => { item.closed = true; reject(error); if (persistent) fail(error); });
      child.once('close', (code, signal) => {
        item.closed = true;
        item.exitCode = code;
        item.exitSignal = signal;
        if (persistent && !stopping && !updateInProgress && !(item === runtimeItem && downInProgress)) {
          const error = new Error(`Astrid quit unexpectedly (${signal || code}).`);
          if (item === runtimeItem) runtimeExitFailure = error;
          fail(error);
        }
        resolve(code);
      });
    });
    item.done.catch(() => {});
    return item;
  }
  const checked = async (spec, options) => {
    const item = launch(spec, options);
    const code = await Promise.race([item.done, failed]);
    await terminate(item);
    if (code !== 0) throw new Error(`Astrid command failed (exit ${code}): ${path.basename(spec.command)}`);
    return item;
  };
  async function runtimeHealthy(childEnv = env) {
    const item = launch(specs.status, { capture: true, childEnv });
    const code = await Promise.race([item.done, failed]);
    await terminate(item);
    if (code !== 0) return false;
    try {
      const status = JSON.parse(item.stdout);
      const healthy = runtimeStatusHealthy(status);
      if (healthy) discovery = status.discovery;
      return healthy;
    } catch { return false; }
  }
  async function waitUntil(check, description) {
    const deadline = Date.now() + startupDeadlineMs;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (await Promise.race([check(), failed])) return;
      await Promise.race([pause(500), failed]);
    }
    throw new Error(`${description} didn't start in time. Check the messages above, then try again.`);
  }
  async function terminate(item) {
    if (item.released || !item.child.pid) return;
    if (item.closed && platform === 'win32') { item.released = true; return; }
    if (platform === 'win32') {
      const killer = spawnProcess(path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(item.child.pid), '/T', '/F'], { env, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { killer.once('error', reject); killer.once('close', (code) => code === 0 || item.closed ? resolve() : reject(new Error(`Could not stop Astrid process tree ${item.child.pid}.`))); });
    } else {
      if (!item.closed) signalGroup(item.child.pid, 'SIGTERM', { killProcess });
      let rejectEscalation;
      const escalation = new Promise((_, reject) => { rejectEscalation = reject; });
      const timer = setTimeout(() => {
        try { signalGroup(item.child.pid, 'SIGKILL', { killProcess }); } catch (error) { rejectEscalation(error); }
      }, 5000);
      try { await Promise.race([item.done, escalation]); } finally { clearTimeout(timer); }
      // A group can outlive its leader (for example an npm child after a failed
      // build). Drain it even when the direct child has already closed.
      signalGroup(item.child.pid, 'SIGKILL', { killProcess });
    }
    await item.done;
    item.released = true;
  }
  // c1Stopped is the updater's report (data, not a command) that Backend C1
  // completed this Runtime's stop. Only that exact report replaces this
  // session's own Runtime down; without it, nothing is cleaned up until down
  // succeeds. The session observes, but never signals, the Runtime child.
  async function shutdown({ c1Stopped = false } = {}) {
    if (stopComplete) return { ok: true, errors: [] };
    // Join any pending attempt; if it refused and this caller carries the
    // report, loop to a fresh attempt (independent of microtask order).
    while (shutdownPromise) {
      const prior = await shutdownPromise;
      if (prior.ok || !c1Stopped) return prior;
      if (stopComplete) return { ok: true, errors: [] };
    }
    shutdownPromise = (async () => {
      const errors = [];
      // Even an exited child can leave durable busy work or a replacement
      // publication. Only C1's reported stop or a successful Runtime down
      // can admit editor/controller cleanup.
      if (runtimeItem && !runtimeDown && c1Stopped) {
        try {
          downInProgress = true;
          if (!runtimeItem.closed) await limit(runtimeItem.done, 5000, 'Runtime exit after C1 stop');
          runtimeDown = true;
        } catch (error) {
          downInProgress = false;
          return { ok: false, errors: [error.message] };
        }
      }
      if (runtimeItem && !runtimeDown) {
        try {
          downInProgress = true;
          await gracefulDown(specs.down, { env, cwd: root, timeoutMs: DOWN_MS });
          if (!runtimeItem.closed) await limit(runtimeItem.done, 5000, 'Runtime exit after down');
          runtimeDown = true;
        } catch (error) {
          downInProgress = false;
          return { ok: false, errors: [error.message], ...(error.details !== undefined ? { details: error.details } : {}) };
        }
      }

      // No process, controller or lock cleanup begins until the final Runtime
      // down has succeeded. A refusal leaves this function callable for retry.
      stopping = true;
      for (const item of [...children].reverse().filter((owned) => owned !== runtimeItem && !owned.released)) {
        try { await limit(terminate(item), 8000, 'Editor/command stop'); }
        catch (error) { errors.push(error.message); }
      }
      if (errors.length === 0) {
        stopComplete = true;
        finishStop();
      }
      return { ok: errors.length === 0, errors };
    })();
    try { return await shutdownPromise; }
    finally { if (!stopComplete) shutdownPromise = undefined; }
  }
  const requestStop = ({ c1Stopped = false } = {}) => {
    if (stopRequestPromise && !c1Stopped) return stopRequestPromise;
    stopRequested = true;
    const attempt = shutdown({ c1Stopped: c1Stopped === true }).then((result) => {
      if (result.ok) fail(new Error('Astrid session stopped.'));
      else if (stopRequestPromise === attempt) { stopRequested = false; stopRequestPromise = undefined; }
      return result;
    });
    stopRequestPromise = attempt;
    return attempt;
  };
  const onSignal = () => {
    if (updateInProgress) { output('Astrid is updating. Wait for the update to finish before stopping it.'); return; }
    stopRequested = true;
    shutdown().then((result) => {
      if (result.ok) fail(new Error('Astrid session stopped.'));
      else { stopRequested = false; output(result.errors.join(' ')); }
    }).catch((error) => output(error.message));
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) signals.on(signal, onSignal);
  try {
    // Never attach the editor to someone else's same-data-root Runtime.
    if (!recoverLocalUpdate && await runtimeHealthy()) throw new Error('Another Astrid is already running with your projects. Stop it, then try again.');
    if (mode === 'local' && action === 'serve' && await portOpen(5180)) throw new Error("Another program is using port 5180, so Astrid's editor can't start. Close it, then try again.");
    const localUpdate = {
      isUpdating: () => updateInProgress,
      begin: async () => {
        if (mode !== 'local' || action !== 'serve') throw new Error('Pinokio local updates require a running fully local session.');
        // The App updater serializes transactions. Begin is only a maintenance
        // flag, so it must also be safe when rollback repeats it before the
        // first candidate Runtime has started.
        updateInProgress = true;
        return { updating: true };
      },
      runtime: async ({ version } = {}) => {
        if (!updateInProgress) throw new Error('Begin the Pinokio update before starting its Runtime.');
        if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
          throw new Error('Invalid Pinokio Runtime update request.');
        }
        const selected = filesystem.readFileSync(paths.join(root, 'current'), 'utf8').trim();
        if (selected !== version) throw new Error('The selected Pinokio Runtime version changed before it could start.');
        if (runtimeItem && !runtimeItem.closed) await limit(runtimeItem.done, 5000, 'Previous Astrid Runtime exit');
        if (runtimeItem && !runtimeItem.closed) throw new Error('The previous Astrid Runtime has not stopped yet.');
        const selectedInstalled = await resolveInstallation(version);
        const expectedRoot = paths.resolve(paths.join(root, 'versions', version));
        if (!selectedInstalled?.record || paths.resolve(selectedInstalled.record.root) !== expectedRoot) {
          throw new Error('The selected Pinokio Runtime record does not match its current version pointer.');
        }
        installed = selectedInstalled;
        specs = commands(root, editor, mode, installed, platform);
        env = { ...installed.env };
        delete env.ASTRID_INSTALLER_OPERATION_ID;
        if (mode === 'local') env.ASTRID_APP_LOOPBACK_ORIGIN = 'off';
        discovery = undefined;
        runtimeDown = false;
        runtimeItem = launch(specs.runtime, { persistent: true, childEnv: env });
        await waitUntil(() => runtimeHealthy(env), 'Astrid Runtime');
        return { version, ready: true };
      },
      end: async () => {
        if (!updateInProgress) return { updating: false };
        if (recoverLocalUpdate && !runtimeItem) {
          const journalPath = paths.join(root, 'update-transaction.json');
          const readTerminalJournal = () => {
            const journal = JSON.parse(filesystem.readFileSync(journalPath, 'utf8'));
            if (!journal || journal.transaction_context?.owner !== 'local-update'
              || !['complete', 'rolled_back'].includes(journal.step)) {
              throw new Error('Local update recovery has not reached a terminal journal state; keep recovery active and retry.');
            }
            return journal;
          };
          readTerminalJournal();
          const selected = filesystem.readFileSync(paths.join(root, 'current'), 'utf8').trim();
          if (typeof selected !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selected)) {
            throw new Error('The selected Pinokio Runtime version is not stable after recovery.');
          }
          const selectedInstalled = await resolveInstallation(selected);
          const expectedRoot = paths.resolve(paths.join(root, 'versions', selected));
          if (!selectedInstalled?.record || paths.resolve(selectedInstalled.record.root) !== expectedRoot) {
            throw new Error('The selected Pinokio Runtime version does not match its installed record after recovery.');
          }
          if (filesystem.readFileSync(paths.join(root, 'current'), 'utf8').trim() !== selected) {
            throw new Error('The selected Pinokio Runtime version changed during recovery.');
          }
          readTerminalJournal();
          installed = selectedInstalled;
          specs = commands(root, editor, mode, installed, platform);
          env = { ...installed.env };
          delete env.ASTRID_INSTALLER_OPERATION_ID;
          if (mode === 'local') env.ASTRID_APP_LOOPBACK_ORIGIN = 'off';
          discovery = undefined;
          if (await runtimeHealthy(env)) {
            throw new Error('A Runtime is already healthy outside this Pinokio session. Stop that Runtime, then retry local recovery.');
          }
          runtimeDown = false;
          runtimeItem = launch(specs.runtime, { persistent: true, childEnv: env });
          await waitUntil(() => runtimeHealthy(env), 'Astrid Runtime after local update recovery');
        }
        if (!(await runtimeHealthy(env))) {
          throw new Error('The Astrid Runtime is not ready; update monitoring remains active for recovery.');
        }
        updateInProgress = false;
        return { updating: false, ready: true };
      },
    };
    controller = await openController(root, requestStop, { localUpdate });
    if (action === 'build') await checked(specs.dependencies, { cwd: editor });
    if (!recoverLocalUpdate) {
      discovery = undefined;
      runtimeItem = launch(specs.runtime, { persistent: true });
      await waitUntil(runtimeHealthy, 'Astrid');
    }
    if (action === 'build') {
      await checked(specs.build, { cwd: editor });
    } else {
      if (prepareEditor) {
        await checked(specs.dependencies, { cwd: editor });
        await checked(specs.build, { cwd: editor });
      }
      if (mode === 'local') launch(specs.preview, { cwd: editor, persistent: true });
      const url = mode === 'local' ? 'http://127.0.0.1:5180/tools/video-editor' : app.DOOR_HEALTH_URL;
      await waitUntil(async () => {
        if (mode === 'local') return localPreviewReady(discovery, { request });
        try {
          const response = await request(url, { signal: AbortSignal.timeout(2500), headers: mode === 'backend' ? { Origin: 'https://astrid.haus' } : {} });
          const body = await response.json();
          return response.status === 200 && body.status === 'ok' && body.protocol === 'workspace.v1';
        } catch { return false; }
      }, mode === 'local' ? "Astrid's editor" : 'Astrid');
      if (failure) throw failure;
      output('ASTRID_PINOKIO_READY');
      await failed;
    }
  } catch (error) {
    const orderlyRuntimeExit = error === runtimeExitFailure && runtimeItem?.closed
      && runtimeItem.exitCode === 0 && !runtimeItem.exitSignal;
    // Cleanup completion does not prove that ci or the build completed. Only
    // serve sessions may finish successfully after a controlled/orderly stop.
    if (action === 'build' || (!stopComplete && !orderlyRuntimeExit)) {
      serveInterruptedByStop = action === 'serve' && stopRequested;
      throw error;
    }
  } finally {
    let result = await shutdown();
    if (!result.ok && controller) {
      // A build/startup failure can reach finally while work is still busy.
      // Keep this session waiting for a successful controller/signal retry;
      // returning here would orphan a live controller with no finalizer.
      output(result.errors.join(' '));
      await stopFinished;
      result = { ok: true };
    }
    if (result.ok) {
      await controller?.close();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) signals.removeListener(signal, onSignal);
      // Serve may be stopped during startup; build cancellation must still
      // reject after all owned children and the controller have drained.
      if (serveInterruptedByStop && stopRequested && stopComplete) return;
    } else if (runtimeItem?.closed && runtimeItem.exitCode === 0 && !runtimeItem.exitSignal) {
      throw new Error(result.errors.join(' '));
    } else if (!failure) throw new Error(result.errors.join(' '));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, root, editor, mode, options = '{}'] = process.argv.slice(2);
  let parsed;
  try { parsed = parseSessionOptions(options); }
  catch {
    console.error('Astrid: Invalid session options.'); process.exitCode = 1;
  }
    if (parsed) runSession({ action, root, editor, mode, prepareEditor: parsed.prepareEditor,
      recoverLocalUpdate: parsed.recoverLocalUpdate })
    .catch((error) => { console.error(`Astrid: ${error.message}`); process.exitCode = 1; });
}
