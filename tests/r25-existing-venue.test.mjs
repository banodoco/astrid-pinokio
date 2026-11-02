import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/r25-snapshot-journey.yml', import.meta.url), 'utf8');

test('existing executable Windows venue selects one bounded setup-only run on the task ref', () => {
  assert.match(workflow, /lane\/M-PIN\/R-PIN-WINDOWS-EXISTING-VENUE/);
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-PIN-WINDOWS-EXISTING-VENUE'/);
  assert.match(workflow, /SETUP_ONLY:/);
  assert.match(workflow, /--setup-only true --setup-timeout-ms \$env:R25_SETUP_TIMEOUT_MS/);
  assert.match(workflow, /\$env:SETUP_ONLY -eq 'true'/);
});

test('existing six-action path remains available only on its original push ref or manual slot', () => {
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-25-WINDOWS-LF-ROUTE-R1'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.slot_id == 'pinokio-fully-local-windows'/);
});
