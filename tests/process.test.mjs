import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import library from '../pinokio/lib.js';
import { runSession } from '../pinokio/session.mjs';
import { createController, requestGracefulStop, runCommand } from '../pinokio/lifecycle.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function makeShellApp(tempRoot, name) {
  const appDirectory = path.join(tempRoot, 'pinokio-home', 'api', name);
  const helperDirectory = path.join(appDirectory, 'pinokio');
  fs.mkdirSync(helperDirectory, { recursive: true });
  for (const file of ['shell.mjs', 'environment.js']) {
    fs.copyFileSync(new URL(`../pinokio/${file}`, import.meta.url), path.join(helperDirectory, file));
  }
  return fs.realpathSync(appDirectory);
}
async function execute(command, env) {
  const child = spawn('bash', ['--noprofile', '--norc', '-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}
const writeExecutable = (file, text) => fs.writeFileSync(file, text, { mode: 0o700 });

// Execute the actual caller's build and following mode-write steps. Only the
// subprocess and installer boundaries are inert; runSession owns their cleanup.
for (const platform of ['darwin', 'linux', 'win32']) {
  for (const caller of ['install-local', 'add-local']) {
    for (const outcome of ['success', 'ci failure', '--build failure', 'ci SIGTERM', '--build SIGTERM', 'ci Stop', '--build Stop', 'Runtime exit']) {
      test(`${platform} ${caller}: ${outcome} drains children and writes mode only after build success`, { timeout: 5000 }, async () => {
        const signals = new EventEmitter();
        const active = new Map();
        const completed = [];
        let pid = 8000, statusCount = 0, stop, runtime, stopResponse;
        let modeWrites = 0, controllerCloses = 0, downs = 0;
        const close = (child, code = 0, signal = null) => {
          if (!child || !active.delete(child.pid)) return;
          child.emit('close', code, signal);
        };
        const options = {
          root: '/fixture/astrid', editor: '/fixture/editor', platform,
          installed: { node: '/pinned/node', npx: '/pinned/npx', python: '/pinned/python',
            profile: '/fixture/profile', data: '/fixture/data', env: {} },
          signals, pause: async () => {},
          openController: async (_root, callback) => {
            stop = callback;
            return { close: async () => { controllerCloses++; } };
          },
          gracefulDown: async () => { downs++; close(runtime); },
          killProcess: (group, signal) => close(active.get(-group), null, signal),
          spawnProcess(command, args) {
            const child = new EventEmitter();
            child.pid = ++pid;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            active.set(child.pid, child);
            if (command.endsWith('/run') || command.endsWith('cmd.exe')) runtime = child;
            queueMicrotask(() => {
              if (command.endsWith('taskkill.exe')) {
                close(active.get(Number(args[1])), null, 'SIGKILL'); close(child);
              } else if (args.includes('status')) {
                const healthy = statusCount++ > 0;
                child.stdout.emit('data', JSON.stringify({ support: { healthy },
                  health: { status: 'ok', runtime_instance_id: 'fixture' },
                  discovery: { runtime_instance_id: 'fixture', active_realm: 'fixture' } }));
                close(child, healthy ? 0 : 1);
              } else if (args.includes('ci') || args.includes('--build')) {
                const stage = args.includes('ci') ? 'ci' : '--build';
                if (outcome === `${stage} SIGTERM`) signals.emit('SIGTERM');
                else if (outcome === `${stage} Stop`) stopResponse = stop();
                else if (outcome === `${stage} failure`) close(child, 9);
                else if (stage === '--build' && outcome === 'Runtime exit') close(runtime);
                else { completed.push(stage); close(child); }
              }
            });
            return child;
          },
        };
        const app = {
          readInstallMode: () => caller === 'add-local' ? 'backend' : null,
          hasOwnedSupervisor: () => false, customStep: (method) => ({ method }),
          stopOwnedStart: async () => {}, ensureDoorPortFree: async () => {}, ensureProgramDirectory() {},
          validateExistingEditorCheckout: () => false, cloneEditorMessage: () => '',
          gitShellStep: () => ({ method: async () => {} }), shellStep: () => ({ method: async () => {} }),
          bootstrapScript: () => '', paths: { join: (...parts) => parts.join('/') }, EDITOR_DIR: '/fixture/editor',
          sessionStep: (action, mode) => ({ method: () => {
            assert.equal(action, 'build'); assert.equal(mode, 'local');
            return runSession({ ...options, action, mode });
          } }),
          saveModeStep: (mode) => ({ method: async () => {
            assert.equal(mode, 'local');
            assert.deepEqual(completed, ['ci', '--build']);
            modeWrites++;
          } }),
        };
        const context = { module: { exports: {} }, require: () => app };
        vm.runInNewContext(fs.readFileSync(new URL(`../pinokio/${caller}.js`, import.meta.url), 'utf8'), context);
        const script = await context.module.exports();
        const runSteps = async () => { for (const step of script.run) await step.method(); };
        if (outcome === 'success') await runSteps();
        else await assert.rejects(runSteps(), /command failed|session stopped|quit unexpectedly/);
        if (stopResponse) assert.equal((await stopResponse).ok, true);
        assert.equal((await stop()).ok, true, 'cleanup remains idempotent even when the build failed');
        assert.equal(active.size, 0, 'cancellation must drain every owned child');
        assert.equal(controllerCloses, 1);
        assert.equal(downs, outcome.startsWith('ci ') ? 0 : 1);
        assert.equal(modeWrites, outcome === 'success' ? 1 : 0);
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) assert.equal(signals.listenerCount(signal), 0);
      });
    }
  }
}

test('POSIX failed shell commands emit a Pinokio break event and do not run later commands', { skip: process.platform === 'win32' && 'requires POSIX shell behavior' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-launcher-shell-failure-'));
  try {
    const app = library.createApp({ appDirectory: makeShellApp(temp, 'shell-failure') });
    const step = app.shellStep('false\necho MUST_NOT_RUN');
    const result = await execute(step.params.message, process.env);
    assert.match(result.stdout, /ASTRID_PINOKIO_FAILURE/);
    assert.doesNotMatch(result.stdout, /MUST_NOT_RUN/);
    assert.deepEqual(step.params.on, [{ event: '/ASTRID_PINOKIO_FAILURE/', break: true }]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('POSIX ref bootstrap downloads matching files, forwards manifest, and removes temporary files', { skip: process.platform === 'win32' && 'requires bash and POSIX shell behavior' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-launcher-bootstrap-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-launcher-fake-bin-'));
  try {
    const evidence = path.join(temp, 'evidence.json');
    // Fake curl supplies inert bootstrap bytes rather than accessing a network.
    writeExecutable(path.join(fakeBin, 'curl'), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const url=a[1];const file=a[a.indexOf('-o')+1];\nfs.appendFileSync(process.env.URL_LOG,url+'\\n');\nfs.writeFileSync(file,url.endsWith('/install')?\`#!/bin/sh\\npython3 -c 'import json,os,sys;json.dump(sys.argv[1:],open(os.environ["EVIDENCE"],"w"))' "$@"\\n\`:'{}');\n`);
    const app = library.createApp({ platform: 'darwin', appDirectory: makeShellApp(temp, "O'Malley app"), environment: { ASTRID_APP_REF: 'feat/pinokio' } });
    const result = await execute(app.shellStep(app.bootstrapScript(), { env: {
      PATH: `${fakeBin}:${process.env.PATH}`, EVIDENCE: evidence, URL_LOG: path.join(temp, 'urls'),
    } }).params.message, process.env);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /ASTRID_PINOKIO_FAILURE/);
    const argv = JSON.parse(fs.readFileSync(evidence));
    assert.deepEqual(argv.slice(0, 4), ['--root', app.BACKEND_ROOT, '--managed-by', 'pinokio']);
    assert.equal(argv[4], '--manifest');
    assert.equal(fs.existsSync(path.dirname(argv[5])), false);
    assert.deepEqual(fs.readFileSync(path.join(temp, 'urls'), 'utf8').trim().split('\n'), [
      'https://raw.githubusercontent.com/banodoco/astrid-app/feat/pinokio/public/install',
      'https://raw.githubusercontent.com/banodoco/astrid-app/feat/pinokio/public/install-manifest.json',
    ]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(fakeBin, { recursive: true, force: true }); }
});

test('real POSIX fake Runtime/build processes leave no live descendants after success, failure or interrupt', { skip: process.platform === 'win32' && 'requires POSIX process groups and signals' }, async () => {
  for (const outcome of ['success', 'failure', 'interrupt']) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-launcher-tree-'));
    const signals = new EventEmitter();
    const children = new Set();
    try {
      const root = path.join(temp, 'root'); const editor = path.join(temp, 'editor');
      fs.mkdirSync(root); fs.mkdirSync(path.join(editor, 'scripts'), { recursive: true });
      writeExecutable(path.join(root, 'run'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.on('SIGTERM',()=>{fs.rmSync(process.env.PID_FILE,{force:true});process.exit(0)});setInterval(()=>{},1000);\n`);
      const python = path.join(temp, 'fake-python');
      writeExecutable(python, `#!${process.execPath}\nconst fs=require('node:fs');const healthy=fs.existsSync(process.env.PID_FILE);if(process.argv.includes('down')){if(healthy)process.kill(Number(fs.readFileSync(process.env.PID_FILE)),'SIGTERM');}else{console.log(JSON.stringify({support:{healthy},health:{status:'ok',runtime_instance_id:'fixture'},discovery:{runtime_instance_id:'fixture',active_realm:'fixture'}}));process.exitCode=healthy?0:1;}\n`);
      const npm = path.join(temp, 'npm-cli.cjs'); fs.writeFileSync(npm, 'process.exit(0)');
      const npx = path.join(temp, 'npx-cli.cjs'); fs.writeFileSync(npx, 'process.exit(0)');
      fs.writeFileSync(path.join(editor, 'scripts', 'dev-local-workspace.mjs'), `import fs from 'node:fs';import {spawn} from 'node:child_process';\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.GRANDCHILD_FILE,String(child.pid));\n${outcome === 'success' ? 'child.kill();process.exit(0);' : outcome === 'failure' ? 'process.exit(9);' : 'setInterval(()=>{},1000);'}\n`);
      const pidFile = path.join(temp, 'runtime.pid'); const grandchildFile = path.join(temp, 'grandchild.pid');
      const installed = { node: process.execPath, npm, npx, python, profile: path.join(temp, 'profile.json'), data: path.join(temp, 'data'), env: { ...process.env, PID_FILE: pidFile, GRANDCHILD_FILE: grandchildFile } };
      const pending = runSession({ action: 'build', root, editor, mode: 'local', installed, signals, pause, startupDeadlineMs: Infinity,
        spawnProcess: (...args) => { const child = spawn(...args); children.add(child); child.once('close', () => children.delete(child)); return child; },
      });
      if (outcome === 'interrupt') {
        while (!fs.existsSync(grandchildFile)) await pause(10);
        signals.emit('SIGTERM');
      }
      if (outcome === 'success') await pending;
      else if (outcome === 'interrupt') await assert.rejects(pending, /command failed|session stopped/);
      else await assert.rejects(pending, /command failed/);
      assert.equal(children.size, 0);
      assert.equal(fs.existsSync(pidFile), false);
      const grandchild = Number(fs.readFileSync(grandchildFile, 'utf8'));
      // The kernel may need a scheduling turn to reap a killed descendant.
      while (true) {
        try { process.kill(grandchild, 0); await pause(10); }
        catch (error) { assert.equal(error.code, 'ESRCH'); break; }
      }
    } finally {
      for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
});


test('checkout bootstrap cache is removed on installer failure before a local build', { skip: process.platform === 'win32' && 'requires bash and POSIX shell behavior' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-bootstrap-failure-'));
  try {
    const app = library.createApp({ platform: 'darwin', appDirectory: makeShellApp(temp, 'bootstrap-failure'), environment: {} });
    const publicDir = path.join(app.EDITOR_DIR, 'public');
    fs.mkdirSync(path.join(publicDir, 'bootstrap-venv'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'install'), 'exit 7\n');
    const step = app.shellStep(app.bootstrapScript('install', path.join(publicDir, 'install-manifest.json')));
    const result = await execute(step.params.message, process.env);
    assert.match(result.stdout, /ASTRID_PINOKIO_FAILURE/);
    assert.equal(fs.existsSync(path.join(publicDir, 'bootstrap-venv')), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('real controlled Stop runs fenced down before editor cleanup and releases the foreground temp lock', { skip: process.platform === 'win32' && 'requires POSIX signals, Python fcntl, and process groups' }, async () => {
  const { requestGracefulStop } = await import('../pinokio/lifecycle.mjs');
  const { spawnSync } = await import('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-graceful-stop-'));
  const root = path.join(temp, 'root'); const editor = path.join(temp, 'editor');
  const signals = new EventEmitter();
  const children = new Set();
  let stop;
  try {
    fs.mkdirSync(root); fs.mkdirSync(path.join(editor, 'scripts'), { recursive: true });
    const realPython = spawnSync('python3', ['-I', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    const env = { ...process.env, PID_FILE: path.join(temp, 'runtime.pid'), EDITOR_PID: path.join(temp, 'editor.pid'), EVENTS: path.join(temp, 'events'), TEST_LOCK: path.join(temp, 'installer.lock') };
    writeExecutable(path.join(root, 'run'), `#!${realPython}\nimport os,sys,fcntl,signal,time\nfrom pathlib import Path\nlock=open(os.environ['TEST_LOCK'],'w+b')\nfcntl.flock(lock,fcntl.LOCK_EX)\nPath(os.environ['PID_FILE']).write_text(str(os.getpid()))\ndef stop(*args):\n    with open(os.environ['EVENTS'],'a') as out: out.write('runtime-clean\\n')\n    Path(os.environ['PID_FILE']).unlink()\n    sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nwhile True: time.sleep(1)\n`);
    const python = path.join(temp, 'python-cli');
    writeExecutable(python, `#!${process.execPath}\nconst fs=require('node:fs');const live=fs.existsSync(process.env.PID_FILE);if(process.argv.includes('down')){fs.appendFileSync(process.env.EVENTS,'down\\n');process.kill(Number(fs.readFileSync(process.env.PID_FILE)),'SIGTERM');}else{console.log(JSON.stringify({support:{healthy:live},health:{status:'ok',runtime_instance_id:'fixture'},discovery:{runtime_instance_id:'fixture',active_realm:'fixture'}}));process.exitCode=live?0:1;}\n`);
    fs.writeFileSync(path.join(editor, 'scripts', 'dev-local-workspace.mjs'), `import fs from 'node:fs';fs.writeFileSync(process.env.EDITOR_PID,String(process.pid));process.on('SIGTERM',()=>{fs.appendFileSync(process.env.EVENTS,'editor-stop\\n');process.exit(0)});setInterval(()=>{},1000);`);
    await runSession({ action: 'serve', root, editor, mode: 'local', signals, pause, startupDeadlineMs: Infinity,
      installed: { node: process.execPath, python, profile: path.join(temp, 'profile.json'), data: path.join(temp, 'data'), env },
      spawnProcess: (...args) => { const child = spawn(...args); children.add(child); child.once('close', () => children.delete(child)); return child; },
      portOpen: async () => false,
      request: async (url) => url.endsWith('workspace.json')
        ? { ok: true, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'fixture', realmId: 'fixture' }) }
        : { ok: fs.existsSync(env.EDITOR_PID) },
      output: () => { stop = requestGracefulStop(root); },
    });
    assert.equal((await stop).ok, true);
    assert.deepEqual(fs.readFileSync(env.EVENTS, 'utf8').trim().split('\n'), ['down', 'runtime-clean', 'editor-stop']);
    assert.equal(children.size, 0);
    assert.equal(fs.existsSync(path.join(root, 'pinokio-control.json')), false);
    assert.equal(spawnSync(realPython, ['-I', '-c', 'import fcntl,sys\nf=open(sys.argv[1],"r+b")\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', env.TEST_LOCK]).status, 0);
  } finally {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('real POSIX busy refusal keeps Runtime, editor descendants, controller and session retryable', { skip: process.platform === 'win32' && 'requires POSIX process groups and signals' }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-busy-retry-'));
  const root = path.join(temp, 'root'); const editor = path.join(temp, 'editor');
  const signals = new EventEmitter(); const children = new Set();
  let controller; let runtimePid; let editorPid; let grandchildPid; let busy = true; let downAttempts = 0;
  try {
    fs.mkdirSync(root); fs.mkdirSync(path.join(editor, 'scripts'), { recursive: true });
    const realPython = spawnSync('python3', ['-I', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    const env = { ...process.env, RUNTIME_PID: path.join(temp, 'runtime.pid'), EDITOR_PID: path.join(temp, 'editor.pid'),
      GRANDCHILD_PID: path.join(temp, 'descendant.pid'), BUSY_FILE: path.join(temp, 'busy'), TEST_LOCK: path.join(temp, 'installer.lock') };
    fs.writeFileSync(env.BUSY_FILE, 'busy');
    writeExecutable(path.join(root, 'run'), `#!${realPython}\nimport os,sys,fcntl,signal,time\nfrom pathlib import Path\nlock=open(os.environ['TEST_LOCK'],'w+b')\nfcntl.flock(lock,fcntl.LOCK_EX)\nPath(os.environ['RUNTIME_PID']).write_text(str(os.getpid()))\ndef stop(*args):\n Path(os.environ['RUNTIME_PID']).unlink()\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nwhile True: time.sleep(1)\n`);
    const probeLock = () => spawnSync(realPython, ['-I', '-c', 'import fcntl,sys\nf=open(sys.argv[1],"r+b")\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)', env.TEST_LOCK]);
    const python = path.join(temp, 'python-cli');
    writeExecutable(python, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;if(a.includes('down')){if(fs.existsSync(process.env.BUSY_FILE)){console.log(JSON.stringify({ok:false,error:{message:'Astrid is busy (1 tasks running). Try again when they finish.',details:{task_count:1,blockers:[{task_id:'task-posix',state:'running'}]}}}));process.exit(2)}const p=Number(fs.readFileSync(process.env.RUNTIME_PID));process.kill(p,'SIGTERM');}else{const live=fs.existsSync(process.env.RUNTIME_PID);console.log(JSON.stringify({support:{healthy:live},health:{status:'ok',runtime_instance_id:'fixture'},discovery:{runtime_instance_id:'fixture',active_realm:'fixture'}}));process.exitCode=live?0:1;}\n`);
    fs.writeFileSync(path.join(editor, 'scripts', 'dev-local-workspace.mjs'), `import fs from 'node:fs';import {spawn} from 'node:child_process';fs.writeFileSync(process.env.EDITOR_PID,String(process.pid));const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.env.GRANDCHILD_PID,String(c.pid));setInterval(()=>{},1000);\n`);
    const installed = { node: process.execPath, python, profile: path.join(temp, 'profile.json'), data: path.join(temp, 'data'), env };
    let firstResponse; let retryResponse;
    const session = runSession({ action: 'serve', root, editor, mode: 'local', installed, signals, pause, startupDeadlineMs: Infinity,
      gracefulDown: async (spec, options) => {
        downAttempts++;
        return runCommand(spec, options);
      },
      openController: async (controllerRoot, stop) => {
        controller = await createController(controllerRoot, stop); return controller;
      },
      spawnProcess: (...args) => { const child = spawn(...args); children.add(child); child.once('close', () => children.delete(child)); return child; },
      request: async () => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, runtimeInstanceId: 'fixture', realmId: 'fixture' }) }),
      output: (line) => {
        if (line !== 'ASTRID_PINOKIO_READY') return;
        firstResponse = requestGracefulStop(root).then(async () => { assert.fail('busy stop unexpectedly succeeded'); }, async (error) => {
          assert.equal(error.message, 'Astrid is busy (1 tasks running). Try again when they finish.');
          assert.deepEqual(error.details, { task_count: 1, blockers: [{ task_id: 'task-posix', state: 'running' }] });
          runtimePid = Number(fs.readFileSync(env.RUNTIME_PID, 'utf8'));
          editorPid = [...children].find((child) => child.pid !== runtimePid)?.pid;
          for (let i = 0; i < 100 && !fs.existsSync(env.GRANDCHILD_PID); i++) await pause(10);
          grandchildPid = Number(fs.readFileSync(env.GRANDCHILD_PID, 'utf8'));
          for (const pid of [runtimePid, editorPid, grandchildPid]) process.kill(pid, 0);
          assert.notEqual(probeLock().status, 0, 'busy refusal must retain the fixture lifetime lock');
          assert.equal(fs.existsSync(path.join(root, 'pinokio-control.json')), true);
          busy = false; fs.rmSync(env.BUSY_FILE);
          retryResponse = await requestGracefulStop(root);
        });
      },
    });
    await session; await firstResponse;
    assert.equal(retryResponse.ok, true);
    assert.equal(downAttempts, 2);
    assert.equal(fs.existsSync(path.join(root, 'pinokio-control.json')), false);
    assert.equal(children.size, 0);
    assert.equal(probeLock().status, 0, 'successful retry must release the fixture lifetime lock');
    // kill(pid, 0) also succeeds on an exited, not-yet-reaped zombie. A killed
    // descendant is reaped by its reaper (init here, on a ~2s cadence), so give
    // the kernel a bounded moment; every PID must still end up gone (ESRCH).
    for (const pid of [runtimePid, editorPid, grandchildPid]) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { process.kill(pid, 0); }
        catch (error) { assert.equal(error.code, 'ESRCH'); break; }
        if (Date.now() >= deadline) assert.fail(`PID ${pid} survived successful retry`);
        await pause(10);
      }
    }
  } finally {
    if (controller) await controller.close().catch(() => {});
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
