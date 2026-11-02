import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { boundedFileDiagnostic, runTool } from './smoke/process.mjs';
import { invokeAction, launchShell } from './smoke/run-pinokio.mjs';

test('installer diagnostics report absence and retain a bounded, hashed log tail', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-install-diagnostic-'));
  const filename = path.join(directory, 'install.log');
  try {
    assert.deepEqual(boundedFileDiagnostic(filename, 8), { status: 'missing' });

    fs.writeFileSync(filename, 'lock owner pid=42');
    const full = boundedFileDiagnostic(filename, 64);
    assert.equal(full.status, 'present');
    assert.equal(full.bytes, 'lock owner pid=42');
    assert.equal(full.sourceBytes, 17);
    assert.equal(full.retainedOffset, 0);
    assert.equal(full.retainedBytes, 17);
    assert.equal(full.truncated, false);
    assert.equal(full.sha256, createHash('sha256').update('lock owner pid=42').digest('hex'));

    const bounded = boundedFileDiagnostic(filename, 8);
    assert.equal(bounded.bytes, 'r pid=42');
    assert.equal(bounded.sourceBytes, 17);
    assert.equal(bounded.retainedOffset, 9);
    assert.equal(bounded.retainedBytes, 8);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.sha256, createHash('sha256').update('r pid=42').digest('hex'));
    assert.throws(() => boundedFileDiagnostic(filename, 0), RangeError);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed Pinokio shell step includes the state installer log before cleanup', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-failed-update-'));
  const home = path.join(directory, 'home');
  const appDirectory = path.join(directory, 'app');
  const logPath = path.join(home, '.local', 'state', 'astrid-runtime', 'logs', 'install.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(appDirectory, { recursive: true });
  fs.writeFileSync(logPath, 'another installer owns the installation lifetime lock\nowner pid=4242');
  try {
    await assert.rejects(launchShell({
      method: 'shell.run',
      params: { shell: 'bash', path: appDirectory, message: 'exit 19' },
    }, { HOME: home, ASTRID_PINOKIO_APP_DIR: appDirectory }), (error) => {
      assert.match(error.message, /bash step failed \(19\)/);
      assert.match(error.message, /another installer owns the installation lifetime lock/);
      assert.match(error.message, /owner pid=4242/);
      assert.match(error.message, /sha256 of retained bytes [a-f0-9]{64}/);
      return true;
    });
    assert.equal(fs.readFileSync(logPath, 'utf8').includes('owner pid=4242'), true,
      'the failure diagnostic is available while the smoke home still exists');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fully-local Update callback retains its bounded installer diagnostic before home cleanup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-callback-update-'));
  const astridHome = path.join(directory, 'selected');
  const home = path.join(directory, 'home');
  const appDirectory = path.join(directory, 'app');
  const logPath = process.platform === 'win32'
    ? path.join(astridHome, 'Astrid Runtime', 'logs', 'install.log')
    : path.join(astridHome, '.local', 'state', 'astrid-runtime', 'logs', 'install.log');
  const bytes = Buffer.from(`${'x'.repeat(70 * 1024)}\nowner pid=4242\n`);
  const tail = bytes.subarray(-64 * 1024);
  const expectedError = new Error('another installer owns the installation lifetime lock');
  fs.mkdirSync(path.join(appDirectory, 'pinokio'), { recursive: true });
  fs.copyFileSync(new URL('../pinokio/update.js', import.meta.url), path.join(appDirectory, 'pinokio', 'update.js'));
  const app = {
    APP_DIR: appDirectory,
    hasPendingUpdate: () => false,
    readInstallMode: () => 'local',
    validateExistingEditorCheckout: () => true,
    customStep: (method) => ({ method }),
    updateLocal: async () => {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, bytes);
      throw expectedError;
    },
  };
  let output = '';
  const write = process.stdout.write;
  try {
    process.stdout.write = function (chunk) { output += chunk.toString(); return true; };
    try {
      await assert.rejects(invokeAction('update', app, appDirectory, { ASTRID_HOME: astridHome, HOME: home, LOCALAPPDATA: astridHome }, directory,
        () => null, async () => {}), (error) => error === expectedError);
      await assert.rejects(invokeAction('update', app, appDirectory, {}, directory,
        () => null, async () => {}), (error) => error === expectedError);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    process.stdout.write = write;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(logPath), false);
  assert.ok(output.includes(logPath));
  assert.ok(output.includes(`65536/${bytes.length} trailing bytes retained from offset ${bytes.length - tail.length}`));
  assert.ok(output.includes(`sha256 of retained bytes ${createHash('sha256').update(tail).digest('hex')}; truncated`));
  assert.ok(output.includes(`--- installer log begin ---\n${tail.toString()}\n--- installer log end ---`));
  assert.ok(output.includes('Installer diagnostic: absent (checked no configured locations)'));
});

