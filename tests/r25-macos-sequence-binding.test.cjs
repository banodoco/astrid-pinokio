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
const sequence = fs.readFileSync(sequencePath, 'utf8');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');

const venueRef = '327d0fc29f0b63d58e6c6c3449c81af5912ac85c';
const wrapperRef = '37e2337271cffe275374fe9a2eda73e8948ef17a';
const wrapperSha256 = 'c9abcd60a839de2001195f207e63133632d457bc2c4fa921f3ba4c09efdd0570';
const installPs1Digest = 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258';
const staleInstallPs1Digest = `${installPs1Digest}f`;
const correctedWrapperSha256 = '2f208fdf12154769f4ff524144cc83bf177ac341f7f2c4771f6bdd4b7b891ea1';

test('macOS sequence binds and invokes the corrected immutable wrapper', () => {
  assert.match(sequence, new RegExp(`venue_ref=${venueRef}`));
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
