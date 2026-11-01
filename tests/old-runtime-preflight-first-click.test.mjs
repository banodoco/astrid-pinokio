import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import library from '../pinokio/lib.js';
import { preflightStop } from '../pinokio/lifecycle.mjs';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
function load(file, app) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'pinokio', `${file}.js`), 'utf8'), {
    module, exports: module.exports, require: (name) => name === './lib' ? app : require(name),
  });
  return module.exports;
}

// This subprocess fixture models an installed Python package predating C1's
// preflight API. It is not an authentic old Runtime or a real engine run.
test('current Update and Stop stay fenced when installed Runtime lacks preflight_stop', { skip: process.platform !== 'linux' }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-old-preflight-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const venv = path.join(temp, 'old-python');
  execFileSync('python3', ['-m', 'venv', '--without-pip', venv]);
  const python = path.join(venv, 'bin', 'python');
  const site = execFileSync(python, ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' }).trim();
  const pkg = path.join(site, 'astrid_runtime');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, '__init__.py'), '');
  fs.writeFileSync(path.join(pkg, 'paths.py'), 'class RuntimePaths: pass\n');
  fs.writeFileSync(path.join(pkg, 'bootstrap.py'), 'class BootstrapError(Exception): pass\n');

  for (const mode of ['backend', 'local']) {
    const events = [];
    const directory = path.join(temp, mode, 'pinokio', 'api', 'Astrid');
    const filesystem = {
      readFileSync(file) {
        if (file.endsWith('install-mode.json')) return JSON.stringify({ schema_version: 1, mode });
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      },
      existsSync: (file) => file === path.join(directory, 'app'),
    };
    const app = library.createApp({ platform: 'linux', appDirectory: directory, filesystem, environment: {},
      lifecycle: {
        preflightStop: async (_root, options) => {
          events.push('preflight');
          return preflightStop({ python, data: temp, env: process.env }, options);
        },
        requestGracefulStop: async () => { events.push('graceful-stop'); },
        waitForInstallerLock: async () => { events.push('lock'); },
      },
      localUpdateOperations: {
        installation: async () => ({}), ready: async () => true,
        prepare: async () => {
          events.push('prepare');
          return { old: { revision: 'fixture' }, snapshot: async () => ({ revision: 'fixture' }),
            cleanup: async () => { events.push('cleanup'); } };
        },
        promote: async () => { events.push('promote'); },
        installer: async () => { events.push('installer'); return { status: 0 }; },
      },
    });
    app.validateExistingEditorCheckout = () => true;
    const kernel = { api: { running: {}, stop: async () => { events.push('kernel-stop'); } } };
    const action = await load('update', app)();
    await assert.rejects(action.run[0].method({}, () => {}, kernel), /cannot import name 'preflight_stop'/);
    assert.deepEqual(events, mode === 'backend' ? ['preflight'] : ['prepare', 'preflight', 'cleanup']);

    events.length = 0;
    const stop = load('stop', app);
    await assert.rejects(stop.run[0].method({}, () => {}, kernel), /cannot import name 'preflight_stop'/);
    assert.deepEqual(events, ['preflight']);
  }
});
