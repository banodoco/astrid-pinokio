import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import library from '../pinokio/lib.js';
import { backendSessionReady, commands, installation, localSessionReady, runSession, signalGroup } from '../pinokio/session.mjs';

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
  return { ...library.createApp({ platform, appDirectory: base, environment: { ASTRID_APP_REF: ref }, filesystem, lifecycle: { preflightStop: async () => ({ safe: true }), requestGracefulStop: async () => {}, waitForInstallerLock: async () => {} }, probe: async () => ({ kind: 'free' }) }),
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
          update: mode === 'local' ? [] : [app.shellStep(app.launcherPullMessage()).params.message, expected.install],
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
          if (['install-local', 'add-local', 'stop'].includes(name)) assert.equal(script.run[0].method, app.stopOwnedStart);
          if (name === 'reset') assert.equal(script.run[0].method, app.stopForRemoval);
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
          if (name === 'reset') assert.equal(shells.length, 0);
          if (name === 'uninstall-delete-data') {
            await assert.rejects(script.run[1].method({ input: { confirmation: 'delete' } }), /Cancelled, so nothing was deleted/);
            assert.deepEqual(plain(await script.run[1].method({ input: { confirmation: 'DELETE' } })), { confirmed: true });
            assert.equal(typeof script.run[2].method, 'function');
          }
          if (['install-local', 'add-local'].includes(name)) {
            const count = app.writes.length;
            await script.run.at(-1).method();
            assert.equal(app.writes.length, count + 1);
            assert.equal(JSON.parse(app.writes.at(-1).content).mode, 'local');
          }
        }
        // Clone path, including a slash ref and shell metacharacters in app paths.
        assert.equal(app.shellStep(app.cloneEditorMessage()).params.message, expected.clone);
      });
    }
  }
}

test('menu: all operation, installation, starting, ready, external and conflict states', async () => {
  for (const mode of [null, 'backend', 'local']) {
    let probeKind = 'free';
    const app = { ...fakeApp('darwin', '', mode), probeDoor: async () => ({ kind: probeKind,
      ...(probeKind === 'astrid' ? { health: { status: 'ok', protocol: 'workspace.v1', runtime_instance_id: 'selected' } } : {}) }),
      backendSessionReady: async (health) => Boolean(health), localSessionReady: async () => true };
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
    probeKind = 'astrid';
    const ready = await menu({}, info);
    if (!mode) assert.deepEqual(plain(ready.map((item) => item.text)), ['Starting Astrid…', 'Stop']);
    else {
      assert.deepEqual(plain(ready.map((item) => item.text)), ['Open Astrid', mode === 'backend' ? 'Update and restart' : 'Update', 'Stop']);
      assert.equal(ready[0].default, true);
      assert.equal(ready[0].popout, mode !== 'local');
      assert.equal(ready[0].target_full, mode === 'local' ? undefined : local.url);
      assert.equal(ready[0].href, mode === 'local' ? local.url : '/');
      assert.equal(ready.at(-2).default, undefined);
    }
    running = '';
    probeKind = 'astrid';
    const external = await menu({}, info);
    if (!mode) assert.deepEqual(plain(external.map((item) => item.text)), ['Astrid is already running on this computer, but the selected Runtime is not ready. Choose Start again after it is healthy.']);
    else {
      assert.deepEqual(plain(external.map((item) => item.text)), ['Open Astrid', mode === 'backend' ? 'Update and restart' : 'Update', 'Stop']);
      assert.equal(external[0].href, mode === 'local' ? library.LOCAL_OPEN_URL : library.HOSTED_OPEN_URL);
    }
    assert.equal(external.some((item) => item.default), false);
    probeKind = 'occupied';
    const conflict = await menu({}, info);
    assert.match(conflict[0].text, /Another program/);
    assert.equal(conflict[0].href, undefined);
    assert.equal(conflict[0].default, undefined);
  }
});

test('menu never offers Open for unavailable or identity-mismatched Runtime responses', async () => {
  for (const error of ['runtime_unavailable', 'runtime_identity_mismatch']) {
    const app = { ...fakeApp('darwin', '', 'backend'), probeDoor: async () => ({ kind: 'occupied', error }) };
    const { menu } = load('pinokio.js', app);
    const items = await menu({}, { exists: () => true, running: () => false, local: () => ({}) });
    assert.equal(items.some((item) => item.text === 'Open Astrid'), false, error);
  }
  let selectedDoorHealth;
  const app = { ...fakeApp('darwin', '', 'backend'), hasOwnedSupervisor: () => true,
    probeDoor: async () => ({ kind: 'astrid', health: { status: 'ok', protocol: 'workspace.v1', runtime_instance_id: 'selected' } }),
    backendSessionReady: async (health) => { selectedDoorHealth = health; return health?.runtime_instance_id === 'selected'; } };
  const { menu } = load('pinokio.js', app);
  const items = await menu({}, { exists: () => true, running: () => false, local: () => ({}) });
  assert.ok(selectedDoorHealth);
  assert.equal(items.some((item) => item.text === 'Open Astrid'), true);
});

test('active Start and external backend paths suppress Open until selected identity matches', async () => {
  for (const runningStart of [false, true]) for (const response of ['unavailable', 'mismatch', 'matching']) {
    const door = response === 'unavailable'
      ? { kind: 'occupied', error: 'runtime_unavailable' }
      : { kind: 'astrid', health: { status: 'ok', protocol: 'workspace.v1', runtime_instance_id: 'instance', identity: { runtime_head: response } } };
    const app = { ...fakeApp('darwin', '', 'backend'), probeDoor: async () => door,
      backendSessionReady: async (health) => response === 'matching' && health?.identity?.runtime_head === 'matching' };
    const { menu } = load('pinokio.js', app);
    const local = runningStart ? app.localSetOpenTarget('backend') : {};
    const info = { exists: () => true, running: (uri) => runningStart && uri === 'pinokio/start.js', local: () => local };
    const items = await menu({}, info);
    assert.equal(items.some((item) => item.text === 'Open Astrid'), response === 'matching', `${runningStart ? 'active Start' : 'external'} / ${response}`);
  }
});

