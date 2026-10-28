import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { bounded, CONTROL_FILE, createController, requestGracefulStop, requestLocalUpdate, runCommand, waitForInstallerLock } from '../pinokio/lifecycle.mjs';

const helper = path.resolve(import.meta.dirname, '../pinokio/installer-lock.py');
test('native hook control is authenticated, awaited and removes its record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-stop-control-'));
  let controller;
  try {
    let release;
    let called;
    const entered = new Promise((resolve) => { called = resolve; });
    controller = await createController(root, async () => { called(); await new Promise((resolve) => { release = resolve; }); return { ok: true }; });
    const record = JSON.parse(fs.readFileSync(path.join(root, CONTROL_FILE)));
    assert.equal((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST' })).status, 403);
    let finished = false;
    const stop = requestGracefulStop(root).then(() => { finished = true; });
    await entered;
    assert.equal(finished, false);
    release(); await stop;
    assert.equal(finished, true);
    await controller.close(); controller = null;
    assert.equal(fs.existsSync(path.join(root, CONTROL_FILE)), false);
    assert.equal((await requestGracefulStop(root)).absent, true);
  } finally { await controller?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('controller failures and deadlines are reported without unbounded test waits', async () => {
  let expire;
  const limited = bounded(new Promise(() => {}), 25_000, 'Runtime exit', { schedule: (callback, ms) => { assert.equal(ms, 25_000); expire = callback; return 1; }, cancel: () => {} });
  expire(); await assert.rejects(limited, /timed out/);
  await assert.rejects(runCommand({ command: 'python', args: ['down'] }, { timeoutMs: 25_000,
    execute: (_cmd, _args, options, done) => { assert.equal(options.timeout, 25_000); assert.equal(options.killSignal, 'SIGKILL'); done({ killed: true, message: 'hung' }, '', ''); },
  }), /timed out/);
  for (const platform of ['darwin', 'linux', 'win32']) {
    let requested = false;
    await assert.rejects(requestGracefulStop('/fake', { platform,
      killProcess: () => {},
      filesystem: { readFileSync: () => JSON.stringify({ schema: 1, pid: 5001, port: 1234, token: 'a'.repeat(64) }) },
      request: async (_url, options) => { requested = true; assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(64)}`); return { ok: false, json: async () => ({ ok: false, errors: ['down failed'] }) }; },
    }), /down failed/);
    assert.equal(requested, true);
  }
});

test('local update control shares the live controller token, checks Host, and blocks Stop while updating', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-local-update-control-'));
  let controller;
  const calls = [];
  let updating = false;
  try {
    controller = await createController(root, async () => ({ ok: true }), { localUpdate: {
      isUpdating: () => updating,
      begin: async () => { calls.push('begin'); updating = true; return { updating: true }; },
      runtime: async (payload) => { calls.push(['runtime', payload]); return { ready: true }; },
      end: async () => { calls.push('end'); updating = false; return { ready: true }; },
    } });
    const record = JSON.parse(fs.readFileSync(path.join(root, CONTROL_FILE)));
    assert.deepEqual(await requestLocalUpdate(root, 'begin'), { ok: true, updating: true });
    // A rollback can re-enter begin before the first candidate Runtime exists.
    assert.deepEqual(await requestLocalUpdate(root, 'begin'), { ok: true, updating: true });
    assert.deepEqual(calls, ['begin', 'begin']);
    assert.equal((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST',
      headers: { Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}` } })).status, 409);
    assert.deepEqual(await requestLocalUpdate(root, 'runtime', { version: 'v2' }),
      { ok: true, ready: true });
    assert.deepEqual(await requestLocalUpdate(root, 'end'), { ok: true, ready: true });
    assert.deepEqual(calls, ['begin', 'begin', ['runtime', { version: 'v2' }], 'end']);
    const denied = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: record.port, path: '/local-update-begin', method: 'POST',
        headers: { Authorization: `Bearer ${record.token}`, Host: `localhost:${record.port}`, 'Content-Type': 'application/json', 'Content-Length': '2' } }, resolve);
      request.on('error', reject); request.end('{}');
    });
    denied.resume(); assert.equal(denied.statusCode, 403);
    await assert.rejects(requestLocalUpdate(root, 'invalid'), /Invalid Pinokio update action/);
  } finally { await controller?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('final Runtime down preserves structured busy details through the controller', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-structured-stop-'));
  let controller;
  const details = { task_count: 1, blockers: [{ task_id: 'task-7', kind: 'render', state: 'running' }] };
  try {
    controller = await createController(root, async () => ({ ok: false,
      errors: ['Astrid is busy (1 tasks running). Try again when they finish.'], details }));
    await assert.rejects(requestGracefulStop(root), (error) => {
      assert.equal(error.message, 'Astrid is busy (1 tasks running). Try again when they finish.');
      assert.deepEqual(error.details, details);
      return true;
    });
  } finally { await controller?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('runCommand keeps Runtime CLI JSON message and details on fenced-down refusal', async () => {
  const details = { blockers: [{ task_id: 'task-8', state: 'cancel_requested' }] };
  const payload = JSON.stringify({ ok: false, error: { message: 'Astrid is busy (1 tasks running). Try again when they finish.', details } });
  await assert.rejects(runCommand({ command: '/pinned/python', args: ['-I', '-m', 'astrid_runtime', 'down'] }, {
    execute: (_command, _args, _options, done) => done(Object.assign(new Error('exit 2'), { code: 2 }), '', payload),
  }), (error) => {
    assert.equal(error.message, 'Astrid is busy (1 tasks running). Try again when they finish.');
    assert.deepEqual(error.details, details);
    return true;
  });
});

test('lock verifier uses installed Python, a bounded wait and fails closed for incomplete installs', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const installed = { python: platform === 'win32' ? 'C:\\pinned\\python.exe' : '/pinned/python', env: { HOME: '/fake-home' } };
    let called = false;
    await waitForInstallerLock('/fake/root', { platform, filesystem: { existsSync: () => true }, installed, run: async (spec, options) => {
      called = true; assert.equal(spec.command, installed.python); assert.deepEqual(spec.args, ['-I', helper, '10']);
      assert.equal(options.timeoutMs, 12_000); assert.equal(options.env, installed.env);
    } });
    assert.equal(called, true);
  }
  await assert.rejects(waitForInstallerLock('/fake/root', { filesystem: { existsSync: () => true, readFileSync: () => { throw new Error('missing installed Python'); } } }), /missing installed Python/);
});

async function executePython(args, env) {
  const child = spawn('python3', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'close'); return { code, output };
}
test('actual lock helper rejects a held temp lock, accepts release and creates no missing lock', { skip: process.platform === 'win32' && 'requires POSIX Python fcntl/flock' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-installer-lock-'));
  let holder;
  try {
    for (const folder of ['astrid', 'astrid/installer', 'runtime_protocol']) {
      fs.mkdirSync(path.join(temp, folder), { recursive: true }); fs.writeFileSync(path.join(temp, folder, '__init__.py'), '');
    }
    fs.writeFileSync(path.join(temp, 'astrid/installer/service.py'), 'import os\nfrom pathlib import Path\ndef installer_lock_path(home, system): return Path(os.environ["TEST_LOCK"])\n');
    fs.writeFileSync(path.join(temp, 'runtime_protocol/platform.py'), 'import fcntl\ndef lock_file(fd, blocking=False): fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\ndef unlock_file(fd): fcntl.flock(fd,fcntl.LOCK_UN)\n');
    const lock = path.join(temp, 'test.lock'); fs.writeFileSync(lock, '');
    holder = spawn('python3', ['-I', '-u', '-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"r+b")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked")\nwhile True: time.sleep(1)', lock], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(holder.stdout, 'data');
    const args = ['-I', '-c', 'import runpy,sys\nsys.path.insert(0,sys.argv.pop(1))\nrunpy.run_path(sys.argv.pop(1),run_name="__main__")', temp, helper, '0'];
    const busy = await executePython(args, { ...process.env, TEST_LOCK: lock });
    assert.notEqual(busy.code, 0); assert.match(busy.output, /Astrid is still running\. Stop it in Pinokio/);
    holder.kill('SIGTERM'); await once(holder, 'close'); holder = null;
    assert.equal((await executePython(args, { ...process.env, TEST_LOCK: lock })).code, 0);
    fs.unlinkSync(lock);
    assert.equal((await executePython(args, { ...process.env, TEST_LOCK: lock })).code, 0);
    assert.equal(fs.existsSync(lock), false);
  } finally { if (holder) { holder.kill('SIGKILL'); await once(holder, 'close'); } fs.rmSync(temp, { recursive: true, force: true }); }
});

test('controllerless stop uses the selected pinned Runtime down and preserves structured details', async () => {
  const { stopRuntime } = await import('../pinokio/lifecycle.mjs');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const appDirectory = platform === 'win32' ? 'C:\\Pinokio\\api\\Astrid' : '/pinokio/api/Astrid';
    const root = p.join(appDirectory, 'app', 'astrid');
    const versionRoot = p.join(root, 'versions', 'v1');
    const node = p.join(versionRoot, 'node', 'bin', 'node');
    const python = p.join(versionRoot, 'py', 'python');
    const profile = p.join(versionRoot, 'profile.json');
    const data = platform === 'win32' ? 'D:\\Data' : '/data';
    const record = { root: versionRoot, python, profile, env: { ASTRID_NODE_EXECUTABLE: node } };
    const files = new Map([[p.join(root, 'current'), 'v1'],
      [p.join(versionRoot, 'version.json'), JSON.stringify(record)],
      [p.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data })]]);
    const filesystem = { existsSync: () => true, readFileSync: (file) => files.get(file) };
    const details = { safe: false, blockers: [{ task_id: 'pinned-down' }] };
    await assert.rejects(stopRuntime(root, { platform, filesystem, environment: {}, appDirectory,
      run: async (spec, options) => {
        assert.deepEqual(spec, { command: python, args: ['-I', '-m', 'astrid_runtime', 'down', '--profile', 'astrid', '--data-root', data, '--source-manifest', profile, '--json'] });
        assert.equal(options.cwd, root);
        assert.equal(options.timeoutMs, 25_000);
        assert.equal(options.env.ASTRID_NODE_EXECUTABLE, node);
        throw Object.assign(new Error('Selected Runtime refused.'), { details });
      },
    }), (error) => { assert.deepEqual(error.details, details); return true; });
    files.set(p.join(root, 'install.json'), JSON.stringify({ owner: 'someone-else', managed_by: 'pinokio', data_root: data }));
    await assert.rejects(stopRuntime(root, { platform, filesystem, run: () => assert.fail('wrong owner must not execute') }), /wasn't installed with Pinokio/);
    await stopRuntime(root, { platform, filesystem: { existsSync: () => false }, run: () => assert.fail('no program files') });
  }
});

