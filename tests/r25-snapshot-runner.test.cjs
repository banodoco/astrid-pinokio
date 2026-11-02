'use strict';

// These tests exercise only the installed-mode parser. They do not run
// Pinokio, an installer, a daemon, or a hosted action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runner = require('../.github/venue/r25-snapshot-runner.cjs');

function withModeFile(value, callback) {
  const root = fs.mkdtempSync(path.join(__dirname, '.mode-receipt-'));
  try {
    fs.mkdirSync(path.join(root, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app', 'install-mode.json'), JSON.stringify(value));
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('returns the parsed installed mode record and binds the expected route', () => {
  const value = withModeFile({ schema_version: 1, mode: 'local' }, root =>
    runner.readInstallModeReceipt(root, 'local'));
  assert.deepEqual(value, { schema_version: 1, mode: 'local' });
});

test('rejects cross-mode, malformed, and extra-field installed records', () => {
  for (const [value, expected] of [
    [{ schema_version: 1, mode: 'backend' }, 'local'],
    [{ schema_version: true, mode: 'local' }, 'local'],
    [{ schema_version: 1, mode: 'local', origin: 'route-label' }, 'local'],
  ]) {
    assert.throws(
      () => withModeFile(value, root => runner.readInstallModeReceipt(root, expected)),
      /installed Pinokio mode receipt differs/,
    );
  }
});

test('maps each Windows slot to its matching Pinokio installer mode', () => {
  assert.deepEqual(
    runner.routeConfig('windows', 'pinokio-backend-windows'),
    {
      targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
      installScript: 'pinokio/install.js',
      installMode: 'backend',
    },
  );
  assert.deepEqual(
    runner.routeConfig('windows', 'pinokio-fully-local-windows'),
    {
      targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
      installScript: 'pinokio/install-local.js',
      installMode: 'local',
    },
  );
});
