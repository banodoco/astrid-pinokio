import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const runner = '.github/venue/r21-real-engine.sh';
const runnerSource = fs.readFileSync(runner, 'utf8');
const observerSource = fs.readFileSync('.github/venue/r21-observe.cjs', 'utf8');

test('R-21 local execution exposes only the pinned Install single-action route', () => {
  const rejected = spawnSync('bash', [runner, '--execute', '--single-action', 'update', 'ignored.json'], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /only --single-action install is supported/);
  assert.match(runnerSource, /R21_LOCAL_CACHE_ROOT/);
  assert.match(runnerSource, /ln -s "\$shared" "\$RUNNER_TEMP\/\$name"/);
  assert.match(runnerSource, /if \[\[ "\$single_action" != install \]\]; then/);
});

test('R-21 targeted Install bypasses acceptance-only App serving and emits bounded action state', () => {
  assert.match(observerSource, /R21_SINGLE_ACTION must be install when set/);
  assert.match(observerSource, /if \(singleAction === 'install'\)/);
  assert.match(observerSource, /r21-single-action\.json/);
  assert.match(observerSource, /the complete protected journey and verifier remain below unchanged/);
});
