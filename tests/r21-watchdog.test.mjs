import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { publish } = createRequire(import.meta.url)('../.github/venue/r21-publish.cjs');
const runner = path.resolve('.github/venue/r21-real-engine.sh');

for (const phase of ['setup', 'journey']) {
  test(`watchdog publishes a bounded ${phase} timeout`, () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r21-watchdog-test-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      // A resistant descendant exercises escalation after its leader receives TERM.
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/bash
if [[ "$R21_FAKE_PHASE" == setup && "$1" == clone ]] || [[ "$R21_FAKE_PHASE" == journey && "$1" == rev-parse ]]; then
  bash -c 'trap "" TERM; echo "$BASHPID" > "$R21_CHILD_PID"; while :; do sleep 1; done' &
  wait
fi
exit 0
`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      const output = path.join(root, 'github-output');
      fs.writeFileSync(output, '');
      const env = {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root,
        GITHUB_OUTPUT: output, R21_FAKE_PHASE: phase, R21_CHILD_PID: path.join(root, 'child.pid'),
        GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/venue/M-PIN-R-21-R12',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
        GITHUB_WORKFLOW_REF: 'banodoco/astrid-pinokio/.github/workflows/r21-real-engine.yml@refs/heads/venue/M-PIN-R-21-R12',
        GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', R21_REQUEST_ID: 'R-21-R12',
        R21_CONFIRMATION: 'REAL_ENGINE_UPDATE_STOP_RETRY', R21_RUNNER_REF: 'a'.repeat(40),
      };
      const started = Date.now();
      const result = spawnSync('bash', [runner, '--watchdog', '2', path.join(root, 'request.json')], { env, encoding: 'utf8', timeout: 12000 });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 124, result.stderr);
      assert.ok(Date.now() - started < 11000, 'deadline and escalation must remain bounded');
      const pid = fs.readFileSync(env.R21_CHILD_PID, 'utf8').trim();
      let state = null;
      try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(state === null || state === 'Z', `resistant descendant still running: ${state}`);
      const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
      assert.equal(outputs.watchdog_exit, '124');
      assert.equal(outputs.setup_exit, phase === 'setup' ? 'not-run' : '0');
      assert.equal(outputs.journey_exit, 'not-run');
      const dest = path.join(root, 'result');
      const verdict = publish({ env, evidenceDir: path.join(root, 'r21-evidence'), destination: dest,
        setupExit: phase === 'setup' ? null : 0, journeyExit: null });
      assert.equal(verdict.status, 'FAILED');
      assert.equal(verdict.reason, 'journey_receipt_missing');
      assert.equal(verdict.workflow_sha, env.GITHUB_SHA);
      assert.equal(verdict.run_id, '100');
      assert.equal(verdict.run_attempt, '1');
      assert.equal(verdict.progress.stage, phase === 'setup' ? 'setup' : 'verify-native-inputs');
      assert.equal(verdict.progress.substage, phase === 'setup' ? 'clone-pinokiod' : null);
      assert.ok(Number.isSafeInteger(verdict.progress.elapsed_ms));
      assert.equal(verdict.watchdog.timed_out, true);
      assert.equal(verdict.watchdog.exit_code, 124);
      assert.ok(verdict.watchdog.elapsed_ms >= 2000 && verdict.watchdog.elapsed_ms < 11000);
      assert.equal(verdict.setup_exit, phase === 'setup' ? null : 0);
      assert.equal(verdict.journey_exit, null);
      assert.ok(Object.values(verdict.action_inner_exits).every(value => value === null));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'request.json'))).runner_ref, env.GITHUB_SHA);
      const checksum = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dest, encoding: 'utf8' });
      assert.equal(checksum.status, 0, checksum.stderr);
      assert.ok(!fs.readFileSync(path.join(dest, 'verdict.json'), 'utf8').includes(root));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
