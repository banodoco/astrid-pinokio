'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const {
  AFTER, ARIA2_PATH, BEFORE, PINOKIOD_REF, SOURCE_SHA256, patchSource, sha256,
} = require('../.github/venue/r20-linux-seed-fix.cjs');

const pinokiodRoot = path.resolve(__dirname, '../../tmp/pinokiod');
const pinnedSource = execFileSync('git', ['-C', pinokiodRoot, 'show', `${PINOKIOD_REF}:${ARIA2_PATH}`], { encoding: 'utf8' });

test('patch is bound to the exact pinned Aria2 source and only changes env kernel binding', () => {
  const source = pinnedSource;
  assert.equal(sha256(source), SOURCE_SHA256);
  const patched = patchSource(source);
  assert.equal(patched, source.replace(BEFORE, AFTER));
  assert.equal((patched.match(/^  env\(kernel\) \{/gm) || []).length, 1);
  assert.match(patched, /if \(kernel\.platform === 'win32'\)/);
  assert.match(patched, /PATH: \[this\.kernel\.bin\.path\("aria2"\)\]/);
  assert.throws(() => patchSource(source.replace('aria2', 'aria2x')), /source hash mismatch/);
});

test('pinned Aria2 env handles the seed caller kernel for Linux, macOS and Windows', () => {
  const source = patchSource(pinnedSource);
  const sandbox = { module: { exports: {} }, require: () => ({}) };
  vm.runInNewContext(source, sandbox, { filename: 'kernel/bin/aria2.js' });
  const Aria2 = sandbox.module.exports;
  const aria2 = new Aria2();
  aria2.kernel = { bin: { path: (name) => `/mock/bin/${name}` } };
  assert.equal(aria2.env({ platform: 'linux' }), undefined);
  assert.equal(aria2.env({ platform: 'darwin' }), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(aria2.env({ platform: 'win32' }))), { PATH: ['/mock/bin/aria2'] });
  assert.equal(PINOKIOD_REF, 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf');
});
