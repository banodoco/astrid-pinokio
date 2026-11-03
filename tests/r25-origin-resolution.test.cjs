'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { resolveProducerJob } = require('../.github/venue/r25-snapshot-runner.cjs');

const expected = {
  jobId: 'macos-six-action',
  runId: 41562449901,
  runAttempt: 1,
  headSha: '70275524f4b1c9501ed1ceda98d2c6f42064a89b',
  slotId: 'pinokio-fully-local-macos',
};

// Captured from GET /repos/banodoco/astrid-pinokio/actions/runs/41562449901/jobs?per_page=100.
const authenticJob = {
  id: 125675981941,
  run_id: 41562449901,
  run_attempt: 1,
  head_sha: '70275524f4b1c9501ed1ceda98d2c6f42064a89b',
  name: 'R-25 hosted macOS (pinokio-fully-local-macos) / macos-six-action',
};

test('resolves the independently reported job id from GitHub reusable-workflow name metadata', () => {
  assert.deepEqual(resolveProducerJob([authenticJob], expected), authenticJob);
});

test('resolves direct workflow jobs when their displayed name carries the selected slot', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'r25-snapshot-journey.yml'), 'utf8');
  assert.match(workflow, /name: R-25 macOS \(\$\{\{ inputs\.slot_id \|\| 'pinokio-fully-local-macos' \}\}\) \/ macos-six-action/);
  const directJob = {
    ...authenticJob,
    name: 'R-25 macOS (pinokio-fully-local-macos) / macos-six-action',
  };
  assert.deepEqual(resolveProducerJob([directJob], expected), directJob);
});

test('fails closed on slot, run, attempt, head, job-name, and ambiguity mismatches', () => {
  const cases = [
    ['wrong slot', { name: 'R-25 hosted macOS (pinokio-backend-macos) / macos-six-action' }],
    ['wrong run', { run_id: expected.runId + 1 }],
    ['wrong attempt', { run_attempt: expected.runAttempt + 1 }],
    ['wrong head', { head_sha: '0'.repeat(40) }],
    ['wrong job name', { name: 'R-25 hosted macOS (pinokio-fully-local-macos) / other-job' }],
    ['missing job id', { id: null }],
  ];
  for (const [label, change] of cases) {
    assert.equal(resolveProducerJob([{ ...authenticJob, ...change }], expected), null, label);
  }
  assert.equal(resolveProducerJob([authenticJob, { ...authenticJob, id: authenticJob.id + 1 }], expected), null, 'ambiguous job');
});
