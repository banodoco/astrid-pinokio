import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import verifier from '../.github/venue/r21-verify.cjs';

const { ACTIONS, APP_RUNTIME, CONFIRMATION, ENDPOINT, REQUEST_ID, TUPLE, validateDispatch, verifyReceipt } = verifier;

function innerExit() { return { code: 0, signal: null }; }
function terminal(refusal = false) { return { stop: true, disconnect: true, expected_refusal: refusal }; }
function receipt() {
  return {
    schema: 1,
    request_id: REQUEST_ID,
    endpoint: ENDPOINT,
    tuple: { ...TUPLE },
    installed_tuple: { before: true, after_retry: true },
    install: {
      action_id: 1, action_uri: ACTIONS.install, inner_exit: innerExit(), terminal: terminal(),
      installer_dispatch: true, installer_success: true, engine_error: false, launcher_failure: false, running_after: false,
    },
    first_click: {
      action_id: 2, action_uri: ACTIONS.update, inner_exit: innerExit(), terminal: terminal(true),
      installer_dispatch: true, running_after: false,
    },
    protected_state: {
      before: { program: 'a'.repeat(64), selected_version: 'b'.repeat(64), installed_bytes: 'f'.repeat(64), user_data: 'c'.repeat(64) },
      after_first_click: { program: 'a'.repeat(64), selected_version: 'b'.repeat(64), installed_bytes: 'f'.repeat(64), user_data: 'c'.repeat(64) },
      after_retry: { program: 'd'.repeat(64), selected_version: 'e'.repeat(64), installed_bytes: '0'.repeat(64), user_data: 'c'.repeat(64) },
    },
    stop: {
      action_id: 3, action_uri: ACTIONS.stop, inner_exit: innerExit(), terminal: terminal(),
      stopped: true, lock_free: true, start_running_after: false,
    },
    retry: {
      action_id: 4, action_uri: ACTIONS.update, inner_exit: innerExit(), terminal: terminal(),
      installer_dispatch: true, installer_success: true, engine_error: false, launcher_failure: false, running_after: false, runtime_ready: true, application_ready: true, candidate_app_runtime_ready: true, start_running_after_retry: true, start_to_ready: true,
    },
    cleanup: {
      action_id: 5, action_uri: ACTIONS.stop, inner_exit: innerExit(), terminal: terminal(),
      lock_free: true, start_running_after: false, daemon_idle: false,
    },
  };
}

