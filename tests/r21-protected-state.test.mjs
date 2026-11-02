import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { digestProtectedState, installedTupleMatches, runtimeStatusSpec } = require('../.github/venue/r21-protected-state.cjs');

function fixture() {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r21-protected-'));
  const appRoot = path.join(home, 'api', 'astrid');
  const root = path.join(appRoot, 'app', 'astrid');
  const version = path.join(root, 'versions', 'candidate');
  const data = path.join(home, 'workspace');
  fs.mkdirSync(version, { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, 'current'), 'candidate\n');
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({ data_root: data }));
  fs.writeFileSync(path.join(version, 'manifest.json'), JSON.stringify({ agent: { sha: 'a'.repeat(40) }, runtime: { sha: 'b'.repeat(40) } }));
  fs.mkdirSync(path.join(version, 'bin'));
  const python = path.join(version, 'bin', 'python');
  const profile = path.join(version, 'profile.json');
  fs.writeFileSync(python, 'selected-python');
  fs.writeFileSync(profile, '{}');
  fs.writeFileSync(path.join(version, 'version.json'), JSON.stringify({ root: version, python, profile, env: {} }));
  fs.writeFileSync(path.join(version, 'program.bin'), 'installed-program-v1');
  fs.writeFileSync(path.join(data, 'project.bin'), 'user-data-v1');
  return { home, appRoot, root, version, data };
}

