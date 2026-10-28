import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import library from '../pinokio/lib.js';
import { bounded, createController, CONTROL_FILE, requestLocalUpdate } from '../pinokio/lifecycle.mjs';
import { commands, installation, localSessionReady, parseSessionOptions, runSession, signalGroup } from '../pinokio/session.mjs';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, '..');
function load(file, app) {
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: (name) => name === './lib' || name === './pinokio/lib' ? app : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(repository, file), 'utf8'), context, { filename: file });
  return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function shellMessage(step, platform) {
  if (platform !== 'win32') return step.params.message;
  const payload = step.params.message.match(/--pinokio-payload=([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(payload, 'Windows shell step must carry its encoded Pinokio payload');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).message;
}
function fakeApp(platform, ref = '', mode = 'backend') {
  const base = platform === 'win32'
    ? "C:\\Users\\Test Home\\pinokio\\api\\Astrid O'Malley"
    : "/Users/testhome/pinokio/api/Astrid O'Malley";
  const writes = [];
  const filesystem = {
    readFileSync(file) {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode });
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    existsSync: () => false, mkdirSync() {}, writeFileSync(file, content) { writes.push({ file, content }); }, rmSync() {},
  };
  return { ...library.createApp({ platform, appDirectory: base, environment: { ASTRID_APP_REF: ref }, filesystem, lifecycle: { requestGracefulStop: async () => {}, waitForInstallerLock: async () => {} }, probe: async () => ({ kind: 'free' }) }),
    validateExistingEditorCheckout: () => true, writes };
}
const scripts = ['install', 'install-local', 'add-local', 'update', 'start', 'stop', 'reset', 'uninstall', 'uninstall-delete-data'];
const fixtures = JSON.parse(fs.readFileSync(new URL('./commands.json', import.meta.url), 'utf8'));

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const ref of ['', 'feat/pinokio']) {
    for (const mode of ['backend', 'local']) {
      test(`${platform} ${mode} ${ref || 'production'}: every script and exact shell commands`, async () => {
        const app = fakeApp(platform, ref, mode);
        const expected = fixtures[`${platform}:${ref}`];
        const fullLocal = [expected.pull, expected.localInstall, expected.build];
        const map = {
          install: [expected.install], 'install-local': fullLocal,
          'add-local': [expected.pull, expected.localUpdate, expected.build],
          update: [expected.launcherPull,
            ...(mode === 'backend' ? [expected.install] : [])],
          start: [expected[mode]], stop: [], reset: [], uninstall: [expected.uninstall],
          'uninstall-delete-data': [expected.delete],
        };
        for (const name of scripts) {
          const module = load(`pinokio/${name}.js`, app);
          if (name === 'add-local' && mode === 'local') {
            await assert.rejects(module({}, {}), /already fully local/);
            continue;
          }
          const script = typeof module === 'function' ? await module({}, {}) : module;
          const shells = script.run.filter((step) => step.method === 'shell.run');
          assert.deepEqual(plain(shells.map((step) => step.params.message)), map[name], name);
          for (const step of shells) assert.equal(step.params.shell, platform === 'win32' ? 'powershell.exe' : 'bash');
          if (['install-local', 'add-local', 'uninstall', 'reset', 'stop'].includes(name)) assert.equal(script.run[0].method, app.stopOwnedStart);
          if (name === 'add-local') assert.equal(script.run[4].method, app.stopOwnedStart);
          if (name === 'start') {
            assert.equal(script.daemon, true);
            assert.deepEqual(plain(script.on.stop), plain(app.stopHook()));
            assert.equal(script.on.stop.method, 'shell.run');
            assert.equal(script.on.stop.params.message, expected.stopHook);
            assert.equal(script.on.stop.uri, undefined);
            assert.equal(script.run[0].method, app.ensureDoorPortFree);
            assert.deepEqual(plain(script.run[1].params.on), [{ event: '/ASTRID_PINOKIO_FAILURE/', break: true }, { event: '/ASTRID_PINOKIO_READY/', done: true }]);
            assert.deepEqual(plain(script.run.at(-1)), { method: 'local.set', params: app.localSetOpenTarget(mode) });
          }
          if (name === 'update') {
            if (mode === 'local') {
              assert.equal(script.run.at(-2).method, app.ensureLocalSessionForUpdate);
              assert.equal(script.run.at(-1).method, app.runLocalUpdate);
              assert.equal(shells.length, 1, 'local Update only pulls the Pinokio launcher before calling the App updater');
            } else assert.equal(shells.at(-1).method, 'shell.run');
          }
          if (name === 'reset') assert.equal(shells.length, 0);
          if (name === 'uninstall-delete-data') {
            await assert.rejects(script.run[1].method({ input: { confirmation: 'delete' } }), /Cancelled, so nothing was deleted/);
            assert.deepEqual(plain(await script.run[1].method({ input: { confirmation: 'DELETE' } })), { confirmed: true });
            assert.equal(script.run[2].method, app.stopOwnedStart);
          }
          if (['install-local', 'add-local'].includes(name)) {
            const count = app.writes.length;
            await script.run.at(-1).method();
            assert.equal(app.writes.length, count + 1);
            assert.equal(JSON.parse(app.writes.at(-1).content).mode, 'local');
          }
          if (name === 'add-local') {
            assert.equal(script.run[0].method, app.stopOwnedStart);
            assert.equal(script.run[1].method, app.ensureDoorPortFree);
            assert.equal(script.run[2].method, 'shell.run');
            assert.equal(script.run[3].method, 'shell.run');
            assert.equal(script.run[4].method, app.stopOwnedStart);
            assert.equal(script.run[5].method, 'shell.run');
            assert.equal(typeof script.run[6].method, 'function');
          }
        }
        // Clone path, including a slash ref and shell metacharacters in app paths.
        assert.equal(app.shellStep(app.cloneEditorMessage()).params.message, expected.clone);
      });
    }
  }
}

test('add-local stops the retained installer session before build and saves mode only after that stop', async () => {
  for (const failAt of [null, 2]) {
    const calls = [];
    const base = fakeApp('linux', '', 'backend');
    const app = {
      ...base,
      stopOwnedStart: async () => {
        const count = calls.filter((call) => call === 'stop').length + 1;
        calls.push('stop');
        if (count === failAt) throw new Error('Retained session stop refused.');
      },
      gitShellStep: () => ({ method: async () => calls.push('checkout') }),
      shellStep: () => ({ method: async () => calls.push('shared installer') }),
      sessionStep: (action, mode) => ({ method: async () => {
        assert.equal(action, 'build'); assert.equal(mode, 'local'); calls.push('build');
      } }),
      saveModeStep: (mode) => ({ method: async () => {
        assert.equal(mode, 'local'); calls.push('save mode');
      } }),
    };
    const script = await load('pinokio/add-local.js', app)({}, {});
    const run = async () => { for (const step of script.run) await step.method(); };
    if (failAt === 2) await assert.rejects(run(), /Retained session stop refused/);
    else await run();
    assert.deepEqual(calls, failAt === 2
      ? ['stop', 'checkout', 'shared installer', 'stop']
      : ['stop', 'checkout', 'shared installer', 'stop', 'build', 'save mode']);
  }
});

