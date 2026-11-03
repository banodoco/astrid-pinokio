'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, '.github/venue/m46-engine-native-diagnostic.sh');

test('hosted executor requires non-root and exact pinned engine sources', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /\[ "\$\(id -u\)" -ne 0 \] \|\| fail 'refusing root/);
  assert.match(source, /add4a674ad1ba95bb62ec427fce519fe5bf0e9bf/);
  assert.match(source, /5be43718701c448b43daf0ce51d8935f170065bb/);
  assert.match(source, /pinokio\/reset\.js/);
  assert.match(source, /capture_protected: false/);
  assert.match(source, /terminal_status: 'unknown'/);
});

test('hosted executor refuses root before touching the evidence or user state', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'm46-native-guard-'));
  try {
    const result = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: root } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing root: diagnostic requires native non-root execution/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