test('backend session readiness matches CLI status to Door identity and instance', async () => {
  const identity = { release: 1, runtime_head: 'abc', managed_by: 'pinokio' };
  const installed = { env: {}, record: { identity } };
  const status = { support: { healthy: true }, health: { status: 'ok' }, discovery: { runtime_instance_id: 'instance', active_realm: 'realm' } };
  const run = async () => JSON.stringify(status);
  const doorHealth = { status: 'ok', protocol: 'workspace.v1', runtime_instance_id: 'instance', identity };
  assert.equal(await backendSessionReady({ root: '/runtime', editor: '/editor', installed, run, doorHealth }), true);
  assert.equal(await backendSessionReady({ root: '/runtime', editor: '/editor', installed, run,
    doorHealth: { ...doorHealth, identity: { ...identity, runtime_head: 'other' } } }), false);
  assert.equal(await backendSessionReady({ root: '/runtime', editor: '/editor', installed, run,
    doorHealth: { ...doorHealth, runtime_instance_id: 'other' } }), false);
});

test('fully-local menu Open requires matching selected, Door and editor identities', async () => {
  const identity = { release: 3, managed_by: 'pinokio' };
  const installed = { env: {}, record: { identity } };
  const status = { support: { healthy: true }, health: { status: 'ok', identity, runtime_instance_id: 'instance' },
    discovery: { runtime_instance_id: 'instance', active_realm: 'realm' } };
  const run = async () => JSON.stringify(status);
  const request = async (url) => url.includes('runtime-config')
    ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
    : { ok: true };
  assert.equal(await localSessionReady({ root: '/runtime', editor: '/editor', installed, run, request, requireDoor: false,
    probeDoor: async () => ({ kind: 'free' }) }), true, 'Update accepts a healthy local preview with its hosted Door disabled');
  for (const response of ['matching', 'origin_required', 'runtime_identity_mismatch', 'runtime_unavailable']) {
    const door = response === 'matching'
      ? { kind: 'astrid', health: { status: 'ok', protocol: 'workspace.v1', identity, runtime_instance_id: 'instance' } }
      : response === 'origin_required'
        ? { kind: 'astrid', originRequired: true }
      : response === 'runtime_identity_mismatch'
        ? { kind: 'astrid', health: { status: 'ok', protocol: 'workspace.v1', identity: { release: 2, managed_by: 'pinokio' }, runtime_instance_id: 'instance' } }
        : { kind: 'occupied', error: response };
    const ready = await localSessionReady({ root: '/runtime', editor: '/editor', installed, run, request, probeDoor: async () => door });
    const app = { ...fakeApp('darwin', '', 'local'), probeDoor: async () => door,
      localSessionReady: async () => ready };
    const { menu } = load('pinokio.js', app);
    const items = await menu({}, { exists: () => true, running: () => false, local: () => ({}) });
    assert.equal(items.some((item) => item.text === 'Open Astrid'), ['matching', 'origin_required'].includes(response), response);
  }
});

test('Update keeps the local route and uses the shared transaction for hosted mode', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local']) {
    const app = fakeApp(platform, 'feat/pinokio', mode);
    const script = await load('pinokio/update.js', app)({}, {});
    if (mode === 'local') {
      assert.equal(script.run[0].method, app.updateLocal);
      assert.equal(script.run[1].method, 'script.start');
      assert.equal(script.run[1].params.uri, 'start.js');
    } else {
      assert.equal(script.run[0].method, app.preflightStop);
      assert.match(shellMessage(script.run[1], platform), /pull --ff-only/);
      assert.ok(shellMessage(script.run[2], platform).includes('--root'));
    }
  }
});

test('hosted Update refuses at read-only preflight before the launcher pull', async () => {
  const base = fakeApp('linux', '', 'backend');
  const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
    filesystem: { readFileSync: (file) => { if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'backend' }); throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, existsSync: () => false },
    lifecycle: { preflightStop: async () => { throw new Error('Astrid is busy (1 tasks running). Try again when they finish.'); },
      waitForInstallerLock: async () => {} } });
  app.validateExistingEditorCheckout = () => true;
  const script = await load('pinokio/update.js', app)({}, {});
  const executed = [];
  await assert.rejects(async () => {
    for (const step of script.run) {
      if (typeof step.method === 'function') await step.method({}, () => {});
      else executed.push(step);
    }
  }, /Astrid is busy \(1 tasks running\)/);
  assert.deepEqual(executed, []);
  assert.equal(script.run[0].method, app.preflightStop);
  assert.equal(script.run[1].method, 'shell.run');
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

  const chunks = [];
  const installerOutput = [
    "Astrid is still running. Choose Pinokio's Stop button, then try again.\n",
    'Recovered your previous version — run Update again\n',
    'Choose Update to finish\n',
  ];
  let releaseChild;
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  const streamedApp = library.createApp({ platform: 'linux', appDirectory, environment: {},
    spawnProcess: (command, args, options) => {
      assert.equal(command, old.python);
      assert.deepEqual(args, ['-I', '-m', 'astrid', 'install', '--root', root, '--managed-by', 'pinokio']);
      assert.equal(options.stdio[1], 'pipe');
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {};
      child.kill = () => child.emit('close', null, 'SIGTERM');
      releaseChild = () => {
        child.stdout.emit('data', installerOutput[0]);
        child.stderr.emit('data', installerOutput[1]);
        child.stdout.emit('data', installerOutput[2]);
        child.emit('close', 0, null);
      };
      childStarted();
      return child;
    },
  });
  const streamed = streamedApp.recoverPendingUpdate({}, ({ raw }) => chunks.push(raw));
  await started;
  assert.equal(typeof releaseChild, 'function');
  assert.deepEqual(chunks, [], 'the child remains asynchronous while Pinokio can process events');
  releaseChild();
  assert.deepEqual(await streamed, { recovered: true });
  assert.deepEqual(chunks, installerOutput);

  const forged = { ...candidate, root: path.join(temporary, 'outside') };
  fs.writeFileSync(path.join(root, 'update-transaction.json'), JSON.stringify({ format: 'astrid-install-update/v1', step: 'stopping', candidate: forged }));
  invoked = undefined;
  const forgedScript = await load('pinokio/update.js', app)({}, {});
  await assert.rejects(forgedScript.run[0].method({}, () => {}), /outside the installed versions directory/);
  assert.equal(invoked, undefined, 'an out-of-root candidate must not be executed');
});

