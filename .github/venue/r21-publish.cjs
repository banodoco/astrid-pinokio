'use strict';

// Only explicitly typed, non-secret observations are allowed into the result ref.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDispatch, verifyReceipt, TUPLE, ENDPOINT, REQUEST_ID } = require('./r21-verify.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bool = value => value === true ? true : value === false ? false : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const action = source => source && typeof source === 'object' ? {
  action_id: number(source.action_id),
  action_uri: Object.values(require('./r21-verify.cjs').ACTIONS).includes(source.action_uri) ? source.action_uri : null,
  inner_exit: { code: number(source.inner_exit?.code), signal: source.inner_exit?.signal === null ? null : 'non-null' },
  terminal: { stop: bool(source.terminal?.stop), disconnect: bool(source.terminal?.disconnect), expected_refusal: bool(source.terminal?.expected_refusal) },
  installer_dispatch: bool(source.installer_dispatch), stopped: bool(source.stopped), lock_free: bool(source.lock_free),
  running_after: bool(source.running_after), start_running_after: bool(source.start_running_after),
  daemon_idle: bool(source.daemon_idle), runtime_ready: bool(source.runtime_ready),
  application_ready: bool(source.application_ready), start_running_after_retry: bool(source.start_running_after_retry), start_to_ready: bool(source.start_to_ready),
} : null;
const state = source => source && typeof source === 'object' ? {
  program: hash(source.program), selected_version: hash(source.selected_version), user_data: hash(source.user_data),
} : null;
function projectReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    schema: raw.schema === 1 ? 1 : null,
    request_id: raw.request_id === REQUEST_ID ? REQUEST_ID : null,
    endpoint: raw.endpoint === ENDPOINT ? ENDPOINT : null,
    tuple: Object.fromEntries(Object.entries(TUPLE).map(([k, v]) => [k, raw.tuple?.[k] === v ? v : null])),
    first_click: action(raw.first_click), stop: action(raw.stop), retry: action(raw.retry), cleanup: action(raw.cleanup),
    protected_state: { before: state(raw.protected_state?.before), after_first_click: state(raw.protected_state?.after_first_click), after_retry: state(raw.protected_state?.after_retry) },
  };
}
function publish({ env, evidenceDir, destination, setupExit, journeyExit }) {
  const request = validateDispatch({ request_id: env.R21_REQUEST_ID, confirmation: env.R21_CONFIRMATION, runner_ref: env.R21_RUNNER_REF }, env);
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('numeric run identity required');
  if (env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA) throw new Error('workflow SHA must equal runner SHA');
  for (const code of [setupExit, journeyExit]) if (code !== null && (!Number.isInteger(code) || code < 0 || code > 255)) throw new Error('invalid inner exit');
  const receipt = projectReceipt(read(path.join(evidenceDir, 'r21-receipt.json')));
  const progress = read(path.join(evidenceDir, 'r21-progress.json'));
  let accepted = false;
  let reason = 'journey_receipt_missing';
  if (receipt) {
    try {
      for (const key of ['before', 'after_first_click', 'after_retry']) {
        if (!Object.values(receipt.protected_state[key] || {}).length || Object.values(receipt.protected_state[key]).some(value => !value)) throw new Error('protected_state digest missing');
      }
      verifyReceipt(receipt);
      if (setupExit !== 0 || journeyExit !== 0) throw new Error('inner exit missing or nonzero');
      accepted = true; reason = null;
    } catch (error) { reason = error.message; }
  }
  // Errors from the verifier are fixed strings, except JSON.stringify of an
  // expected constant; never publish exception text from engine or user data.
  const verdict = { schema: 1, status: accepted ? 'ACCEPTED' : 'FAILED', reason,
    setup_exit: setupExit, journey_exit: journeyExit,
    action_inner_exits: Object.fromEntries(['install', 'first_click', 'stop', 'retry', 'cleanup'].map(k => [k, receipt?.[k]?.inner_exit || action(progress?.[k])?.inner_exit || null])),
    workflow_sha: env.GITHUB_WORKFLOW_SHA, run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT };
  fs.mkdirSync(destination, { recursive: true });
  const files = { 'request.json': request, 'verdict.json': verdict };
  if (receipt) files['r21-receipt.json'] = receipt;
  const failure = read(path.join(evidenceDir, 'r21-runner-failure.json'));
  const stages = ['preflight','verify-native-inputs','retain-historical-launcher','verify-published-app-manifest','start-native-engine','run-r21-journey','complete'];
  if (failure && stages.includes(failure.stage)) files['runner-failure.json'] = { schema: 1, status: 'blocked', stage: failure.stage };
  const obsFailure = read(path.join(evidenceDir, 'r21-failure.json'));
  if (obsFailure && ['timeout','engine-or-observer'].includes(obsFailure.category)) files['observer-failure.json'] = { schema: 1, status: 'blocked', category: obsFailure.category };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(destination, name), `${JSON.stringify(data, null, 2)}\n`);
  const sums = Object.keys(files).sort().map(name => `${digest(fs.readFileSync(path.join(destination, name)))}  ${name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(destination, 'SHA256SUMS'), sums);
  return verdict;
}
module.exports = { projectReceipt, publish };
if (require.main === module) {
  const parseExit = value => value === 'not-run' ? null : Number(value);
  const verdict = publish({ env: process.env, evidenceDir: process.argv[2], destination: process.argv[3], setupExit: parseExit(process.argv[4]), journeyExit: parseExit(process.argv[5]) });
  process.stdout.write(`${verdict.status}\n`);
}
