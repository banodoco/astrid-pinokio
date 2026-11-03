import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureInstalledR0 } from './smoke/r0-installed-capture.mjs';

test('R0 installed capture refuses a non-Windows host before reading an installation', () => {
  assert.throws(() => captureInstalledR0('C:\\disposable\\app\\astrid', { platform: 'linux' }), /requires Windows/);
});

test('R0 installed capture refuses an installation outside its named disposable temp home', () => {
  assert.throws(() => captureInstalledR0('C:\\Users\\person\\AppData\\Local\\Astrid Runtime', {
    platform: 'win32', tempDirectory: 'C:\\Users\\person\\AppData\\Local\\Temp',
  }), /outside a named disposable/);
});
