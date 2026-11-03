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

const venueRef = '5ad7ef974f5f11643ba19da95c20fbaeb9fca442';
const wrapperRef = '5ad7ef974f5f11643ba19da95c20fbaeb9fca442';
const wrapperSha256 = '2f208fdf12154769f4ff524144cc83bf177ac341f7f2c4771f6bdd4b7b891ea1';

test('macOS sequence binds and invokes the corrected immutable wrapper', () => {
  assert.match(sequence, new RegExp(`venue_ref=${venueRef}`));
  assert.match(sequence, new RegExp(`wrapper_ref=${wrapperRef}`));
  assert.match(sequence, new RegExp(`wrapper_sha256=${wrapperSha256}`));
  assert.match(sequence, /wrapper_url=.*\$wrapper_ref\/\.github\/venue\/r25-local-macos-option-b\.sh/);
  assert.match(sequence, /curl --fail --silent --show-error --location "\$wrapper_url" --output "\$wrapper_download"/);
  assert.match(sequence, /printf .*"\$wrapper_sha256".*"\$wrapper_download".*shasum -a 256 --check/);
  assert.match(sequence, /bash -n "\$wrapper_path"/);
  assert.match(sequence, /bash "\$wrapper_path"/);
  assert.match(sequence, /stat -f '%Lp' "\$run_root"/);
  assert.doesNotMatch(sequence, /stat -f '%p' "\$run_root"/);
  assert.doesNotMatch(sequence, /bash "\$sources\/astrid-pinokio\/\.github\/venue\/r25-local-macos-option-b\.sh"/);

  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(wrapperPath)).digest('hex');
  assert.equal(actualSha256, wrapperSha256);
  assert.match(wrapper, /python_bin="\$\{PYTHON:-python3\.11\}"/);
  assert.match(wrapper, /\[ "\$python_version" = 3\.11 \]/);
  const tuple = JSON.parse(/^tuple='([^']+)'$/m.exec(wrapper)[1]);
  assert.equal(tuple.artifacts['public/install.ps1'], 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258');
  for (const digest of Object.values(tuple.artifacts)) assert.match(digest, /^[0-9a-f]{64}$/);
});
