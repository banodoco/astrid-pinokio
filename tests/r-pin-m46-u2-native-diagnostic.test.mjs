import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, '.github/venue/m46-u2-native-diagnostic.mjs');

test('root is refused before a selected path is read', { skip: process.getuid?.() !== 0 }, () => {
  const result = spawnSync(process.execPath, [script, '/definitely-not-a-selected-app'], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 2);
  const row = JSON.parse(result.stdout);
  assert.equal(row.first_failed_predicate, 'real non-root Linux principal required');
  assert.equal(row.selected_app, null);
  assert.equal(row.inner_exit, null);
  assert.equal(row.terminal_status, 'unknown');
});

test('a missing selected installation cannot yield an argv or settlement', () => {
  // Stub only the principal gate so the missing-install branch is exercised in root-only CI.
  const entry = `process.getuid = () => 1000; process.argv = [process.execPath, ${JSON.stringify(script)}, '/definitely-not-a-selected-app']; import(${JSON.stringify(new URL(`file://${script}`).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 2, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.match(row.first_failed_predicate, /^resolution unavailable: ENOENT$/);
  assert.equal(row.runtime_argv_observed, null);
  assert.equal(row.inner_exit, null);
  assert.equal(row.terminal_status, 'unknown');
});

test('computed mode-specific launch stays distinct from observed argv and settlement', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'm46-u2-fixture-'));
  const base = path.join(temp, 'pin-home', 'api', 'astrid');
  try {
    fs.mkdirSync(path.join(base, 'pinokio'), { recursive: true });
    for (const operation of ['start', 'stop', 'update', 'uninstall']) fs.copyFileSync(path.join(root, 'pinokio', `${operation}.js`), path.join(base, 'pinokio', `${operation}.js`));
    const install = path.join(base, 'app', 'astrid');
    const version = path.join(install, 'versions', 'fixture');
    const node = path.join(version, 'bin', 'node');
    const python = path.join(version, 'py', 'bin', 'python');
    const profile = path.join(version, 'profile.json');
    const npmDir = path.join(version, 'lib', 'node_modules', 'npm', 'bin');
    for (const file of [node, python, profile, path.join(npmDir, 'npm-cli.js'), path.join(npmDir, 'npx-cli.js')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
    }
    fs.writeFileSync(path.join(install, 'current'), 'fixture');
    fs.writeFileSync(path.join(version, 'version.json'), JSON.stringify({ root: version, python, profile, env: { ASTRID_NODE_EXECUTABLE: node } }));
    fs.writeFileSync(path.join(install, 'install.json'), JSON.stringify({ owner: 'haus.astrid.runtime', managed_by: 'pinokio', data_root: path.join(temp, 'data') }));
    for (const [mode, args] of [['backend', []], ['local', ['--hosted-origin', 'off']]]) {
      fs.writeFileSync(path.join(base, 'app', 'install-mode.json'), JSON.stringify({ schema_version: 1, mode }));
      const entry = `process.getuid = () => 1000; process.argv = [process.execPath, ${JSON.stringify(script)}, ${JSON.stringify(base)}]; import(${JSON.stringify(new URL(`file://${script}`).href)});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry], { encoding: 'utf8', cwd: root });
      assert.equal(result.status, 2, result.stderr);
      const row = JSON.parse(result.stdout);
      assert.ok(row.runtime_spec_computed, JSON.stringify(row));
      assert.deepEqual(row.runtime_spec_computed.args, args);
      assert.equal(row.runtime_spec_computed.command, path.join(install, 'run'));
      assert.equal(row.runtime_argv_observed, null);
      assert.equal(row.inner_exit, null);
      assert.equal(row.terminal_status, 'unknown');
      assert.equal(row.complete_helper_closure, false);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
