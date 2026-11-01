import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// This is deliberately a bounded component harness. It replays the action
// array assembled by the retained launcher, but it does not stand in for a
// Pinokio engine, an R-17 publication, or independently observed readiness.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldLauncher = 'bbba620e3d89eeff8021417f365e6ea584203105';
const publishedAgent = '020877f12ea490308a9e5f9564c8f4a4bf77ede1';
const r17Refusal = "Astrid is still running. Choose Pinokio's Stop button, then try again.";
const nodeRequire = createRequire(import.meta.url);
const candidateRepository = process.env.ASTRID_AGENT_REPOSITORY
  || [
    path.resolve(repo, '../agent-candidate'),
    path.resolve(repo, '../../../../../../../M-AG/repos/astrid-agent'),
  ].find((candidate) => fs.existsSync(path.join(candidate, '.git')))
  || path.resolve(repo, '../agent-candidate');
const source = (revision, file) => revision === 'worktree'
  ? fs.readFileSync(path.join(repo, file), 'utf8')
  : execFileSync('git', ['show', `${revision}:${file}`], { cwd: repo, encoding: 'utf8' });

function candidateSource(file) {
  return execFileSync('git', ['show', `${publishedAgent}:${file}`], {
    cwd: candidateRepository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sliceBetween(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  return from >= 0 && to >= 0 ? text.slice(from, to) : '';
}

function inspectR17Contract() {
  const files = {
    update: 'astrid/installer/app_update.py',
    custody: 'astrid/installer/custody.py',
    oldStopProof: 'tests/test_installer_pinokio_old_stop.py',
    stoppedUpdateProof: 'tests/test_installer_pinokio_stopped_update.py',
  };
  const missing = [];
  try {
    const update = candidateSource(files.update);
    const custody = candidateSource(files.custody);
    const oldStopProof = candidateSource(files.oldStopProof);
    const stoppedUpdateProof = candidateSource(files.stoppedUpdateProof);
    const preflight = sliceBetween(update, 'def preflight_pinokio_update', '\ndef qualify_running');
    const operation = sliceBetween(custody, 'def operation(', '\ndef _serve');
    if (!preflight.includes('pinokio_lock_paths') || !preflight.includes('qualify_running')
      || !preflight.includes(r17Refusal)) missing.push('candidate-running-refusal-order');
    if (!operation.includes('stopped_custody') || !operation.includes('qualify_running')
      || !operation.includes(r17Refusal)) missing.push('candidate-stopped-admission-refusal');
    if (!oldStopProof.includes('test_receipt_free_old_stop_needs_custody_and_never_calls_newer_down')) {
      missing.push('candidate-old-stop-proof');
    }
    if (!stoppedUpdateProof.includes('test_canonical_stop_then_fresh_update_cli_uses_retained_c1_authority')
      || !stoppedUpdateProof.includes('retry = run_cli()')
      || !stoppedUpdateProof.includes('assert retry.returncode == 0')) {
      missing.push('candidate-fresh-retry-proof');
    }
  } catch (error) {
    missing.push(`candidate-source-unavailable:${error.code || error.name}`);
  }
  return { status: missing.length === 0 ? 'bound' : 'blocked', missing };
}

function moduleAt(revision, file, dependencies = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source(revision, file), {
    module, exports: module.exports, __dirname: path.join(repo, path.dirname(file)), process, Buffer,
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith('node:')) return nodeRequire(name);
      throw new Error(`Unexpected ${revision} dependency: ${name}`);
    },
  }, { filename: `${revision}:${file}` });
  return module.exports;
}

function oldBackendUpdate() {
  const posix = moduleAt(oldLauncher, 'pinokio/platforms/posix.js');
  const windows = moduleAt(oldLauncher, 'pinokio/platforms/windows.js');
  const legacy = moduleAt(oldLauncher, 'pinokio/lib.js', {
    './platforms/posix': posix, './platforms/windows': windows,
  });
  const appDirectory = '/fixture/pinokio/Astrid';
  const app = legacy.createApp({
    platform: 'linux', appDirectory, environment: {}, probe: async () => ({ kind: 'free' }),
    filesystem: {
      readFileSync(file) {
        if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'backend' });
        throw Object.assign(new Error('fixture file absent'), { code: 'ENOENT' });
      },
      existsSync: () => false,
    },
  });
  app.validateExistingEditorCheckout = () => true;
  return moduleAt(oldLauncher, 'pinokio/update.js', { './lib': app });
}

function currentLauncher(events) {
  const library = nodeRequire('../pinokio/lib.js');
  const base = library.createApp({ platform: 'linux', appDirectory: '/fixture/pinokio/Astrid', environment: {} });
  const filesystem = {
    readFileSync(file) {
      if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode: 'backend' });
      throw Object.assign(new Error('fixture file absent'), { code: 'ENOENT' });
    },
    existsSync: (file) => file === base.PROGRAMS_DIR,
  };
  const app = library.createApp({
    platform: 'linux', appDirectory: base.APP_DIR, environment: {}, filesystem,
    lifecycle: {
      preflightStop: async () => { events.push('preflight'); return { safe: true }; },
      requestGracefulStop: async () => { events.push('graceful-stop'); },
      waitForInstallerLock: async () => { events.push('lock'); },
    },
  });
  const uri = app.paths.join(app.APP_DIR, 'pinokio', 'start.js');
  const kernel = { api: { running: { [uri]: true }, stop: async () => {
    events.push('kernel-stop'); delete kernel.api.running[uri];
  } } };
  return { app, kernel, uri };
}

