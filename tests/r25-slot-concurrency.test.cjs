const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);

test('CI concurrency isolates R-25 dispatch slots while retaining same-slot cancellation', () => {
  const group = workflow.match(/^  group: (.+)$/m)?.[1];
  assert.equal(
    group,
    "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event_name == 'workflow_dispatch' && inputs.r25_slot_id != 'none' && inputs.r25_slot_id || 'default' }}",
  );
  assert.match(workflow, /^  cancel-in-progress: true$/m);
  assert.match(workflow, /options: \[none, pinokio-backend-macos, pinokio-fully-local-macos\]/);
});