test('Bash launcher pull reports a convenient restart only when HEAD changes and preserves failures', { skip: process.platform === 'win32' }, () => {
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pinokio-launcher-pull-'));
  const bin = path.join(temporary, 'bin');
  fs.mkdirSync(bin);
  const git = path.join(bin, 'git');
  fs.writeFileSync(git, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.PINOKIO_GIT_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const action = process.argv.at(-2);
state.calls.push(action);
if (action === 'rev-parse') {
  const head = state.heads.shift();
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (head === undefined) process.exit(9);
  process.stdout.write(head + '\\n');
} else if (action === 'pull') { fs.writeFileSync(statePath, JSON.stringify(state)); process.exit(state.pullStatus); }
else process.exit(8);
`);
  fs.chmodSync(git, 0o755);
  const message = fakeApp('linux').launcherPullMessage();
  const invoke = (state) => {
    const statePath = path.join(temporary, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(state));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', message], {
      cwd: temporary, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PINOKIO_GIT_STATE: statePath },
    });
    return { ...result, state: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  };
  try {
    const changed = invoke({ heads: ['old', 'new'], pullStatus: 0, calls: [] });
    assert.equal(changed.status, 0);
    assert.match(changed.stdout, /Restart Astrid when convenient/);
    assert.deepEqual(changed.state.calls, ['rev-parse', 'pull', 'rev-parse']);
    const unchanged = invoke({ heads: ['same', 'same'], pullStatus: 0, calls: [] });
    assert.equal(unchanged.status, 0);
    assert.doesNotMatch(unchanged.stdout, /Restart Astrid/);
    assert.deepEqual(unchanged.state.calls, ['rev-parse', 'pull', 'rev-parse']);
    const failed = invoke({ heads: ['old', 'new'], pullStatus: 7, calls: [] });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Couldn.t update the Pinokio launcher/);
    assert.doesNotMatch(failed.stdout, /Restart Astrid/);
    assert.deepEqual(failed.state.calls, ['rev-parse', 'pull']);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('PowerShell launcher pull applies the same changed, unchanged and failed behavior', { skip: process.platform !== 'win32' }, () => {
  const message = fakeApp('win32').launcherPullMessage();
  const invoke = (heads, pullStatus) => {
    const script = [
      `$script:heads = @(${heads.map((head) => `'${head}'`).join(', ')})`,
      '$script:headIndex = 0',
      `function git { if ($args -contains 'rev-parse') { $value = $script:heads[$script:headIndex]; $script:headIndex++; $global:LASTEXITCODE = 0; return $value }; if ($args -contains 'pull') { $global:LASTEXITCODE = ${pullStatus}; return } }`,
      message,
    ].join('\n');
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  };
  const changed = invoke(['old', 'new'], 0);
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /Restart Astrid when convenient/);
  const unchanged = invoke(['same', 'same'], 0);
  assert.equal(unchanged.status, 0);
  assert.doesNotMatch(unchanged.stdout, /Restart Astrid/);
  const failed = invoke(['old', 'new'], 7);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /Couldn.t update the Pinokio launcher/);
  assert.doesNotMatch(failed.stdout, /Restart Astrid/);
});

test('menu: all operation, installation, starting, ready, external and conflict states', async () => {
  for (const mode of [null, 'backend', 'local']) {
    let probeKind = 'free';
    const app = { ...fakeApp('darwin', '', mode), probeDoor: async () => ({ kind: probeKind }) };
    let running = '';
    let local = {};
    const info = { exists: () => Boolean(mode), running: (uri) => uri === running, local: () => local };
    const { menu } = load('pinokio.js', app);
    const idle = mode ? ['Start', 'Update', ...(mode === 'backend' ? ['Switch to fully local'] : []), 'Reset', 'Uninstall', 'Uninstall and delete all Astrid data…'] : ['Install', 'Install fully local'];
    const idleItems = await menu({}, info);
    assert.deepEqual(plain(idleItems.map((item) => item.text)), idle);
    assert.equal(idleItems.filter((item) => item.default).length, mode ? 1 : 0);
    if (mode) assert.equal(idleItems[0].default, true);
    for (const name of [...scripts.filter((name) => name !== 'start'), 'stop']) {
      running = `pinokio/${name}.js`;
      const items = await menu({}, info);
      assert.equal(items.length, 1);
      assert.equal(items[0].href, undefined);
      assert.equal(items[0].default, undefined);
    }
    running = 'pinokio/start.js';
    const pending = await menu({}, info);
    assert.deepEqual(plain(pending.map((item) => item.text)), ['Starting Astrid…', 'Stop']);
    assert.equal(pending.some((item) => item.default), false);
    local = app.localSetOpenTarget(mode);
    const ready = await menu({}, info);
    assert.deepEqual(plain(ready.map((item) => item.text)), ['Open Astrid', mode ? (mode === 'backend' ? 'Update and restart' : 'Update') : undefined, 'Stop'].filter(Boolean));
    assert.equal(ready[0].default, true);
    assert.equal(ready[0].popout, mode !== 'local');
    assert.equal(ready[0].target_full, mode === 'local' ? undefined : local.url);
    assert.equal(ready[0].href, mode === 'local' ? local.url : '/');
    if (mode) assert.equal(ready.at(-2).default, undefined);
    running = '';
    probeKind = 'astrid';
    const external = await menu({}, info);
    assert.deepEqual(plain(external.map((item) => item.text)), ['Astrid is already running on this computer. Use Open Astrid, or stop that copy to run Astrid from Pinokio.', 'Open Astrid']);
    assert.equal(external[1].href, library.HOSTED_OPEN_URL);
    assert.equal(external.some((item) => item.default), false);
    probeKind = 'occupied';
    const conflict = await menu({}, info);
    assert.match(conflict[0].text, /Another program/);
    assert.equal(conflict[0].href, undefined);
    assert.equal(conflict[0].default, undefined);
  }
});

test('detached local owner readiness avoids hosted port and stopped Start keeps its preflight', async () => {
  const app = fakeApp('linux', '', 'local');
  let owned = true;
  let ready = true;
  let probeCalls = 0;
  let probeKind = 'occupied';
  app.hasOwnedSupervisor = () => owned;
  app.localSessionReady = async () => ready;
  app.probeDoor = async () => { probeCalls++; return { kind: probeKind }; };
  const info = { exists: () => true, running: () => false, local: () => ({}) };
  const { menu } = load('pinokio.js', app);

  const open = await menu({}, info);
  assert.deepEqual(plain(open.map((entry) => entry.text)), ['Open Astrid', 'Update', 'Stop']);
  assert.equal(open[0].href, library.LOCAL_OPEN_URL);
  assert.equal(open.some((entry) => entry.default), false);
  assert.equal(open[1].href, 'pinokio/update.js');
  assert.equal(open[2].href, 'pinokio/stop.js');

  ready = false;
  const pending = await menu({}, info);
  assert.deepEqual(plain(pending.map((entry) => entry.text)), ['Starting Astrid…', 'Stop']);
  assert.equal(pending.some((entry) => entry.default), false);
  assert.equal(probeCalls, 0);

  owned = false;
  probeKind = 'free';
  const stopped = await menu({}, info);
  assert.equal(stopped[0].text, 'Start');
  assert.equal(stopped[0].default, true);
  assert.equal(probeCalls, 1);
});

test('detached local readiness reuses the session status and preview/config binding', async () => {
  const discovery = { runtime_instance_id: 'instance-1', active_realm: 'realm-1' };
  const installed = { env: {} };
  const requests = [];
  let configMatches = true;
  const result = () => JSON.stringify({ support: { healthy: true },
    health: { status: 'ok', runtime_instance_id: 'instance-1' }, discovery });
  const ready = await localSessionReady({ root: '/astrid', editor: '/editor', installed,
    run: async (spec) => { assert.ok(spec.args.includes('status')); return result(); },
    request: async (url) => {
      requests.push(url);
      if (url.endsWith('/tools/video-editor')) return { ok: true };
      return { ok: configMatches, json: async () => ({ schemaVersion: 1,
        runtimeInstanceId: 'instance-1', realmId: configMatches ? 'realm-1' : 'other-realm' }) };
    },
  });
  assert.equal(ready, true);
  assert.deepEqual(requests, ['http://127.0.0.1:5180/tools/video-editor', 'http://127.0.0.1:5180/runtime-config/v1/workspace.json']);
  configMatches = false;
  assert.equal(await localSessionReady({ root: '/astrid', editor: '/editor', installed,
    run: async () => result(), request: async (url) => url.endsWith('/tools/video-editor') ? { ok: true }
      : { ok: false, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance-1', realmId: 'other-realm' }) },
  }), false);
  const bound = { env: { ASTRID_INSTALLER_OPERATION_ID: 'a'.repeat(32) } };
  assert.equal(await localSessionReady({ root: '/astrid', editor: '/editor', installed: bound,
    run: async () => result(), request: async (url) => url.endsWith('/tools/video-editor') ? { ok: true }
      : { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance-1', realmId: 'realm-1' }) },
  }), true);
});

test('detached local readiness still requires Runtime instance and realm identity', async () => {
  for (const discovery of [{ active_realm: 'realm' }, { runtime_instance_id: 'instance' }]) {
    const status = JSON.stringify({ support: { healthy: true },
      health: { status: 'ok', runtime_instance_id: discovery.runtime_instance_id }, discovery });
    const ready = await localSessionReady({ root: '/astrid', editor: '/editor', installed: { env: {} },
      run: async () => status,
      request: async () => assert.fail('missing Runtime identity must fail before preview checks'),
    });
    assert.equal(ready, false);
  }
  for (const healthId of [undefined, 'other-instance']) {
    const status = JSON.stringify({ support: { healthy: true },
      health: { status: 'ok', ...(healthId ? { runtime_instance_id: healthId } : {}) },
      discovery: { runtime_instance_id: 'instance', active_realm: 'realm' } });
    const ready = await localSessionReady({ root: '/astrid', editor: '/editor', installed: { env: {} },
      run: async () => status,
      request: async () => assert.fail('health/discovery instance mismatch must fail before preview checks'),
    });
    assert.equal(ready, false);
  }
});

test('Update preserves hosted bootstrap and routes fully local Update through the App updater', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local']) {
    const app = fakeApp(platform, 'feat/pinokio', mode);
    const script = await load('pinokio/update.js', app)({}, {});
    const pull = script.run[0];
    assert.equal(pull.method, 'shell.run');
    assert.equal(pull.params.path, app.APP_DIR);
    const pullMessage = shellMessage(pull, platform);
    assert.match(pullMessage, /pull --ff-only/);
    assert.match(pullMessage, /update the Pinokio launcher\./);
    assert.match(pullMessage, /undo those edits, then choose Update again\./);
    assert.ok(pull.params.on.some((event) => event.event === '/ASTRID_PINOKIO_FAILURE/' && event.break));
    if (mode === 'local') {
      assert.equal(script.run[1].method, app.ensureLocalSessionForUpdate);
      assert.equal(script.run[2].method, app.runLocalUpdate);
      assert.equal(script.run.length, 3);
    } else {
      const astridUpdate = script.run.at(-1);
      assert.equal(astridUpdate.method, 'shell.run');
      assert.ok(shellMessage(astridUpdate, platform).includes('--root'));
      assert.doesNotMatch(shellMessage(astridUpdate, platform), /--update-app|--update(?:\s|')/);
    }
  }
  assert.equal(library.LAUNCHER_PULL_FAILURE, "Couldn't update the Pinokio launcher. If you edited its files, undo those edits, then choose Update again.");
});

test('the fully-local Pinokio caller launches the installed npm update script in the editor checkout', async () => {
  const base = fakeApp('linux', '', 'local');
  const root = base.BACKEND_ROOT;
  const version = 'v2';
  const versionRoot = path.join(root, 'versions', version);
  const node = path.join(versionRoot, 'node', 'bin', 'node');
  const python = path.join(versionRoot, 'py', 'bin', 'python');
  const profile = path.join(versionRoot, 'profile.json');
  const records = new Map([
    [path.join(base.APP_DIR, 'app', 'install-mode.json'), JSON.stringify({ schema_version: 1, mode: 'local' })],
    [path.join(root, 'current'), version],
    [path.join(versionRoot, 'version.json'), JSON.stringify({ root: versionRoot, python, profile, env: { ASTRID_NODE_EXECUTABLE: node } })],
    [path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: '/Astrid Data' })],
  ]);
  const npmCli = path.resolve(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npxCli = path.join(path.dirname(npmCli), 'npx-cli.js');
  const installedFiles = new Set([node, python, profile, npmCli, npxCli]);
  let invoked;
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => { if (records.has(file)) return records.get(file); throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
      existsSync: (file) => installedFiles.has(file) },
    execute: (command, args, options) => { invoked = { command, args, options }; return { status: 0, stdout: 'up to date\n', stderr: '' }; },
    lifecycle: {},
  });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/update.js', app)({}, {});
  assert.equal(script.run.at(-1).method, app.runLocalUpdate);
  let output = '';
  await app.runLocalUpdate({}, (event) => { output += event.raw; });
  assert.equal(invoked.command, node);
  assert.deepEqual(invoked.args, [npmCli, 'run', 'update']);
  assert.equal(invoked.options.cwd, app.EDITOR_DIR);
  assert.equal(invoked.options.timeout, 600_000);
  assert.match(output, /up to date/);
});

function localUpdateFixture(appDirectory, { transaction, dataRoot = '/Astrid Data' } = {}) {
  const root = path.join(appDirectory, 'app', 'astrid');
  const versionRoot = path.join(root, 'versions', 'v2');
  const node = path.join(versionRoot, 'node', 'bin', 'node');
  const python = path.join(versionRoot, 'py', 'bin', 'python');
  const profile = path.join(versionRoot, 'profile.json');
  const npmCli = path.resolve(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npxCli = path.join(path.dirname(npmCli), 'npx-cli.js');
  const records = new Map([
    [path.join(appDirectory, 'app', 'install-mode.json'), JSON.stringify({ schema_version: 1, mode: 'local' })],
    [path.join(root, 'current'), 'v2'],
    [path.join(versionRoot, 'version.json'), JSON.stringify({ root: versionRoot, python, profile, env: { ASTRID_NODE_EXECUTABLE: node } })],
    [path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: dataRoot })],
  ]);
  if (transaction) records.set(path.join(root, 'update-transaction.json'), JSON.stringify(transaction));
  const installedFiles = new Set([node, python, profile, npmCli, npxCli]);
  const filesystem = {
    readFileSync: (file) => {
      if (records.has(file)) return records.get(file);
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
    existsSync: (file) => installedFiles.has(file),
  };
  return { appDirectory, root, node, python, npmCli, filesystem };
}
function fakeUpdateChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function until(condition, description) {
  for (let i = 0; i < 1000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${description}`);
}
function spawnRecorder() {
  let resolveSpawn;
  const spawned = new Promise((resolve) => { resolveSpawn = resolve; });
  const spawnProcess = (command, args, options) => {
    const child = fakeUpdateChild();
    resolveSpawn({ child, command, args, options });
    return child;
  };
  return { spawned, spawnProcess };
}

test('Pinokio Update runs npm as an async child: output reaches the caller before exit and timers fire meanwhile', async () => {
  const fixture = localUpdateFixture('/pinokio/api/Astrid');
  const { spawned, spawnProcess } = spawnRecorder();
  const app = library.createApp({ platform: 'linux', appDirectory: fixture.appDirectory, environment: {},
    filesystem: fixture.filesystem, spawnProcess });
  const events = [];
  const update = app.runLocalUpdate({}, (event) => events.push(event.raw));
  update.catch(() => {});
  const { child, command, args, options } = await within(spawned, 2000, 'npm was not started as an async child');
  assert.equal(command, fixture.node);
  assert.deepEqual(args, [fixture.npmCli, 'run', 'update']);
  assert.equal(options.cwd, app.EDITOR_DIR);
  child.stdout.write('npm WARN first chunk\n');
  await until(() => events.length === 1, 'the first npm chunk');
  assert.deepEqual(events, ['npm WARN first chunk\n'], 'the first chunk is delivered while npm is still running');
  let timerFired = false;
  await new Promise((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 5));
  assert.equal(timerFired, true, 'a timer must fire while npm is still running');
  child.stderr.write('npm WARN second chunk\n');
  await until(() => events.length === 2, 'the second npm chunk');
  child.emit('close', 0, null);
  assert.deepEqual(await update, { updated: true });
  assert.deepEqual(events, ['npm WARN first chunk\n', 'npm WARN second chunk\n'], 'each chunk is delivered exactly once');
});

test('Pinokio Update reports a failed npm child with its output and no duplicate lines', async () => {
  const fixture = localUpdateFixture('/pinokio/api/Astrid');
  const { spawned, spawnProcess } = spawnRecorder();
  const app = library.createApp({ platform: 'linux', appDirectory: fixture.appDirectory, environment: {},
    filesystem: fixture.filesystem, spawnProcess });
  const events = [];
  const update = app.runLocalUpdate({}, (event) => events.push(event.raw));
  update.catch(() => {});
  const { child } = await within(spawned, 2000, 'npm was not started as an async child');
  child.stderr.write('npm ERR! code E404\n');
  await until(() => events.length === 1, 'the npm error chunk');
  child.emit('close', 1, null);
  await assert.rejects(update, (error) => {
    assert.equal(error.message, 'npm ERR! code E404');
    return true;
  });
  assert.deepEqual(events, ['npm ERR! code E404\n']);
});

test('Pinokio recovery streams the installed CLI output as it arrives', async () => {
  const fixture = localUpdateFixture('/pinokio/api/Astrid', { transaction: {
    format: 'astrid-install-update/v1', step: 'switched', operation_id: 'a'.repeat(32) } });
  const { spawned, spawnProcess } = spawnRecorder();
  const app = library.createApp({ platform: 'linux', appDirectory: fixture.appDirectory, environment: {},
    filesystem: fixture.filesystem, spawnProcess });
  const events = [];
  const recovery = app.recoverPendingUpdate({}, (event) => events.push(event.raw));
  recovery.catch(() => {});
  const { child, command, args } = await within(spawned, 2000, 'recovery was not started as an async child');
  assert.equal(command, fixture.python);
  assert.deepEqual(args, ['-I', '-m', 'astrid', 'install', '--root', fixture.root, '--managed-by', 'pinokio']);
  child.stdout.write('installing recovered version\n');
  await until(() => events.length === 1, 'the recovery chunk');
  assert.deepEqual(events, ['installing recovered version\n'], 'recovery output is delivered before exit');
  child.emit('close', 0, null);
  assert.deepEqual(await recovery, { recovered: true });
});

test('a local session started for Update logs to a file and stops forwarding output after READY', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'astrid-pinokio-session-log-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const appDirectory = path.join(temporary, 'pinokio', 'api', 'Astrid');
  fs.mkdirSync(path.join(appDirectory, 'app'), { recursive: true });
  const fixture = localUpdateFixture(appDirectory, { dataRoot: path.join(temporary, 'Astrid Data') });
  const logFile = path.join(appDirectory, 'app', 'local-update-session.log');
  const { spawned, spawnProcess } = spawnRecorder();
  const app = library.createApp({ platform: 'linux', appDirectory, environment: {},
    filesystem: { ...fixture.filesystem, createWriteStream: fs.createWriteStream },
    spawnProcess, sessionReadyCheck: async () => true });
  const events = [];
  const started = app.ensureLocalSessionForUpdate({}, (event) => events.push(event.raw));
  started.catch(() => {});
  const { child, command, args, options } = await within(spawned, 2000, 'the local session was not started');
  assert.equal(command, fixture.node);
  assert.equal(args[1], 'serve');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  child.stdout.write('starting\n');
  await until(() => events.includes('starting\n'), 'the session start output');
  child.stdout.write('ASTRID_PINOKIO_READY\n');
  assert.deepEqual(await started, { started: true, ready: true, recovering: false });
  child.stdout.write('written during the update\n');
  await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('written during the update'), 'the session log file');
  child.emit('close', 0, null);
  assert.deepEqual(events, ['starting\n', 'ASTRID_PINOKIO_READY\n'], 'output after READY goes to the log, not to the finished Update step');
  assert.match(fs.readFileSync(logFile, 'utf8'), /starting\n[\s\S]*ASTRID_PINOKIO_READY\n[\s\S]*written during the update\n/);
});

