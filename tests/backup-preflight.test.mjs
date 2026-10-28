import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { preflightBackup, PREFLIGHT_MS } from '../pinokio/backup-preflight.mjs';
import library from '../pinokio/lib.js';

const require = createRequire(import.meta.url);
const helper = path.resolve(import.meta.dirname, '../pinokio/backup-preflight.py');
const repository = path.resolve(import.meta.dirname, '..');
const makeTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-backup-preflight-'));

function withFixture(work) {
  const temp = fs.realpathSync(makeTemp());
  const root = path.join(temp, 'program');
  const data = path.join(temp, 'support');
  try {
    for (const folder of ['astrid', 'astrid/installer', 'program', 'support/runtime', 'support/logs']) {
      fs.mkdirSync(path.join(temp, folder), { recursive: true });
    }
    for (const folder of ['astrid', 'astrid/installer']) fs.writeFileSync(path.join(temp, folder, '__init__.py'), '');
    fs.writeFileSync(path.join(temp, 'astrid/installer/core.py'), `from pathlib import Path
def absolute(value):
    path = Path(value)
    if not path.is_absolute(): raise ValueError('An absolute path is required')
    for entry in (path, *path.parents):
        if entry.is_symlink(): raise ValueError(f'Managed paths cannot contain links: {entry}')
    return path
`);
    fs.writeFileSync(path.join(temp, 'astrid/installer/service.py'), 'import os\nfrom pathlib import Path\ndef install_selection(home, system): return Path(os.environ["TEST_SELECTION"])\n');
    // Stand-in installed policy; the launcher helper itself has no exclusion list.
    fs.writeFileSync(path.join(temp, 'astrid/installer/backend.py'), `from pathlib import Path
class Backend:
    @staticmethod
    def _backup_ignored(source, parent, names, *, support):
        ignored = set()
        if support and parent == source: ignored.add('logs')
        if support and parent == source / 'runtime':
            ignored.update({'realms', 'discovery.json', 'instance.lock', 'bootstrap.lock'})
        for name in set(names) - ignored:
            entry = parent / name
            if entry.is_symlink(): raise ValueError(f'Backup refused a linked entry: {entry}')
        return ignored.intersection(names)
`);
    fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data }));
    fs.writeFileSync(path.join(data, 'user.json'), '{}');
    return work({ temp, root, data });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function runHelper(temp, root) {
  // -I ignores ambient imports; the test inserts only its temporary installed package.
  const code = 'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_path(sys.argv.pop(1),run_name="__main__")';
  return spawnSync('python3', ['-I', '-B', '-c', code, temp, helper, root], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, TEST_SELECTION: path.join(temp, 'selection.json') } });
}

function snapshot(folder) {
  const entries = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const entry = path.join(folder, name);
    const stat = fs.lstatSync(entry);
    entries.push([name, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(entry) : stat.isDirectory() ? snapshot(entry) : fs.readFileSync(entry).toString('hex')]);
  }
  return entries;
}

test('read-only helper rejects admitted links and ignores installed-policy exclusions', () => withFixture(({ temp, root, data }) => {
  for (const name of ['logs/private', 'runtime/realms/other', 'runtime/discovery.json', 'runtime/instance.lock', 'runtime/bootstrap.lock']) {
    fs.mkdirSync(path.dirname(path.join(data, name)), { recursive: true });
    fs.symlinkSync(path.join(temp, 'outside'), path.join(data, name));
  }
  const before = snapshot(temp);
  assert.equal(runHelper(temp, root).status, 0);
  assert.deepEqual(snapshot(temp), before);
  fs.symlinkSync(path.join(temp, 'outside'), path.join(data, 'runtime', 'linked.json'));
  const rejected = snapshot(temp);
  const failure = runHelper(temp, root);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Backup refused a linked entry:.*linked\.json/);
  assert.deepEqual(snapshot(temp), rejected);
}));

test('helper fails closed for missing policy, invalid install record and unavailable support', () => withFixture(({ temp, root, data }) => {
  const backend = path.join(temp, 'astrid/installer/backend.py');
  const policy = fs.readFileSync(backend);
  fs.rmSync(backend);
  assert.match(runHelper(temp, root).stderr, /No module named.*backend/);
  fs.writeFileSync(backend, 'raise ImportError("policy unavailable")\n');
  assert.match(runHelper(temp, root).stderr, /policy unavailable/);
  fs.writeFileSync(backend, policy);
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ owner: 'wrong', data_root: data }));
  assert.match(runHelper(temp, root).stderr, /not owned by Pinokio/);
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: data }));
  fs.rmSync(data, { recursive: true });
  assert.match(runHelper(temp, root).stderr, /Backup source is unavailable/);
}));

test('selection-record data root mismatch refuses before scanning another support root', () => withFixture(({ temp, root, data }) => {
  const selection = path.join(temp, 'selection.json');
  fs.writeFileSync(selection, JSON.stringify({ owner: 'haus.astrid.runtime', program_root: root, data_root: data }));
  assert.equal(runHelper(temp, root).status, 0);
  fs.writeFileSync(selection, JSON.stringify({ owner: 'haus.astrid.runtime', data_root: path.join(temp, 'other') }));
  const before = snapshot(temp);
  const refusal = runHelper(temp, root);
  assert.notEqual(refusal.status, 0);
  assert.match(refusal.stderr, /different support roots/);
  assert.deepEqual(snapshot(temp), before);
  fs.symlinkSync(path.join(temp, 'outside'), path.join(data, 'linked'));
  for (const [record, message] of [
    [{ owner: 'haus.astrid.runtime', program_root: root }, /no support root/],
    [{ owner: 'haus.astrid.runtime', program_root: path.join(temp, 'other'), data_root: data }, /different program root/],
  ]) {
    fs.writeFileSync(selection, JSON.stringify(record));
    const unchanged = snapshot(temp);
    const failed = runHelper(temp, root);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, message);
    assert.deepEqual(snapshot(temp), unchanged);
  }
}));

