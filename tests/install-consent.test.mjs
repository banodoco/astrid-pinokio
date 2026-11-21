import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import library from '../pinokio/lib.js';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, '..');
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(file, app) {
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: (name) => name === './lib' || name === './pinokio/lib' ? app : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(repository, file), 'utf8'), context, { filename: file });
  return module.exports;
}
function shellMessage(step, platform) {
  if (platform !== 'win32') return step.params.message;
  const payload = step.params.message.match(/--pinokio-payload=([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(payload, 'Windows shell step must carry its encoded Pinokio payload');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).message;
}

for (const platform of ['darwin', 'win32']) {
  for (const source of ['downloaded', 'local']) {
    test(`${platform} ${source} install passes installer --yes`, async () => {
      const appDirectory = platform === 'win32' ? 'C:\\Users\\tester\\pinokio\\api\\Astrid' : '/Users/tester/pinokio/api/Astrid';
      const app = library.createApp({ platform, appDirectory, environment: { ASTRID_APP_REF: 'feature/setup' },
        filesystem: { readFileSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }, existsSync: () => false, mkdirSync() {}, writeFileSync() {}, rmSync() {} },
        lifecycle: { preflightStop: async () => ({ safe: true }), requestGracefulStop: async () => {}, waitForInstallerLock: async () => {} },
        probe: async () => ({ kind: 'free' }) });
      const file = source === 'local' ? 'pinokio/install-local.js' : 'pinokio/install.js';
      const script = await load(file, app)({}, {});
      const messages = script.run.filter((step) => step.method === 'shell.run').map((step) => shellMessage(step, platform));
      const install = source === 'local'
        ? messages.find((message) => /public[\\/]install(?:\.ps1)?/.test(message))
        : messages.at(-1);
      assert.ok(install, 'install action must emit an installer command');
      assert.match(install, /--yes/);
    });
  }
}

test('Pinokio metadata explains recommended install choices', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(repository, 'pinokio.json'), 'utf8'));
  const description = metadata.description;
  assert.match(description, /recommended selection: autostart on/i);
  assert.match(description, /terminal command on/i);
  assert.match(description, /detected agent skills on/i);
  assert.match(description, /skill copies off/i);
  assert.match(description, /Pinokio owns startup/i);
  assert.match(description, /no login service is registered/i);
  assert.match(description, /detected agent skills are enabled for supported agents/i);
  assert.match(description, /skill copies are kept off/i);
  assert.match(description, /Install accepts these choices/i);
});
