import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureInstalledR0, installedSitePackagesForPython, probeBootstrapExport } from './smoke/r0-installed-capture.mjs';

test('R0 installed capture refuses a non-Windows host before reading an installation', () => {
  assert.throws(() => captureInstalledR0('C:\\disposable\\app\\astrid', { platform: 'linux' }), /requires Windows/);
});

test('R0 installed capture refuses an installation outside its named disposable temp home', () => {
  assert.throws(() => captureInstalledR0('C:\\Users\\person\\AppData\\Local\\Astrid Runtime', {
    platform: 'win32', tempDirectory: 'C:\\Users\\person\\AppData\\Local\\Temp',
    userSid: 'S-1-5-21-1',
  }), /outside a named disposable/);
});

test('R0 site-packages lookup follows the observed py\\Scripts\\python.exe layout', () => {
  const python = 'D:\\a\\_temp\\authentic-r0-capture-windows\\program\\versions\\3204bb00-6d53a190-1aa59606\\py\\Scripts\\python.exe';
  assert.equal(
    installedSitePackagesForPython(python),
    'D:\\a\\_temp\\authentic-r0-capture-windows\\program\\versions\\3204bb00-6d53a190-1aa59606\\py\\Lib\\site-packages',
  );
});

test('R0 site-packages lookup preserves a direct Python home and does not treat Scripts-like names as Scripts', () => {
  assert.equal(installedSitePackagesForPython('C:\\runtime\\py\\python.exe'), 'C:\\runtime\\py\\Lib\\site-packages');
  assert.equal(installedSitePackagesForPython('C:\\runtime\\py\\ScriptsExtra\\python.exe'), 'C:\\runtime\\py\\ScriptsExtra\\Lib\\site-packages');
});

test('R0 import probe uses the version-record Python in isolated no-bytecode mode and records the export', () => {
  let invocation;
  const report = probeBootstrapExport('C:\\temp\\python.exe', 'C:\\temp\\site-packages\\astrid_runtime\\bootstrap.py', {
    runPython: (...args) => {
      invocation = args;
      return { status: 0, stdout: '{"module":"C:\\\\temp\\\\site-packages\\\\astrid_runtime\\\\bootstrap.py","preflight_stop":false}\n', stderr: '' };
    },
  });
  assert.equal(invocation[0], 'C:\\temp\\python.exe');
  assert.deepEqual(invocation[1].slice(0, 2), ['-I', '-B']);
  assert.equal(invocation[2].timeout, 10000);
  assert.equal(report.exitCode, 0);
  assert.equal(report.preflightStopExport, false);
});

test('R0 import probe refuses failed imports and a module path outside the verified installed bytes', () => {
  assert.throws(() => probeBootstrapExport('python.exe', 'C:\\pkg\\bootstrap.py', {
    runPython: () => ({ status: 1, stdout: '', stderr: 'ModuleNotFoundError' }),
  }), /import probe failed \(exit 1\)/);
  assert.throws(() => probeBootstrapExport('python.exe', 'C:\\pkg\\bootstrap.py', {
    runPython: () => ({ status: 0, stdout: '{"module":"C:\\\\other\\\\bootstrap.py","preflight_stop":true}', stderr: '' }),
  }), /outside the authenticated/);
});
