import assert from 'node:assert/strict';
import { test } from 'node:test';
import verifier from '../.github/venue/r21-verify.cjs';

const { ACTIONS, CONFIRMATION, ENDPOINT, REQUEST_ID, TUPLE, validateDispatch, verifyReceipt } = verifier;

function innerExit() { return { code: 0, signal: null }; }
function terminal(refusal = false) { return { stop: true, disconnect: true, expected_refusal: refusal }; }
function receipt() {
  return {
    schema: 1,
    request_id: REQUEST_ID,
    endpoint: ENDPOINT,
    tuple: { ...TUPLE },
    first_click: {
      action_id: 1, action_uri: ACTIONS.update, inner_exit: innerExit(), terminal: terminal(true),
      installer_dispatch: true, running_after: false,
    },
    protected_state: {
      before: { program: 'program', selected_version: 'selected', user_data: 'user' },
      after_first_click: { program: 'program', selected_version: 'selected', user_data: 'user' },
      after_retry: { program: 'program-after', selected_version: 'selected-after', user_data: 'user' },
    },
    stop: {
      action_id: 2, action_uri: ACTIONS.stop, inner_exit: innerExit(), terminal: terminal(),
      stopped: true, lock_free: true, start_running_after: false,
    },
    retry: {
      action_id: 3, action_uri: ACTIONS.update, inner_exit: innerExit(), terminal: terminal(),
      installer_dispatch: true, running_after: false, runtime_ready: true, application_ready: true, start_to_ready: true,
    },
    cleanup: {
      action_id: 4, action_uri: ACTIONS.stop, inner_exit: innerExit(), terminal: terminal(),
      lock_free: true, start_running_after: false, daemon_idle: false,
    },
  };
}

test('R-21 venue verifier accepts only a complete native old-launcher receipt', () => {
  assert.deepEqual(verifyReceipt(receipt()), { accepted: true, request_id: REQUEST_ID });
});

test('R-21 venue verifier fails closed for missing engine terminal event', () => {
  const value = receipt();
  value.first_click.terminal.disconnect = false;
  assert.throws(() => verifyReceipt(value), /complete engine terminal observation/);
});

test('R-21 venue verifier fails closed for a wrong endpoint action URI', () => {
  const value = receipt();
  value.retry.action_uri = 'pinokio://127.0.0.1:42001/api/astrid/pinokio/update.js';
  assert.throws(() => verifyReceipt(value), /retry action URI/);
});

test('R-21 venue verifier fails closed for unknown action state', () => {
  const value = receipt();
  value.stop.start_running_after = 'unknown';
  assert.throws(() => verifyReceipt(value), /explicit false engine status/);
});

test('R-21 venue verifier rejects a successful-looking wrapper with a nonzero inner PTerm exit', () => {
  const value = receipt();
  value.retry.inner_exit.code = 1;
  assert.throws(() => verifyReceipt(value), /zero inner PTerm exit/);
});

test('R-21 dispatch binding rejects a mutable or wrong-lane request', () => {
  const environment = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/lane/M-PIN/R-21-R7',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/lane/M-PIN/R-21-R7',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
  };
  const bound = validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment);
  assert.equal(bound.endpoint, ENDPOINT);
  assert.throws(() => validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'main' }, environment), /immutable 40-character SHA/);
  assert.throws(() => validateDispatch({ request_id: 'R-20', confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment), /request_id/);
});
