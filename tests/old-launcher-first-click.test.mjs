import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// This is a simulation of action arrays, not an engine or installer run.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = 'bbba620e3d89eeff8021417f365e6ea584203105';
const nodeRequire = createRequire(import.meta.url);
const source = (file) => execFileSync('git', ['show', `${revision}:${file}`], { cwd: repo, encoding: 'utf8' });

function historicalModule(file, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source(file), {
    module, exports: module.exports, __dirname: path.join(repo, path.dirname(file)), process, Buffer,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith('node:')) return nodeRequire(name);
      throw new Error(`Unexpected historical dependency: ${name}`);
    },
  }, { filename: `${revision}:${file}` });
  return module.exports;
}

function fixture(mode) {
  const posix = historicalModule('pinokio/platforms/posix.js');
  const windows = historicalModule('pinokio/platforms/windows.js');
  const lib = historicalModule('pinokio/lib.js', { './platforms/posix': posix, './platforms/windows': windows });
  const events = [];
  let running = false;
  const appDirectory = '/fixture/pinokio/Astrid';
  const filesystem = {
    readFileSync(file) {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode });
      throw Object.assign(new Error('fixture file absent'), { code: 'ENOENT' });
    },
    existsSync: () => false,
  };
  const app = lib.createApp({ platform: 'linux', appDirectory, filesystem, environment: {},
    probe: async () => ({ kind: 'free' }),
    lifecycle: {
      requestGracefulStop: async () => { events.push('graceful-stop'); running = false; },
      waitForInstallerLock: async () => { events.push('lock-check'); },
    },
  });
  app.validateExistingEditorCheckout = () => true;
  const calls = [];
  const bootstrap = app.bootstrapScript;
  app.bootstrapScript = (...args) => { calls.push(args); return bootstrap(...args); };
  const load = (file) => historicalModule(`pinokio/${file}.js`, { './lib': app });
  const startUri = path.posix.join(appDirectory, 'pinokio', 'start.js');
  const kernel = { api: { running: {}, stop: async () => { events.push('kernel-stop'); running = false; delete kernel.api.running[startUri]; } } };
  return {
    app, calls, events, load, kernel,
    setRunning(value) { running = value; if (value) kernel.api.running[startUri] = true; else delete kernel.api.running[startUri]; },
    isRunning: () => running,
  };
}

// An adapter must return 'ok', 'failure', or 'unknown' for every shell step.
// Even all-ok steps are insufficient without an independently observed ready state.
async function simulateAction(action, kernel, shell, observeReady) {
  let completed = 0;
  let installerCompleted = false;
  for (const step of action.run) {
    if (typeof step.method === 'function') {
      try { await step.method({}, () => {}, kernel); } catch { return { outcome: 'failure', completed }; }
    } else if (step.method === 'shell.run') {
      const result = await shell(step, completed);
      if (result === 'failure') return { outcome: 'failure', completed };
      if (result !== 'ok') return { outcome: 'unknown', completed };
      if (step.params?.message?.includes('--managed-by')) installerCompleted = true;
    } else {
      throw new Error(`Unmodelled action step: ${step.method}`);
    }
    completed++;
  }
  if (!installerCompleted) return { outcome: 'unknown', completed };
  return { outcome: (await observeReady()) === true ? 'ready' : 'unknown', completed };
}

for (const mode of ['backend', 'local']) {
  test(`historical ${mode}: stopped first click and Stop/retry are observable without inventing readiness`, async () => {
    const f = fixture(mode);
    const update = f.load('update');
    const first = await update(); // Array is built before the launcher pull executes.
    const expected = mode === 'backend' ? ['update-app'] : ['update', '/fixture/pinokio/Astrid/app/editor/public/install-manifest.json'];
    assert.deepEqual(f.calls[0], expected);
    const messages = Array.from(first.run, (step) => step.params?.message || 'custom');
    const pullIndex = messages.findIndex((message) => message.includes('pull --ff-only'));
    const installerIndex = messages.findIndex((message) => message.includes('--managed-by'));
    assert.ok(pullIndex >= 0 && installerIndex > pullIndex);
    assert.match(messages[installerIndex], mode === 'backend' ? /--update-app/ : /--update/);
    assert.equal(f.isRunning(), false);

    const firstSteps = [];
    const firstResult = await simulateAction(first, f.kernel, async (_step, index) => {
      firstSteps.push(index);
      return index === installerIndex ? 'failure' : 'ok';
    }, async () => { assert.fail('failed installer must not be treated as ready'); });
    assert.equal(firstResult.outcome, 'failure');
    assert.equal(firstResult.completed, installerIndex);
    assert.equal(firstSteps.at(-1), installerIndex);

    // Invoke the historical Stop action, then rebuild Update as a new click.
    const stop = f.load('stop');
    assert.equal(typeof stop.run[0].method, 'function');
    await stop.run[0].method({}, () => {}, f.kernel);
    assert.equal(f.isRunning(), false);
    assert.ok(f.events.includes('lock-check'));
    const retry = await update();
    assert.deepEqual(f.calls[1], expected);
    const noObservation = await simulateAction(retry, f.kernel, async () => 'ok', async () => undefined);
    assert.equal(noObservation.outcome, 'unknown');
    assert.equal(noObservation.completed, retry.run.length);
    const withoutInstaller = { run: Array.from(retry.run).filter((step) => !step.params?.message?.includes('--managed-by')) };
    const missing = await simulateAction(withoutInstaller, f.kernel, async () => 'ok', async () => { assert.fail('missing installer must not be ready'); });
    assert.equal(missing.outcome, 'unknown');
    const unknown = await simulateAction(retry, f.kernel, async () => 'unknown', async () => { assert.fail('unsettled action must not be ready'); });
    assert.equal(unknown.outcome, 'unknown');
    // Controlled adapter results exercise the harness only, not product success.
    const observed = await simulateAction(retry, f.kernel, async () => 'ok', async () => true);
    assert.equal(observed.outcome, 'ready');
    assert.equal(observed.completed, retry.run.length);
  });
}

test('running-old refusal remains failure until a separate Stop and retry', async () => {
  const f = fixture('backend');
  f.setRunning(true);
  const update = f.load('update');
  const action = await update();
  const installerIndex = Array.from(action.run).findIndex((step) => step.params?.message?.includes('--managed-by'));
  const refused = await simulateAction(action, f.kernel, async (_step, index) => index === installerIndex ? 'failure' : 'ok', async () => { assert.fail('refusal is not ready'); });
  assert.equal(refused.outcome, 'failure');
  assert.equal(f.isRunning(), true);
  await f.load('stop').run[0].method({}, () => {}, f.kernel);
  assert.equal(f.isRunning(), false);
  assert.deepEqual(f.events, ['graceful-stop', 'kernel-stop', 'lock-check']);
  const retry = await update();
  const result = await simulateAction(retry, f.kernel, async (_step, index) => index === installerIndex ? 'failure' : 'ok', async () => { assert.fail('failed retry is not ready'); });
  assert.equal(result.outcome, 'failure');
});