test('stopped fully-local Update starts the existing Pinokio Start session and waits for readiness', async () => {
  const base = fakeApp('linux', '', 'local');
  let readyChecks = 0;
  let started;
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'local' });
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }, existsSync: () => false },
    sessionReadyCheck: async () => ++readyChecks > 1, pause: async () => {},
    startSessionForUpdate: async (options) => { started = options; },
  });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/update.js', app)({}, {});
  const result = await script.run[1].method({}, () => {});
  assert.equal(started.root, app.BACKEND_ROOT);
  assert.equal(started.editor, app.EDITOR_DIR);
  assert.equal(started.recoverLocalUpdate, false);
  assert.equal(typeof started.ondata, 'function');
  assert.deepEqual(plain(result), { started: true, ready: true, recovering: false });
  assert.equal(readyChecks, 2);
});

test('interrupted local App update starts runSession in journal-recovery mode and reruns npm update', async () => {
  const base = fakeApp('linux', '', 'local');
  const transaction = JSON.stringify({ step: 'switched', transaction_context: { owner: 'local-update' } });
  let readyChecks = 0;
  let startOptions;
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'local' });
      if (file.endsWith('update-transaction.json')) return transaction;
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }, existsSync: () => false },
    sessionReadyCheck: async () => ++readyChecks > 1, pause: async () => {},
    startSessionForUpdate: async (options) => { startOptions = options; },
  });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/update.js', app)({}, {});
  assert.equal(script.run.length, 2);
  assert.equal(script.run[0].method, app.ensureLocalSessionForUpdate);
  assert.equal(script.run[1].method, app.runLocalUpdate);
  await script.run[0].method({}, () => {});
  assert.equal(startOptions.recoverLocalUpdate, true);
});

for (const step of ['complete', 'rolled_back']) {
  test(`local Update after Stop with a ${step} journal starts the normal Runtime session`, async () => {
    const base = fakeApp('linux', '', 'local');
    const transaction = JSON.stringify({ step, transaction_context: { owner: 'local-update' } });
    let startOptions;
    const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
      filesystem: { readFileSync: (file) => {
        if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'local' });
        if (file.endsWith('update-transaction.json')) return transaction;
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      }, existsSync: () => false },
      sessionReadyCheck: async () => true,
      startSessionForUpdate: async (options) => { startOptions = options; },
    });
    app.validateExistingEditorCheckout = () => true;
    app.runLocalUpdate = async () => ({ updated: true });
    const h = sessionHarness({ platform: 'linux' });
    let sessionFinished;
    const script = await load('pinokio/update.js', app)({}, {});
    assert.equal(script.run[1].method, app.ensureLocalSessionForUpdate);
    await script.run[1].method({}, () => {});
    assert.equal(startOptions.recoverLocalUpdate, false);
    assert.deepEqual(plain(await script.run[2].method({}, () => {})), { updated: true });
    sessionFinished = runSession({ ...h.options, action: 'serve', mode: 'local', recoverLocalUpdate: startOptions.recoverLocalUpdate,
      request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
        ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
        : { ok: true, status: 200 },
      output: (line) => { if (line === 'ASTRID_PINOKIO_READY') queueMicrotask(() => h.signals.emit('SIGTERM')); },
    });
    await sessionFinished;
    assert.ok(h.log.some((item) => item.command?.endsWith('/run')), 'normal recovery must launch Runtime');
    assert.ok(h.log.some((item) => item.command === '/pinned/python' && item.args.includes('status')),
      'normal recovery must populate discovery through Runtime status');
    assert.equal(h.active.size, 0);
  });
}

