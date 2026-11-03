import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { smokeTarget } from './smoke/app-ref.mjs';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('the original hosted smoke continues to select App main', () => {
  assert.deepEqual(smokeTarget('hosted'), { appRef: 'main' });
});

test('the bounded proof-manifest diagnostic selects only the exact App proof ref', () => {
  assert.deepEqual(smokeTarget('hosted-proof-manifest'), {
    appRef: '641e7347efe2396856c9311ea76f2e07e3e719cb',
  });
});

test('unknown hosted smoke targets fail closed', () => {
  assert.throws(() => smokeTarget('hosted-anything-else'), /Unknown hosted smoke target/);
});

test('the existing manual CI workflow dispatches only the bounded diagnostic on this lane', () => {
  assert.match(workflow, /unit:\n\s+name: Unit \(\$\{\{ matrix\.os \}\}\)\n\s+if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| github\.ref != 'refs\/heads\/lane\/M-PIN\/R-PIN-CI-PUBLISHED-MANIFEST' \}\}/);
  assert.match(workflow, /pinokio-smoke:\n\s+name: Pinokio smoke \(\$\{\{ matrix\.os \}\}\)\n\s+if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| github\.ref != 'refs\/heads\/lane\/M-PIN\/R-PIN-CI-PUBLISHED-MANIFEST' \}\}/);
  assert.match(workflow, /published-manifest-stop-diagnostic:\n\s+name: Windows Stop with proof-only App manifest\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/lane\/M-PIN\/R-PIN-CI-PUBLISHED-MANIFEST' \}\}[\s\S]*?run: node tests\/smoke\/run-pinokio\.mjs hosted-proof-manifest/);
});
