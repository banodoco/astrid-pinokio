import { test } from 'node:test';
import assert from 'node:assert/strict';
import verify from '../.github/venue/verify.cjs';

const success = [
  { type: 'result', index: 0, total: 2, data: { stopped: false, lockFree: true } },
  { type: 'result', index: 1, total: 2, data: { reset: true, dataKept: true } },
  { type: 'event', data: 'stop' },
  { type: 'disconnect' },
];
test('R-20 requires both Reset steps, normal termination and idle status', () => {
  assert.doesNotThrow(() => verify(success, false));
  for (let i = 0; i < success.length; i++) assert.throws(() => verify(success.filter((_, n) => n !== i), false));
  for (const state of [true, null, undefined]) assert.throws(() => verify(success, state));
  assert.throws(() => verify([...success, { type: 'error' }], false));
});
