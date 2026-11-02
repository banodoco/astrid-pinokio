'use strict';

// Focused mapping checks only. These tests do not execute a hosted or local
// installer and do not qualify a venue.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const runner = require('../.github/venue/r25-snapshot-runner.cjs');
const workflow = fs.readFileSync(
  require.resolve('../.github/workflows/r25-snapshot-journey.yml'),
  'utf8',
);

test('macOS backend slot selects backend installer and mode', () => {
  assert.deepEqual(
    runner.routeConfig('macos', 'pinokio-backend-macos', 'gui/501/haus.astrid.runtime'),
    {
      targets: { os: 'macos', launchd_targets: ['gui/501/haus.astrid.runtime'] },
      installScript: 'pinokio/install.js',
      installMode: 'backend',
    },
  );
});

test('macOS fully-local slot selects local installer and mode', () => {
  assert.deepEqual(
    runner.routeConfig('macos', 'pinokio-fully-local-macos', 'gui/501/haus.astrid.runtime'),
    {
      targets: { os: 'macos', launchd_targets: ['gui/501/haus.astrid.runtime'] },
      installScript: 'pinokio/install-local.js',
      installMode: 'local',
    },
  );
});

test('workflow maps dispatch slot into runner and artifact identity', () => {
  assert.match(workflow, /options:\s*\[pinokio-backend-macos, pinokio-fully-local-macos\]/);
  assert.match(workflow, /inputs\.slot_id == 'pinokio-backend-macos' \|\| inputs\.slot_id == 'pinokio-fully-local-macos'/);
  assert.match(workflow, /SLOT_ID: \$\{\{ github\.event_name == 'push' && 'pinokio-fully-local-macos' \|\| inputs\.slot_id \}\}/);
  assert.match(workflow, /R25_SLOT_ID: \$\{\{ github\.event_name == 'push' && 'pinokio-fully-local-macos' \|\| inputs\.slot_id \}\}/);
  assert.match(workflow, /name: r25-snapshots-\$\{\{ env\.SLOT_ID \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /name: r25-snapshot-diagnostics-\$\{\{ env\.SLOT_ID \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test('incompatible macOS slot is rejected fail closed', () => {
  assert.throws(
    () => runner.routeConfig('macos', 'pinokio-fully-local-windows', 'gui/501/haus.astrid.runtime'),
    /R25_TARGET_OS and R25_SLOT_ID are incompatible/,
  );
});
