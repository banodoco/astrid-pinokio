'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sequencePath = path.join(__dirname, '..', '.github', 'venue', 'r25-option-b-macos-sequence.sh');
const wrapperPath = path.join(__dirname, '..', '.github', 'venue', 'r25-local-macos-option-b.sh');
const sequence = fs.readFileSync(sequencePath, 'utf8');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');

const venueRef = '327d0fc29f0b63d58e6c6c3449c81af5912ac85c';
const wrapperRef = '37e2337271cffe275374fe9a2eda73e8948ef17a';
const wrapperSha256 = 'c9abcd60a839de2001195f207e63133632d457bc2c4fa921f3ba4c09efdd0570';

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

  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(wrapperPath)).digest('hex');
  assert.equal(actualSha256, wrapperSha256);
  assert.match(wrapper, /python_bin="\$\{PYTHON:-python3\.11\}"/);
  assert.match(wrapper, /\[ "\$python_version" = 3\.11 \]/);
});
