'use strict';

// This module is intentionally small and standalone: the real-engine runner
// and its focused tests share the exact same admission rules.  It does not
// interpret fixture results or the R-20 Reset receipt.

const TUPLE = Object.freeze({
  runtime: '5453366458f7b4ee874c94d15ae7952e3e82d3c3',
  agent: '2de0726d1eaea7f7bd141251e088aa9fdf224525',
  app: 'ce1502e94b935fe6ef1e2f363fc6b55aade4a204',
  pinokio: '3a6a98ae251ca126505245286e2d3e760f4348e9',
  old_launcher: 'bbba620e3d89eeff8021417f365e6ea584203105',
  pinokiod: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf',
  pterm: '5be43718701c448b43daf0ce51d8935f170065bb',
});

// This standalone observer does not execute the separate Agent journey harness.
const AGENT_JOURNEY_HARNESS_REFERENCE = '6e46e3bb45ec3feddbd0b0617a50a157e3a4df67';
const MANIFEST_SHA256 = '920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87';
// These values come from the pinned App source above: its served manifest and
// browser Runtime client. The observer uses the real browser-door routes with
// this exact contract instead of treating an unrelated public-page 200 as an
// App-to-Runtime readiness result.
const APP_RUNTIME = Object.freeze({
  origin: 'https://astrid.haus',
  protocol: 'workspace.v1',
  schema_digest: 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c',
  client_name: 'astrid-browser',
  client_version: 'astrid-r1-consumer-20260911',
  requested_scopes: Object.freeze([
    'handshake', 'installer:update', 'projects:read', 'projects:write',
    'objects:read', 'objects:write', 'tasks:read', 'tasks:write',
  ]),
  capability: 'execution_binding.targeted.v1',
});
const REQUEST_ID = 'R-21-PUBLISHED-TUPLE-R1';
const CONFIRMATION = 'REAL_ENGINE_UPDATE_STOP_RETRY';
const ENDPOINT = 'pinokio://127.0.0.1:42000/api/astrid';
// This lane is the dedicated diagnostic workflow source.  The product tuple
// above remains the candidate under observation; this execution lane is never
// substituted for its Pinokio product pin.
const PRODUCT_REF = 'refs/heads/lane/M-PIN/R-21-VENUE-REF-BINDING-R1';
const VENUE_REF = 'refs/heads/venue/M-PIN-R-21-CANDIDATE-APP-SERVE-R1';
const WORKFLOW_PATH = '.github/workflows/r21-real-engine.yml';
const FIRST_REFUSAL = "Astrid is still running. Choose Pinokio's Stop button, then try again.";
const ACTIONS = Object.freeze({
  install: `${ENDPOINT}/pinokio/install.js`,
  start: `${ENDPOINT}/pinokio/start.js`,
  update: `${ENDPOINT}/pinokio/update.js`,
  stop: `${ENDPOINT}/pinokio/stop.js`,
});

