import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import library from '../pinokio/lib.js';
import policy from '../pinokio/environment.js';
import { runShell } from '../pinokio/shell.mjs';
import { installation, runSession } from '../pinokio/session.mjs';
import { waitForInstallerLock } from '../pinokio/lifecycle.mjs';
import { pinokioEnv } from './fixtures/pinokio-env.mjs';

const require = createRequire(import.meta.url);
const scripts = ['install', 'install-local', 'update', 'add-local', 'reset', 'uninstall', 'uninstall-delete-data', 'start', 'stop'];
function load(name, app) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL(`../pinokio/${name}.js`, import.meta.url), 'utf8'), {
    module, require: (name) => name === './lib' ? app : require(name),
  });
  return module.exports;
}

// Decode the four quoted arguments actually submitted to Pinokio's shell.
function wrapperArguments(message, win) {
  let i = message.indexOf('node ') + 5;
  const args = [];
  while (args.length < (win ? 2 : 4)) {
    while (/\s/.test(message[i])) i++;
    let value = '', quoted = false;
    while (i < message.length) {
      const char = message[i++];
      if (char === "'") {
        if (win && quoted && message[i] === "'") { value += "'"; i++; }
        else quoted = !quoted;
      } else if (!win && !quoted && char === '\\') value += message[i++];
      else if (!quoted && /\s/.test(char)) break;
      else value += char;
    }
    args.push(value);
  }
  if (win) {
    const prefix = '--pinokio-payload=';
    assert.ok(args[1].startsWith(prefix));
    const payload = JSON.parse(Buffer.from(args[1].slice(prefix.length), 'base64').toString('utf8'));
    return [args[0], payload.appDirectory, payload.message, JSON.stringify(payload.explicit)];
  }
  return args;
}

function fixture(platform, mode) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const home = win ? 'C:\\Pinokio Home' : '/Pinokio Home';
  const appDirectory = p.join(home, 'api', "Astrid O'Malley");
  const root = p.join(appDirectory, 'app', 'astrid');
  const editor = p.join(appDirectory, 'app', 'editor');
  const version = p.join(root, 'versions', 'v1');
  const node = p.join(version, 'tools', 'node', win ? 'node.exe' : 'bin/node');
  const data = win ? 'C:\\fixture\\home\\Astrid' : '/fixture/home/Astrid';
  const environment = { ...pinokioEnv(home, platform), PWD: appDirectory,
    VIRTUAL_ENV: p.join(home, 'bin', 'miniforge'), NODE_OPTIONS: '--bad',
    ASTRID_RUNTIME_DATA_ROOT: p.join(home, 'cache', 'wrong'), ASTRID_CHECKOUT: '/wrong',
    HTTP_PROXY: 'http://proxy.example:8080', https_proxy: 'http://proxy.example:8080', NO_PROXY: 'localhost' };
  const recordEnv = { ASTRID_NODE_EXECUTABLE: node, ASTRID_FFMPEG_EXECUTABLE: p.join(version, 'tools', 'ffmpeg'),
    PATH: [p.dirname(node), win ? 'C:\\recorded-tools' : '/recorded-tools', win ? 'C:\\Windows\\System32' : '/usr/bin'].join(win ? ';' : ':'),
    RECORDED_VALUE: 'kept' };
  const files = new Map([
    [p.join(root, 'current'), 'v1'],
    [p.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data })],
    [p.join(version, 'version.json'), JSON.stringify({ root: version, python: p.join(version, 'py', win ? 'Scripts/python.exe' : 'bin/python'), profile: p.join(version, 'profile.json'), env: recordEnv })],
    [p.join(appDirectory, 'app', 'install-mode.json'), JSON.stringify({ schema_version: 1, mode })],
  ]);
  const filesystem = { readFileSync: (file) => { if (!files.has(file)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return files.get(file); },
    existsSync: () => true, mkdirSync() {}, writeFileSync() {}, rmSync() {} };
  const getTemp = () => '/var/folders/fixture/T/';
  const installed = installation(root, { platform, environment, filesystem, getTemp });
  return { platform, win, p, home, appDirectory, root, editor, environment, filesystem, getTemp, installed, recordEnv };
}

