import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { runTool } from './smoke/process.mjs';
import { prepareCheckout, assertRunEnvironment } from './smoke/checkout.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseRefs, assertVersionChanged } from './smoke/journey-assertions.mjs';
import { interruptAtJournal } from './smoke/interrupt.mjs';

test('interrupt waits for a durable phase and signals only its child', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinokio-interrupt-'));
  const journal = path.join(temp, 'journal.json');
  let closed;
  const child = { closed: false, exit: new Promise((resolve) => { closed = resolve; }) };
  let kills = 0;
  const kill = async (target) => { assert.equal(target, child); kills++; target.closed = true; closed({ code: null, signal: 'SIGKILL' }); };
  try {
    fs.writeFileSync(journal, JSON.stringify({ step: 'staged' }));
    const result = interruptAtJournal(child, journal, kill, { timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(kills, 0);
    fs.writeFileSync(journal, JSON.stringify({ step: 'stopped' }));
    assert.equal(await result, 'stopped');
    assert.equal(kills, 1);
    await assert.rejects(interruptAtJournal({ closed: true }, journal, kill), /exited or timed out/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('release journey requires distinct immutable refs and changed selected version and health identity', () => {
  const oldRef = 'a'.repeat(40); const candidateRef = 'b'.repeat(40);
  assert.deepEqual(releaseRefs(oldRef, candidateRef), { oldRef, candidateRef });
  assert.throws(() => releaseRefs(oldRef, oldRef), /must differ/);
  assert.throws(() => releaseRefs('main', candidateRef), /full lowercase/);
  const before = { current: 'old', status: 200, recordIdentity: { release: 1 }, health: { install: { managed_by: 'pinokio' }, identity: { release: 1 } } };
  const after = { current: 'new', status: 200, recordIdentity: { release: 2 }, health: { install: { managed_by: 'pinokio' }, identity: { release: 2 } } };
  assertVersionChanged(before, after);
  assert.throws(() => assertVersionChanged(before, { ...after, current: 'old' }), /version did not change/);
  assert.throws(() => assertVersionChanged(before, { ...after, recordIdentity: before.recordIdentity, health: before.health }), /identity did not change/);
  assert.throws(() => assertVersionChanged(before, { ...after, health: before.health }), /differs from selected version/);
  assert.throws(() => assertVersionChanged(before, { ...after, health: { install: { managed_by: 'pinokio' } } }), /identity is missing/);
  assert.throws(() => assertVersionChanged(before, { ...after, status: 503 }), /not ready/);
});

test('smoke checkout preserves source branch, dirty files and supports pull', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinokio-checkout-'));
  const source = path.join(temp, 'source');
  const destination = path.join(temp, 'run', 'app');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    fs.mkdirSync(source); fs.mkdirSync(path.dirname(destination));
    git('init', source); git('-C', source, 'config', 'user.name', 'Smoke fixture');
    git('-C', source, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(source, 'file'), 'committed');
    git('-C', source, 'add', 'file'); git('-C', source, 'commit', '-m', 'fixture');
    git('-C', source, 'checkout', '-b', 'owner-branch');
    fs.writeFileSync(path.join(source, 'file'), 'user edits');
    const before = git('-C', source, 'status', '--porcelain=v1', '--branch');
    prepareCheckout(source, destination);
    assert.equal(git('-C', source, 'status', '--porcelain=v1', '--branch'), before);
    assert.equal(fs.readFileSync(path.join(source, 'file'), 'utf8'), 'user edits');
    assert.equal(git('-C', destination, 'branch', '--show-current'), 'ci-smoke');
    assert.equal(fs.readFileSync(path.join(destination, 'file'), 'utf8'), 'committed');
    git('-C', destination, 'pull', '--ff-only');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('local smoke requires explicit disposable Linux container', () => {
  assert.doesNotThrow(() => assertRunEnvironment({ GITHUB_ACTIONS: 'true' }, 'darwin', false));
  assert.doesNotThrow(() => assertRunEnvironment({ ASTRID_DISPOSABLE_CONTAINER: 'yes' }, 'linux', true));
  for (const [env, platform, container] of [[{}, 'linux', true], [{ ASTRID_DISPOSABLE_CONTAINER: 'yes' }, 'linux', false], [{ ASTRID_DISPOSABLE_CONTAINER: 'yes' }, 'darwin', true]]) {
    assert.throws(() => assertRunEnvironment(env, platform, container), /disposable Linux container/);
  }
});

test('smoke commands keep draining a noisy server while waiting for its response', async () => {
  const server = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      process.stdout.write('x'.repeat(2 * 1024 * 1024), () => response.end('ready'));
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('message', () => server.close(() => process.exit(0)));
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = once(server, 'close');
  let drained = 0;
  server.stdout.on('data', (chunk) => { drained += chunk.length; });
  server.stderr.pipe(process.stderr);
  try {
    const [port] = await once(server, 'message');
    const result = await runTool(process.execPath, ['-e', `
      require('node:http').get('http://127.0.0.1:${port}', (response) => {
        response.pipe(process.stdout);
      }).on('error', (error) => { console.error(error); process.exitCode = 1; });
    `], process.env);
    assert.equal(result, 'ready');
    assert.equal(drained, 2 * 1024 * 1024);
  } finally {
    server.send('stop');
    await closed;
  }
});

test('smoke command failures preserve exit status and diagnostics', async () => {
  await assert.rejects(runTool(process.execPath, ['-e', "console.error('fixture failure'); process.exit(7)"], process.env),
    (error) => error.code === 7 && error.stderr.includes('fixture failure'));
});

test('smoke commands receive EOF on stdin', async () => {
  const result = await runTool(process.execPath, ['-e', `
    process.stdin.on('end', () => console.log('EOF'));
    process.stdin.resume();
  `], process.env);
  assert.equal(result.trim(), 'EOF');
});