const SHA = /^[0-9a-f]{40}$/;
const fail = (message) => { throw new Error(`R-21 venue receipt rejected: ${message}`); };
const equal = (actual, expected, label) => {
  if (actual !== expected) fail(`${label} must be ${JSON.stringify(expected)}`);
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is required`);
  return value;
};
const exitZero = (step, label) => {
  object(step, label);
  if (!step.inner_exit || step.inner_exit.code !== 0 || step.inner_exit.signal !== null) {
    fail(`${label} did not retain a zero inner PTerm exit`);
  }
};
const settled = (step, label) => {
  if (step.terminal?.disconnect !== true || step.terminal?.stop !== true) {
    fail(`${label} has no complete engine terminal observation`);
  }
};
const idle = (state, label) => {
  if (state !== false) fail(`${label} must be an explicit false engine status, not an inferred or unknown state`);
};

function validateDispatch(input, environment = process.env) {
  object(input, 'dispatch input');
  equal(input.request_id, REQUEST_ID, 'request_id');
  equal(input.confirmation, CONFIRMATION, 'confirmation');
  if (typeof input.runner_ref !== 'string' || !SHA.test(input.runner_ref)) {
    fail('runner_ref must be a lowercase immutable 40-character SHA');
  }
  equal(input.runner_ref, environment.GITHUB_SHA, 'runner_ref/GITHUB_SHA binding');
  equal(environment.GITHUB_WORKFLOW_SHA, environment.GITHUB_SHA, 'workflow SHA/runner SHA binding');
  const expectedRef = {
    workflow_dispatch: PRODUCT_REF,
    push: VENUE_REF,
  }[environment.GITHUB_EVENT_NAME];
  if (!expectedRef) fail('GitHub event must be workflow_dispatch or the dedicated venue push');
  equal(environment.GITHUB_REF, expectedRef, 'GitHub ref');
  const expectedWorkflowRef = `banodoco/astrid-pinokio/${WORKFLOW_PATH}@${expectedRef}`;
  if (environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    fail('workflow source is not the dedicated R-21 lane workflow');
  }
  return {
    schema: 1,
    request_id: REQUEST_ID,
    runner_ref: input.runner_ref,
    endpoint: ENDPOINT,
    tuple: TUPLE,
    app_manifest_sha256: MANIFEST_SHA256,
    agent_journey_harness: { ref: AGENT_JOURNEY_HARNESS_REFERENCE, executed: false },
    workflow: {
      event: environment.GITHUB_EVENT_NAME,
      ref: environment.GITHUB_REF,
      workflow_ref: environment.GITHUB_WORKFLOW_REF,
      sha: environment.GITHUB_WORKFLOW_SHA,
      run_id: environment.GITHUB_RUN_ID || null,
      run_attempt: environment.GITHUB_RUN_ATTEMPT || null,
    },
  };
}

function verifyReceipt(receipt) {
  object(receipt, 'receipt');
  equal(receipt.schema, 1, 'receipt schema');
  equal(receipt.request_id, REQUEST_ID, 'receipt request_id');
  equal(receipt.endpoint, ENDPOINT, 'receipt endpoint');
  for (const [name, sha] of Object.entries(TUPLE)) equal(receipt.tuple?.[name], sha, `tuple.${name}`);

  if (receipt.installed_tuple?.before !== true || receipt.installed_tuple?.after_retry !== true) {
    fail('installed selected manifests do not match the candidate Agent and Runtime');
  }

  const install = object(receipt.install, 'install');
  equal(install.action_uri, ACTIONS.install, 'initial Install action URI');
  exitZero(install, 'initial Install');
  settled(install, 'initial Install');
  if (install.installer_dispatch !== true || install.installer_success !== true
      || install.engine_error !== false || install.launcher_failure !== false) {
    fail('initial Install lacks accepted installer dispatch/completion or contains an engine/launcher failure');
  }
  idle(install.running_after, 'initial Install action status');

  const first = object(receipt.first_click, 'first_click');
  equal(first.action_uri, ACTIONS.update, 'first-click action URI');
  exitZero(first, 'first click');
  settled(first, 'first click');
  if (first.action_id === install.action_id || !Number.isInteger(first.action_id)
      || !Number.isInteger(install.action_id)) fail('first click is not distinct from the accepted initial Install action');
  if (first.terminal.expected_refusal !== true) fail('first click did not retain the exact R-17 refusal');
  if (first.installer_dispatch !== true) fail('first click did not reach the authentic old-launcher installer dispatch');
  idle(first.running_after, 'first-click action status');

  const protectedState = object(receipt.protected_state, 'protected_state');
  for (const key of ['before', 'after_first_click', 'after_retry']) {
    for (const field of ['program', 'selected_version', 'installed_bytes', 'user_data']) {
      if (!/^[a-f0-9]{64}$/.test(protectedState[key]?.[field] || '')) fail('protected state digest missing or invalid');
    }
  }
  if (!protectedState.before || !protectedState.after_first_click
      || protectedState.before.program !== protectedState.after_first_click.program
      || protectedState.before.selected_version !== protectedState.after_first_click.selected_version
      || protectedState.before.installed_bytes !== protectedState.after_first_click.installed_bytes
      || protectedState.before.user_data !== protectedState.after_first_click.user_data) {
    fail('first click changed protected program state, selected version, installed bytes, or user data');
  }

  const stop = object(receipt.stop, 'stop');
  equal(stop.action_uri, ACTIONS.stop, 'Stop action URI');
  exitZero(stop, 'Stop');
  settled(stop, 'Stop');
  if (stop.stopped !== true || stop.lock_free !== true) fail('Stop did not retain genuine stopped/lock-free results');
  idle(stop.start_running_after, 'Stop start status');

  const retry = object(receipt.retry, 'retry');
  equal(retry.action_uri, ACTIONS.update, 'retry action URI');
  exitZero(retry, 'retry');
  settled(retry, 'retry');
  if (retry.action_id === first.action_id || !Number.isInteger(retry.action_id)) {
    fail('retry is not a freshly constructed action');
  }
  if (retry.installer_dispatch !== true) fail('retry did not retain an installer dispatch');
  if (retry.installer_success !== true || retry.engine_error !== false || retry.launcher_failure !== false) {
    fail('retry lacks successful installer completion or contains an engine/launcher failure');
  }
  idle(retry.running_after, 'retry action status');
  if (retry.start_running_after_retry !== true || retry.runtime_ready !== true
      || retry.application_ready !== true || retry.candidate_app_runtime_ready !== true
      || retry.start_to_ready !== true) {
    fail('retry lacks independent Runtime, application, candidate App-to-Runtime, or Stop-to-Start readiness');
  }
  const served = object(retry.served_app_runtime, 'served candidate App-to-Runtime interaction');
  equal(served.app, TUPLE.app, 'served candidate App build');
  equal(served.origin, APP_RUNTIME.origin, 'served candidate App origin');
  equal(served.app_release, 1, 'served candidate App release');
  if (served.health !== true || served.realm !== true || served.handshake !== true
      || !/^[a-f0-9]{64}$/.test(served.runtime_instance_digest || '')
      || !/^[a-f0-9]{64}$/.test(served.realm_digest || '')) {
    fail('served candidate App did not observably connect and handshake with this Runtime');
  }
  const build = object(served.served_build, 'served candidate App build provenance');
  equal(build.source_commit, TUPLE.app, 'served candidate App source commit');
  equal(build.manifest_sha256, MANIFEST_SHA256, 'served candidate App manifest digest');
  equal(build.build_json_app, TUPLE.app, 'served candidate App build.json app');
  equal(build.build_json_release, 1, 'served candidate App build.json release');
  equal(build.origin, APP_RUNTIME.origin, 'served candidate App build origin');
  if (build.local_loopback !== true || !/^[a-f0-9]{64}$/.test(build.build_json_sha256 || '')) {
    fail('served candidate App build was not locally served from its verified output');
  }
  if (protectedState.before.user_data !== protectedState.after_retry?.user_data) {
    fail('retry changed the protected user-data digest');
  }

  const cleanup = object(receipt.cleanup, 'cleanup');
  equal(cleanup.action_uri, ACTIONS.stop, 'cleanup Stop action URI');
  exitZero(cleanup, 'cleanup Stop');
  settled(cleanup, 'cleanup Stop');
  if (cleanup.lock_free !== true) fail('cleanup did not retain lock-free state');
  idle(cleanup.start_running_after, 'cleanup start status');
  idle(cleanup.daemon_idle, 'cleanup daemon-idle status');
  return { accepted: true, request_id: REQUEST_ID };
}

module.exports = {
  ACTIONS, APP_RUNTIME, CONFIRMATION, ENDPOINT, FIRST_REFUSAL, MANIFEST_SHA256, REQUEST_ID, TUPLE,
  validateDispatch, verifyReceipt,
};