test('R-21 venue verifier accepts only a complete native old-launcher receipt', () => {
  assert.deepEqual(TUPLE, {
    runtime: '5453366458f7b4ee874c94d15ae7952e3e82d3c3',
    agent: '2de0726d1eaea7f7bd141251e088aa9fdf224525',
    app: 'ce1502e94b935fe6ef1e2f363fc6b55aade4a204',
    pinokio: '3a6a98ae251ca126505245286e2d3e760f4348e9',
    old_launcher: 'bbba620e3d89eeff8021417f365e6ea584203105',
    pinokiod: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf',
    pterm: '5be43718701c448b43daf0ce51d8935f170065bb',
  });
  assert.equal(APP_RUNTIME.schema_digest, 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c');
  assert.equal(APP_RUNTIME.origin, 'https://astrid.haus');
  assert.deepEqual(verifyReceipt(receipt()), { accepted: true, request_id: REQUEST_ID });
});

test('R-21 real-engine route and receipt bind the same current manifest tuple', () => {
  const runner = fs.readFileSync('.github/venue/r21-real-engine.sh', 'utf8');
  for (const value of [TUPLE.pinokio, TUPLE.agent, TUPLE.app, '920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87']) {
    assert.match(runner, new RegExp(value));
  }
  for (const stale of [
    '2f085c5fc0cde192ac4a022065883c85dcccd0de',
    'e425903f7a9fa5b82973281d15054c0716b46e2d',
    '5c95abb00525e1a77d00c32042b6453d9f14f4e7',
    'a6eef2804e58e198d56899f1b36d97688d5cbc4a0847a82078ba144df4a207eb',
  ]) assert.doesNotMatch(runner, new RegExp(stale));
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
    GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-REVIEW-FIX-R1',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-REVIEW-FIX-R1',
    GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
  };
  const bound = validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment);
  assert.equal(bound.endpoint, ENDPOINT);
  assert.equal(bound.workflow.sha, environment.GITHUB_SHA);
  assert.deepEqual(bound.agent_journey_harness, { ref: '6e46e3bb45ec3feddbd0b0617a50a157e3a4df67', executed: false });
  assert.equal(bound.app_manifest_sha256, '920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87');
  assert.throws(() => validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'main' }, environment), /immutable 40-character SHA/);
  assert.throws(() => validateDispatch({ request_id: 'R-20', confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, environment), /request_id/);
  assert.throws(() => validateDispatch({ request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) }, {
    ...environment, GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R9',
  }), /GitHub ref/);
  const manualEnvironment = {
    ...environment,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/lane/M-PIN/R-21-CURRENT-TUPLE-R1',
    GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/lane/M-PIN/R-21-CURRENT-TUPLE-R1',
  };
  const manualInput = { request_id: REQUEST_ID, confirmation: CONFIRMATION, runner_ref: 'a'.repeat(40) };
  const manual = validateDispatch(manualInput, manualEnvironment);
  assert.equal(manual.workflow.event, 'workflow_dispatch');
  assert.throws(() => validateDispatch({ ...manualInput, runner_ref: 'b'.repeat(40) }, manualEnvironment), /runner_ref\/GITHUB_SHA binding/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }), /workflow SHA\/runner SHA binding/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_REF: 'refs/heads/lane/M-PIN/R-21-START-OBSERVABILITY-R1' }), /GitHub ref/);
  assert.throws(() => validateDispatch({ ...manualInput, confirmation: 'wrong' }, manualEnvironment), /confirmation/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_EVENT_NAME: 'pull_request' }), /GitHub event/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/lane/M-PIN/R-21-R13' }), /workflow source/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/other.yml@refs/heads/lane/M-PIN/R-21-PUBLISHED-TUPLE-R1' }), /workflow source/);
  assert.throws(() => validateDispatch(manualInput, { ...manualEnvironment, GITHUB_WORKFLOW_REF: `untrusted/${manualEnvironment.GITHUB_WORKFLOW_REF}` }), /workflow source/);
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
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-REVIEW-FIX-R1',
      GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
      GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-REVIEW-FIX-R1',
      GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: REQUEST_ID,
      R21_CONFIRMATION: CONFIRMATION, R21_RUNNER_REF: 'a'.repeat(40),
    };
    environment.RUNNER_TEMP = root;
    fs.mkdirSync(path.join(root, 'r21-watchdog'));
    fs.writeFileSync(path.join(root, 'r21-watchdog', 'watchdog.json'), JSON.stringify({ timed_out: false, exit_code: 0, elapsed_ms: 42 }));
    const input = path.join(root, 'in');
    fs.mkdirSync(input);
    const sample = receipt();
    for (const v of Object.values(sample.protected_state)) {
      v.program = 'a'.repeat(64); v.selected_version = 'b'.repeat(64);
      v.installed_bytes = 'd'.repeat(64); v.user_data = 'c'.repeat(64);
    }
    sample.secret = 'must-never-leave-runner';
    fs.writeFileSync(path.join(input, 'r21-receipt.json'), JSON.stringify(sample));
    fs.writeFileSync(path.join(input, 'r21-install-diagnostics.json'), JSON.stringify({ binding: { request_id: REQUEST_ID, runner_ref: 'a'.repeat(40), run_id: '100', run_attempt: '1', secret: 'spoof' },
      events: [{ kind: 'stream', timestamp: '2026-01-01T00:00:00.000Z', index: 2, total: 4, method: 'shell.run', raw: sample.secret }], secret: sample.secret }));
    const out = path.join(root, 'out');
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }).status, 'ACCEPTED');
    assert.equal(fs.readFileSync(path.join(out, 'r21-receipt.json'), 'utf8').includes(sample.secret), false);
    const diagnosticText = fs.readFileSync(path.join(out, 'install-diagnostics.json'), 'utf8');
    const diagnostic = JSON.parse(diagnosticText);
    assert.doesNotMatch(diagnosticText, /must-never-leave-runner|spoof/);
    assert.deepEqual(diagnostic.binding, { request_id: REQUEST_ID, runner_ref: 'a'.repeat(40), run_id: '100', run_attempt: '1' });
    assert.equal(diagnostic.events[0].index, 2);
    assert.match(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8'), /  install-diagnostics\.json/);
    const wrongBinding = JSON.parse(fs.readFileSync(path.join(input, 'r21-install-diagnostics.json')));
    wrongBinding.binding.run_id = '999';
    fs.writeFileSync(path.join(input, 'r21-install-diagnostics.json'), JSON.stringify(wrongBinding));
    const wrongDestination = path.join(root, 'wrong-binding');
    publish({ env: environment, evidenceDir: input, destination: wrongDestination, setupExit: 0, journeyExit: 0 });
    assert.equal(fs.existsSync(path.join(wrongDestination, 'install-diagnostics.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'verdict.json'))).action_inner_exits.retry.code, 0);
    assert.throws(() => publish({ env: { ...environment, GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }), /workflow SHA/);
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 1 }).status, 'FAILED');
    fs.writeFileSync(path.join(root, 'r21-watchdog', 'watchdog.json'), JSON.stringify({ timed_out: true, exit_code: 124, elapsed_ms: 50 }));
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }).status, 'FAILED');
    fs.unlinkSync(path.join(root, 'r21-watchdog', 'watchdog.json'));
    assert.equal(publish({ env: environment, evidenceDir: input, destination: out, setupExit: 0, journeyExit: 0 }).status, 'FAILED');
    fs.writeFileSync(path.join(root, 'r21-watchdog', 'progress.json'), JSON.stringify({ stage: 'run-r21-journey', substage: 'secret payload', elapsed_ms: 10 }));
    const redacted = publish({ env: environment, evidenceDir: input, destination: path.join(root, 'redacted'), setupExit: null, journeyExit: null });
    assert.deepEqual(redacted.progress, { stage: 'run-r21-journey', substage: null, elapsed_ms: 10 });
    const { spawnSync } = await import('node:child_process');
    const cliDest = path.join(root, 'missing-outputs');
    const cli = spawnSync(process.execPath, ['.github/venue/r21-publish.cjs', input, cliDest, '', ''], { env: { ...process.env, ...environment }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const cliVerdict = JSON.parse(fs.readFileSync(path.join(cliDest, 'verdict.json')));
    assert.equal(cliVerdict.setup_exit, null);
    assert.equal(cliVerdict.journey_exit, null);
    assert.equal(cliVerdict.status, 'FAILED');
    fs.unlinkSync(path.join(input, 'r21-receipt.json'));
    fs.writeFileSync(path.join(input, 'r21-progress.json'), JSON.stringify({ first_click: sample.first_click, secret: sample.secret }));
    const missing = publish({ env: environment, evidenceDir: input, destination: path.join(root, 'missing'), setupExit: 0, journeyExit: 1 });
    assert.equal(missing.reason, 'journey_receipt_missing');
    assert.equal(missing.action_inner_exits.first_click.code, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('R-21 rejects absent protected digests even if both sides are absent', () => {
  const value = receipt();
  delete value.protected_state.before.program;
  delete value.protected_state.after_first_click.program;
  assert.throws(() => verifyReceipt(value), /protected state digest/);
});

test('R-21 rejects a first click that changes protected installed bytes', () => {
  const value = receipt();
  value.protected_state.after_first_click.installed_bytes = '1'.repeat(64);
  assert.throws(() => verifyReceipt(value), /installed bytes/);
});

test('R-21 requires accepted initial Install evidence', () => {
  for (const mutate of [
    value => { delete value.install; },
    value => { value.install.action_uri = ACTIONS.update; },
    value => { value.install.installer_dispatch = false; },
    value => { value.install.installer_success = false; },
    value => { value.install.engine_error = true; },
    value => { value.install.running_after = true; },
  ]) {
    const value = receipt(); mutate(value);
    assert.throws(() => verifyReceipt(value), /install/i);
  }
});

test('R-21 requires candidate App-to-Runtime readiness after retry', () => {
  const value = receipt(); value.retry.candidate_app_runtime_ready = false;
  assert.throws(() => verifyReceipt(value), /App-to-Runtime/);
});

test('R-21 rejects retry without positive installer completion or with failures', () => {
  for (const [key, value] of [['installer_success', false], ['engine_error', true], ['launcher_failure', true], ['engine_error', null]]) {
    const sample = receipt(); sample.retry[key] = value;
    assert.throws(() => verifyReceipt(sample), /successful installer completion/);
  }
});

test('R-21 requires the installed candidate both before and after retry', () => {
  const value = receipt(); value.installed_tuple.after_retry = false;
  assert.throws(() => verifyReceipt(value), /installed selected manifests/);
});