test('controller /stop passes only the exact C1 stop report through, as data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-c1-report-'));
  let controller; const seen = [];
  try {
    controller = await createController(root, async (report) => { seen.push(report); return { ok: true }; });
    const record = JSON.parse(fs.readFileSync(path.join(root, CONTROL_FILE)));
    const url = `http://127.0.0.1:${record.port}/stop`;
    const headers = { Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}` };
    assert.equal((await fetch(url, { method: 'POST', body: '{"c1":"stopped"}' })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { ...headers, Host: `localhost:${record.port}` } }, resolve);
      req.on('error', reject); req.end('{"c1":"stopped"}');
    });
    wrongHost.resume(); assert.equal(wrongHost.statusCode, 403);
    assert.deepEqual(seen, []);
    for (const body of [undefined, '', '{}', '{"c1":"refused"}', '{"c1":true}', '{"c1":"stopped"', 'null',
      '"stopped"', '{"command":"down"}', '{"c1":"stopped","extra":1}', '[{"c1":"stopped"}]', '["c1","stopped"]', JSON.stringify({ c1: 'stopped', pad: 'x'.repeat(5000) })]) {
      assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
    }
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{"c1":"stopped"}' })).status, 200);
    assert.deepEqual(seen.map((report) => report.c1Stopped), [...Array(13).fill(false), true]);
  } finally { await controller?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
