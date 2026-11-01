import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectInstalled, verifyInputBytes } from './installed-idle-inspection.mjs';
import { EXPECTED } from './installed-idle-contract.mjs';

test('inspects launcher validation, backend mode and the effective installed tuple', async t => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-idle-test-'));
  t.after(() => fs.rmSync(app, {recursive:true, force:true}));
  fs.cpSync(path.resolve('pinokio'), path.join(app, 'pinokio'), {recursive:true});
  const root = path.join(app, 'app', 'astrid');
  const version = path.join(root, 'versions', 'fixture');
  const node = path.join(version, 'tools', 'node', 'bin', 'node');
  const python = path.join(version, 'py', 'bin', 'python');
  const profile = path.join(version, 'profile.json');
  for (const file of [node, python, profile, path.join(version, 'tools', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(version, 'tools', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')]) {
    fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'fixture');
  }
  fs.writeFileSync(path.join(root, 'current'), 'fixture');
  fs.writeFileSync(path.join(root, 'install.json'), JSON.stringify({owner:'haus.astrid.runtime', managed_by:'pinokio', data_root:path.join(app,'data')}));
  fs.writeFileSync(path.join(version, 'version.json'), JSON.stringify({root:version, python, profile, env:{ASTRID_NODE_EXECUTABLE:node}}));
  const manifestFile = path.join(version, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({agent:{sha:EXPECTED.agent},runtime:{sha:EXPECTED.runtime}}));
  fs.writeFileSync(path.join(app, 'app', 'install-mode.json'), JSON.stringify({schema_version:1,mode:'backend'}));
  assert.deepEqual(await inspectInstalled(app), {filesValidated:true,manifestValidated:true,backendModePersisted:true,versionRecordPresent:true});
  fs.writeFileSync(manifestFile, JSON.stringify({agent:{sha:'main'},runtime:{sha:EXPECTED.runtime}}));
  assert.equal((await inspectInstalled(app)).manifestValidated, false);
  fs.unlinkSync(python);
  await assert.rejects(() => inspectInstalled(app), /installed file is missing/);
});

test('input-byte validation rejects malformed or modified payloads', () => {
  assert.deepEqual(verifyInputBytes(Buffer.from('bad'), Buffer.from('{}')), {bootstrapMatches:false,manifestMatches:false,tupleMatches:false});
  assert.deepEqual(verifyInputBytes(Buffer.from('bad'), Buffer.from('{')), {bootstrapMatches:false,manifestMatches:false,tupleMatches:false});
});
