'use strict';

// This module is intentionally small and standalone: the real-engine runner
// and its focused tests share the exact same admission rules.  It does not
// interpret fixture results or the R-20 Reset receipt.

const TUPLE = Object.freeze({
  runtime: '1e6d899efa77a2d6ec247c38250f9748330bb587',
  agent: '751547766957f0a907871617d9261318a1c8cdb8',
  app: 'cd2788e0830a96f1abb771a515b5b6abad50ecc9',
  pinokio: '89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4',
  old_launcher: 'bbba620e3d89eeff8021417f365e6ea584203105',
  pinokiod: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf',
  pterm: '5be43718701c448b43daf0ce51d8935f170065bb',
});

const REQUEST_ID = 'R-21-R12';
const CONFIRMATION = 'REAL_ENGINE_UPDATE_STOP_RETRY';
const ENDPOINT = 'pinokio://127.0.0.1:42000/api/astrid';
const PRODUCT_REF = 'refs/heads/lane/M-PIN/R-21-R12';
const VENUE_REF = 'refs/heads/venue/M-PIN-R-21-R12';
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
  const expectedRef = {
    workflow_dispatch: PRODUCT_REF,
    push: VENUE_REF,
  }[environment.GITHUB_EVENT_NAME];
  if (!expectedRef) fail('GitHub event must be workflow_dispatch or the dedicated venue push');
  equal(environment.GITHUB_REF, expectedRef, 'GitHub ref');
  if (typeof environment.GITHUB_WORKFLOW_REF !== 'string'
      || !environment.GITHUB_WORKFLOW_REF.endsWith(`${WORKFLOW_PATH}@${expectedRef}`)) {
    fail('workflow source is not the dedicated R-21 lane workflow');
  }
  return {
    schema: 1,
    request_id: REQUEST_ID,
    runner_ref: input.runner_ref,
    endpoint: ENDPOINT,
    tuple: TUPLE,
    workflow: {
      event: environment.GITHUB_EVENT_NAME,
      ref: environment.GITHUB_REF,
      workflow_ref: environment.GITHUB_WORKFLOW_REF,
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

  const first = object(receipt.first_click, 'first_click');
  equal(first.action_uri, ACTIONS.update, 'first-click action URI');
  exitZero(first, 'first click');
  settled(first, 'first click');
  if (first.terminal.expected_refusal !== true) fail('first click did not retain the exact R-17 refusal');
  if (first.installer_dispatch !== true) fail('first click did not reach the authentic old-launcher installer dispatch');
  idle(first.running_after, 'first-click action status');

  const protectedState = object(receipt.protected_state, 'protected_state');
  if (!protectedState.before || !protectedState.after_first_click
      || protectedState.before.program !== protectedState.after_first_click.program
      || protectedState.before.selected_version !== protectedState.after_first_click.selected_version
      || protectedState.before.user_data !== protectedState.after_first_click.user_data) {
    fail('first click changed protected program state, selected version, or user data');
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
  idle(retry.running_after, 'retry action status');
  if (retry.start_running_after_retry !== true || retry.runtime_ready !== true || retry.application_ready !== true || retry.start_to_ready !== true) {
    fail('retry lacks independent Runtime, application, or Stop-to-Start readiness');
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
  ACTIONS, CONFIRMATION, ENDPOINT, FIRST_REFUSAL, REQUEST_ID, TUPLE,
  validateDispatch, verifyReceipt,
};