test('failed Update callback reports absent and unreadable installer logs', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-callback-absent-'));
  const appDirectory = path.join(directory, 'app');
  const home = path.join(directory, 'home');
  const logPath = path.join(home, '.local', 'state', 'astrid-runtime', 'logs', 'install.log');
  fs.mkdirSync(path.join(appDirectory, 'pinokio'), { recursive: true });
  fs.copyFileSync(new URL('../pinokio/update.js', import.meta.url), path.join(appDirectory, 'pinokio', 'update.js'));
  const app = {
    APP_DIR: appDirectory, hasPendingUpdate: () => false, readInstallMode: () => 'local',
    validateExistingEditorCheckout: () => true, customStep: (method) => ({ method }),
    updateLocal: async () => { throw new Error('callback failed'); },
  };
  let output = '';
  const write = process.stdout.write;
  try {
    process.stdout.write = function (chunk) { output += chunk.toString(); return true; };
    const run = () => invokeAction('update', app, appDirectory, { HOME: home }, directory, () => null, async () => {});
    await assert.rejects(run(), /callback failed/);
    assert.match(output, /Installer diagnostic: absent/);
    assert.ok(output.includes(logPath));
    output = '';
    fs.mkdirSync(logPath, { recursive: true });
    await assert.rejects(run(), /callback failed/);
    assert.match(output, /Installer diagnostic: unreadable/);
    assert.match(output, /EISDIR/);
    assert.doesNotMatch(output, /Installer diagnostic: absent/);
  } finally {
    process.stdout.write = write;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('smoke commands keep draining a noisy server while waiting for its response', async () => {
  const server = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      process.stdout.write('x'.repeat(2 * 1024 * 1024), () => response.end('ready'));
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('message', () => server.close(() => process.exit(0)));
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(server, 'close');
  let drained = 0;
  server.stdout.on('data', (chunk) => { drained += chunk.length; });
  server.stderr.pipe(process.stderr);
  try {
    const [port] = await once(server, 'message');
    const result = await runTool(process.execPath, ['-e', `
      require('node:http').get('http://127.0.0.1:${port}', (response) => {
        response.pipe(process.stdout);
      }).on('error', (error) => { console.error(error); process.exitCode = 1; });
    `], process.env);
    assert.equal(result, 'ready');
    assert.equal(drained, 2 * 1024 * 1024);
  } finally {
    server.send('stop');
    await closed;
  }
});

test('smoke command failures preserve exit status and diagnostics', async () => {
  await assert.rejects(runTool(process.execPath, ['-e', "console.error('fixture failure'); process.exit(7)"], process.env),
    (error) => error.code === 7 && error.stderr.includes('fixture failure'));
});

test('smoke commands receive EOF on stdin', async () => {
  const result = await runTool(process.execPath, ['-e', `
    process.stdin.on('end', () => console.log('EOF'));
    process.stdin.resume();
  `], process.env);
  assert.equal(result.trim(), 'EOF');
});
