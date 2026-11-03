import assert from 'node:assert/strict';
import test from 'node:test';
import { smokeTarget } from './smoke/app-ref.mjs';

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
