'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'r25-native-collectors.yml'), 'utf8');
const venueBranch = 'venue/M-PIN-R-25-NATIVE-PROBE-R1';
const tuple = '{"app":"79f7e5397c044c4c97dc7e97b20ad96f787e5247","agent":"ab43bad818ef65ca1e929b973a2f61cd9fc4bf61","runtime":"2776ba973b6c8f3555b5629b0840d9691a98d3c2","pinokio":"3a6a98ae251ca126505245286e2d3e760f4348e9","manifest_sha256":"b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f"}';
const sourceRef = '47059b072889b489b2db20d3a3e86acf02e5a3d4';

test('native collector workflow has one narrowly scoped push venue and retains manual dispatch', () => {
  assert.match(workflow, new RegExp(`push:\\n    branches:\\n      - ${venueBranch}`));
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /branches:\s*\[?\s*(?:main|release-1|lane\/M-PIN\/\*\*)/);
});

test('a venue push fixes the current tuple/source and schedules both native platforms', () => {
  assert.equal((workflow.match(new RegExp(tuple.replace(/[{}]/g, '\\$&'), 'g')) || []).length, 2);
  const pushSource = "SOURCE_REF: ${{ github.event_name == 'push' && '" + sourceRef + "' || inputs.source_ref }}";
  assert.equal(workflow.split(pushSource).length - 1, 2);
  assert.match(workflow, /macos:\n    if: github\.event_name == 'push' \|\| inputs\.target_os == 'macos'/);
  assert.match(workflow, /windows:\n    if: github\.event_name == 'push' \|\| inputs\.target_os == 'windows'/);
  assert.equal((workflow.match(/MODE: \$\{\{ github\.event_name == 'push' && 'both' \|\| inputs\.mode \}\}/g) || []).length, 2);
});
