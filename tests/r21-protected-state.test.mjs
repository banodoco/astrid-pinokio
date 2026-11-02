import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { digestProtectedState, installedTupleMatches } = require('../.github/venue/r21-protected-state.cjs');

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
    fs.writeFileSync(path.join(f.root, 'current'), '../outside\n');
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /selection is invalid/);
    fs.writeFileSync(path.join(f.root, 'current'), 'candidate\n');
    fs.writeFileSync(path.join(f.root, 'install.json'), JSON.stringify({ data_root: path.dirname(f.home) }));
    await assert.rejects(digestProtectedState(f.appRoot, f.home), /escaped/);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
