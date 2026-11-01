import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// R-17 remains an external installer input.  This check deliberately reads
// its supplied checkout instead of copying or implementing installer logic in
// the Pinokio launcher.  A release job supplies the checkout explicitly.
const candidate = '017472bf3e26ad8567accce88991942d094c71c8';
const refusal = "Astrid is still running. Choose Pinokio's Stop button, then try again.";
const checkout = process.env.ASTRID_R17_CANDIDATE_CHECKOUT;

function git(...args) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
}

test('R-21 binds the supplied R-17 stopped-path candidate without owning installer semantics', {
  skip: checkout ? false : 'ASTRID_R17_CANDIDATE_CHECKOUT is required for the cross-repository binding check',
}, () => {
  assert.equal(git('rev-parse', 'HEAD').trim(), candidate);

  const update = git('show', `${candidate}:astrid/installer/app_update.py`);
  assert.match(update, /def preflight_pinokio_update\(/);
  assert.match(update, new RegExp(refusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(update, /never write or invoke C1 while that owner is still alive/);

  const custody = git('show', `${candidate}:astrid/installer/custody.py`);
  assert.match(custody, /def stopped_custody\(/);
  assert.match(custody, /None means running/);
  assert.match(custody, /raise ValueError\("Astrid is still running\. Choose Pinokio's Stop button, then try again\."\)/);

  const oldStop = git('show', `${candidate}:tests/test_installer_pinokio_old_stop.py`);
  assert.match(oldStop, /test_receipt_free_old_stop_needs_custody_and_never_calls_newer_down/);
  assert.match(oldStop, /test_receipt_free_old_stop_does_not_admit_live_controller/);

  const retry = git('show', `${candidate}:tests/test_installer_pinokio_stopped_update.py`);
  assert.match(retry, /stopped-backend/);
  assert.match(retry, /stopped-local/);
});