test('C1 report releases the exited owned session without another Runtime down', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let stop; let stopped; let downs = 0; let controllerClosed = false;
  await runSession({ ...h.options, action: 'serve', mode: 'backend',
    openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
    gracefulDown: async () => { downs++; },
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) }),
    output: (line) => {
      if (line !== 'ASTRID_PINOKIO_READY') return;
      stopped = stop({ c1Stopped: true });
      const runtime = h.log.find((call) => call.command?.endsWith('/run'));
      const child = h.active.get(runtime.pid);
      h.active.delete(runtime.pid); child.emit('close', 0, null);
    },
  });
  assert.equal((await stopped).ok, true);
  assert.equal(downs, 0);
  assert.equal(controllerClosed, true);
  assert.equal(h.active.size, 0);
});

test('C1 report joins an in-flight down refusal before draining the session', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let stop; let work; let downs = 0; let releaseDown; let entered;
  const downEntered = new Promise((resolve) => { entered = resolve; });
  const blockedDown = new Promise((resolve) => { releaseDown = resolve; });
  let controllerClosed = false;
  await runSession({ ...h.options, action: 'serve', mode: 'local',
    openController: async (_root, callback) => { stop = callback; return { close: async () => { controllerClosed = true; } }; },
    gracefulDown: async () => { downs++; entered(); await blockedDown; throw new Error('No selected Runtime owner.'); },
    request: async (url) => url.endsWith('/runtime-config/v1/workspace.json')
      ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'instance', realmId: 'realm' }) }
      : { ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) },
    output: (line) => {
      if (line !== 'ASTRID_PINOKIO_READY') return;
      const runtime = h.log.find((call) => call.command?.endsWith('/run'));
      const child = h.active.get(runtime.pid);
      h.active.delete(runtime.pid); child.emit('close', 0, null);
      work = (async () => {
        await downEntered;
        const reported = stop({ c1Stopped: true });
        assert.equal(controllerClosed, false);
        releaseDown();
        assert.equal((await reported).ok, true);
      })();
    },
  });
  await work;
  assert.equal(downs, 1);
  assert.equal(controllerClosed, true);
  assert.equal(h.active.size, 0);
});


