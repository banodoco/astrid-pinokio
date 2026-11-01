import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { captureLinuxCustodyCheckpoint } from '../pinokio/providers/linux-custody-observations.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decode = (result) => JSON.parse(result.bytes.toString('utf8'));

async function child(t) {
  const process = spawn(processExec(), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(process, 'spawn');
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await once(process, 'exit');
    }
  });
  return process;
}
function processExec() { return process.execPath; }

test('captures bounded raw Linux checkpoints with matching observation and file references', { skip: process.platform !== 'linux' }, async (t) => {
  const controller = await child(t);
  const runtime = await child(t);
  const args = { phase: 'initial', pids: { controller: controller.pid, runtime: runtime.pid, editor: process.pid }, sequence: 7 };
  const result = await captureLinuxCustodyCheckpoint(args);
  const payload = decode(result);
  const canonical = spawnSync('python3', ['-c', 'import json,sys; x=json.load(sys.stdin); sys.stdout.write(json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=True,allow_nan=False))'], { input: result.bytes });
  assert.equal(canonical.status, 0, canonical.stderr.toString());
  assert.deepEqual(canonical.stdout, result.bytes);
  assert.deepEqual(result.observation, { id: 'obs-000007', kind: 'custody-census', file: 'observations/obs-000007.json', sha256: sha256(result.bytes), sequence: 7 });
  assert.deepEqual(result.file, { path: result.observation.file, role: 'custody-census', sha256: result.observation.sha256, size: result.bytes.length });
  assert.ok(result.bytes.length < 1024 * 1024);
  assert.match(payload.bootId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(payload.sources.map((source) => source.state), ['observed', 'observed', 'observed']);
  for (const source of payload.sources) {
    assert.match(source.startTimeTicks, /^\d+$/);
    assert.match(source.executableSha256, /^[0-9a-f]{64}$/);
    assert.equal(source.principal.uid.length, 4);
    assert.match(Buffer.from(source.raw.statBefore, 'base64').toString(), new RegExp(`^${source.pid} \\(`));
    assert.match(Buffer.from(source.raw.statusAfter, 'base64').toString(), new RegExp(`^Pid:\\s+${source.pid}$`, 'm'));
  }
  assert.equal(payload.identity, 'unauthenticated');
  assert.equal(payload.sourceCompleteness, 'unknown');
  assert.equal(payload.continuity, 'unknown');
  assert.equal(payload.sourceProfileSha256, null);
  assert.ok(payload.limitations.includes('no-removal-authority'));
  const final = decode(await captureLinuxCustodyCheckpoint({ ...args, phase: 'final', sequence: 8 }));
  assert.equal(final.continuity, 'unknown');
  assert.equal(final.identity, 'unauthenticated');
  assert.equal(final.sourceCompleteness, 'unknown');
});

test('missing, invalid, absent and ambiguous identities remain unavailable and unauthenticated', { skip: process.platform !== 'linux' }, async () => {
  const result = decode(await captureLinuxCustodyCheckpoint({ phase: 'initial', pids: { controller: 0, runtime: 2147483647 } }));
  assert.deepEqual(result.sources.map((source) => source.reason), ['missing-or-invalid-pid', 'source-unavailable', 'missing-or-invalid-pid']);
  assert.equal(result.identity, 'unauthenticated');
  assert.equal(result.continuity, 'unknown');
  const duplicates = decode(await captureLinuxCustodyCheckpoint({ phase: 'final', pids: { controller: process.pid, runtime: process.pid } }));
  assert.deepEqual(duplicates.sources.map((source) => source.reason), ['ambiguous-role-pid', 'ambiguous-role-pid', 'missing-or-invalid-pid']);
  assert.equal(duplicates.sourceCompleteness, 'unknown');
});

test('rejects malformed capture requests and cannot accept caller snapshots as observations', async () => {
  for (const input of [undefined, { phase: 'middle' }, { phase: 'initial', sequence: 0 },
    { phase: 'initial', sequence: 4097 }, { phase: 'initial', pids: [] },
    { phase: 'initial', pids: { controller: process.pid, snapshot: {} } }]) {
    await assert.rejects(captureLinuxCustodyCheckpoint(input), TypeError);
  }
  const payload = decode(await captureLinuxCustodyCheckpoint({ phase: 'initial', pids: { controller: { pid: process.pid, authenticated: true }, runtime: '1' } }));
  assert.deepEqual(payload.sources.map((source) => source.state), ['unavailable', 'unavailable', 'unavailable']);
  assert.equal(payload.identity, 'unauthenticated');
});