function installedFixture(platform, overrides = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'C:\\Astrid\\api\\app\\app\\astrid' : '/Astrid/api/app/app/astrid';
  const versionRoot = p.join(root, 'versions', 'v1');
  const python = p.join(versionRoot, 'py', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const node = p.join(versionRoot, 'tools', 'node', platform === 'win32' ? 'node.exe' : 'bin/node');
  const files = new Map([
    [p.join(root, 'current'), 'v1'],
    [p.join(versionRoot, 'version.json'), JSON.stringify({ root: versionRoot, python, profile: p.join(versionRoot, 'profile.json'), env: { ASTRID_NODE_EXECUTABLE: node } })],
    [p.join(root, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: platform === 'win32' ? 'D:\\Astrid Data' : '/data/workspace' })],
  ]);
  const filesystem = { readFileSync: (file) => files.get(file), existsSync: () => true,
    lstatSync: () => ({ isSymbolicLink: () => false }) };
  return { root, python, files, filesystem, ...overrides };
}

test('pinned Python runs isolated with a bounded command on every platform', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const fixture = installedFixture(platform);
    let called = false;
    await preflightBackup(fixture.root, { platform, filesystem: fixture.filesystem, environment: { PYTHONPATH: '/ambient' },
      run: async (spec, options) => {
        called = true;
        assert.equal(spec.command, fixture.python);
        assert.deepEqual(spec.args, ['-I', '-B', helper, fixture.root]);
        assert.equal(options.timeoutMs, PREFLIGHT_MS);
        assert.equal(options.env.PYTHONPATH, undefined);
      } });
    assert.equal(called, true);
  }
});

test('invalid current or Python path and process failure refuse before mutation', async () => {
  const fixture = installedFixture('darwin');
  let calls = 0;
  const run = async () => { calls++; };
  const currentFile = path.posix.join(fixture.root, 'current');
  const linkedFilesystem = { ...fixture.filesystem,
    lstatSync: (file) => ({ isSymbolicLink: () => file === currentFile }) };
  await assert.rejects(preflightBackup(fixture.root, { platform: 'darwin', filesystem: linkedFilesystem, run }), /Installed path is linked/);
  assert.equal(calls, 0);
  fixture.files.set(path.posix.join(fixture.root, 'current'), '../outside');
  await assert.rejects(preflightBackup(fixture.root, { platform: 'darwin', filesystem: fixture.filesystem, run }), /Invalid Astrid version pointer/);
  assert.equal(calls, 0);
  fixture.files.set(path.posix.join(fixture.root, 'current'), 'v1');
  const recordFile = path.posix.join(fixture.root, 'versions/v1/version.json');
  const record = JSON.parse(fixture.files.get(recordFile));
  record.python = '/elsewhere/python'; fixture.files.set(recordFile, JSON.stringify(record));
  await assert.rejects(preflightBackup(fixture.root, { platform: 'darwin', filesystem: fixture.filesystem, run }), /Pinned Python is outside/);
  assert.equal(calls, 0);
  record.python = fixture.python; fixture.files.set(recordFile, JSON.stringify(record));
  await assert.rejects(preflightBackup(fixture.root, { platform: 'darwin', filesystem: fixture.filesystem,
    run: async (_spec, options) => { assert.equal(options.timeoutMs, PREFLIGHT_MS); throw new Error('Command timed out'); } }), /Command timed out/);
});

test('add-local and update refuse before stop, pull or build; eligible preflight reaches stop', async () => {
  for (const name of ['add-local', 'update']) {
    const log = [];
    let eligible = false;
    const app = { ...library.createApp({ appDirectory: '/tmp/astrid-fixture', filesystem: { readFileSync: () => JSON.stringify({ schema_version: 1, mode: 'backend' }), existsSync: () => false,
      mkdirSync: () => log.push('mkdir'), writeFileSync: () => log.push('mode') }, probe: async () => ({ kind: 'free' }) }),
      hasPendingUpdate: () => false, preflightBackup: async () => { log.push('preflight'); if (!eligible) throw new Error('Backup refused a linked entry'); },
      stopOwnedStart: async () => { log.push('stop'); }, validateExistingEditorCheckout: () => false };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(repository, 'pinokio', `${name}.js`), 'utf8'),
      { module, exports: module.exports, require: () => app });
    const script = await module.exports({}, {});
    const execute = async () => {
      for (const step of script.run) {
        if (typeof step.method === 'function') await step.method();
        else if (step.method === 'shell.run') log.push('shell');
      }
    };
    await assert.rejects(execute(), /Backup refused a linked entry/);
    assert.deepEqual(log, ['preflight']);
    eligible = true;
    await execute();
    assert.equal(log[1], 'preflight');
    assert.equal(log[2], name === 'add-local' ? 'stop' : 'shell');
    assert.ok(log.includes('shell'));
  }
});

