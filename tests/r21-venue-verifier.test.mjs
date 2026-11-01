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
      installer_dispatch: true, running_after: false, runtime_ready: true, application_ready: true, start_running_after_retry: true, start_to_ready: true,
    },
    cleanup: {
      action_id: 4, action_uri: ACTIONS.stop, inner_exit: innerExit(), terminal: terminal(),
      lock_free: true, start_running_after: false, daemon_idle: false,
    },
  };
}

test('R-21 venue verifier accepts only a complete native old-launcher receipt', () => {
  assert.deepEqual(TUPLE, {
    runtime: '47e5949465cb6f3afdfd1cb8a0e90009fd9d4020',
    agent: '020877f12ea490308a9e5f9564c8f4a4bf77ede1',
    app: '9d3ccda1e81383082258943207745086da2aabe4',
    pinokio: '89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4',
    old_launcher: 'bbba620e3d89eeff8021417f365e6ea584203105',
    pinokiod: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf',
    pterm: '5be43718701c448b43daf0ce51d8935f170065bb',
  });
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

test('R-21 dispatch binding accepts only the exact product dispatch or self-serve venue ref', () => {
  const environment = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R11',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-R11',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
  };
  const bound = validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment);
  assert.equal(bound.endpoint, ENDPOINT);
  assert.throws(() => validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'main' }, environment), /immutable 40-character SHA/);
  assert.throws(() => validateDispatch({ request_id: 'R-20', confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment), /request_id/);
  assert.throws(() => validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, {
    ...environment, GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R9',
  }), /GitHub ref/);
  const manual = validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, {
    ...environment,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/lane/M-PIN/R-21-R11',
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/lane/M-PIN/R-21-R11',
  });
  assert.equal(manual.workflow.event, 'workflow_dispatch');
});

test('publisher binds the run and only retains sanitized evidence with inner exits', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { publish } = createRequire(import.meta.url)('../.github/venue/r21-publish.cjs');
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r21-publisher-'));
  try {
    const environment = {
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R11',
      GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
      GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-R11',
      GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: REQUEST_ID,
      R21_CONFIRMATION: CONFIRMATION, R21_RUNNER_REF: 'a'.repeat(40),
    };
    const input = path.join(root, 'in');
    fs.mkdirSync(input);
    const sample = receipt();
    for (const v of Object.values(sample.protected_state)) {
      v.program = 'a'.repeat(64); v.selected_version = 'b'.repeat(64); v.user_data = 'c'.repeat(64);
    }
    sample.secret = 'must-never-leave-runner';
    fs.writeFileSync(path.join(input, 'r21-receipt.json'), JSON.stringify(sample));
    const out = path.join(root, 'out');
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }).status, 'ACCEPTED');
    assert.equal(fs.readFileSync(path.join(out, 'r21-receipt.json'), 'utf8').includes(sample.secret), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'verdict.json'))).action_inner_exits.retry.code, 0);
    assert.throws(() => publish({ env: { ...environment, GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }), /workflow SHA/);
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 1 }).status, 'FAILED');
    fs.unlinkSync(path.join(input, 'r21-receipt.json'));
    fs.writeFileSync(path.join(input, 'r21-progress.json'), JSON.stringify({ first_click: sample.first_click, secret: sample.secret }));
    const missing = publish({ env: environment, evidenceDir: input, destination: path.join(root, 'missing'), setupExit: 0, journeyExit: 1 });
    assert.equal(missing.reason, 'journey_receipt_missing');
    assert.equal(missing.action_inner_exits.first_click.code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