async function replayOldFirstClick(action, events) {
  for (const step of action.run) {
    if (typeof step.method === 'function') {
      await step.method({}, () => {});
      continue;
    }
    const message = step.params?.message || '';
    if (message.includes('pull --ff-only')) {
      events.push('old-launcher-pull');
      continue;
    }
    if (message.includes('--managed-by')) {
      events.push('candidate-refusal');
      return { status: 'refused', message: r17Refusal, candidate: publishedAgent };
    }
    throw new Error(`Unmodelled old-launcher step: ${step.method}`);
  }
  throw new Error('The old launcher did not dispatch the installer.');
}

async function replayFreshRetry(action, app, kernel, events) {
  let installerDispatched = false;
  for (const step of action.run) {
    if (typeof step.method === 'function') {
      await step.method({}, () => {}, kernel);
      continue;
    }
    const message = step.params?.message || '';
    if (message.includes('pull --ff-only')) {
      events.push('fresh-launcher-pull');
      continue;
    }
    if (message.includes('--managed-by')) {
      events.push('fresh-installer-dispatch');
      installerDispatched = true;
      continue;
    }
    throw new Error(`Unmodelled fresh-launcher step: ${step.method}`);
  }
  assert.equal(installerDispatched, true, 'a retry must reach a newly built installer dispatch');
  assert.equal(action.run[0].method, app.preflightStop, 'the fresh action begins with the current read-only preflight');
  return { installerDispatched };
}

function boundedCollection({ handoff, firstClick, stop, retry, observation }) {
  const missing = [];
  if (handoff?.published !== true) missing.push('published-r17-handoff');
  if (firstClick?.status !== 'refused' || firstClick.message !== r17Refusal) missing.push('exact-first-click-refusal');
  if (stop?.lockFree !== true) missing.push('stop-lock-postcondition');
  if (retry?.installerDispatched !== true) missing.push('fresh-retry-dispatch');
  if (observation?.runtimeReady !== true) missing.push('independent-runtime-readiness');
  if (observation?.applicationReady !== true) missing.push('independent-application-readiness');
  if (observation?.source !== 'independent') missing.push('independent-observation');
  if (observation?.terminal !== 'idle') missing.push('terminal-idle-correlation');
  if (!observation?.protectedState || observation.protectedState.before !== observation.protectedState.after) {
    missing.push('protected-state-postcondition');
  }
  return {
    status: missing.length === 0 ? 'captured' : 'blocked',
    missing,
    // A local fixture is never an R-21 qualification, even when every input
    // is supplied. Qualification requires a separately published receipt.
    qualification: 'none',
  };
}

test('published R-17 contract binds refusal ordering and stopped-path proofs before collection', {
  skip: fs.existsSync(path.join(candidateRepository, '.git'))
    ? false : 'R-17 Agent checkout is not available in this environment',
}, () => {
  const contract = inspectR17Contract();
  assert.deepEqual(contract, { status: 'bound', missing: [] });
  assert.equal(fs.readFileSync(path.join(repo, 'pinokio/stop.js'), 'utf8').trim(),
    "'use strict';\nconst app = require('./lib');\nmodule.exports = { run: [app.customStep(app.stopOwnedStart)] };");
});

test('R-21 component harness: old first click refuses, current Stop succeeds, and only a rebuilt retry reaches bounded collection', async () => {
  const events = [];
  const { app, kernel, uri } = currentLauncher(events);
  const oldUpdate = oldBackendUpdate();
  const firstAction = await oldUpdate();
  const first = await replayOldFirstClick(firstAction, events);

  assert.deepEqual(first, { status: 'refused', message: r17Refusal, candidate: publishedAgent });
  assert.deepEqual(events, ['old-launcher-pull', 'candidate-refusal']);
  assert.equal(kernel.api.running[uri], true, 'the candidate refusal does not invent a launcher-side Stop');

  events.length = 0;
  const stop = moduleAt('worktree', 'pinokio/stop.js', { './lib': app });
  const stopped = await stop.run[0].method({}, () => {}, kernel);
  assert.deepEqual(stopped, { stopped: true, lockFree: true });
  assert.deepEqual(events, ['preflight', 'graceful-stop', 'kernel-stop', 'lock']);
  assert.equal(kernel.api.running[uri], undefined);

  events.length = 0;
  const update = moduleAt('worktree', 'pinokio/update.js', { './lib': app });
  const retryAction = await update();
  assert.notEqual(retryAction, firstAction, 'Stop is followed by a new click, not a resumed old action array');
  const retry = await replayFreshRetry(retryAction, app, kernel, events);
  assert.deepEqual(events, ['preflight', 'fresh-launcher-pull', 'fresh-installer-dispatch']);

  const completeFixture = boundedCollection({
    handoff: { published: false, candidate: publishedAgent }, firstClick: first, stop: stopped, retry,
    observation: {
      source: 'fixture', runtimeReady: true, applicationReady: true, terminal: 'idle',
      protectedState: { before: 'fixture-state-sha256', after: 'fixture-state-sha256' },
    },
  });
  assert.deepEqual(completeFixture, {
    status: 'blocked', missing: ['published-r17-handoff', 'independent-observation'], qualification: 'none',
  });

  const incomplete = boundedCollection({
    handoff: { published: false, candidate: publishedAgent }, firstClick: first, stop: stopped, retry,
    observation: { source: 'fixture', runtimeReady: true, applicationReady: false, terminal: 'running', protectedState: { before: 'a', after: 'b' } },
  });
  assert.deepEqual(incomplete.missing, [
    'published-r17-handoff', 'independent-application-readiness', 'independent-observation', 'terminal-idle-correlation', 'protected-state-postcondition',
  ]);
  assert.equal(incomplete.qualification, 'none');
});