function checkEnvironment(env, f, installed = false) {
  assert.equal(env.HOME, f.environment.HOME);
  assert.equal(env.HTTP_PROXY, f.environment.HTTP_PROXY);
  assert.equal(env.https_proxy, f.environment.https_proxy);
  assert.equal(env.NO_PROXY, 'localhost');
  assert.ok(env.PATH);
  assert.equal(env.ASTRID_INSTALL_MANAGED_BY, 'pinokio');
  const fixtureEnvironment = pinokioEnv(f.home, f.platform);
  const inheritedFixtureKeys = new Set(['HOME', 'USERPROFILE', 'PATH', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'ComSpec', 'PATHEXT']);
  const valueFor = (key) => f.win
    ? Object.entries(env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
    : env[key];
  for (const [key, value] of Object.entries(fixtureEnvironment)) {
    if (inheritedFixtureKeys.has(key)) continue;
    const actual = valueFor(key);
    if ((f.win && ['TEMP', 'TMP'].includes(key)) || (f.platform === 'darwin' && key === 'TMPDIR')) {
      assert.notEqual(actual, value, key);
    } else assert.equal(actual, undefined, key);
  }
  const normalize = (value) => f.win ? value.replace(/\\/g, '/').toLowerCase() : value;
  const home = normalize(f.home);
  for (const [key, value] of Object.entries(env)) {
    // Pinokio's injected values must disappear, even when they contain no path.
    if (key in f.environment && !['HOME', 'USERPROFILE', 'PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'HTTP_PROXY', 'https_proxy', 'NO_PROXY'].includes(key)) {
      assert.notEqual(value, f.environment[key], key);
    }
    for (const part of String(value).split(f.win ? ';' : ':')) {
      const normalized = normalize(part);
      if (normalized.includes(home)) {
        assert.ok([f.root, f.editor].some((root) => normalized === normalize(root) || normalized.startsWith(`${normalize(root)}/`)), `${key}=${value}`);
      }
    }
  }
  for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PYTHONNOUSERSITE', 'GIT_CONFIG_GLOBAL', 'CONDA_PREFIX', 'PIP_REQUIRE_VIRTUALENV', 'UV_PYTHON_PREFERENCE']) assert.equal(env[key], undefined, key);
  if (f.platform === 'darwin') assert.equal(env.TMPDIR, f.getTemp());
  else assert.equal(env.TMPDIR, undefined);
  if (f.win) assert.equal(env.TEMP, f.p.join(env.LOCALAPPDATA, 'Temp'));
  else { assert.equal(env.TEMP, undefined); assert.equal(env.TMP, undefined); }
  if (installed) {
    assert.equal(env.RECORDED_VALUE, 'kept');
    assert.equal(env.ASTRID_FFMPEG_EXECUTABLE, f.recordEnv.ASTRID_FFMPEG_EXECUTABLE);
    assert.ok(env.PATH.includes(f.win ? 'C:\\recorded-tools' : '/recorded-tools'));
  } else assert.equal(env.RECORDED_VALUE, undefined);
}

function checkPinokioEnvironment(env, f) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  assert.equal(env[pathKey], f.environment.PATH);
  assert.ok(env[pathKey].split(f.win ? ';' : ':').includes(f.p.join(f.home, 'bin')));
  assert.equal(env.GIT_CONFIG_GLOBAL, f.environment.GIT_CONFIG_GLOBAL);
  assert.equal(env.ASTRID_PINOKIO_ENVIRONMENT, undefined);
}

async function sessionProcesses(f, action, mode) {
  let pid = 6000, statuses = 0, stop, runtimeChild;
  const active = new Map();
  const close = (child) => { active.delete(child.pid); child.emit('close', 0); };
  await runSession({ action, mode, root: f.root, editor: f.editor, platform: f.platform, installed: f.installed,
    checkStop: async () => ({ safe: true }),
    signals: new EventEmitter(), pause: async () => {}, portOpen: async () => false,
    spawnProcess(command, args, options) {
      checkEnvironment(options.env, f, true);
      const child = new EventEmitter(); child.pid = ++pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); active.set(pid, child);
      if (command.endsWith('/run') || command.endsWith('cmd.exe')) runtimeChild = child;
      queueMicrotask(() => {
        if (args.includes('status')) {
          const healthy = statuses++ > 0;
          child.stdout.emit('data', JSON.stringify({ support: { healthy }, health: { status: 'ok' }, discovery: { runtime_instance_id: 'fixture', active_realm: 'fixture' } }));
          close(child);
        } else if (args.includes('ci') || args.includes('--build')) close(child);
        else if (command.endsWith('taskkill.exe')) { const target = active.get(Number(args[1])); if (target) close(target); close(child); }
      });
      return child;
    },
    killProcess: (group) => { const child = active.get(-group); if (child) close(child); },
    gracefulDown: async (_spec, options) => { checkEnvironment(options.env, f, true); if (runtimeChild && active.has(runtimeChild.pid)) close(runtimeChild); },
    openController: async (_root, callback) => { stop = callback; return { close: async () => {} }; },
    request: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', protocol: 'workspace.v1', schemaVersion: 1, runtimeInstanceId: 'fixture', realmId: 'fixture' }) }),
    output: () => { void stop(); },
  });
  assert.equal(active.size, 0);
}

