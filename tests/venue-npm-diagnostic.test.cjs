'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../.github/venue/npm-diagnostic.cjs');
const lock = { packages: {
  'node_modules/better-sqlite3': { version: '12.11.1' },
  'node_modules/@scope/native': { version: '1.2.3' },
} };

test('extracts only the locked Windows package and standard npm tokens', () => {
  const log = ['npm error code 1', 'npm error errno -4058',
    'npm error path C:\\runner\\secret\\node_modules\\better-sqlite3',
    'npm error command https://user:password@example.invalid/token?signature=secret',
    'npm error code ESECRET https://example.invalid', 'npm error code ESECRET'].join('\n');
  assert.equal(diagnose(log, lock), 'package=better-sqlite3@12.11.1\ncode=1\nerrno=-4058');
});

test('handles scoped packages and legacy npm format without retaining untrusted paths', () => {
  assert.equal(diagnose('npm ERR! path /private/node_modules/@scope/native/build\nnpm ERR! code ENOENT', lock),
    'package=@scope/native@1.2.3\ncode=ENOENT');
  assert.equal(diagnose('npm error path /token/node_modules/unknown\nnpm error code https://secret', lock), '');
});

test('retains only allowlisted lifecycle, tool, and reason tokens', () => {
  const log = [
    'npm error lifecycle better-sqlite3@12.11.1~install: failed',
    'npm error command C:\\Users\\secret\\node_modules\\node-gyp\\bin\\node-gyp.js rebuild https://secret.invalid/token',
    'gyp ERR! find Python Python is not set from command line or npm configuration',
    'npm error path C:\\Users\\secret\\node_modules\\better-sqlite3',
    'npm error code 1',
  ].join('\n');
  assert.equal(diagnose(log, lock), [
    'package=better-sqlite3@12.11.1',
    'phase=install',
    'tool=node-gyp',
    'reason=python-missing',
    'code=1',
  ].join('\n'));
});

test('does not echo unrecognized lifecycle commands or reason text', () => {
  const log = [
    'npm error lifecycle secret-package@1.0.0~custom: failed',
    'npm error command C:\\Users\\secret\\unknown-build-tool --token https://secret.invalid',
    'fatal: secret local directory missing',
  ].join('\n');
  assert.equal(diagnose(log, lock), '');
});