test('Stop and every maintenance caller preserve busy and unknown failures before mutation', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local'])
    for (const stage of ['preflight', 'controller']) for (const reason of ['busy', 'transport', 'timeout', 'generic']) {
    for (const name of ['stop', 'update', 'install-local', 'reset', 'uninstall', 'uninstall-delete-data', ...(mode === 'backend' ? ['add-local'] : [])]) {
      // The final fence for both Update choices is inside the shared Python transaction.
      if (name === 'update' && (stage === 'controller' || mode === 'local')) continue;
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
            if (file.endsWith('update-transaction.json') || file.endsWith('astrid-install.json')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            return JSON.stringify(file.endsWith('install-mode.json') ? { schema_version: 1, mode } : file.endsWith('install.json') ? { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: platform === 'win32' ? 'D:\\data' : '/data' } : file.endsWith('catalog.json') ? { selected_realm_id: null, realms: [] } : { schema: 1, pid: 123, port: 1234 });
          },
          rmSync: () => calls.push('remove'), writeFileSync: () => calls.push('write'), mkdirSync: () => calls.push('mkdir'),
        },
        lifecycle: {
          preflightStop: async () => { calls.push('preflight'); if (stage === 'preflight') fail(); return { safe: true }; },
          requestGracefulStop: async () => { calls.push('controller'); fail(); },
          waitForInstallerLock: async () => calls.push('lock'),
        },
      });
      app.validateExistingEditorCheckout = () => true;
      const module = load(`pinokio/${name}.js`, app);
      const script = typeof module === 'function' ? await module({}, {}) : module;
      const kernel = { api: { running: { [app.paths.join(app.APP_DIR, 'pinokio', 'start.js')]: true },
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
      assert.deepEqual(calls, stage === 'preflight' ? ['preflight'] : ['preflight', 'controller']);
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
  for (const [status, body, expected] of [[200, { status: 'ok', protocol: 'workspace.v1' }, 'astrid'], [503, { error: 'runtime_unavailable' }, 'occupied'], [503, { error: 'runtime_identity_mismatch' }, 'occupied'], [403, { error: 'hosted_origin_required' }, 'astrid'], [200, { status: 'ok' }, 'occupied'], [404, {}, 'occupied']]) {
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
      preflightStop: async () => ({ safe: true }),
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
  operationId, discoveredOperationId = operationId } = {}) {
  const signals = new EventEmitter();
  const log = [];
  let pid = 5000;
  let statusCount = 0;
  const active = new Map();
  const installed = { node: '/pinned/node', npm: '/pinned/npm-cli.js', npx: '/pinned/npx-cli.js', python: '/pinned/python', profile: '/pinned/profile.json', data: '/data', env: operationId ? { ASTRID_INSTALLER_OPERATION_ID: operationId } : {} };
  function close(child, code = 0) { active.delete(child.pid); child.emit('close', code, null); }
  function spawnProcess(command, args, options) {
    const child = new EventEmitter(); child.pid = ++pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    log.push({ command, args, options, pid }); active.set(pid, child);
    queueMicrotask(() => {
      if (command.endsWith('taskkill.exe')) { const target = active.get(Number(args[1])); if (target) close(target); close(child); }
      else if (args.includes('status')) { const healthy = statusCount++ > 0; child.stdout.emit('data', JSON.stringify({ support: { healthy }, health: { status: 'ok' }, discovery: { runtime_instance_id: 'instance', active_realm: 'realm', ...(discoveredOperationId ? { installer_operation_id: discoveredOperationId } : {}) } })); close(child, healthy ? 0 : 1); }
      else if (args.includes('ci')) close(child, dependencyCode);
      else if (args.includes('--build')) close(child, buildCode);
      else if (earlyExit && (command.endsWith('/run') || command.endsWith('cmd.exe'))) close(child, 7);
    });
    return child;
  }
  return { log, active, signals, options: { root: platform === 'win32' ? 'C:\\Astrid' : '/astrid', editor: platform === 'win32' ? 'C:\\editor' : '/editor', platform, installed, spawnProcess, signals,
    checkStop: async () => ({ safe: true }),
    openController: async () => ({ close: async () => {} }),
    gracefulDown: async (spec) => {
      log.push({ down: spec });
      const runtime = log.find((call) => call.command?.endsWith('/run') || call.command?.endsWith('cmd.exe'));
      const child = runtime && active.get(runtime.pid);
      if (child) close(child);
    },
    portOpen: async () => occupied, pause: async () => {}, killProcess: (group, signal) => { log.push({ group, signal }); const child = active.get(-group); if (child) close(child); } } };
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
    checkStop: async () => {
      if (checks++ === 0) throw new Error('Astrid is busy (1 tasks running). Try again when they finish.');
      return { safe: true, blockers: [] };
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

test('transaction-bound serve requires the exact discovery operation id before readiness', async () => {
  const operationId = 'a'.repeat(32);
  const matched = sessionHarness({ platform: 'linux', operationId });
  let ready = false;
  await runSession({ ...matched.options, action: 'serve', mode: 'backend',
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1' }) }),
    output: (line) => { ready = line === 'ASTRID_PINOKIO_READY'; queueMicrotask(() => matched.signals.emit('SIGTERM')); },
  });
  const runtime = matched.log.find((item) => item.command?.endsWith('/run'));
  assert.equal(runtime.options.env.ASTRID_INSTALLER_OPERATION_ID, operationId);
  assert.equal(ready, true);

  const mismatch = sessionHarness({ platform: 'linux', operationId, discoveredOperationId: 'b'.repeat(32) });
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

test('Stop preserves the failing operation and only continues after a separate successful attempt', async () => {
  for (const failingStage of ['preflight', 'graceful', 'lock']) {
    const events = [];
    const original = Object.assign(new Error('controlled stop failure'), { details: { fixture: failingStage } });
    let fail = true;
    const operation = (stage) => async () => {
      events.push(stage);
      if (fail && stage === failingStage) throw original;
    };
    const app = library.createApp({ platform: 'linux', appDirectory: '/fixture/astrid', environment: {},
      filesystem: { existsSync: () => true, readFileSync: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } },
      lifecycle: { preflightStop: operation('preflight'), requestGracefulStop: operation('graceful'),
        waitForInstallerLock: operation('lock') },
    });
    const uri = path.join(app.APP_DIR, 'pinokio', 'start.js');
    const kernel = { api: { running: { [uri]: true }, stop: async () => events.push('kernel-stop') } };
    const stop = load('pinokio/stop.js', app).run[0].method;
    await assert.rejects(stop({}, () => {}, kernel), (error) => {
      assert.equal(error.cause, original);
      assert.equal(error.details, original.details);
      assert.match(error.message, /controlled stop failure/);
      return true;
    });
    const expected = ['preflight', 'graceful', 'kernel-stop', 'lock'];
    assert.deepEqual(events, expected.slice(0, expected.indexOf(failingStage) + 1));
    fail = false;
    events.length = 0;
    assert.deepEqual(await stop({}, () => {}, kernel), { stopped: true, lockFree: true });
    assert.deepEqual(events, expected);
  }
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

test('busy and unknown preflight/down failures preserve both live modes on every platform for retry', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local'])
    for (const stage of ['preflight', 'down']) for (const reason of ['busy', 'transport', 'timeout', 'generic']) {
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
      checkStop: async () => { if (stage === 'preflight') refuseOnce(); return { safe: true }; },
      gracefulDown: async (_spec, options) => {
        downCalls++;
        if (stage === 'down') refuseOnce();
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
    assert.equal(downCalls, stage === 'preflight' ? 1 : 2);
    assert.equal(h.active.size, 0);
    assert.equal(controllerClosed, true);
    assert.equal((await stop()).ok, true);
    assert.equal(downCalls, stage === 'preflight' ? 1 : 2);
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

test('hosted updater handoff requires a completed Runtime down without a C1 report', async () => {
  const h = sessionHarness({ platform: 'linux' });
  let downCalls = 0; let controllerClosed = false;
  await runSession({ ...h.options, action: 'serve', mode: 'backend',
    checkStop: async () => ({ safe: true, blockers: [] }),
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
      readFileSync: (file) => { if (file.endsWith('update-transaction.json') || file.endsWith('astrid-install.json')) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return JSON.stringify(file.endsWith('install.json') ? { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: platform === 'win32' ? 'D:\\data' : '/data' } : file.endsWith('catalog.json') ? { selected_realm_id: null, realms: [] } : { schema_version: 1, mode: 'backend' }); },
      rmSync: () => log.push('remove'),
    };
    const app = { ...library.createApp({ platform, appDirectory: base.APP_DIR, filesystem, environment: {}, probe: async () => ({ kind: 'free' }),
      lifecycle: {
        preflightStop: async () => { log.push('preflight'); if (reason === 'busy') throw new Error('Astrid is busy (1 tasks running). Try again when they finish.'); if (reason === 'unknown') throw new Error('Runtime stop timed out.'); },
        requestGracefulStop: async () => { log.push('grace'); },
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
      assert.deepEqual(log, reason === 'busy' || reason === 'unknown' ? ['preflight']
        : reason === 'force' ? ['preflight', 'grace', 'force'] : ['preflight', 'grace', 'force', 'lock'], `${reason}: ${name}`);
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
      preflightStop: async () => {},
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
    filesystem: { readFileSync: () => JSON.stringify({ schema: 1, pid: 123, port: 9876 }) },
    lifecycle: { preflightStop: async () => order.push('preflight'), requestGracefulStop: async () => order.push('grace'), waitForInstallerLock: async () => order.push('lock') },
  });
  assert.equal(app.hasOwnedSupervisor(), true);
  await app.stopOwnedStart({}, () => {}, { api: { running: {}, stop: async () => order.push('force') } });
  assert.deepEqual(order, ['preflight', 'grace', 'lock']);
  const { menu } = load('pinokio.js', { ...app, readInstallMode: () => 'backend', probeDoor: async () => ({ kind: 'astrid' }), backendSessionReady: async () => true });
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
      preflightStop: async () => ({ safe: true }),
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

test('removal refuses pending updates and program roots overlapping data or selected workspace', async () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'astrid-removal-'));
  try {
    const appDirectory = path.join(temp, 'api', 'Astrid');
    const app = library.createApp({ appDirectory, environment: {}, lifecycle: {
      preflightStop: async () => assert.fail('refusal must precede stop'),
    } });
    fs.mkdirSync(app.BACKEND_ROOT, { recursive: true });
    const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const marker = path.join(app.BACKEND_ROOT, 'install.json');
    const journal = path.join(app.BACKEND_ROOT, 'update-transaction.json');
    const data = path.join(temp, 'data');
    write(marker, { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data });
    const kernel = { api: { running: {}, stop: () => assert.fail('must not stop') } };
    for (const action of ['reset', 'uninstall', 'uninstall-delete-data']) {
      write(journal, { step: 'switched' });
      const script = await load(`pinokio/${action}.js`, app)();
      const step = script.run[action === 'uninstall-delete-data' ? 2 : 0];
      await assert.rejects(step.method({}, () => {}, kernel), /update is interrupted/);
    }
    fs.writeFileSync(journal, '{invalid');
    assert.throws(() => app.assertSafeRemoval(), SyntaxError);
    write(journal, { step: 'complete' });
    for (const root of [app.PROGRAMS_DIR, path.join(app.PROGRAMS_DIR, 'nested'), appDirectory]) {
      write(marker, { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: root });
      assert.throws(() => app.assertSafeRemoval(), /roots overlap/);
    }
    write(marker, { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data });
    write(path.join(data, 'runtime', 'catalog.json'), { selected_realm_id: 'selected', realms: [{ realm_id: 'selected', data_root: path.join(app.PROGRAMS_DIR, 'workspace') }] });
    assert.throws(() => app.assertSafeRemoval(), /workspace roots overlap/);
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(app.PROGRAMS_DIR, alias);
    write(path.join(data, 'runtime', 'catalog.json'), { selected_realm_id: 'selected', realms: [{ realm_id: 'selected', data_root: path.join(alias, 'workspace') }] });
    assert.throws(() => app.assertSafeRemoval(), /workspace roots overlap/);
    write(path.join(data, 'runtime', 'catalog.json'), { selected_realm_id: 'selected', realms: [] });
    assert.throws(() => app.assertSafeRemoval(), /workspace root is unavailable/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('owned partial install reaches the installer, while unowned, live and residual files remain fenced', async () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'astrid-partial-'));
  try {
    const appDirectory = path.join(temp, 'pinokio', 'api', 'Astrid');
    const home = path.join(temp, 'home');
    const app = library.createApp({ appDirectory, environment: { HOME: home }, lifecycle: {
      preflightStop: async () => { throw new Error('preflight unavailable'); },
      waitForInstallerLock: async () => assert.fail('partial defers the lock to installer'),
    } });
    fs.mkdirSync(app.BACKEND_ROOT, { recursive: true });
    const marker = path.join(app.BACKEND_ROOT, 'install.json');
    const selectionFile = path.join(home, '.local', 'share', 'astrid-install.json');
    const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
    const idle = { api: { running: {}, stop: () => assert.fail('no session') } };
    await assert.rejects(app.stopForUninstall({}, () => {}, idle), /unowned or incomplete/);
    write(marker, { owner: 'other', managed_by: 'pinokio', data_root: path.join(temp, 'data') });
    await assert.rejects(app.stopForUninstall({}, () => {}, idle), /unowned/);
    assert.ok(fs.existsSync(marker));
    write(marker, { owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: path.join(temp, 'data') });
    assert.deepEqual(await app.stopForUninstall({}, () => {}, idle), { partial: true });
    assert.throws(() => app.finishUninstall(), /could not remove all program files/);
    write(selectionFile, { realm_root: path.join(app.EDITOR_DIR, 'realm') });
    await assert.rejects(app.stopForUninstall({}, () => {}, idle), /workspace roots overlap/);
    write(selectionFile, { data_root: app.EDITOR_DIR });
    await assert.rejects(app.stopForUninstall({}, () => {}, idle), /data roots overlap/);
    fs.unlinkSync(selectionFile);
    fs.writeFileSync(path.join(app.BACKEND_ROOT, 'pinokio-control.json'), '{}');
    await assert.rejects(app.stopForUninstall({}, () => {}, idle), /preflight unavailable/);
    fs.unlinkSync(path.join(app.BACKEND_ROOT, 'pinokio-control.json'));
    const active = { api: { running: { [path.join(appDirectory, 'pinokio', 'start.js')]: true } } };
    await assert.rejects(app.stopForUninstall({}, () => {}, active), /preflight unavailable/);
    const menu = load('pinokio.js', { ...app, probeDoor: async () => ({ kind: 'free' }) });
    const items = await menu.menu({}, { running: () => false, exists: (p) => p === 'app/astrid/install.json', local: () => ({}) });
    assert.ok(items.some((item) => item.text === 'Uninstall'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('failed owned installation can finish through the installer uninstall route', async () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'astrid-recovery-'));
  try {
    const app = library.createApp({ appDirectory: path.join(temp, 'pinokio', 'api', 'Astrid'), environment: { HOME: path.join(temp, 'home') }, probe: async () => ({ kind: 'free' }) });
    fs.mkdirSync(app.BACKEND_ROOT, { recursive: true });
    fs.writeFileSync(path.join(app.BACKEND_ROOT, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: path.join(temp, 'data') }));
    fs.writeFileSync(path.join(app.BACKEND_ROOT, 'staged-file'), 'failed before Runtime staging');
    const script = await load('pinokio/uninstall.js', app)();
    const calls = [];
    for (const step of script.run) {
      if (typeof step.method === 'function') await step.method({}, () => {}, { api: { running: {} } });
      else if (step.method === 'shell.run') {
        assert.match(step.params.message, /--uninstall/);
        calls.push('installer');
        // Simulate a successful installer-owned removal, including its lock and stop checks.
        fs.rmSync(app.BACKEND_ROOT, { recursive: true });
      }
    }
    assert.deepEqual(calls, ['installer']);
    assert.equal(fs.existsSync(app.PROGRAMS_DIR), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('uninstall rechecks captured roots and current selection and preserves unrelated app files', () => {
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'astrid-recheck-'));
  try {
    const home = path.join(temp, 'home');
    const app = library.createApp({ appDirectory: path.join(temp, 'pinokio', 'api', 'Astrid'), environment: { HOME: home } });
    const safe = path.join(temp, 'safe');
    const data = path.join(temp, 'data-link');
    fs.mkdirSync(app.BACKEND_ROOT, { recursive: true });
    fs.mkdirSync(app.EDITOR_DIR, { recursive: true });
    fs.mkdirSync(safe);
    fs.symlinkSync(safe, data);
    fs.writeFileSync(path.join(app.BACKEND_ROOT, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data }));
    const roots = app.assertSafeRemoval();
    fs.rmSync(app.BACKEND_ROOT, { recursive: true });
    fs.unlinkSync(data);
    fs.symlinkSync(app.EDITOR_DIR, data);
    assert.throws(() => app.finishUninstall(roots), /roots overlap/);
    assert.ok(fs.existsSync(app.EDITOR_DIR));
    fs.unlinkSync(data);
    fs.symlinkSync(safe, data);
    const selection = path.join(home, '.local', 'share', 'astrid-install.json');
    fs.mkdirSync(path.dirname(selection), { recursive: true });
    fs.writeFileSync(selection, JSON.stringify({ realm_root: app.EDITOR_DIR }));
    assert.throws(() => app.finishUninstall(roots), /workspace roots overlap/);
    fs.unlinkSync(selection);
    const unrelated = path.join(app.PROGRAMS_DIR, 'personal');
    fs.writeFileSync(unrelated, 'keep');
    assert.throws(() => app.finishUninstall(roots), /unrecognized files/);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('isolated update preparation preserves the checkout and reports build and race failures', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { prepareCandidate } = await import('../pinokio/update-stage.mjs');
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pinokio-stage-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'remote.git');
  const seed = path.join(parent, 'seed');
  const editor = path.join(parent, 'editor');
  const stage = path.join(parent, 'stage');
  fs.mkdirSync(stage);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(parent, 'init', '--bare', '--initial-branch=main', remote);
  git(parent, 'init', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'Fixture');
  git(seed, 'config', 'user.email', 'fixture@example.invalid');
  fs.mkdirSync(path.join(seed, 'public'));
  fs.writeFileSync(path.join(seed, 'public/install-manifest.json'), '{"release":1}');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'dist/\nnode_modules/\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'old');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-u', 'origin', 'main');
  git(parent, 'clone', remote, editor);
  const original = git(editor, 'rev-parse', 'HEAD');
  const remoteTracking = git(editor, 'rev-parse', 'origin/main');
  fs.mkdirSync(path.join(editor, 'dist'));
  fs.mkdirSync(path.join(editor, 'node_modules'));
  fs.writeFileSync(path.join(editor, 'dist', 'old-build'), 'old build bytes');
  fs.writeFileSync(path.join(editor, 'node_modules', 'old-dependency'), 'old dependency bytes');
  const assertOriginal = () => {
    assert.equal(git(editor, 'rev-parse', 'HEAD'), original);
    assert.equal(git(editor, 'branch', '--show-current'), 'main');
    assert.equal(git(editor, 'rev-parse', 'origin/main'), remoteTracking);
    assert.equal(fs.readFileSync(path.join(editor, 'dist', 'old-build'), 'utf8'), 'old build bytes');
    assert.equal(fs.readFileSync(path.join(editor, 'node_modules', 'old-dependency'), 'utf8'), 'old dependency bytes');
  };
  fs.writeFileSync(path.join(seed, 'public/install-manifest.json'), '{"release":2}');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'new'); git(seed, 'push', 'origin', 'main');
  const target = git(seed, 'rev-parse', 'HEAD');
  const selection = path.join(parent, 'current');
  const data = path.join(parent, 'project');
  fs.writeFileSync(selection, 'old-runtime\n'); fs.writeFileSync(data, Buffer.from([0, 1, 2, 255]));
  const installed = { node: 'fixture-node', npx: 'npx', npm: 'npm', env: {} };
  const run = async (command, args, options) => {
    if (command === 'git') return { stdout: git(options.cwd, ...args) };
    assert.fail(`unexpected command: ${command}`);
  };
  const root = path.join(parent, 'runtime');
  const failureBuild = async (options) => {
    assert.equal(options.action, 'build');
    assert.equal(options.mode, 'local');
    assert.equal(options.root, root);
    assert.notEqual(options.editor, editor);
    assert.equal(options.installed.env.VITE_APP_BUILD, target);
    assert.equal(options.installed.env.RAILWAY_GIT_COMMIT_SHA, target);
    throw new Error('controlled build failure');
  };
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: failureBuild }), /controlled build failure/);
  assert.equal(git(editor, 'rev-parse', 'HEAD'), original);
  assertOriginal();
  assert.equal(fs.readFileSync(selection, 'utf8'), 'old-runtime\n');
  assert.deepEqual(fs.readFileSync(data), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(fs.readdirSync(stage), []);
  const successBuild = async (options) => {
    assert.equal(options.installed.env.VITE_APP_BUILD, target);
    fs.mkdirSync(path.join(options.editor, 'dist'));
    fs.writeFileSync(path.join(options.editor, 'dist/build.json'), JSON.stringify({ app: target, release: 2 }));
  };
  const moduleUrl = new URL('../pinokio/update-stage.mjs', import.meta.url).href;
  const interrupted = `import { prepareCandidate } from ${JSON.stringify(moduleUrl)};
    await prepareCandidate({ editor: process.env.FIXTURE_EDITOR, ref: 'main', remote: process.env.FIXTURE_REMOTE,
      stagingRoot: process.env.FIXTURE_STAGE, root: process.env.FIXTURE_ROOT, installed: { env: {} },
      build: async () => process.exit(42) });`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', interrupted], {
    env: { ...process.env, FIXTURE_EDITOR: editor, FIXTURE_REMOTE: remote, FIXTURE_STAGE: stage, FIXTURE_ROOT: root },
    stdio: 'pipe',
  }), (error) => error.status === 42);
  const interruptedLock = path.join(stage, 'astrid-update.lock');
  const evidence = fs.readFileSync(path.join(interruptedLock, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(evidence.map((entry) => entry.phase), ['acquired', 'snapshot', 'staging', 'building']);
  assert.equal(evidence[1].sha, original);
  assert.equal(evidence[3].target, target);
  assertOriginal();
  assert.equal(fs.readFileSync(selection, 'utf8'), 'old-runtime\n');
  assert.deepEqual(fs.readFileSync(data), Buffer.from([0, 1, 2, 255]));
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: successBuild }), /needs inspection/);
  fs.rmSync(evidence[2].parent, { recursive: true });
  fs.rmSync(interruptedLock, { recursive: true });
  const prepared = await prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: successBuild });
  const preparedEvidence = fs.readFileSync(path.join(stage, 'astrid-update.lock', 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(preparedEvidence.at(-1).phase, 'prepared');
  assert.equal(preparedEvidence.at(-1).target, target);
  assert.equal(prepared.targetSha, target);
  assert.equal(prepared.oldSha, original);
  assert.equal(git(editor, 'rev-parse', 'HEAD'), original);
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: successBuild }), /already in progress/);
  await Promise.all([prepared.cleanup(), prepared.cleanup()]);
  await prepared.cleanup();
  assert.deepEqual(fs.readdirSync(stage), []);
  const staleLock = path.join(stage, 'astrid-update.lock');
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'owner-evidence'), 'preserve');
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: successBuild }), /needs inspection/);
  assert.equal(fs.readFileSync(path.join(staleLock, 'owner-evidence'), 'utf8'), 'preserve');
  fs.rmSync(staleLock, { recursive: true });
  const mismatchBuild = async (options) => {
    await successBuild(options);
    fs.writeFileSync(path.join(options.editor, 'dist/build.json'), JSON.stringify({ app: target, release: 999 }));
  };
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: mismatchBuild }), /build identity/);
  assert.deepEqual(fs.readdirSync(stage), []);
  const tamperedBuild = async (options) => {
    await successBuild(options);
    fs.writeFileSync(path.join(options.editor, 'public/install-manifest.json'), '{"release":3}');
  };
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: tamperedBuild }), /Candidate checkout changed/);
  assert.equal(git(editor, 'rev-parse', 'HEAD'), original);
  assert.equal(fs.readFileSync(selection, 'utf8'), 'old-runtime\n');
  assert.deepEqual(fs.readFileSync(data), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(fs.readdirSync(stage), []);
  const failureRaceBuild = async () => {
    fs.writeFileSync(path.join(editor, 'failure-race'), 'keep');
    throw new Error('controlled failure with checkout race');
  };
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: failureRaceBuild }),
    /Editor checkout changed during staging.*controlled failure with checkout race/);
  assert.equal(fs.readFileSync(path.join(editor, 'failure-race'), 'utf8'), 'keep');
  const raceLock = path.join(stage, 'astrid-update.lock');
  const raceEvidence = fs.readFileSync(path.join(raceLock, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(raceEvidence.at(-1).phase, 'checkout-uncertain');
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: successBuild }), /needs inspection/);
  fs.rmSync(raceEvidence.find((entry) => entry.phase === 'staging').parent, { recursive: true });
  fs.rmSync(raceLock, { recursive: true });
  fs.rmSync(path.join(editor, 'failure-race'));
  const raceBuild = async (options) => {
    await successBuild(options);
    fs.writeFileSync(path.join(editor, 'user-change'), 'keep');
  };
  await assert.rejects(prepareCandidate({ editor, ref: 'main', remote, stagingRoot: stage, root, installed, run, build: raceBuild }), /changed during staging/);
  assert.equal(fs.readFileSync(path.join(editor, 'user-change'), 'utf8'), 'keep');
  assertOriginal();
  assert.ok(fs.existsSync(path.join(stage, 'astrid-update.lock', 'journal.jsonl')));
});