test('pending local Update authenticates the retained controller before bypassing stopped editor readiness', async (t) => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'astrid-pinokio-pending-retry-'));
  const appDirectory = path.join(temporary, 'pinokio', 'api', 'astrid');
  const root = path.join(appDirectory, 'app', 'astrid');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(root), 'install-mode.json'), JSON.stringify({ schema_version: 1, mode: 'local' }));
  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({
    step: 'recovering', transaction_context: { owner: 'local-update' },
  }));
  const version = 'v2';
  const versionRoot = path.join(root, 'versions', version);
  const node = path.join(versionRoot, 'node', 'bin', 'node');
  const python = path.join(versionRoot, 'py', 'bin', 'python');
  const profile = path.join(versionRoot, 'profile.json');
  const npmCli = path.resolve(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npxCli = path.join(path.dirname(npmCli), 'npx-cli.js');
  fs.mkdirSync(versionRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'current'), `${version}\n`);
  fs.writeFileSync(path.join(versionRoot, 'version.json'), JSON.stringify({ root: versionRoot, python, profile,
    env: { ASTRID_NODE_EXECUTABLE: node } }));
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime',
    managed_by: 'pinokio', data_root: path.join(temporary, 'Astrid Data') }));
  const installedFiles = new Set([node, npmCli, npxCli, python, profile]);
  const filesystem = { readFileSync: fs.readFileSync.bind(fs), existsSync: (file) => installedFiles.has(file) || fs.existsSync(file) };
  let updating = false;
  let controlCalls = 0;
  let runtimeVerified = false;
  let editorReady = false;
  let readinessChecks = 0;
  const controller = await createController(root, async () => ({ ok: true }), { localUpdate: {
    isUpdating: () => updating,
    begin: async () => { controlCalls += 1; updating = true; return { updating: true }; },
    runtime: async ({ version: selected } = {}) => {
      assert.equal(updating, true);
      assert.equal(selected, version);
      runtimeVerified = true;
      return { version: selected, ready: true };
    },
    end: async () => {
      assert.equal(updating, true);
      assert.equal(runtimeVerified, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'update-transaction.json'))).step, 'rolled_back');
      assert.equal(editorReady, true);
      updating = false;
      return { updating: false, ready: true };
    },
  } });
  t.after(async () => { Date.now = originalNow; await controller.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const record = JSON.parse(fs.readFileSync(path.join(root, CONTROL_FILE), 'utf8'));
  let recoveryPromise;
  let invoked;
  const app = library.createApp({ platform: 'linux', appDirectory, environment: {},
    filesystem,
    execute: (command, args, options) => {
      invoked = { command, args, options };
      recoveryPromise = (async () => {
        assert.deepEqual(plain(await requestLocalUpdate(root, 'runtime', { version })),
          { ok: true, version, ready: true });
        fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({
          step: 'rolled_back', transaction_context: { owner: 'local-update' },
        }));
        editorReady = true;
        assert.deepEqual(plain(await requestLocalUpdate(root, 'end')), { ok: true, updating: false, ready: true });
      })();
      return { status: 0, stdout: 'rollback recovery complete\n', stderr: '' };
    },
    processAlive: (pid) => pid === record.pid,
    sessionReadyCheck: async () => { readinessChecks += 1; return editorReady; },
    pause: async (ms) => { clock += ms; },
    startSessionForUpdate: async () => assert.fail('must reuse the authenticated live controller'),
  });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/update.js', app)({}, {});
  assert.equal(script.run[0].method, app.ensureLocalSessionForUpdate);
  assert.equal(script.run[1].method, app.runLocalUpdate);
  const ensured = await script.run[0].method({}, () => {});
  assert.deepEqual(plain(ensured), { started: false, ready: true, recovering: true });
  assert.equal(readinessChecks, 0, 'recovery must reach the updater before waiting for the editor it restores');
  assert.equal((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST', headers: {
    Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}`,
  } })).status, 409, 'maintenance keeps C1 Stop admission closed until recovery completes');
  await script.run[1].method({}, () => {});
  await recoveryPromise;
  assert.equal(invoked.command, node);
  assert.deepEqual(invoked.args, [npmCli, 'run', 'update']);
  assert.equal(invoked.options.cwd, app.EDITOR_DIR);
  assert.equal(editorReady, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'update-transaction.json'))).step, 'rolled_back');
  assert.equal(controlCalls, 1, 'the caller must prove ownership through the secret and exact loopback Host');
  assert.equal(updating, false, 'the authenticated end callback releases the existing C1 Stop fence after recovery');
  assert.equal((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST', headers: {
    Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}`,
  } })).status, 200);
});

test('pending local Update rejects a bad retained-controller secret before updater or session start', async () => {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  const appDirectory = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'astrid-pinokio-bad-token-'));
  const root = path.join(appDirectory, 'app', 'astrid');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(path.dirname(root), 'install-mode.json'), JSON.stringify({ schema_version: 1, mode: 'local' }));
  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({
    step: 'recovering', transaction_context: { owner: 'local-update' },
  }));
  let updating = false;
  let controller;
  try {
    controller = await createController(root, async () => ({ ok: true }), { localUpdate: {
      isUpdating: () => updating,
      begin: async () => { updating = true; return { updating: true }; },
    } });
    const record = JSON.parse(fs.readFileSync(path.join(root, CONTROL_FILE), 'utf8'));
    fs.writeFileSync(path.join(root, CONTROL_FILE), JSON.stringify({ ...record, token: 'b'.repeat(64) }));
    const app = library.createApp({ platform: 'linux', appDirectory, environment: {},
      processAlive: (pid) => pid === record.pid,
      sessionReadyCheck: async () => false,
      pause: async (ms) => { clock += ms; },
      startSessionForUpdate: async () => assert.fail('authentication failure must not start a session'),
    });
    let updaterCalled = false;
    app.runLocalUpdate = async () => { updaterCalled = true; };
    const script = await load('pinokio/update.js', app)({}, {});
    await assert.rejects(script.run[0].method({}, () => {}), /Pinokio update request failed/);
    assert.equal(updaterCalled, false);
    assert.equal(updating, false);
  } finally {
    Date.now = originalNow;
    await controller?.close();
    fs.rmSync(appDirectory, { recursive: true, force: true });
  }
});

test('fully-local Update treats a dead controller receipt as stale and lets runSession replace it', async () => {
  const base = fakeApp('linux', '', 'local');
  let starts = 0;
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'local' });
      if (file.endsWith('pinokio-control.json')) return JSON.stringify({ schema: 1, pid: 1000000, port: 19000, token: 'a'.repeat(64) });
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }, existsSync: () => false },
    processAlive: () => false,
    sessionReadyCheck: async () => ++starts > 1, pause: async () => {},
    startSessionForUpdate: async () => {},
  });
  await app.ensureLocalSessionForUpdate({}, () => {});
  assert.equal(starts, 2);
});

test('ready fully-local Update reuses the live Pinokio controller and does not create another session', async () => {
  const base = fakeApp('linux', '', 'local');
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'local' });
      if (file.endsWith('pinokio-control.json')) return JSON.stringify({ schema: 1, pid: 123, port: 19000, token: 'a'.repeat(64) });
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    }, existsSync: () => false },
    processAlive: () => true, sessionReadyCheck: async () => true,
    startSessionForUpdate: async () => assert.fail('must reuse the live session'),
  });
  assert.deepEqual(plain(await app.ensureLocalSessionForUpdate({}, () => {})), { started: false, ready: true });
});

test('hosted Update leaves stop admission to the shared installer transaction', async () => {
  const app = fakeApp('linux', '', 'backend');
  const script = await load('pinokio/update.js', app)({}, {});
  assert.equal(script.run.length, 2);
  assert.equal(script.run[0].method, 'shell.run');
  assert.match(shellMessage(script.run[0], 'linux'), /pull --ff-only/);
  assert.match(shellMessage(script.run[1], 'linux'), /--managed-by.*pinokio/);
  assert.doesNotMatch(shellMessage(script.run[1], 'linux'), /--update-app/);
});

test('Update performs only installed-CLI recovery before any new launcher or manifest fetch', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'astrid-pinokio-recovery-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const appDirectory = path.join(temporary, 'pinokio', 'api', 'Astrid');
  const root = path.join(appDirectory, 'app', 'astrid');
  const makeVersion = (version, release) => {
    const versionRoot = path.join(root, 'versions', version);
    const node = path.join(versionRoot, 'node', 'bin', 'node');
    const python = path.join(versionRoot, 'py', 'bin', 'python');
    const profile = path.join(versionRoot, 'profile.json');
    const npm = path.resolve(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npx = path.join(path.dirname(npm), 'npx-cli.js');
    for (const file of [node, python, profile, npm, npx]) fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const file of [node, python, profile, npm, npx]) fs.writeFileSync(file, '');
    const env = { ASTRID_NODE_EXECUTABLE: node, ASTRID_INSTALL_RELEASE: String(release), ASTRID_INSTALL_MANAGED_BY: 'pinokio' };
    const record = { root: versionRoot, python, profile, env, identity: { release, managed_by: 'pinokio' } };
    fs.writeFileSync(path.join(versionRoot, 'version.json'), JSON.stringify(record));
    return { root: versionRoot, python, profile, env, identity: record.identity };
  };
  const old = makeVersion('v1', 1);
  const candidate = makeVersion('v2', 2);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'current'), 'v1\n');
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: path.join(temporary, 'data') }));
  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({ format: 'astrid-install-update/v1', step: 'switched', operation_id: 'a'.repeat(32), candidate }));
  let invoked;
  const app = library.createApp({ platform: 'linux', appDirectory, environment: {}, execute: (command, args, options) => {
    invoked = { command, args, options }; return { status: 0, stdout: 'recovered\n', stderr: '' };
  } });
  const script = await load('pinokio/update.js', app)({}, {});
  assert.equal(script.run.length, 1);
  assert.equal(script.run[0].method, app.recoverPendingUpdate);
  await script.run[0].method({}, () => {});
  assert.equal(invoked.command, candidate.python);
  assert.deepEqual(invoked.args, ['-I', '-m', 'astrid', 'install', '--root', root, '--managed-by', 'pinokio']);
  assert.equal(invoked.options.timeout, 600_000);
  assert.notEqual(old.python, invoked.command, 'recovery uses the staged C2 candidate CLI instead of an older current CLI');

  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({ format: 'astrid-install-update/v1', step: 'stopping' }));
  invoked = undefined;
  const legacyScript = await load('pinokio/update.js', app)({}, {});
  await legacyScript.run[0].method({}, () => {});
  assert.equal(invoked.command, old.python, 'legacy journals without a candidate fall back to current');

  const forged = { ...candidate, root: path.join(temporary, 'outside') };
  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({ format: 'astrid-install-update/v1', step: 'stopping', candidate: forged }));
  invoked = undefined;
  const forgedScript = await load('pinokio/update.js', app)({}, {});
  await assert.rejects(forgedScript.run[0].method({}, () => {}), /outside the installed versions directory/);
  assert.equal(invoked, undefined, 'an out-of-root candidate must not be executed');
});

test('local Update preserves structured refusal from the shared transaction caller', async () => {
  const app = fakeApp('linux', '', 'local');
  const details = { safe: false, blockers: [{ task_id: 'local-update' }] };
  const calls = [];
  app.ensureLocalSessionForUpdate = async () => { calls.push('session'); };
  app.runLocalUpdate = async () => {
    calls.push('transaction');
    throw Object.assign(new Error('Work is still active.'), { details });
  };
  const script = await load('pinokio/update.js', app)({}, {});
  await assert.rejects(async () => {
    for (const step of script.run) {
      if (typeof step.method === 'function') await step.method();
      else calls.push('pull');
    }
  }, (error) => { assert.deepEqual(error.details, details); return true; });
  assert.deepEqual(calls, ['pull', 'session', 'transaction']);
});

