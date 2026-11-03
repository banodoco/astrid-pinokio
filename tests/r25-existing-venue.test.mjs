import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/r25-snapshot-journey.yml', import.meta.url), 'utf8');
const broadWorkflow = fs.readFileSync(new URL('../.github/workflows/pinokio-venue.yml', import.meta.url), 'utf8');

test('existing executable Windows venue selects one bounded setup-only run on the task ref', () => {
  assert.match(workflow, /lane\/M-PIN\/R-PIN-WINDOWS-EXISTING-VENUE/);
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-PIN-WINDOWS-EXISTING-VENUE'/);
  assert.match(workflow, /SETUP_ONLY:/);
  assert.match(workflow, /--setup-only true --setup-timeout-ms \$env:R25_SETUP_TIMEOUT_MS/);
  assert.match(workflow, /\$env:SETUP_ONLY -eq 'true'/);
});

test('bounded follow-up branch changes the capture and remains setup-only', () => {
  assert.match(workflow, /lane\/M-PIN\/R-PIN-WINDOWS-BOUNDED/);
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-PIN-WINDOWS-BOUNDED'/);
  assert.match(workflow, /SETUP_ONLY:.*R-PIN-WINDOWS-EXISTING-VENUE.*R-PIN-WINDOWS-BOUNDED/);
});

test('capture branch selects exactly the bounded setup-only Windows workflow and excludes the broad venue', () => {
  assert.match(workflow, /lane\/M-PIN\/R-PIN-WINDOWS-CAPTURE/);
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-PIN-WINDOWS-CAPTURE'/);
  assert.match(workflow, /SETUP_ONLY:.*R-PIN-WINDOWS-CAPTURE/);
  assert.match(broadWorkflow, /'!lane\/M-PIN\/R-PIN-WINDOWS-CAPTURE'/);
});

test('PTY integration push selects the changed setup-only route', () => {
  assert.match(workflow, /- lane\/M-PIN\/R-PIN-WINDOWS-PTY-INTEGRATE/);
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-PIN-WINDOWS-PTY-INTEGRATE'/);
  assert.match(workflow, /SETUP_ONLY:.*R-PIN-WINDOWS-PTY-INTEGRATE/);
  assert.doesNotMatch(workflow, /R-PIN-WINDOWS-PTY-INTEGRATE.*six-action/);
});

test('existing six-action path remains available only on its original push ref or manual slot', () => {
  assert.match(workflow, /github\.ref_name == 'lane\/M-PIN\/R-25-WINDOWS-LF-ROUTE-R1'/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.slot_id == 'pinokio-fully-local-windows'/);
});
