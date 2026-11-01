import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {controllerSocketOwned,daemonHealthMatches,shellProbeMessage,protectedTree,cleanTrackedGitTree} from './installed-idle-proc.mjs';
test('controller listener must belong to the recorded process and loopback port', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'idle-proc-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'123','fd'),{recursive:true}); fs.mkdirSync(path.join(root,'net'));
  fs.symlinkSync('socket:[456]',path.join(root,'123','fd','8'));
  fs.writeFileSync(path.join(root,'net','tcp'),'header\n 0: 0100007F:4E20 00000000:0000 0A 0:0 0:0 0 1000 0 456\n');
  assert.equal(controllerSocketOwned(123,20000,root),true);
  assert.equal(controllerSocketOwned(123,20001,root),false);
  fs.unlinkSync(path.join(root,'123','fd','8'));
  assert.equal(controllerSocketOwned(123,20000,root),false);
  assert.equal(controllerSocketOwned(999,20000,root),false);
});

test('daemon health uses the pinned /check success field and exact home', () => {
  assert.equal(daemonHealthMatches({pinokiod:'8.1.1'},{path:'/tmp/run/home'},{success:true},'/tmp/run/home'),true);
  assert.equal(daemonHealthMatches({pinokiod:'8.1.1'},{path:'/tmp/run/home'},{ok:true},'/tmp/run/home'),false);
  assert.equal(daemonHealthMatches({pinokiod:'8.1.1'},{path:'/tmp/other'},{success:true},'/tmp/run/home'),false);
});

test('shell prerequisite refuses a missing base activation', t => {
  const missing = spawnSync('bash',['-c',shellProbeMessage],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.notEqual(missing.status,0); assert.equal(missing.stdout.includes('ASTRID_SHELL_READY'),false);
  const prefix=fs.mkdtempSync(path.join(os.tmpdir(),'conda-probe-')); t.after(()=>fs.rmSync(prefix,{recursive:true,force:true}));
  fs.mkdirSync(path.join(prefix,'bin')); fs.writeFileSync(path.join(prefix,'bin','conda'),'#!/bin/sh\necho conda\n',{mode:0o755});
  fs.writeFileSync(path.join(prefix,'bin','node'),'#!/bin/sh\necho v20.19.4\n',{mode:0o755});
  const ready=spawnSync('bash',['-c',shellProbeMessage],{encoding:'utf8',env:{PATH:path.join(prefix,'bin')+':/usr/bin:/bin',CONDA_PREFIX:prefix,CONDA_DEFAULT_ENV:'base'}});
  assert.equal(ready.status,0); assert.match(ready.stdout,/ASTRID_SHELL_READY/);
});

test('protected reference tree rejects writable content and escaping symlinks', t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'idle-ref-'))); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.chmodSync(root,0o755); const f=path.join(root,'source'); fs.writeFileSync(f,'a',{mode:0o644});
  assert.equal(protectedTree(root,process.getuid()),true);
  fs.chmodSync(f,0o666); assert.equal(protectedTree(root,process.getuid()),false);
  fs.chmodSync(f,0o644); fs.symlinkSync('/etc/passwd',path.join(root,'escape'));
  assert.equal(protectedTree(root,process.getuid()),false);
});
test('pinned engine validation rejects modified or staged tracked files', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'idle-git-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...args) => spawnSync('git',['-C',root,...args],{encoding:'utf8',stdio:'ignore'});
  assert.equal(git('init','-q').status,0); git('config','user.name','fixture'); git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(root,'tracked'),'first'); git('add','tracked'); assert.equal(git('commit','-qm','fixture').status,0);
  const ref=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();
  assert.equal(cleanTrackedGitTree(root,ref),true);
  fs.writeFileSync(path.join(root,'tracked'),'changed'); assert.equal(cleanTrackedGitTree(root,ref),false);
  git('add','tracked'); assert.equal(cleanTrackedGitTree(root,ref),false);
});