test('fully-local Update route stages failure, promotes success, and reports installer failure', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { buildWithSession } = await import('../pinokio/update-stage.mjs');
  for (const outcome of ['build failure', 'success', 'installer failure', 'installer refusal']) {
    const parent = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pinokio-route-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const remote = path.join(parent, 'remote.git');
    const seed = path.join(parent, 'seed');
    const appDirectory = path.join(parent, 'home', 'api', 'astrid');
    const programs = path.join(appDirectory, 'app');
    const editor = path.join(programs, 'editor');
    const runtime = path.join(programs, 'astrid');
    const data = path.join(parent, 'data');
    fs.mkdirSync(programs, { recursive: true }); fs.mkdirSync(runtime); fs.mkdirSync(data);
    git(parent, 'init', '--bare', '--initial-branch=main', remote);
    git(parent, 'clone', remote, seed);
    git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
    fs.mkdirSync(path.join(seed, 'public'));
    fs.writeFileSync(path.join(seed, '.gitignore'), 'dist/\nnode_modules/\n');
    fs.writeFileSync(path.join(seed, 'public/install-manifest.json'), '{"release":1}');
    fs.mkdirSync(path.join(seed, 'scripts'));
    fs.writeFileSync(path.join(seed, 'scripts', 'dev-local-workspace.mjs'), `import fs from 'node:fs';
      if (process.env.FIXTURE_BUILD_FAIL === '1') { console.error('controlled build failure'); process.exit(7); }
      fs.mkdirSync('dist'); fs.writeFileSync('dist/build.json', JSON.stringify({ app: process.env.VITE_APP_BUILD, release: 2 }));`);
    const npx = path.join(parent, 'fixture-npx.cjs');
    fs.writeFileSync(npx, "require('node:fs').mkdirSync('node_modules'); require('node:fs').writeFileSync('node_modules/new', 'candidate dependencies');");
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'old'); git(seed, 'push', 'origin', 'main');
    git(programs, 'clone', remote, editor);
    const old = git(editor, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(editor, 'dist')); fs.mkdirSync(path.join(editor, 'node_modules'));
    fs.writeFileSync(path.join(editor, 'dist', 'old'), 'ignored build');
    fs.writeFileSync(path.join(editor, 'node_modules', 'old'), 'ignored dependency');
    fs.writeFileSync(path.join(runtime, 'current'), 'selected-runtime\n');
    fs.writeFileSync(path.join(data, 'project'), Buffer.from([0, 1, 2, 255]));
    fs.writeFileSync(path.join(programs, 'install-mode.json'), '{"schema_version":1,"mode":"local"}');
    fs.writeFileSync(path.join(seed, 'public/install-manifest.json'), '{"release":2}');
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'new'); git(seed, 'push', 'origin', 'main');
    const target = git(seed, 'rev-parse', 'HEAD');
    const events = [];
    let ready = true;
    const app = library.createApp({ platform: 'linux', appDirectory, environment: process.env,
      lifecycle: { preflightStop: async () => { events.push('preflight'); },
        requestGracefulStop: async () => { events.push('stop'); ready = false; }, waitForInstallerLock: async () => {} },
      localUpdateOperations: {
        installation: async () => ({ node: process.execPath, npx, env: { ...process.env, FIXTURE_BUILD_FAIL: outcome === 'build failure' ? '1' : '0' } }), ready: async () => ready,
        run: async (cmd, args, options) => {
          assert.equal(cmd, 'git');
          const mapped = args.map((arg) => arg === library.EDITOR_REPOSITORY ? remote : arg);
          return { stdout: git(options.cwd, ...mapped) };
        },
        build: async (options) => {
          events.push('build'); assert.equal(options.running, true); assert.equal(ready, true);
          assert.notEqual(options.editor, editor);
          await buildWithSession(options);
        },
        installer: async (_cmd, args) => {
          events.push('installer'); assert.equal(git(editor, 'rev-parse', 'HEAD'), target);
          assert.match(args.join(' '), /--update/); assert.match(args.join(' '), /install-manifest\.json/);
          if (outcome === 'installer refusal') {
            const error = new Error('controlled refusal');
            error.details = { fixture: 'opaque refusal details' };
            return { status: null, error };
          }
          return { status: outcome === 'installer failure' ? 1 : 0, stderr: outcome === 'installer failure' ? 'controlled installer failure' : '' };
        },
      } });
    app.validateExistingEditorCheckout = () => true;
    const script = await load('pinokio/update.js', app)();
    const uri = path.join(appDirectory, 'pinokio', 'start.js');
    const kernel = { api: { running: { [uri]: true }, stop: async () => events.push('kernel-stop') } };
    if (outcome === 'build failure') {
      await assert.rejects(script.run[0].method({}, () => {}, kernel), /controlled build failure/);
      assert.deepEqual(events, ['build']);
      assert.equal(ready, true);
      assert.equal(git(editor, 'rev-parse', 'HEAD'), old);
      assert.equal(git(editor, 'branch', '--show-current'), 'main');
      assert.equal(fs.readFileSync(path.join(editor, 'dist', 'old'), 'utf8'), 'ignored build');
      assert.equal(fs.readFileSync(path.join(editor, 'node_modules', 'old'), 'utf8'), 'ignored dependency');
    } else {
      if (outcome === 'installer refusal') await assert.rejects(script.run[0].method({}, () => {}, kernel), (error) => {
        assert.match(error.message, /Editor promoted, but the installer update failed.*controlled refusal/);
        assert.deepEqual(error.details, { fixture: 'opaque refusal details' });
        assert.equal(error.cause.message, 'controlled refusal');
        return true;
      });
      else if (outcome === 'installer failure') await assert.rejects(script.run[0].method({}, () => {}, kernel), /Editor promoted, but the installer update failed.*controlled installer failure/);
      else await script.run[0].method({}, () => {}, kernel);
      assert.deepEqual(events, ['build', 'preflight', 'stop', 'kernel-stop', 'installer']);
      assert.equal(git(editor, 'rev-parse', 'HEAD'), target);
      assert.equal(JSON.parse(fs.readFileSync(path.join(editor, 'dist', 'build.json'))).app, target);
      assert.equal(fs.readFileSync(path.join(editor, 'node_modules', 'new'), 'utf8'), 'candidate dependencies');
      assert.equal(script.run[1].method, 'script.start');
    }
    assert.equal(fs.readFileSync(path.join(runtime, 'current'), 'utf8'), 'selected-runtime\n');
    assert.deepEqual(fs.readFileSync(path.join(data, 'project')), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(fs.readdirSync(programs).filter((file) => file.startsWith('astrid-update')), []);
  }
});