test('Stop and every maintenance caller preserve busy and unknown failures before mutation', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local'])
    for (const stage of ['down', 'controller']) for (const reason of ['busy', 'transport', 'timeout', 'generic']) {
    for (const name of ['stop', 'install-local', 'reset', 'uninstall', 'uninstall-delete-data', ...(mode === 'backend' ? ['add-local'] : [])]) {
      const base = fakeApp(platform, '', mode);
      const calls = [];
      const message = reason === 'busy' ? 'Astrid is busy (1 tasks running). Try again when they finish.\ntask-caller [render; running; age 4s]'
        : reason === 'transport' ? 'Controller transport failed.' : reason === 'timeout' ? 'Runtime stop timed out.' : 'Runtime stop failed.';
      const fail = () => {
        const error = new Error(message);
        if (reason === 'busy') error.details = { task_count: 1, blockers: [{ task_id: 'task-caller' }] };
        throw error;
      };
      const app = library.createApp({ platform, appDirectory: base.APP_DIR, environment: {},
        filesystem: {
          existsSync: () => true,
          readFileSync: (file) => {
            if (file.endsWith('update-transaction.json')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            return JSON.stringify(file.endsWith('install-mode.json') ? { schema_version: 1, mode } : { schema: 1, pid: 123, port: 1234 });
          },
          rmSync: () => calls.push('remove'), writeFileSync: () => calls.push('write'), mkdirSync: () => calls.push('mkdir'),
        },
        lifecycle: {
          stopRuntime: async () => { calls.push('down'); fail(); },
          requestGracefulStop: async () => { calls.push('controller'); fail(); },
          waitForInstallerLock: async () => calls.push('lock'),
        },
      });
      app.validateExistingEditorCheckout = () => true;
      const module = load(`pinokio/${name}.js`, app);
      const script = typeof module === 'function' ? await module({}, {}) : module;
      const kernel = { api: { running: stage === 'controller' ? { [app.paths.join(app.APP_DIR, 'pinokio', 'start.js')]: true } : {},
        stop: async () => calls.push('kernel-stop') } };
      await assert.rejects(async () => {
        for (const step of script.run) {
          if (typeof step.method === 'function') await step.method({ input: { confirmation: 'DELETE' } }, () => {}, kernel);
          else if (step.method !== 'input') calls.push(step.method);
        }
      }, (error) => {
        assert.ok(error.message.includes(message), `${platform}/${mode}/${name}/${stage}/${reason}: ${error.message}`);
        if (reason === 'busy') assert.equal(error.details.task_count, 1);
        return true;
      });
      assert.deepEqual(calls, [stage]);
    }
  }
});

test('settings use ENVIRONMENT first and fall back to the shipped _ENVIRONMENT template', () => {
  const p = process.platform === 'win32' ? path.win32 : path.posix;
  const base = p.join(p.parse(process.platform === 'win32' ? 'C:\\' : '/').root, 'Pinokio Apps', 'Astrid');
  const values = new Map([
    [p.join(base, '_ENVIRONMENT'), 'ASTRID_APP_REF=feat/pinokio\nOTHER=default'],
  ]);
  const app = library.createApp({ appDirectory: base, environment: {}, filesystem: {
    readFileSync(file) { if (!values.has(file)) throw new Error('absent'); return values.get(file); },
  } });
  assert.equal(app.setting('ASTRID_APP_REF'), 'feat/pinokio');
  values.set(p.join(base, 'ENVIRONMENT'), 'ASTRID_APP_REF=\nOTHER=generated');
  assert.equal(app.setting('ASTRID_APP_REF'), '');
  assert.equal(app.setting('OTHER'), 'generated');
  values.set(p.join(base, 'ENVIRONMENT'), 'OTHER=generated');
  assert.equal(app.setting('ASTRID_APP_REF'), 'feat/pinokio');
});

test('port classification and preflight use injected requests; no live port probes', async () => {
  assert.equal((await library.probeDoor({ portOpen: async () => false })).kind, 'free');
  for (const [status, body, expected] of [[200, { protocol: 'workspace.v1' }, 'astrid'], [503, { error: 'runtime_unavailable' }, 'astrid'], [403, { error: 'hosted_origin_required' }, 'astrid'], [200, { status: 'ok' }, 'occupied'], [404, {}, 'occupied']]) {
    assert.equal((await library.probeDoor({ portOpen: async () => true, request: async () => ({ status, json: async () => body }) })).kind, expected);
  }
  for (const kind of ['astrid', 'occupied']) {
    const app = library.createApp({ probe: async () => ({ kind }) });
    await assert.rejects(app.ensureDoorPortFree({}, () => {}), kind === 'astrid' ? /already running/ : /Another program/);
  }
});

test('Stop awaits the absolute Pinokio script owner before returning', async () => {
  const app = fakeApp('darwin');
  let release;
  let entered;
  const invoked = new Promise((resolve) => { entered = resolve; });
  let stopped = false;
  const pending = app.stopOwnedStart({}, () => {}, { api: { stop: async (request) => {
    assert.equal(request.params.uri, app.paths.join(app.APP_DIR, 'pinokio', 'start.js'));
    await new Promise((resolve) => { release = resolve; entered(); }); stopped = true;
  } } });
  assert.equal(stopped, false);
  await invoked; release(); await pending; assert.equal(stopped, true);
});

test('an active Start with a missing controller refuses before Pinokio tree cleanup', async () => {
  const base = fakeApp('linux');
  const calls = [];
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR,
    filesystem: { ...base.filesystem, existsSync: () => true }, lifecycle: {
      requestGracefulStop: async () => ({ ok: true, absent: true }),
      waitForInstallerLock: async () => calls.push('lock'),
    } });
  await assert.rejects(app.stopOwnedStart({}, () => {}, { api: {
    running: { [app.paths.join(app.APP_DIR, 'pinokio', 'start.js')]: true },
    stop: async () => calls.push('kernel-stop'),
  } }), /no responsive stop controller/);
  assert.deepEqual(calls, []);
});

test('installer record selects authoritative Python, data root, Node and npm; no imaginary with-env', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const app = fakeApp(platform);
    const p = app.paths;
    const root = app.BACKEND_ROOT;
    const versionRoot = p.join(root, 'versions', 'v1');
    const node = p.join(versionRoot, 'tools', 'node', platform === 'win32' ? 'node.exe' : 'bin/node');
    const python = p.join(versionRoot, 'py', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const profile = p.join(versionRoot, 'source-profile.json');
    const data = platform === 'win32' ? 'D:\\Astrid Data' : '/retained Astrid data';
    const files = new Map([
      [p.join(root, 'current'), 'v1'],
      [p.join(root, 'versions', 'v1', 'version.json'), JSON.stringify({ root: versionRoot, python, profile, env: { ASTRID_NODE_EXECUTABLE: node } })],
      [p.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data })],
    ]);
    const installed = installation(root, { platform, filesystem: { readFileSync: (f) => files.get(f), existsSync: () => true, realpathSync: (f) => f }, environment: { PATH: '/ambient', ASTRID_RUNTIME_DATA_ROOT: '/wrong', ASTRID_RUNTIME_CHECKOUT: '/wrong', NODE_OPTIONS: '--bad', PYTHONNOUSERSITE: '1', GIT_CONFIG_GLOBAL: '/pinokio/gitconfig' } });
    assert.equal(installed.env.ASTRID_RUNTIME_DATA_ROOT, data);
    assert.equal(installed.env.ASTRID_RUNTIME_CHECKOUT, '');
    assert.equal(installed.env.NODE_OPTIONS, undefined);
    assert.equal(installed.env.PYTHONNOUSERSITE, undefined);
    assert.equal(installed.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(installed.env.ASTRID_RUNTIME_PYTHON, python);
    assert.equal(installed.env.ASTRID_RUNTIME_SOURCE_MANIFEST, profile);
    const c = commands(root, app.EDITOR_DIR, 'local', installed, platform);
    assert.deepEqual(c.dependencies, { command: node, args: [installed.npx, '-y', 'npm@11', 'ci', '--no-audit', '--no-fund'] });
    assert.deepEqual(c.build, { command: node, args: ['scripts/dev-local-workspace.mjs', '--build'] });
    assert.deepEqual(c.preview, { command: node, args: ['scripts/dev-local-workspace.mjs', '--preview', '--preview-dir', p.join(app.EDITOR_DIR, 'dist')] });
    assert.deepEqual(c.status, { command: python, args: ['-I', '-m', 'astrid_runtime', 'status', '--data-root', data, '--json'] });
    assert.deepEqual(c.down, { command: python, args: ['-I', '-m', 'astrid_runtime', 'down', '--profile', 'astrid', '--data-root', data, '--source-manifest', profile, '--json'] });
    if (platform === 'win32') assert.deepEqual(c.runtime, { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `""${p.join(root, 'run.cmd')}" --hosted-origin off"`], windowsVerbatimArguments: true });
    else assert.deepEqual(c.runtime, { command: p.join(root, 'run'), args: ['--hosted-origin', 'off'] });
  }
});

function sessionHarness({ platform = 'darwin', buildCode = 0, dependencyCode = 0, occupied = false, earlyExit = false,
  externalHealthy = false } = {}) {
  const signals = new EventEmitter();
  const log = [];
  let pid = 5000;
  let statusCount = 0;
  const active = new Map();
  const installed = { node: '/pinned/node', npm: '/pinned/npm-cli.js', npx: '/pinned/npx-cli.js', python: '/pinned/python', profile: '/pinned/profile.json', data: '/data', env: {} };
  function close(child, code = 0) { active.delete(child.pid); child.emit('close', code, null); }
  function spawnProcess(command, args, options) {
    const child = new EventEmitter(); child.pid = ++pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    log.push({ command, args, options, pid }); active.set(pid, child);
    queueMicrotask(() => {
      if (command.endsWith('taskkill.exe')) { const target = active.get(Number(args[1])); if (target) close(target); close(child); }
      else if (args.includes('status')) { const healthy = externalHealthy ? statusCount++ === 0 : statusCount++ > 0; child.stdout.emit('data', JSON.stringify({ support: { healthy }, health: { status: 'ok', runtime_instance_id: 'instance' }, discovery: { runtime_instance_id: 'instance', active_realm: 'realm' } })); close(child, healthy ? 0 : 1); }
      else if (args.includes('ci')) close(child, dependencyCode);
      else if (args.includes('--build')) close(child, buildCode);
      else if (earlyExit && (command.endsWith('/run') || command.endsWith('cmd.exe'))) close(child, 7);
    });
    return child;
  }
  return { log, active, signals, options: { root: platform === 'win32' ? 'C:\\Astrid' : '/astrid', editor: platform === 'win32' ? 'C:\\editor' : '/editor', platform, installed, spawnProcess, signals,
    openController: async () => ({ close: async () => {} }),
    gracefulDown: async (spec) => {
      log.push({ down: spec });
      const runtime = [...log].reverse().find((call) => (call.command?.endsWith('/run') || call.command?.endsWith('cmd.exe')) && active.has(call.pid));
      const child = runtime && active.get(runtime.pid);
      if (child) close(child);
    },
    portOpen: async () => occupied, pause: async () => {}, killProcess: (group, signal) => { log.push({ group, signal }); const child = active.get(-group); if (child) close(child); } } };
}

function selectedSessionInstall(version, installed) {
  const root = `/astrid/versions/${version}`;
  return { ...installed, node: `${root}/node`, npm: `${root}/npm-cli.js`, npx: `${root}/npx-cli.js`,
    python: `${root}/python`, profile: `${root}/profile.json`, record: { root }, env: { ...installed.env } };
}

test('temporary build Runtime cleanup: success, build failure and npm failure on POSIX and Windows', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const [buildCode, dependencyCode] of [[0, 0], [1, 0], [0, 1]]) {
    const h = sessionHarness({ platform, buildCode, dependencyCode });
    const result = runSession({ ...h.options, action: 'build', mode: 'local' });
    if (buildCode || dependencyCode) await assert.rejects(result, /command failed/);
    else await result;
    assert.equal(h.active.size, 0);
    assert.equal(h.signals.listenerCount('SIGTERM'), 0);
    const runtime = h.log.find((call) => call.command?.endsWith('/run') || call.command?.endsWith('cmd.exe'));
    assert.equal(Boolean(runtime), dependencyCode === 0);
    if (runtime) assert.equal(runtime.options.env.ASTRID_APP_LOOPBACK_ORIGIN, 'off');
  }
});

