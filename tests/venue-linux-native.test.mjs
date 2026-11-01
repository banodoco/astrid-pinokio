import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
for (const failObserver of [false, true]) test(`native Linux uses its own action path and cleans up when observer ${failObserver ? 'fails' : 'succeeds'}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'r20-native-test-'));
  try {
    const bin = path.join(root, 'bin');
    const runner = path.join(root, 'runner');
    mkdirSync(bin); mkdirSync(path.join(runner, 'pinokiod'), { recursive: true }); mkdirSync(path.join(runner, 'pterm'));
    const script = (name, body) => writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o755 });
    script('git', 'if [ "$1" = -C ]; then echo pinned; else exec /usr/bin/git "$@"; fi');
    script('docker', 'echo invoked > "$TEST_ROOT/docker-called"; exit 1');
    script('curl', 'printf "{}\\n"');
    script('node', `if [ "$1" = -e ]; then exit 0; fi
if [ "$1" = script/index.js ]; then echo "$$" > "$TEST_ROOT/daemon-pid"; exec sleep 60; fi
printf '%s' "$R20_ACTION_URI" > "$TEST_ROOT/action-uri"
exit ${failObserver ? 1 : 0}`);
    const result = spawnSync('bash', ['.github/venue/linux.sh'], { cwd: repo, encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, RUNNER_TEMP: runner, R20_LINUX_MODE: 'native', GITHUB_RUN_ID: 'test', GITHUB_RUN_ATTEMPT: '1' } });
    assert.equal(result.status, failObserver ? 1 : 0, result.stderr);
    assert.equal(readFileSync(path.join(root, 'action-uri'), 'utf8'), `${runner}/r20-home/api/astrid/pinokio/reset.js`);
    assert.throws(() => readFileSync(path.join(root, 'docker-called')));
    assert.match(readFileSync(path.join(runner, 'r20-evidence', 'SHA256SUMS'), 'utf8'), /identity\.txt/);
    const pid = Number(readFileSync(path.join(root, 'daemon-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