test('protected state includes all installed version bytes independently of markers and user data', async () => {
  const f = fixture();
  try {
    const before = await digestProtectedState(f.appRoot, f.home);
    assert.deepEqual(Object.keys(before), ['program', 'selected_version', 'installed_bytes', 'user_data']);
    assert.ok(Object.values(before).every(value => /^[a-f0-9]{64}$/.test(value)));

    fs.writeFileSync(path.join(f.version, 'program.bin'), 'installed-program-v2');
    const changed = await digestProtectedState(f.appRoot, f.home);
    assert.equal(changed.program, before.program);
    assert.equal(changed.selected_version, before.selected_version);
    assert.notEqual(changed.installed_bytes, before.installed_bytes);
    assert.equal(changed.user_data, before.user_data);

    fs.mkdirSync(path.join(f.root, 'versions', 'staged'));
    fs.writeFileSync(path.join(f.root, 'versions', 'staged', 'new.bin'), 'new-candidate');
    const staged = await digestProtectedState(f.appRoot, f.home);
    assert.notEqual(staged.installed_bytes, changed.installed_bytes);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('installed tuple observation binds the selected manifest and rejects escaped roots', async () => {
  const f = fixture();
  try {
    assert.equal(await installedTupleMatches(f.appRoot, { agent: 'a'.repeat(40), runtime: 'b'.repeat(40) }), true);
    assert.equal(await installedTupleMatches(f.appRoot, { agent: 'c'.repeat(40), runtime: 'b'.repeat(40) }), false);
    const status = await runtimeStatusSpec(f.appRoot, f.home);
    assert.deepEqual(status.args.slice(0, 4), ['-I', '-m', 'astrid_runtime', 'status']);
    assert.equal(status.cwd, f.root);
    fs.writeFileSync(path.join(f.root, 'current'), '../outside\n');
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /selection is invalid/);
    fs.writeFileSync(path.join(f.root, 'current'), 'candidate\n');
    fs.writeFileSync(path.join(f.root, 'install.json'), JSON.stringify({ data_root: path.dirname(f.home) }));
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /escaped/);
    await assert.rejects(runtimeStatusSpec(f.appRoot, f.home), /escaped/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('protected state rejects every required selected control resource when it is missing', async () => {
  const cases = [
    [f => path.join(f.root, 'current'), /protected installed version selection is missing/],
    [f => path.join(f.root, 'install.json'), /protected installed record is missing/],
    [f => f.version, /selected installed version root is missing/],
    [f => path.join(f.version, 'manifest.json'), /selected installed manifest is missing/],
    [f => path.join(f.version, 'version.json'), /selected installed version record is missing/],
    [f => path.join(f.version, 'bin', 'python'), /selected installed Python is missing/],
    [f => path.join(f.version, 'profile.json'), /selected installed profile is missing/],
    [f => f.data, /protected user data root is missing/],
  ];
  for (const [resource, message] of cases) {
    const f = fixture();
    try {
      fs.rmSync(resource(f), { recursive: true, force: true });
      await assert.rejects(digestProtectedState(f.appRoot, f.home), message);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('protected state rejects linked control resources', { skip: process.platform === 'win32' }, async () => {
  const cases = [
    [f => path.join(f.root, 'current'), /protected installed version selection is not a regular file/],
    [f => path.join(f.root, 'install.json'), /protected installed record is not a regular file/],
    [f => path.join(f.root, 'update-transaction.json'), /protected installed update transaction is not a regular file/],
    [f => path.join(f.version, 'manifest.json'), /selected installed manifest is not a regular file/],
  ];
  for (const [resource, message] of cases) {
    const f = fixture();
    try {
      const pathname = resource(f);
      const target = `${pathname}.target`;
      fs.writeFileSync(target, fs.existsSync(pathname) ? fs.readFileSync(pathname) : 'transaction');
      fs.rmSync(pathname, { force: true });
      fs.symlinkSync(path.basename(target), pathname);
      await assert.rejects(digestProtectedState(f.appRoot, f.home), message);
    } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
  }
});

test('deleting a selected installed file changes the protected digest and is rejected by comparison', async () => {
  const f = fixture();
  try {
    const before = await digestProtectedState(f.appRoot, f.home);
    fs.rmSync(path.join(f.version, 'program.bin'));
    const after = await digestProtectedState(f.appRoot, f.home);
    assert.notEqual(after.installed_bytes, before.installed_bytes);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('protected-state digests bind in-root linked bytes and reject dangling links', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const target = path.join(f.version, 'linked-target');
    const link = path.join(f.version, 'linked-program');
    fs.writeFileSync(target, 'linked-v1');
    fs.symlinkSync('linked-target', link);
    const before = await digestProtectedState(f.appRoot, f.home);
    fs.writeFileSync(target, 'linked-v2');
    const changed = await digestProtectedState(f.appRoot, f.home);
    assert.notEqual(changed.installed_bytes, before.installed_bytes);
    fs.rmSync(target);
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /dangling link/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('protected user data binds in-root links and rejects linked roots', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const target = path.join(f.data, 'linked-target');
    const link = path.join(f.data, 'linked-project');
    fs.writeFileSync(target, 'linked-user-data-v1');
    fs.symlinkSync('linked-target', link);
    const before = await digestProtectedState(f.appRoot, f.home);
    fs.writeFileSync(target, 'linked-user-data-v2');
    const changed = await digestProtectedState(f.appRoot, f.home);
    assert.notEqual(changed.user_data, before.user_data);

    fs.rmSync(f.data, { recursive: true });
    const replacement = path.join(f.home, 'replacement-data');
    fs.mkdirSync(replacement);
    fs.symlinkSync(replacement, f.data);
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /protected user data root is not a regular directory/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('protected-state links cannot escape or recursively traverse a directory', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const outside = path.join(f.home, 'outside');
    fs.writeFileSync(outside, 'outside-program');
    fs.symlinkSync(outside, path.join(f.version, 'escaped-program'));
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /link escaped its root/);

    fs.rmSync(path.join(f.version, 'escaped-program'));
    fs.mkdirSync(path.join(f.version, 'linked-directory'));
    fs.writeFileSync(path.join(f.version, 'linked-directory', 'child'), 'child');
    fs.symlinkSync('linked-directory', path.join(f.version, 'directory-link'));
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /link target is not a regular file/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('protected user-data links cannot escape their snapshot root', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  try {
    const outside = path.join(f.home, 'outside-user-data');
    fs.writeFileSync(outside, 'outside-user-data');
    fs.symlinkSync(outside, path.join(f.data, 'escaped-user-data'));
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /link escaped its root/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