test('build failure with busy cleanup keeps its controller open until the same session retries', async () => {
  const h = sessionHarness({ platform: 'linux', buildCode: 1 });
  let stop; let retryWork; let checks = 0; let controllerClosed = false;
  await assert.rejects(runSession({ ...h.options, action: 'build', mode: 'local',
    gracefulDown: async (spec, options) => {
      if (checks++ === 0) throw new Error('Astrid is busy (1 tasks running). Try again when they finish.');
      await h.options.gracefulDown(spec, options);
    },
    openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
    output: (line) => {
      if (!line.includes('Astrid is busy')) return;
      retryWork = (async () => {
        assert.equal(controllerClosed, false);
        assert.equal(h.active.size, 1);
        const retried = await stop();
        assert.equal(retried.ok, true);
      })();
    },
  }), /command failed/);
  await retryWork;
  assert.equal(controllerClosed, true);
  assert.equal(h.active.size, 0);
  assert.equal(checks, 2);
});

test('serve only announces ready after correct health; signal/error/conflict cleanup drains every child', async () => {
  for (const mode of ['backend', 'local']) for (const platform of ['darwin', 'linux', 'win32']) {
    const h = sessionHarness({ platform });
    let requests = 0;
    let published = false;
    await runSession({ ...h.options, action: 'serve', mode,
      request: async (url) => {
        if (url.endsWith('/runtime-config/v1/workspace.json')) return { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) };
        requests++;
        assert.equal(url, mode === 'local' ? 'http://127.0.0.1:5180/tools/video-editor' : library.DOOR_HEALTH_URL);
        return { ok: requests > 1, status: requests > 1 ? 200 : 503, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) };
      }, output: (line) => {
        assert.equal(line, 'ASTRID_PINOKIO_READY'); assert.equal(requests, 2); published = true;
        queueMicrotask(() => h.signals.emit('SIGTERM'));
      },
    });
    assert.equal(published, true);
    assert.equal(h.active.size, 0);
  }
  for (const setting of [{ occupied: true }, { earlyExit: true }]) {
    const h = sessionHarness(setting);
    await assert.rejects(runSession({ ...h.options, action: 'serve', mode: 'local', output: () => assert.fail('published before readiness') }), /5180|quit unexpectedly/);
    assert.equal(h.active.size, 0);
  }
});

test('local update preparation builds before preview and announces READY under one retained Runtime', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let stop;
  let ready = false;
  await runSession({ ...h.options, action: 'serve', mode: 'local', prepareEditor: true,
    openController: async (_root, callback) => { stop = callback; return { close: async () => {} }; },
    request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
      ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
      : { ok: true, status: 200 },
    output: (line) => { assert.equal(line, 'ASTRID_PINOKIO_READY'); ready = true; queueMicrotask(() => h.signals.emit('SIGTERM')); },
  });
  const commandsRun = h.log.map((item) => item.args?.includes('ci') ? 'dependencies'
    : item.args?.includes('--build') ? 'build'
      : item.args?.includes('--preview') ? 'preview'
        : item.command?.endsWith('/run') ? 'runtime' : null).filter(Boolean);
  assert.deepEqual(commandsRun, ['runtime', 'dependencies', 'build', 'preview']);
  assert.equal(ready, true);
  assert.equal(h.active.size, 0);
  assert.equal(typeof stop, 'function');
});

test('Pinokio local update callbacks retain the session owner while restarting and verifying the selected Runtime', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let localUpdate;
  let handoff;
  let ready = false;
  const session = runSession({ ...h.options, action: 'serve', mode: 'local',
    filesystem: { readFileSync: () => 'candidate-v2' },
    resolveInstallation: async (version) => selectedSessionInstall(version, h.options.installed),
    openController: async (_root, _stop, options) => { localUpdate = options.localUpdate; return { close: async () => {} }; },
    request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
      ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
      : { ok: true, status: 200 },
    output: (line) => {
      assert.equal(line, 'ASTRID_PINOKIO_READY'); ready = true;
      handoff = (async () => {
        assert.deepEqual(await localUpdate.begin(), { updating: true });
        await h.options.gracefulDown({ command: '/pinned/python', args: ['down'] });
        assert.deepEqual(await localUpdate.runtime({ version: 'candidate-v2' }),
          { version: 'candidate-v2', ready: true });
        assert.deepEqual(await localUpdate.end(), { updating: false, ready: true });
        const candidate = h.log.findLast((item) => item.command?.endsWith('/run'));
        assert.equal(candidate.options.env.ASTRID_INSTALLER_OPERATION_ID, undefined);
        h.signals.emit('SIGTERM');
      })();
    },
  });
  await session;
  await handoff;
  assert.equal(ready, true);
  assert.ok(h.log.some((item) => item.command === '/astrid/versions/candidate-v2/python' && item.args.includes('status')));
  assert.equal(h.active.size, 0);
});

test('fresh-controller recovery lets the existing App launcher start Runtime before Pinokio normal readiness', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let localUpdate;
  let work;
  const baseSpawn = h.options.spawnProcess;
  h.options.spawnProcess = (command, args, options) => {
    const child = baseSpawn(command, args, options);
    if (args.includes('--preview')) work = (async () => {
      assert.deepEqual(await localUpdate.runtime({ version: 'recovered-v2' }),
        { version: 'recovered-v2', ready: true });
      assert.deepEqual(await localUpdate.end(), { updating: false, ready: true });
    })();
    return child;
  };
  const started = [];
  await runSession({ ...h.options, action: 'serve', mode: 'local', recoverLocalUpdate: true,
    filesystem: { readFileSync: () => 'recovered-v2' },
    resolveInstallation: async (version) => selectedSessionInstall(version, h.options.installed),
    openController: async (_root, _stop, options) => { localUpdate = options.localUpdate; return { close: async () => {} }; },
    request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
      ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
      : { ok: true, status: 200 },
    output: (line) => {
      if (line !== 'ASTRID_PINOKIO_READY') return;
      started.push('ready'); queueMicrotask(() => h.signals.emit('SIGTERM'));
    },
  });
  await work;
  const previewIndex = h.log.findIndex((item) => item.args?.includes('--preview'));
  const runtimeIndex = h.log.findIndex((item) => item.command?.endsWith('/run'));
  assert.ok(previewIndex >= 0 && runtimeIndex > previewIndex, 'the old App launcher requests Runtime through the retained owner');
  assert.ok(h.log.some((item) => item.command === '/astrid/versions/recovered-v2/python' && item.args.includes('status')));
  assert.deepEqual(started, ['ready']);
  assert.equal(h.active.size, 0);
});

test('staged-only local recovery restarts selected stable Runtime when release-app arrives without pinokio-start', async () => {
  const h = sessionHarness({ platform: 'linux' });
  const version = 'stable-v1';
  const journal = JSON.stringify({ format: 'astrid-install-update/v1', step: 'complete',
    transaction_context: { owner: 'local-update' } });
  let handoff;
  let ready = false;
  const filesystem = { readFileSync(file) {
    if (file.endsWith('/current')) return `${version}\n`;
    if (file.endsWith('/update-transaction.json')) return journal;
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  } };
  const session = runSession({ ...h.options, action: 'serve', mode: 'local', recoverLocalUpdate: true,
    filesystem, resolveInstallation: async (selected) => selectedSessionInstall(selected, h.options.installed),
    openController: async (_root, _stop, options) => {
      handoff = options.localUpdate.end();
      await handoff;
      return { close: async () => {} };
    },
    request: async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
    output: (line) => {
      assert.equal(line, 'ASTRID_PINOKIO_READY'); ready = true;
      queueMicrotask(() => h.signals.emit('SIGTERM'));
    },
  });
  await session;
  assert.deepEqual(await handoff, { updating: false, ready: true });
  const runtime = h.log.find((item) => item.command?.endsWith('/run'));
  assert.ok(runtime, 'the retained session starts the old stable Runtime');
  assert.equal(runtime.options.env.ASTRID_INSTALLER_OPERATION_ID, undefined);
  assert.ok(h.log.some((item) => item.command === `/astrid/versions/${version}/python` && item.args.includes('status')));
  assert.equal(ready, true);
  assert.equal(h.active.size, 0);
});

test('staged-only local recovery refuses to adopt an already healthy external Runtime', async () => {
  const h = sessionHarness({ platform: 'linux', externalHealthy: true });
  const filesystem = { readFileSync(file) {
    if (file.endsWith('/current')) return 'stable-v1\n';
    if (file.endsWith('/update-transaction.json')) return JSON.stringify({ step: 'complete', transaction_context: { owner: 'local-update' } });
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  } };
  await assert.rejects(runSession({ ...h.options, action: 'serve', mode: 'local', recoverLocalUpdate: true,
    filesystem, resolveInstallation: async (version) => selectedSessionInstall(version, h.options.installed),
    openController: async (_root, _stop, options) => { await options.localUpdate.end(); return { close: async () => {} }; },
    output: () => assert.fail('must not publish readiness while an external Runtime is active'),
  }), /already healthy outside this Pinokio session/);
  assert.equal(h.log.some((item) => item.command?.endsWith('/run')), false);
  assert.equal(h.log.some((item) => item.down), false);
  assert.equal(h.active.size, 0);
});

test('session CLI accepts only the boolean editor preparation option', () => {
  assert.deepEqual(parseSessionOptions(), { prepareEditor: false, recoverLocalUpdate: false });
  assert.deepEqual(parseSessionOptions('{"prepareEditor":true}'), { prepareEditor: true, recoverLocalUpdate: false });
  assert.deepEqual(parseSessionOptions('{"recoverLocalUpdate":true}'), { prepareEditor: false, recoverLocalUpdate: true });
  for (const value of ['null', '[]', '{"root":"/elsewhere"}', '{"action":"stop"}', '{"prepareEditor":"yes"}', '{']) {
    assert.throws(() => parseSessionOptions(value), /Invalid session options/);
  }
});

test('local update build failures never publish READY and drain the provisional session', async () => {
  for (const failure of [{ dependencyCode: 1 }, { buildCode: 1 }]) {
    const h = sessionHarness({ platform: 'linux', ...failure });
    let ready = false;
    await assert.rejects(runSession({ ...h.options, action: 'serve', mode: 'local', prepareEditor: true,
      request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
        ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
        : { ok: true, status: 200 },
      output: (line) => { if (line === 'ASTRID_PINOKIO_READY') ready = true; },
    }), /command failed/);
    assert.equal(ready, false);
    assert.equal(h.log.some((item) => item.args?.includes('--preview')), false);
    assert.equal(h.active.size, 0);
  }
});

