import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { boundedFileDiagnostic, completeFileDiagnostic, linuxLockDiagnostic, redactArguments, runTool } from './smoke/process.mjs';
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
      return true;
    });
    assert.equal(fs.readFileSync(logPath, 'utf8').includes('owner pid=4242'), true,
      'the failure diagnostic is available while the smoke home still exists');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fully-local Update callback retains its complete installer diagnostic before home cleanup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-callback-update-'));
  const astridHome = path.join(directory, 'selected');
  const home = path.join(directory, 'home');
  const appDirectory = path.join(directory, 'app');
  const logPath = process.platform === 'win32'
    ? path.join(astridHome, 'Astrid Runtime', 'logs', 'install.log')
    : path.join(astridHome, '.local', 'state', 'astrid-runtime', 'logs', 'install.log');
  const bytes = Buffer.from(`${'x'.repeat(70 * 1024)}\nowner pid=4242\n`);
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
  assert.ok(output.includes(`"sourceBytes":${bytes.length}`));
  assert.ok(output.includes(`"sha256":"${createHash('sha256').update(bytes).digest('hex')}"`));
  const chunks = [...output.matchAll(/^INSTALL_LOG_BASE64 (.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(Buffer.from(chunks.join(''), 'base64'), bytes);
  assert.ok(output.includes('INSTALL_LOG_END'));
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
    assert.match(output, /"status":"unreadable"/);
    assert.match(output, /EISDIR/);
    assert.doesNotMatch(output, /Installer diagnostic: absent/);
  } finally {
    process.stdout.write = write;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('complete log capture preserves bytes and withholds credential-like content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-full-log-'));
  const filename = path.join(directory, 'install.log');
  try {
    assert.equal(completeFileDiagnostic(filename).status, 'missing');
    const bytes = Buffer.concat([Buffer.alloc(150000, 120), Buffer.from([0, 255, 10])]);
    fs.writeFileSync(filename, bytes);
    const result = completeFileDiagnostic(filename);
    assert.deepEqual(Buffer.from(result.base64, 'base64'), bytes);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    fs.writeFileSync(filename, 'token=private-value');
    assert.deepEqual(completeFileDiagnostic(filename), { status: 'withheld', reason: 'credential-like content or environment dump detected' });
    assert.deepEqual(redactArguments(['python', '--token', 'private', '--password=private', 'API_KEY=private', 'https://u:p@example/x', '-c', 'secret code', 'run']),
      ['python', '--token', '[REDACTED]', '[REDACTED]', '[REDACTED]', '[REDACTED]', '-c', '[REDACTED]', 'run']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Linux lock snapshot identifies the kernel owner, process and open lock fd', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-lock-snapshot-'));
  const filename = path.join(directory, 'astrid-install.lock');
  let holder;
  try {
    assert.equal(linuxLockDiagnostic(filename, [directory]).lock.state, 'absent');
    fs.writeFileSync(filename, '');
    const idle = linuxLockDiagnostic(filename, [directory]);
    assert.equal(idle.lock.fileType, 'regular file');
    assert.equal(idle.lock.state, 'no matching kernel lock observed');
    assert.equal(idle.lock.owner.status, 'unknown');
    holder = spawn('python3', ['-u', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(60)', filename, '--token', 'dont-publish'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(holder.stdout, 'data');
    const snapshot = linuxLockDiagnostic(filename, [directory]);
    assert.equal(snapshot.lock.state, 'locked');
    assert.equal(snapshot.lock.entries[0].type, 'FLOCK');
    assert.equal(snapshot.lock.entries[0].mode, 'WRITE');
    assert.equal(snapshot.owners[0].kernelPid, holder.pid);
    const owner = snapshot.owners[0].ancestry[0];
    assert.equal(owner.pid, holder.pid);
    assert.equal(owner.ppid, process.pid);
    assert.ok(owner.startTicks);
    assert.match(owner.startTime, /^\d{4}-/);
    assert.match(owner.executable, /python/);
    assert.ok(owner.commandLine.includes('[REDACTED]'));
    assert.ok(owner.openFds.some((fd) => fd.target === filename && fd.matchesLock === true));
    assert.equal(snapshot.owners[0].ancestry[1].pid, process.pid);
    assert.doesNotMatch(JSON.stringify(snapshot), /dont-publish/);
    assert.equal(linuxLockDiagnostic(filename, ['/not-the-smoke-root']).lock.status, 'unknown');
    assert.equal(linuxLockDiagnostic(filename, [directory], { platform: 'win32' }).lock.status, 'unknown');
    assert.match(linuxLockDiagnostic(filename, [directory], { proc: path.join(directory, 'missing-proc') }).lock.reason, /proc\/locks/);
  } finally {
    if (holder) { holder.kill(); await once(holder, 'close'); }
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
