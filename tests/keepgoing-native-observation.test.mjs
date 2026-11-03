import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeObservation } from './smoke/native-observation.mjs';

test('native first engine refusal survives subsequent terminal and PTerm success', () => {
  const view = createNativeObservation('install');
  view.packet({ type: 'stream', data: { raw: 'Terminated Shell' } });
  view.packet({ type: 'error', data: 'later error' });
  view.packet({ type: 'event', data: 'disconnect' });
  view.observation.pterm_exit = { code: 0 };
  assert.throws(view.validate, /Terminated Shell/);
  assert.equal(view.observation.installer_exit, null);
  assert.equal(view.observation.qualification_eligible, false);
});

test('split installer failure marker remains a failure after terminal event', () => {
  const view = createNativeObservation('update');
  view.packet({ type: 'stream', data: { raw: 'ASTRID_PINOKIO_' } });
  view.packet({ type: 'stream', data: { raw: 'FAILURE' } });
  view.packet({ type: 'event', data: 'stop' });
  view.observation.pterm_exit = { code: 0 };
  assert.throws(view.validate, /ASTRID_PINOKIO_FAILURE/);
});

test('native observations never infer installer success from PTerm exit', () => {
  const view = createNativeObservation('start');
  view.observation.pterm_exit = { code: 0 };
  assert.throws(view.validate, /without an observed engine terminal/);
  view.packet({ type: 'event', data: 'stop' });
  assert.equal(view.validate().installer_exit, null);
  assert.equal(view.validate().qualification_eligible, false);
});