test('transaction-bound serve requires the exact discovery operation id before readiness', async () => {
  const matched = sessionHarness({ platform: 'linux' });
  let ready = false;
  await runSession({ ...matched.options, action: 'serve', mode: 'backend',
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) }),
    output: (line) => { ready = line === 'ASTRID_PINOKIO_READY'; queueMicrotask(() => matched.signals.emit('SIGTERM')); },
  });
  const runtime = matched.log.find((item) => item.command?.endsWith('/run'));
  assert.equal(runtime.options.env.ASTRID_INSTALLER_OPERATION_ID, undefined);
  assert.equal(ready, true);

  const mismatch = sessionHarness({ platform: 'linux' });
  await assert.rejects(runSession({ ...mismatch.options, action: 'serve', mode: 'backend', startupDeadlineMs: 0,
    output: (line) => assert.notEqual(line, 'ASTRID_PINOKIO_READY'),
  }), /didn't start in time/);
  assert.equal(mismatch.active.size, 0);
});


test('macOS vanished/zombie-only groups tolerate EPERM; live groups preserve the failure', () => {
  const killProcess = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  signalGroup(42, 'SIGKILL', { killProcess, snapshot: () => ({ status: 0, stdout: '42 Z\n43 Ss' }) });
  assert.throws(() => signalGroup(42, 'SIGKILL', { killProcess, snapshot: () => ({ status: 0, stdout: '42 S' }) }), /denied/);
  assert.throws(() => signalGroup(42, 'SIGKILL', { killProcess, snapshot: () => ({ status: 1, stdout: '' }) }), /denied/);
});


test('Stop of an idle/partial install and resolving Start without a mode remain safe', async () => {
  const app = fakeApp('darwin', '', null);
  const result = await app.stopOwnedStart({}, () => {}, { api: { running: {}, stop: () => assert.fail('no owner to stop') } });
  assert.equal(result.stopped, false);
  const script = await load('pinokio/start.js', app)({}, {});
  await assert.rejects(script.run[0].method(), /isn't fully installed/);
  const freshLocal = await load('pinokio/install-local.js', app)({}, {});
  assert.equal(freshLocal.run[0].method, app.ensureDoorPortFree);
});


test('controlled Stop runs fenced down before editor cleanup and releases Runtime on every platform and mode', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local']) {
    const h = sessionHarness({ platform });
    let stop;
    let response;
    let downCalled = 0;
    await runSession({ ...h.options, action: 'serve', mode,
      openController: async (_root, callback) => { stop = callback; return { close: async () => {} }; },
      gracefulDown: async (spec, options) => {
        downCalled++;
        assert.deepEqual(spec.args, ['-I', '-m', 'astrid_runtime', 'down', '--profile', 'astrid', '--data-root', '/data', '--source-manifest', '/pinned/profile.json', '--json']);
        assert.equal(options.timeoutMs, 25_000);
        const preview = h.log.find((call) => call.args?.includes('--preview'));
        if (preview) assert.equal(h.active.has(preview.pid), true);
        await h.options.gracefulDown(spec);
      },
      request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1', schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
      output: () => { response = stop(); assert.equal(stop(), response); },
    });
    assert.equal((await response).ok, true);
    assert.equal(downCalled, 1);
    assert.equal(h.active.size, 0);
  }
});

test('busy and unknown down failures preserve both live modes on every platform for retry', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local'])
    for (const reason of ['busy', 'transport', 'timeout', 'generic']) {
    const h = sessionHarness({ platform });
    let stop;
    let response;
    let attempts = 0; let downCalls = 0; let controllerClosed = false;
    const message = reason === 'busy' ? 'Astrid is busy (1 tasks running). Try again when they finish.\ntask-matrix [running]'
      : reason === 'transport' ? 'Controller transport failed.' : reason === 'timeout' ? 'Command timed out' : 'Runtime stop failed.';
    const details = { task_count: 1, blockers: [{ task_id: 'task-matrix', state: 'running' }] };
    const refuseOnce = () => {
      if (attempts++ === 0) {
        const error = new Error(message);
        if (reason === 'busy') error.details = details;
        throw error;
      }
    };
    await runSession({ ...h.options, action: 'serve', mode,
      openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
      gracefulDown: async (_spec, options) => {
        downCalls++;
        refuseOnce();
        await h.options.gracefulDown(_spec, options);
      },
      request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1',
        schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
      output: () => { const before = h.log.length; response = stop().then(async (first) => {
        assert.deepEqual(first, { ok: false, errors: [message], ...(reason === 'busy' ? { details } : {}) });
        assert.equal(h.active.size, mode === 'local' ? 2 : 1);
        assert.equal(controllerClosed, false);
        assert.deepEqual(h.log.slice(before), []); // no signals, taskkill or other cleanup
        return stop();
      }); },
    });
    assert.equal((await response).ok, true);
    assert.equal(attempts, 2);
    assert.equal(downCalls, 2);
    assert.equal(h.active.size, 0);
    assert.equal(controllerClosed, true);
    assert.equal((await stop()).ok, true);
    assert.equal(downCalls, 2);
  }
});

test('cleanup retry after a completed down does not issue a second Runtime stop', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let stop; let response; let downs = 0; let cleanupAttempts = 0;
  await runSession({ ...h.options, action: 'serve', mode: 'local',
    openController: async (_root, callback) => { stop = callback; return { close: async () => {} }; },
    gracefulDown: async () => {
      downs++;
      const runtime = h.log.find((call) => call.command?.endsWith('/run'));
      const child = h.active.get(runtime.pid);
      h.active.delete(runtime.pid); child.emit('close', 0, null);
    },
    killProcess: (group, signal) => {
      const editor = h.log.find((call) => call.args?.includes('--preview'));
      if (editor?.pid === -group && cleanupAttempts++ === 0) throw new Error('editor cleanup unavailable');
      h.options.killProcess(group, signal);
    },
    request: async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
    output: () => { response = stop().then(async (first) => {
      assert.equal(first.ok, false);
      assert.equal(h.active.size, 1);
      assert.equal(downs, 1);
      return stop();
    }); },
  });
  assert.equal((await response).ok, true);
  assert.equal(downs, 1);
  assert.equal(h.active.size, 0);
});

test('hosted updater handoff checks an orderly Runtime exit with idempotent down', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let downCalls = 0; let controllerClosed = false;
  await runSession({ ...h.options, action: 'serve', mode: 'backend',
    gracefulDown: async () => { downCalls++; },
    openController: async () => ({ close: async () => { controllerClosed = true; } }),
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) }),
    output: (line) => {
      if (line !== 'ASTRID_PINOKIO_READY') return;
      const runtime = h.log.find((call) => call.command?.endsWith('/run'));
      const child = h.active.get(runtime.pid);
      h.active.delete(runtime.pid); child.emit('close', 0, null);
    },
  });
  assert.equal(downCalls, 1);
  assert.equal(controllerClosed, true);
  assert.equal(h.active.size, 0);
});

test('Stop before Runtime launch prevents child creation and cannot down external discovery', async () => {
  const h = sessionHarness();
  let down = false;
  await runSession({ ...h.options, action: 'serve', mode: 'local',
    openController: async (_root, callback) => { await callback(); return { close: async () => {} }; },
    gracefulDown: async () => { down = true; },
  });
  assert.equal(down, false);
  assert.equal(h.active.size, 0);
});

test('maintenance never mutates after failed grace, forced stop or held installer lock', async () => {
    for (const platform of ['darwin', 'linux', 'win32']) for (const reason of ['busy', 'unknown', 'force', 'lock']) {
    const log = [];
    const base = fakeApp(platform);
    const filesystem = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ schema_version: 1, mode: 'backend' }),
      rmSync: () => log.push('remove'),
    };
    const app = { ...library.createApp({ platform, appDirectory: base.APP_DIR, filesystem, environment: {}, probe: async () => ({ kind: 'free' }),
      lifecycle: {
        requestGracefulStop: async () => { log.push('grace'); if (reason === 'busy') throw new Error('Astrid is busy (1 tasks running). Try again when they finish.'); if (reason === 'unknown') throw new Error('Runtime stop timed out.'); },
        waitForInstallerLock: async () => { log.push('lock'); if (reason === 'lock') throw new Error('Astrid is still running. Stop it in Pinokio, then try again.'); },
      },
    }), validateExistingEditorCheckout: () => false };
    for (const name of ['reset', 'uninstall', 'uninstall-delete-data', 'add-local']) {
      log.length = 0;
      const module = await load(`pinokio/${name}.js`, app)({}, {});
      const kernel = { api: { running: { [app.paths.join(app.APP_DIR, 'pinokio', 'start.js')]: true }, stop: async () => {
        log.push('force'); if (reason === 'force') throw new Error('force failed');
      } } };
      const run = async () => {
        for (const step of module.run) {
          if (typeof step.method === 'function') await step.method({ input: { confirmation: 'DELETE' } }, () => {}, kernel);
          else if (step.method === 'shell.run') log.push('mutation');
        }
      };
      await assert.rejects(run(), reason === 'busy' ? /Astrid is busy \(1 tasks running\)/ : reason === 'unknown' ? /Runtime stop timed out/ : /Astrid is still running\. Stop it in Pinokio, then try again\./);
      assert.deepEqual(log, reason === 'busy' || reason === 'unknown' ? ['grace']
        : reason === 'force' ? ['grace', 'force'] : ['grace', 'force', 'lock'], `${reason}: ${name}`);
    }
  }
});

test('maintenance waits for delayed lock release after forced cleanup, including idle installs', async () => {
  for (const active of [false, true]) {
    const order = [];
    let release;
    const locked = new Promise((resolve) => { release = resolve; });
    const base = fakeApp('darwin');
    const app = library.createApp({ appDirectory: base.APP_DIR, lifecycle: {
      requestGracefulStop: async () => { order.push('grace'); },
      waitForInstallerLock: async () => { order.push('probe'); await locked; order.push('free'); },
    } });
    const pending = app.stopOwnedStart({}, () => {}, { api: { running: active ? { [app.paths.join(app.APP_DIR, 'pinokio', 'start.js')]: true } : {}, stop: async () => { order.push('force'); } } });
    while (!order.includes('probe')) await Promise.resolve();
    assert.deepEqual(order, active ? ['grace', 'force', 'probe'] : ['probe']);
    release(); await pending;
    assert.equal(order.at(-1), 'free');
  }
});

test('app updater supervisor remains controllable outside the native Start script', async () => {
  const base = fakeApp('darwin');
  const order = [];
  const app = library.createApp({ platform: 'darwin', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: () => JSON.stringify({ schema: 1, pid: 123, port: 9876, token: 'a'.repeat(64) }) },
    processAlive: () => true,
    lifecycle: { requestGracefulStop: async () => order.push('grace'), waitForInstallerLock: async () => order.push('lock') },
  });
  assert.equal(app.hasOwnedSupervisor(), true);
  await app.stopOwnedStart({}, () => {}, { api: { running: {}, stop: async () => order.push('force') } });
  assert.deepEqual(order, ['grace', 'lock']);
  const { menu } = load('pinokio.js', { ...app, readInstallMode: () => 'backend', probeDoor: async () => ({ kind: 'astrid' }) });
  const items = await menu({}, { exists: () => true, running: () => false });
  assert.deepEqual(plain(items.map((item) => item.text)), ['Open Astrid', 'Update and restart', 'Stop']);
});