for (const platform of ['darwin', 'linux', 'win32']) for (const mode of ['backend', 'local']) {
  test(`${platform} ${mode}: every lifecycle shell and Astrid child uses the environment contract`, async () => {
    const f = fixture(platform, mode);
    let lockChecks = 0;
    const app = library.createApp({ ...f, probe: async () => ({ kind: 'free' }),
      execute: (_command, _args, options) => { checkPinokioEnvironment(options.env, f); return { status: 0, stdout: library.EDITOR_REPOSITORY }; }, lifecycle: {
      preflightStop: async () => ({ safe: true, blockers: [] }),
      requestGracefulStop: async () => {},
      waitForInstallerLock: async (root, options) => {
        await waitForInstallerLock(root, { ...options, installed: f.installed, run: async (_spec, options) => { checkEnvironment(options.env, f, true); lockChecks++; } });
      },
    } });
    for (const name of scripts) {
      if (name === 'add-local' && mode === 'local') continue;
      const factory = load(name, app);
      const script = typeof factory === 'function' ? await factory({}, {}) : factory;
      for (const step of [...script.run, ...(script.on?.stop ? [script.on.stop] : [])]) {
        if (typeof step.method === 'function') await step.method({ input: { confirmation: 'DELETE' } }, () => {}, { api: { running: {}, stop: async () => {} } });
        else if (step.method === 'shell.run') {
          const [helper, appDirectory, message, explicit] = wrapperArguments(step.params.message, f.win);
          const pinokioEnvironment = step.params.env?.ASTRID_PINOKIO_ENVIRONMENT === '1';
          if (/\bgit(?: -C| clone)\b/.test(message)) assert.equal(pinokioEnvironment, true, message);
          assert.equal(helper, f.p.join(f.appDirectory, 'pinokio', 'shell.mjs'));
          assert.equal(appDirectory, f.appDirectory);
          await runShell({ appDirectory, message, explicit: JSON.parse(explicit), platform, environment: f.environment, getTemp: f.getTemp, pinokioEnvironment,
            spawnProcess(command, args, options) {
              if (pinokioEnvironment) checkPinokioEnvironment(options.env, f);
              else checkEnvironment(options.env, f);
              assert.equal(options.cwd, f.environment.HOME);
              assert.ok(command.endsWith(f.win ? 'powershell.exe' : '/bash'));
              if (f.win) assert.ok(args.at(-1).endsWith('exit $LASTEXITCODE'));
              else assert.ok(args.at(-1).includes('unset PWD'));
              const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
            },
          });
          if (message.includes('session.mjs')) await sessionProcesses(f, message.includes("'build'") ? 'build' : 'serve', message.includes("'local'") ? 'local' : 'backend');
        }
      }
    }
    assert.ok(lockChecks >= 5);
  });
}