test('Update preflight failure, separate Stop and rebuilt retry preserve ordering in fixtures', async () => {
  for (const mode of ['backend', 'local']) {
    const events = [];
    let refuse = true;
    const base = fakeApp('linux', '', mode);
    const app = library.createApp({ platform: 'linux', appDirectory: base.APP_DIR, environment: {},
      filesystem: {
        readFileSync(file) {
          if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode });
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        },
        existsSync: (file) => file === base.PROGRAMS_DIR,
      },
      lifecycle: {
        preflightStop: async () => { events.push('preflight'); if (refuse) throw new Error('fixture preflight failure'); },
        requestGracefulStop: async () => { events.push('graceful-stop'); },
        waitForInstallerLock: async () => { events.push('lock'); },
      },
      localUpdateOperations: {
        installation: async () => ({}), ready: async () => true,
        prepare: async () => {
          events.push('prepare');
          return { old: { revision: 'fixture' }, snapshot: async () => ({ revision: 'fixture' }),
            cleanup: async () => { events.push('cleanup'); } };
        },
        promote: async () => { events.push('promote'); },
        installer: async () => { events.push('installer'); return { status: 0 }; },
      },
    });
    app.validateExistingEditorCheckout = () => true;
    const uri = app.paths.join(app.APP_DIR, 'pinokio', 'start.js');
    const kernel = { api: { running: { [uri]: true }, stop: async () => {
      events.push('kernel-stop'); delete kernel.api.running[uri];
    } } };
    const update = load('pinokio/update.js', app);
    const first = await update();
    await assert.rejects(first.run[0].method({}, () => {}, kernel), /fixture preflight failure/);
    assert.deepEqual(events, mode === 'backend' ? ['preflight'] : ['prepare', 'preflight', 'cleanup']);
    assert.equal(kernel.api.running[uri], true);

    refuse = false;
    events.length = 0;
    const stop = load('pinokio/stop.js', app);
    await stop.run[0].method({}, () => {}, kernel);
    assert.deepEqual(events, ['preflight', 'graceful-stop', 'kernel-stop', 'lock']);
    assert.equal(kernel.api.running[uri], undefined);

    events.length = 0;
    const retry = await update();
    await retry.run[0].method({}, () => {}, kernel);
    if (mode === 'backend') {
      assert.deepEqual(events, ['preflight']);
      assert.deepEqual(Array.from(retry.run.slice(1), (step) => step.method), ['shell.run', 'shell.run']);
    } else {
      assert.deepEqual(events, ['prepare', 'preflight', 'lock', 'promote', 'installer', 'cleanup']);
      assert.equal(retry.run[1].method, 'script.start');
    }
  }
});
