import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createBootstrapEvidence, projectBootstrapEvidence, reduceTrace, writeBootstrapEvidence } =
  require('../.github/venue/r21-bootstrap-diagnostics.cjs');
const { publish } = require('../.github/venue/r21-publish.cjs');

const binding = { request_id: 'R-21-PUBLISHED-TUPLE-R1', runner_ref: 'a'.repeat(40),
  run_id: '101', run_attempt: '2' };
const request = { request_id: binding.request_id, runner_ref: binding.runner_ref,
  workflow: { run_id: binding.run_id, run_attempt: binding.run_attempt } };
const trace = [
  '101 1767225600.100000 execve("/usr/bin/curl", ["curl", "-fsSL", "https://private.invalid/install?token=secret", "-o", "/private/cache/install"], 0x1 /* 3 vars */) = 0',
  '101 1767225600.200000 exit_group(0) = ?',
  '102 1767225600.300000 execve("/usr/bin/curl", ["curl", "-fsSL", "https://private.invalid/install-manifest.json?token=secret", "-o", "/private/cache/install-manifest.json"], 0x2 /* 3 vars */) = 0',
  '102 1767225600.400000 exit_group(60) = ?',
].join('\n');

test('bootstrap trace reduces to the first fixed stage, normalized exit, and safe class', () => {
  const reduced = reduceTrace(trace);
  assert.deepEqual(reduced.stages.fetch_install, { observed: true,
    started_at: '2026-01-01T00:00:00.100Z', normalized_exit: 0, safe_class: 'success' });
  assert.deepEqual(reduced.stages.fetch_manifest, { observed: true,
    started_at: '2026-01-01T00:00:00.300Z', normalized_exit: 60, safe_class: 'tls_verification' });
  assert.deepEqual(reduced.stages.execute_installer, { observed: false,
    started_at: null, normalized_exit: null, safe_class: 'not_observed' });
  assert.deepEqual(reduced.first_failure, { stage: 'fetch_manifest', normalized_exit: 60,
    safe_class: 'tls_verification' });
  assert.equal(reduced.next_unresolved_stage, 'fetch_manifest');
  assert.doesNotMatch(JSON.stringify(reduced), /private|secret|invalid|https/);
});

test('missing process evidence is unresolved and is not reported as an observed failure', () => {
  const reduced = reduceTrace('301 1767225602.100000 exit_group(1) = ?');
  assert.equal(reduced.first_failure, null);
  assert.equal(reduced.next_unresolved_stage, 'fetch_install');
  assert.equal(reduced.stages.fetch_install.safe_class, 'not_observed');
});

test('execute_installer is distinguished from later installer fetches', () => {
  const value = reduceTrace([
    '201 1767225601.100000 execve("/usr/bin/curl", ["curl", "-fsSL", "hidden", "-o", "/tmp/a/install"], 0x1) = 0',
    '201 1767225601.200000 exit_group(0) = ?',
    '202 1767225601.300000 execve("/usr/bin/curl", ["curl", "-fsSL", "hidden", "-o", "/tmp/a/install-manifest.json"], 0x1) = 0',
    '202 1767225601.400000 exit_group(0) = ?',
    '203 1767225601.500000 execve("/usr/bin/sh", ["sh", "/tmp/a/install", "--root", "/private/root", "--managed-by", "pinokio", "--manifest", "/tmp/a/install-manifest.json"], 0x1) = 0',
    '204 1767225601.600000 execve("/usr/bin/curl", ["curl", "--output", "/tmp/a/uv.sh", "hidden"], 0x1) = 0',
    '204 1767225601.700000 exit_group(22) = ?',
    '203 1767225601.800000 exit_group(17) = ?',
  ].join('\n'));
  assert.deepEqual(value.first_failure, { stage: 'execute_installer', normalized_exit: 17,
    safe_class: 'installer_nonzero' });
});

test('settlement says whether terminal and child exit preceded the PTerm deadline', () => {
  const evidence = createBootstrapEvidence(trace, request, {
    timer: { deadline_at: '2026-01-01T00:45:00.000Z', fired_at: '2026-01-01T00:45:00.100Z' },
    last_terminal: null,
    child: { exited_at: '2026-01-01T00:45:00.200Z', code: 0, signal: null },
  });
  assert.deepEqual(evidence.binding, binding);
  assert.deepEqual(evidence.settlement, { terminal_before_deadline: false,
    child_exit_before_deadline: false, timer_fired: true,
    pterm_exit: { normalized_exit: 0, safe_class: 'zero' } });
  assert.deepEqual(evidence.instrumentation, { kind: 'linux_ptrace_process_exit',
    historical_launcher_modified: false, installer_bytes_modified: false });
});