test('Git shell steps keep Pinokio PATH while Astrid shell steps remove it', async () => {
  const f = fixture('linux', 'backend');
  const app = library.createApp({ ...f });
  async function childEnvironment(step) {
    let result;
    await runShell({ appDirectory: f.appDirectory, message: 'true', platform: f.platform,
      environment: f.environment, pinokioEnvironment: step.params.env?.ASTRID_PINOKIO_ENVIRONMENT === '1',
      spawnProcess(_command, _args, options) {
        result = options.env;
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
    return result;
  }

  const gitEnv = await childEnvironment(app.gitShellStep('git --version'));
  checkPinokioEnvironment(gitEnv, f);

  const astridEnv = await childEnvironment(app.shellStep('node --version'));
  checkEnvironment(astridEnv, f);
});

test('environment verifies layout, path boundaries, Windows casing, temp failure and recorded paths', () => {
  assert.throws(() => policy.buildEnvironment({ appDirectory: '/not-pinokio/app' }), /home.*api/);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const f = fixture(platform, 'backend');
    const delimiter = f.win ? ';' : ':';
    const outside = `${f.home}-other`;
    const env = policy.buildEnvironment({ ...f, recordEnv: {}, getTemp: () => '', environment: { ...f.environment,
      PATH: [f.p.join(f.home, 'bin'), outside, './node_modules/.bin', f.win ? 'C:\\Windows' : '/bin'].join(delimiter),
      ...(f.win ? { Path: f.p.join(f.home, 'bin') } : {}) } });
    assert.equal(env.TMPDIR, undefined);
    if (f.win) assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH').length, 1);
    else assert.ok(env.PATH.includes(outside));
    assert.equal(policy.buildEnvironment({ ...f, recordEnv: { ASTRID_FFMPEG_EXECUTABLE: f.p.join(f.home, 'bin', 'ffmpeg') } }).ASTRID_FFMPEG_EXECUTABLE, undefined);
  }
});

test('environment preserves login-service variables while removing Pinokio fixture values', () => {
  const win = fixture('win32', 'backend');
  const windowsVariables = {
    processor_architecture: 'AMD64', processor_architew6432: 'AMD64', windir: 'C:\\Windows',
    SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramW6432: 'C:\\Program Files', ProgramData: 'C:\\ProgramData', ALLUSERSPROFILE: 'C:\\ProgramData',
    CommonProgramFiles: 'C:\\Program Files\\Common Files', 'CommonProgramFiles(x86)': 'C:\\Program Files (x86)\\Common Files',
    CommonProgramW6432: 'C:\\Program Files\\Common Files', PUBLIC: 'C:\\Users\\Public',
    pSmOdUlEpAtH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    NUMBER_OF_PROCESSORS: '8', PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 142 Stepping 10, GenuineIntel',
    PROCESSOR_LEVEL: '6', PROCESSOR_REVISION: '8e0a', OS: 'Windows_NT', COMPUTERNAME: 'TEST-PC',
    USERDOMAIN: 'TEST-PC', USERDOMAIN_ROAMINGPROFILE: 'TEST-PC', LOGONSERVER: '\\\\TEST-PC',
  };
  const windowsEnv = policy.buildEnvironment({ ...win, recordEnv: {}, environment: { ...win.environment, ...windowsVariables } });
  for (const [key, value] of Object.entries(windowsVariables)) {
    assert.equal(Object.entries(windowsEnv).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1], value, key);
  }

  const linux = fixture('linux', 'backend');
  const sessionVariables = { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' };
  const linuxEnv = policy.buildEnvironment({ ...linux, recordEnv: {}, environment: { ...linux.environment, ...sessionVariables } });
  for (const [key, value] of Object.entries(sessionVariables)) assert.equal(linuxEnv[key], value, key);
});

test('native shell wrapper strips a Pinokio environment at the real child boundary and preserves exit status', async () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-env-boundary-')));
  try {
    const home = path.join(temp, 'pinokio');
    const appDirectory = path.join(home, 'api', "Astrid O'Malley");
    const userHome = path.join(temp, 'user');
    fs.mkdirSync(appDirectory, { recursive: true }); fs.mkdirSync(userHome);
    const file = path.join(temp, 'environment.json');
    const childScript = path.join(temp, 'environment-child.cjs');
    const environment = { ...pinokioEnv(home, process.platform), HOME: userHome,
      ...(process.platform === 'win32' ? { USERPROFILE: userHome, LOCALAPPDATA: path.join(userHome, 'AppData', 'Local'), APPDATA: path.join(userHome, 'AppData', 'Roaming') } : {}), ASTRID_RUNTIME_DOOR_PORT: '17341' };
    if (process.platform === 'win32') fs.mkdirSync(path.join(environment.LOCALAPPDATA, 'Temp'), { recursive: true });
    const app = library.createApp({ appDirectory });
    const q = process.platform === 'win32' ? (value) => `'${value.replace(/'/g, "''")}'` : (value) => `'${value.replace(/'/g, "'\\''")}'`;
    const code = `require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify(process.env));process.exit(7)`;
    fs.writeFileSync(childScript, code);
    const command = `${process.platform === 'win32' ? '& ' : ''}${q(process.execPath)} ${q(childScript)}`;
    const message = process.platform === 'win32' ? command : `sh -c ${q(command)}`;
    assert.equal(await runShell({ appDirectory, environment, message, explicit: { ASTRID_RUNTIME_DOOR_PORT: '17341' } }), 7);
    const env = JSON.parse(fs.readFileSync(file));
    assert.equal(env.HOME, userHome);
    assert.equal(env.ASTRID_RUNTIME_DOOR_PORT, '17341');
    for (const [key, value] of Object.entries(env)) assert.ok(!value.includes(home), `${key}=${value}`);
    for (const key of ['PYTHONNOUSERSITE', 'GIT_CONFIG_GLOBAL', 'CONDA_PREFIX', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'PIP_REQUIRE_VIRTUALENV', 'UV_PYTHON_PREFERENCE']) assert.equal(env[key], undefined);
    assert.ok(env.PATH);
    assert.equal(app.BACKEND_ROOT, path.join(appDirectory, 'app', 'astrid'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('older Pinokio tool/cache records refuse Start and block Reset before mutation when preflight is unavailable', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const f = fixture(platform, 'backend');
    const filesystem = { ...f.filesystem, readFileSync(file) {
      const bytes = f.filesystem.readFileSync(file);
      if (file.endsWith('version.json')) {
        const record = JSON.parse(bytes);
        record.env.ASTRID_FFMPEG_EXECUTABLE = f.p.join(f.home, 'bin', 'ffmpeg');
        record.env.ASTRID_RUNTIME_DATA_ROOT = f.p.join(f.home, 'cache', 'XDG_DATA_HOME', 'Astrid');
        record.env.PATH = `${f.p.join(f.home, 'bin')}${f.win ? ';' : ':'}${record.env.PATH}`;
        return JSON.stringify(record);
      }
      if (file.endsWith('install.json')) return JSON.stringify({ ...JSON.parse(bytes), data_root: f.p.join(f.home, 'cache', 'XDG_DATA_HOME', 'Astrid') });
      return bytes;
    } };
    assert.throws(() => installation(f.root, { ...f, filesystem }), /Choose Reset, then Install again/);
    const order = [];
    filesystem.rmSync = () => order.push('remove');
    const app = library.createApp({ ...f, filesystem, lifecycle: {
      preflightStop: async () => { order.push('preflight'); throw new Error('Runtime stop preflight is unavailable for this installation.'); },
      waitForInstallerLock: (root, options) => waitForInstallerLock(root, { ...options, run: async (spec, options) => {
        order.push('lock');
        assert.equal(spec.command, f.installed.python);
        assert.equal(options.env.HOME, f.environment.HOME);
        assert.equal(options.env.RECORDED_VALUE, 'kept');
        assert.equal(options.env.ASTRID_NODE_EXECUTABLE, f.installed.node);
        assert.equal(options.env.ASTRID_FFMPEG_EXECUTABLE, undefined);
        assert.equal(options.env.ASTRID_RUNTIME_DATA_ROOT, undefined);
        assert.equal(options.env.XDG_DATA_HOME, undefined);
        assert.ok(!options.env.PATH.includes(f.p.join(f.home, 'bin')));
      } }),
    } });
    const script = await load('reset', app)({}, {});
    await assert.rejects(script.run[0].method({}, () => {}, { api: { running: {} } }), /Runtime stop preflight is unavailable/);
    assert.deepEqual(order, ['preflight']);
  }
});
