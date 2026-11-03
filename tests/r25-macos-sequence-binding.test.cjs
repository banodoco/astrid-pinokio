'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sequencePath = path.join(__dirname, '..', '.github', 'venue', 'r25-option-b-macos-sequence.sh');
const wrapperPath = path.join(__dirname, '..', '.github', 'venue', 'r25-local-macos-option-b.sh');
const runnerPath = path.join(__dirname, '..', '.github', 'venue', 'r25-snapshot-runner.cjs');
const sequence = fs.readFileSync(sequencePath, 'utf8');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');
const runner = fs.readFileSync(runnerPath, 'utf8');

const venueRef = '6c159e87ebb4f8965f93f6de7a9cfa25778b01d4';
const runnerSha256 = '0139869dbfcba0e18613e35c732916f197e7d5a623726509070de5f2d87bf1c8';
const runnerBlob = '54829e23741a8fd26efe538b48e4afc9f0459620';
const observerSha256 = 'b3eb6d0943efaf8aaae268f6ffd94ab8826a7053aff4df142238cc74b73fc94f';
const observerBlob = 'd7eb13d3716528d95f8c24bd4b02033adb03faaa';
const wrapperRef = '37e2337271cffe275374fe9a2eda73e8948ef17a';
const wrapperSha256 = 'c9abcd60a839de2001195f207e63133632d457bc2c4fa921f3ba4c09efdd0570';
const installPs1Digest = 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258';
const staleInstallPs1Digest = `${installPs1Digest}f`;
const correctedWrapperSha256 = '2f208fdf12154769f4ff524144cc83bf177ac341f7f2c4771f6bdd4b7b891ea1';

test('macOS sequence binds and invokes the corrected immutable wrapper', () => {
  assert.match(sequence, new RegExp(`venue_ref=${venueRef}`));
  assert.match(sequence, new RegExp(`inner_snapshot_runner_sha256=${runnerSha256}`));
  assert.match(sequence, new RegExp(`inner_snapshot_runner_blob=${runnerBlob}`));
  assert.match(sequence, new RegExp(`inner_observer_diagnostics_sha256=${observerSha256}`));
  assert.match(sequence, new RegExp(`inner_observer_diagnostics_blob=${observerBlob}`));
  assert.match(sequence, /outer_pinokio_head="\$\(git rev-parse HEAD\)"/);
  assert.match(sequence, /inner_pinokio_head="\$\(git -C "\$sources\/astrid-pinokio" rev-parse HEAD\)"/);
  assert.match(sequence, /test "\$inner_pinokio_head" = "\$venue_ref"/);
  assert.match(sequence, /verify_inner_source \.github\/venue\/r25-snapshot-runner\.cjs/);
  assert.match(sequence, /verify_inner_source \.github\/venue\/r21-observer-diagnostics\.cjs/);
  assert.match(sequence, new RegExp(`wrapper_ref=${wrapperRef}`));
  assert.match(sequence, new RegExp(`wrapper_sha256=${wrapperSha256}`));
  assert.match(sequence, /wrapper_url=.*\$wrapper_ref\/\.github\/venue\/r25-local-macos-option-b\.sh/);
  assert.match(sequence, /curl --fail --silent --show-error --location "\$wrapper_url" --output "\$wrapper_download"/);
  assert.match(sequence, /printf .*"\$wrapper_sha256".*"\$wrapper_download".*shasum -a 256 --check/);
  assert.match(sequence, /bash -n "\$wrapper_path"/);
  assert.match(sequence, /bash "\$wrapper_path"/);
  assert.doesNotMatch(sequence, /bash "\$sources\/astrid-pinokio\/\.github\/venue\/r25-local-macos-option-b\.sh"/);
  assert.match(sequence, /stat -f '%Lp'/);
  assert.doesNotMatch(sequence, /stat -f '%p'/);
  assert.match(sequence, new RegExp(`install_ps1_digest=${installPs1Digest}`));
  assert.match(sequence, new RegExp(`stale_install_ps1_digest="\\$\\{install_ps1_digest\\}f"`));
  assert.match(sequence, new RegExp(`corrected_wrapper_sha256=${correctedWrapperSha256}`));

  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(wrapperPath)).digest('hex');
  assert.equal(actualSha256, wrapperSha256);
  assert.equal(staleInstallPs1Digest.length, 65);
  assert.equal(installPs1Digest.length, 64);
  assert.match(wrapper, /python_bin="\$\{PYTHON:-python3\.11\}"/);
  assert.match(wrapper, /\[ "\$python_version" = 3\.11 \]/);

  const observerPath = path.join(__dirname, '..', '.github', 'venue', 'r21-observer-diagnostics.cjs');
  assert.match(wrapper, /cd "\$venue_root"/);
  assert.match(wrapper, /node \.github\/venue\/r25-snapshot-runner\.cjs/);
  assert.match(runner, /require\('\.\/r21-observer-diagnostics\.cjs'\)/);
  assert.ok(sequence.indexOf('verify_inner_source .github/venue/r21-observer-diagnostics.cjs')
    < sequence.indexOf('bash "$wrapper_path"'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex'), runnerSha256);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(observerPath)).digest('hex'), observerSha256);
  assert.equal(childProcess.execFileSync('git', ['rev-parse', `HEAD:${path.relative(path.join(__dirname, '..'), runnerPath)}`], { encoding: 'utf8' }).trim(), runnerBlob);
  assert.equal(childProcess.execFileSync('git', ['rev-parse', `HEAD:${path.relative(path.join(__dirname, '..'), observerPath)}`], { encoding: 'utf8' }).trim(), observerBlob);
});

test('macOS route preserves both inner row exit codes and returns the wrapper result', () => {
  assert.match(wrapper, /run_slot pinokio-backend-macos 1/);
  assert.match(wrapper, /backend_exit=\$\?/);
  assert.match(wrapper, /run_slot pinokio-fully-local-macos 2/);
  assert.match(wrapper, /local_exit=\$\?/);
  assert.match(wrapper, /runner\.exit/);
  assert.match(sequence, /bash "\$wrapper_path"/);
  assert.match(sequence, /route_exit=\$\?/);
  assert.match(sequence, /printf '%s\\n' "\$route_exit" >"\$run_root\/route\.exit"/);
  assert.match(sequence, /exit "\$route_exit"/);
});

test('macOS preflight accepts portable 700 mode and rejects 755 and Darwin 40700 output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-macos-preflight-'));
  const fakeBin = path.join(root, 'bin');
  const directory = path.join(root, 'run');
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(directory, { mode: 0o700 });
  const fakeStat = path.join(fakeBin, 'stat');
  fs.writeFileSync(fakeStat, [
    '#!/bin/sh',
    '[ "$1" = "-f" ] && [ "$2" = "%Lp" ] || exit 99',
    'if [ -n "${R25_TEST_STAT_OUTPUT:-}" ]; then printf "%s\\n" "$R25_TEST_STAT_OUTPUT"; else stat -c "%a" "$3"; fi',
    '',
  ].join('\n'), { mode: 0o700 });
  const run = output => childProcess.spawnSync('bash', [sequencePath, directory], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, R25_PREFLIGHT_ONLY: '1', R25_TEST_STAT_OUTPUT: output },
    encoding: 'utf8',
  });
  try {
    assert.equal(run('700').status, 0);
    assert.notEqual(run('755').status, 0);
    assert.notEqual(run('40700').status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