test('projection recomputes failure classification from observed stage exits', () => {
  const raw = createBootstrapEvidence(trace, request, {});
  raw.first_failure = { stage: 'execute_installer', normalized_exit: 99, safe_class: 'installer_nonzero' };
  raw.next_unresolved_stage = 'execute_installer';
  raw.stages.fetch_install.safe_class = 'fetch_nonzero';
  raw.stages.execute_installer = { observed: false, started_at: '2026-01-01T00:00:00.000Z',
    normalized_exit: 99, safe_class: 'installer_nonzero' };
  const projected = projectBootstrapEvidence(raw, binding);
  assert.deepEqual(projected.first_failure, { stage: 'fetch_manifest', normalized_exit: 60,
    safe_class: 'tls_verification' });
  assert.equal(projected.next_unresolved_stage, 'fetch_manifest');
  assert.deepEqual(projected.stages.execute_installer, { observed: false, started_at: null,
    normalized_exit: null, safe_class: 'not_observed' });
});

test('private trace is deleted after bounded evidence is written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-bootstrap-'));
  try {
    const tracePath = path.join(root, 'private.trace');
    const requestPath = path.join(root, 'request.json');
    const installPath = path.join(root, 'install.json');
    const outputPath = path.join(root, 'bounded.json');
    fs.writeFileSync(tracePath, trace, { mode: 0o600 });
    fs.writeFileSync(requestPath, JSON.stringify(request));
    fs.writeFileSync(installPath, JSON.stringify({}));
    writeBootstrapEvidence({ tracePath, requestPath, installPath, outputPath });
    assert.equal(fs.existsSync(tracePath), false);
    const bounded = fs.readFileSync(outputPath, 'utf8');
    assert.doesNotMatch(bounded, /private|secret|invalid|https/);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publisher reprojects only exact-bound bootstrap diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-bootstrap-publish-'));
  try {
    const evidenceDir = path.join(root, 'evidence');
    const destination = path.join(root, 'result');
    fs.mkdirSync(evidenceDir);
    const raw = createBootstrapEvidence(trace, request, {});
    raw.secret = '/private/token';
    raw.stages.fetch_manifest.extra = 'https://private.invalid';
    fs.writeFileSync(path.join(evidenceDir, 'r21-bootstrap-diagnostics.json'), JSON.stringify(raw));
    const env = { GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
      GITHUB_SHA: binding.runner_ref, GITHUB_WORKFLOW_SHA: binding.runner_ref,
      GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-PUBLISHED-TUPLE-PROOF-R1',
      GITHUB_RUN_ID: binding.run_id, GITHUB_RUN_ATTEMPT: binding.run_attempt,
      R21_REQUEST_ID: binding.request_id, R21_CONFIRMATION: 'REAL_ENGINE_UPDATE_STOP_RETRY',
      R21_RUNNER_REF: binding.runner_ref };
    publish({ env, evidenceDir, destination, setupExit: 0, journeyExit: 1 });
    const bounded = fs.readFileSync(path.join(destination, 'bootstrap-diagnostics.json'), 'utf8');
    assert.deepEqual(JSON.parse(bounded), projectBootstrapEvidence(raw, binding));
    assert.doesNotMatch(bounded, /private|secret|invalid|https|extra/);

    raw.binding.run_id = '999';
    fs.writeFileSync(path.join(evidenceDir, 'r21-bootstrap-diagnostics.json'), JSON.stringify(raw));
    const other = path.join(root, 'other');
    publish({ env, evidenceDir, destination: other, setupExit: 0, journeyExit: 1 });
    assert.equal(fs.existsSync(path.join(other, 'bootstrap-diagnostics.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real-engine tracing is process-only and reduces after the traced daemon flushes', () => {
  const source = fs.readFileSync('.github/venue/r21-real-engine.sh', 'utf8');
  assert.match(source, /strace --kill-on-exit -f -qq -ttt -s 4096 -e trace=execve,exit_group/);
  assert.match(source, /r21-bootstrap-diagnostics\.cjs[\s\\]+\n\s+--trace/);
  assert.ok(source.indexOf('r21-bootstrap-diagnostics.cjs') > source.indexOf('wait "$daemon_pid"'));
  assert.doesNotMatch(fs.readFileSync('.github/workflows/r21-real-engine.yml', 'utf8'), /bootstrap-strace/);
});
