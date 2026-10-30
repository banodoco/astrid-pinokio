import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = path.resolve(repository, '../../../../astrid-agent');
const revisions = ['bbba620e', 'c3b4cd5', '5e1f256'];

function oldModule(revision, file, app) {
  const source = revision === 'working' ? fs.readFileSync(path.join(repository, file), 'utf8')
    : execFileSync('git', ['show', `${revision}:${file}`], { cwd: repository, encoding: 'utf8' });
  const module = { exports: {} };
  const require = (name) => name === './lib' ? app : requireFromNode(name);
  function requireFromNode(name) { return createRequireFromHere(name); }
  function createRequireFromHere(name) {
    // These old action modules only import ./lib; keep any unexpected import loud.
    throw new Error(`Unexpected import from historical launcher action: ${name}`);
  }
  vm.runInNewContext(source, { module, exports: module.exports, require }, { filename: `${revision}:${file}` });
  return module.exports;
}

function fixture(mode, editorExists = true) {
  const calls = [];
  const app = {
    APP_DIR: '/tmp/pinokio/Astrid',
    EDITOR_DIR: '/tmp/pinokio/Astrid/app/astrid',
    paths: path.posix,
    readInstallMode: () => mode,
    modeOpenTarget: (selected) => ({ href: `http://127.0.0.1:17340/${selected}` }),
    probeDoor: async () => ({ kind: 'free' }),
    hasOwnedSupervisor: () => true,
    hasPendingUpdate: () => false,
    validateExistingEditorCheckout: () => editorExists,
    launcherPullMessage: () => 'OLD_LAUNCHER_PULL',
    pullEditorMessage: () => 'OLD_EDITOR_PULL',
    cloneEditorMessage: () => 'OLD_EDITOR_CLONE',
    bootstrapScript: (action, manifest) => {
      const request = { action, manifest };
      calls.push(request);
      return `AGENT_INSTALLER:${JSON.stringify(request)}`;
    },
    shellStep: (message) => ({ method: 'shell.run', params: { message } }),
    gitShellStep: (message) => ({ method: 'shell.run', params: { message } }),
    customStep: (method) => ({ method }),
    sessionStep: (...args) => ({ method: 'session', args }),
    ensureDoorPortFree: () => {},
    ensureProgramDirectory: () => {},
    stopOwnedStart: () => {},
    saveModeStep: (selected) => ({ method: 'save-mode', selected }),
  };
  return { app, calls };
}

async function buildAction(revision, file, mode, editorExists = true) {
  const { app, calls } = fixture(mode, editorExists);
  const action = oldModule(revision, file, app);
  return { steps: (await action({}, {})).run, calls };
}

function askCurrentAgentParser(action, manifest) {
  const args = ['--root', '/tmp/pinokio/Astrid/app/astrid', '--managed-by', 'pinokio'];
  if (action !== 'install') args.push(`--${action}`);
  if (manifest) args.push('--manifest', manifest);
  const code = [
    'import json, sys',
    'from astrid.installer.cli import parser',
    'parsed = parser().parse_args(json.loads(sys.argv[1]))',
    'mode = "app-update" if parsed.update_app else "update" if parsed.update else "uninstall" if parsed.uninstall else "install"',
    'print(json.dumps({"mode": mode, "managed_by": parsed.managed_by, "manifest": str(parsed.manifest) if parsed.manifest else None}))',
  ].join('; ');
  const result = spawnSync('python', ['-c', code, JSON.stringify(args)], {
    cwd: agent, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('historical backend Update arrays preserve launcher-pull order and reach the current agent CLI', async () => {
  for (const revision of revisions) {
    const { steps, calls } = await buildAction(revision, 'pinokio/update.js', 'backend');
    const installerStep = steps.findIndex((step) => step.params?.message?.startsWith('AGENT_INSTALLER:'));
    assert.ok(installerStep > 0, `${revision}: installer remains in the prebuilt action array`);
    const launcherPull = steps.slice(0, installerStep).some((step) => step.params?.message === 'OLD_LAUNCHER_PULL');
    assert.equal(launcherPull, revision !== '5e1f256', `${revision}: actual launcher-pull position`);
    assert.equal(calls.length, 1);
    const parsed = askCurrentAgentParser(calls[0].action);
    assert.equal(parsed.managed_by, 'pinokio');
    assert.equal(parsed.mode, calls[0].action === 'update-app' ? 'app-update' : 'update');
  }
});

test('historical fully-local Install and Update arrays retain the editor manifest route', async () => {
  const install = await buildAction('bbba620e', 'pinokio/install-local.js', 'local', false);
  assert.deepEqual(install.calls, [{ action: 'install', manifest: '/tmp/pinokio/Astrid/app/astrid/public/install-manifest.json' }]);
  assert.equal(install.steps.findIndex((step) => step.params?.message === 'OLD_EDITOR_CLONE') >= 0, true);
  assert.equal(askCurrentAgentParser(install.calls[0].action, install.calls[0].manifest).mode, 'install');

  for (const revision of revisions) {
    const { steps, calls } = await buildAction(revision, 'pinokio/update.js', 'local');
    const installerStep = steps.findIndex((step) => step.params?.message?.startsWith('AGENT_INSTALLER:'));
    assert.ok(installerStep > 0, `${revision}: local agent invocation remains in the prebuilt array`);
    const launcherPull = steps.slice(0, installerStep).some((step) => step.params?.message === 'OLD_LAUNCHER_PULL');
    assert.equal(launcherPull, revision !== '5e1f256', `${revision}: actual launcher-pull position`);
    assert.ok(steps.slice(0, installerStep).some((step) => step.params?.message === 'OLD_EDITOR_PULL'),
      `${revision}: editor pull precedes local manifest invocation`);
    assert.deepEqual(calls, [{ action: 'update', manifest: '/tmp/pinokio/Astrid/app/astrid/public/install-manifest.json' }]);
    const parsed = askCurrentAgentParser(calls[0].action, calls[0].manifest);
    assert.equal(parsed.mode, 'update');
    assert.equal(parsed.managed_by, 'pinokio');
    assert.equal(parsed.manifest, calls[0].manifest);
  }
});

test('current fully-local clicks preserve the existing editor-manifest installer route', async () => {
  const installed = await buildAction('working', 'pinokio/install-local.js', 'local', false);
  assert.deepEqual(installed.calls, [{ action: 'install', manifest: '/tmp/pinokio/Astrid/app/astrid/public/install-manifest.json' }]);
  assert.equal(installed.steps.some((step) => step.params?.message === 'OLD_EDITOR_CLONE'), true);
  assert.equal(installed.steps.some((step) => step.method === 'session' && step.args[0] === 'build'), true);

  const updated = await buildAction('working', 'pinokio/update.js', 'local');
  assert.deepEqual(updated.calls, [{ action: 'update', manifest: '/tmp/pinokio/Astrid/app/astrid/public/install-manifest.json' }]);
  const messages = Array.from(updated.steps, (step) => step.params?.message).filter(Boolean);
  assert.deepEqual(messages, ['OLD_LAUNCHER_PULL', 'OLD_EDITOR_PULL',
    `AGENT_INSTALLER:${JSON.stringify(updated.calls[0])}`]);
  assert.equal(updated.steps.some((step) => step.method === 'session' && step.args[0] === 'build'), true);
  assert.equal(messages.some((message) => message.includes('npm run update')), false);
});