test('Switch stops on a post-update busy refusal and retries without writing mode', async () => {
  const base = fakeApp('linux');
  const events = [];
  let busy = true;
  const details = { blockers: [{ task_id: 'work', state: 'running' }] };
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    processAlive: () => true, probe: async () => ({ kind: 'free' }),
    filesystem: {
      existsSync: () => true,
      readFileSync: (file) => file.endsWith('install-mode.json')
        ? JSON.stringify({ schema_version: 1, mode: 'backend' })
        : JSON.stringify({ schema: 1, pid: 123, port: 9876, token: 'a'.repeat(64) }),
      mkdirSync() {}, writeFileSync: () => events.push('mode'),
    },
    lifecycle: {
      requestGracefulStop: async () => {
        events.push('stop');
        if (busy && events.includes('update')) throw Object.assign(new Error('Astrid is busy.'), { details });
      },
      waitForInstallerLock: async () => events.push('lock'),
    },
  });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/add-local.js', app)();
  const kernel = { api: { running: {}, stop: () => assert.fail('no native Start owner') } };
  const execute = async () => {
    for (const [index, step] of script.run.entries()) {
      if (typeof step.method === 'function') await step.method({}, undefined, kernel);
      else if (index === 3) events.push('update');
      else if (index === 5) events.push('build');
    }
  };
  await assert.rejects(execute(), (error) => error.message.startsWith('Astrid is busy.') && error.details === details);
  assert.deepEqual(events, ['stop', 'lock', 'update', 'stop']);
  busy = false;
  events.length = 0;
  await execute();
  assert.deepEqual(events, ['stop', 'lock', 'update', 'stop', 'lock', 'build', 'mode']);
});

test('exited Runtime refusal retains editor and controller until the same down succeeds', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local'])
    for (const reason of ['busy', 'unknown']) {
    const h = sessionHarness({ platform });
    let stop; let retry; let downs = 0; let controllerClosed = false;
    const details = { safe: false, blockers: [{ task_id: 'exited-runtime' }] };
    await runSession({ ...h.options, action: 'serve', mode,
      openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
      gracefulDown: async () => {
        if (downs++ < 2) throw Object.assign(new Error('Stop refused after exit.'), reason === 'busy' ? { details } : {});
      },
      request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1',
        schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
      output: (line) => {
        if (line === 'ASTRID_PINOKIO_READY') {
          const runtime = h.log.find((call) => call.command?.endsWith('/run') || call.command?.endsWith('cmd.exe'));
          const child = h.active.get(runtime.pid);
          h.active.delete(runtime.pid); child.emit('close', 0, null);
        } else {
          assert.match(line, /Stop refused after exit/);
          assert.equal(controllerClosed, false);
          assert.equal(h.active.size, mode === 'local' ? 1 : 0);
          // Retry through the retained controller once down is admissible.
          retry = (async () => {
            const result = await stop();
            assert.deepEqual(result, { ok: false, errors: ['Stop refused after exit.'], ...(reason === 'busy' ? { details } : {}) });
            assert.equal(controllerClosed, false);
            assert.equal(h.active.size, mode === 'local' ? 1 : 0);
            assert.equal((await stop()).ok, true);
          })();
        }
      },
    });
    await retry;
    assert.equal(downs, 3);
    assert.equal(controllerClosed, true);
    assert.equal(h.active.size, 0);
  }
});

test('controllerless maintenance uses installed down before lock admission and preserves refusal', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const stale of [false, true])
    for (const reason of ['busy', 'unknown', 'idle']) for (const name of ['stop', 'reset', 'uninstall', 'uninstall-delete-data', 'add-local']) {
    const base = fakeApp(platform);
    const calls = [];
    const details = { safe: false, blockers: [{ task_id: 'controllerless' }] };
    const app = library.createApp({ platform, appDirectory: base.APP_DIR, environment: {}, processAlive: () => true,
      probe: async () => ({ kind: 'free' }), filesystem: {
        existsSync: () => true,
        readFileSync: (file) => {
          if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'backend' });
          if (stale && file.endsWith(CONTROL_FILE)) return JSON.stringify({ schema: 1, pid: 123, port: 1234, token: 'a'.repeat(64) });
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        },
        rmSync: () => calls.push('remove'), mkdirSync: () => calls.push('mkdir'), writeFileSync: () => calls.push('write'),
      }, lifecycle: {
        requestGracefulStop: async () => { calls.push('controller'); return { ok: true, absent: true }; },
        stopRuntime: async (root) => {
          assert.equal(root, app.BACKEND_ROOT); calls.push('down');
          if (reason !== 'idle') throw Object.assign(new Error('Cannot stop selected Runtime.'), reason === 'busy' ? { details } : {});
        },
        waitForInstallerLock: async () => { calls.push('lock'); },
      },
    });
    app.validateExistingEditorCheckout = () => false;
    const factory = load(`pinokio/${name}.js`, app);
    const script = typeof factory === 'function' ? await factory({}, {}) : factory;
    const execute = async () => {
      for (const step of script.run) {
        if (typeof step.method === 'function') await step.method({ input: { confirmation: 'DELETE' } }, () => {},
          { api: { running: {}, stop: () => assert.fail('no active native owner') } });
        else if (step.method !== 'input') calls.push('mutation');
      }
    };
    if (reason === 'idle') {
      await execute();
      assert.deepEqual(calls.slice(0, stale ? 3 : 2), [...(stale ? ['controller'] : []), 'down', 'lock']);
    } else {
      await assert.rejects(execute(), (error) => {
        assert.match(error.message, /Cannot stop selected Runtime/);
        if (reason === 'busy') assert.deepEqual(error.details, details);
        return true;
      });
      assert.deepEqual(calls, [...(stale ? ['controller'] : []), 'down']);
    }
  }
});


test('failed Runtime spawn still requires down before releasing its controller', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const h = sessionHarness({ platform });
    let controllerClosed = false; let downs = 0;
    await assert.rejects(runSession({ ...h.options, action: 'serve', mode: 'local',
      spawnProcess: (command, args, options) => {
        const child = h.options.spawnProcess(command, args, options);
        if (command.endsWith('/run') || command.endsWith('cmd.exe')) queueMicrotask(() => {
          h.active.delete(child.pid); child.pid = undefined; child.emit('error', new Error('Runtime spawn failed.'));
        });
        return child;
      },
      gracefulDown: async () => { downs++; assert.equal(controllerClosed, false); },
      openController: async () => ({ close: async () => { controllerClosed = true; } }),
    }), /Runtime spawn failed/);
    assert.equal(downs, 1);
    assert.equal(controllerClosed, true);
    assert.equal(h.active.size, 0);
  }
});

test('C1 stop report drains without a second down after an automatic down refused', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local']) {
    const h = sessionHarness({ platform });
    let stop; let retry; let downs = 0; let controllerClosed = false;
    await runSession({ ...h.options, action: 'serve', mode,
      openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
      gracefulDown: async () => {
        downs++;
        // The retained revision's two preflight refusals after the Runtime child exited.
        throw new Error(downs % 2
          ? 'Runtime Pinokio interruption refused: no owner or completed-stop evidence.'
          : 'Runtime interruption refused: owner lock has no matching discovery.');
      },
      request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1',
        schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
      output: (line) => {
        if (line === 'ASTRID_PINOKIO_READY') {
          const runtime = h.log.find((call) => call.command?.endsWith('/run') || call.command?.endsWith('cmd.exe'));
          const child = h.active.get(runtime.pid);
          h.active.delete(runtime.pid); child.emit('close', 0, null);
        } else {
          // The exit finalizer's own down refused (an older Runtime CLI).
          assert.match(line, /no owner or completed-stop evidence/);
          retry = (async () => {
            // No report, or any other report, keeps today's down-gated stop.
            assert.equal((await stop()).ok, false);
            assert.equal((await stop({ c1Stopped: false })).ok, false);
            assert.equal(controllerClosed, false);
            assert.equal(h.active.size, mode === 'local' ? 1 : 0);
            assert.equal(downs, 3);
            assert.equal((await stop({ c1Stopped: true })).ok, true);
            assert.equal(downs, 3);
          })();
        }
      },
    });
    await retry;
    assert.equal(controllerClosed, true);
    assert.equal(h.active.size, 0);
  }
});

test('C1 stop report joins a pending automatic down instead of racing it', async () => {
  for (const outcome of ['refused', 'admitted']) {
    const h = sessionHarness({ platform: 'linux' });
    let stop; let work; let downs = 0; let releaseDown; let entered;
    const downEntered = new Promise((resolve) => { entered = resolve; });
    const downBlocked = new Promise((resolve) => { releaseDown = resolve; });
    let controllerClosed = false;
    await runSession({ ...h.options, action: 'serve', mode: 'local',
      openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
      gracefulDown: async () => {
        downs++; entered(); await downBlocked;
        if (outcome === 'refused') throw new Error('Runtime interruption refused: owner lock has no matching discovery.');
      },
      request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1',
        schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
      output: (line) => {
        if (line !== 'ASTRID_PINOKIO_READY') return;
        const runtime = h.log.find((call) => call.command?.endsWith('/run'));
        const child = h.active.get(runtime.pid);
        h.active.delete(runtime.pid); child.emit('close', 0, null);
        work = (async () => {
          await downEntered;
          const reported = stop({ c1Stopped: true });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(h.active.size, 1);
          assert.equal(controllerClosed, false);
          releaseDown();
          assert.equal((await reported).ok, true);
          assert.equal(downs, 1);
        })();
      },
    });
    await work;
    assert.equal(controllerClosed, true);
    assert.equal(h.active.size, 0);
  }
});

test('C1 stop report never signals a still-live Runtime child and stays retryable', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let stop; let work; let closed = false; let downs = 0;
  await runSession({ ...h.options, action: 'serve', mode: 'local',
    openController: async (_root, callback) => { stop = callback; return { close: async () => { closed = true; } }; },
    gracefulDown: async (spec) => { downs++; await h.options.gracefulDown(spec); },
    limit: (promise, ms, label) => label === 'Runtime exit after C1 stop'
      ? Promise.reject(new Error('Runtime exit after C1 stop timed out.')) : bounded(promise, ms, label),
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1',
      schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }),
    output: (line) => {
      if (line !== 'ASTRID_PINOKIO_READY') return;
      work = (async () => {
        const signalsBefore = h.log.filter((call) => call.signal).length;
        assert.deepEqual(await stop({ c1Stopped: true }), { ok: false, errors: ['Runtime exit after C1 stop timed out.'] });
        assert.equal(h.log.filter((call) => call.signal).length, signalsBefore);
        assert.equal(h.active.size, 2);
        assert.equal(closed, false);
        assert.equal(downs, 0);
        // Ordinary Stop still goes through the session's own Runtime down.
        assert.equal((await stop()).ok, true);
        assert.equal(downs, 1);
      })();
    },
  });
  await work;
  assert.equal(h.active.size, 0);
  assert.equal(closed, true);
});
