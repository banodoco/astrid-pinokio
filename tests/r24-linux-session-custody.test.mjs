import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureLinuxSessionCustody } from '../pinokio/providers/linux-session-custody.mjs';

const boot = '12345678-1234-1234-1234-123456789abc';
const stat = (start = 100) => `1 (test) S 0 ${Array(17).fill('0').join(' ')} ${start} 0\n`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r24-custody-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(rel, value) { const f = path.join(root, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, value); }
  await write('sys/kernel/random/boot_id', boot + '\n');
  await write('net/tcp', 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n');
  await write('net/tcp6', 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n');
  await write('net/unix', 'Num RefCount Protocol Flags Type St Inode Path\n');
  await write('namespace', 'ns'); await write('binary', 'test-executable');
  await write('1/stat', stat()); await write('1/status', 'Uid:\t1\t2\t3\t4\nGid:\t5\t6\t7\t8\n');
  await fs.mkdir(path.join(root, '1/fd'), { recursive: true });
  await fs.mkdir(path.join(root, '1/ns'), { recursive: true });
  await fs.mkdir(path.join(root, 'self/ns'), { recursive: true });
  await fs.symlink(path.join(root, 'namespace'), path.join(root, '1/ns/net'));
  await fs.symlink(path.join(root, 'namespace'), path.join(root, 'self/ns/net'));
  await fs.symlink(path.join(root, 'binary'), path.join(root, '1/exe'));
  await write('definition', 'manager bytes');
  const options = { checkpoint: 'initial', procRoot: root, processes: [{ role: 'controller', pid: 1 }],
    artifacts: [{ role: 'manager-definition', id: 'manager', path: path.join(root, 'definition') }, { role: 'owned-root', id: 'root', path: root }] };
  return { root, write, options, capture: (overrides = {}) => captureLinuxSessionCustody({ ...options, ...overrides }) };
}
const data = r => JSON.parse(r.payload);

test('bounded checkpoint returns raw byte references and measured process and path facts without authority', async t => {
  const f = await fixture(t); const r = await f.capture(); const p = data(r);
  assert.equal(p.census.completeness, 'complete');
  assert.equal(p.census.hostCompleteness, 'unknown');
  assert.equal(p.status, 'unknown'); assert.equal(p.authentication, 'unavailable'); assert.equal(p.continuity, 'unavailable');
  assert.equal(p.processes[0].startTimeTicks, '100'); assert.equal(p.processes[0].bootId, boot);
  assert.deepEqual(p.processes[0].principal.uid, ['1', '2', '3', '4']);
  assert.equal(p.processes[0].executable.sha256, createHash('sha256').update('test-executable').digest('hex'));
  assert.equal(p.artifacts[0].sha256, createHash('sha256').update('manager bytes').digest('hex'));
  assert.equal(r.observation.sha256, createHash('sha256').update(r.payload).digest('hex'));
  assert.equal(r.file.sha256, r.observation.sha256); assert.equal(r.file.size, r.payload.length);
  assert.ok(!r.payload.toString().includes('manager bytes'));
  const last = data(await f.capture({ checkpoint: 'final' }));
  assert.equal(last.continuity, 'unavailable'); assert.equal(last.status, 'unknown');
});

test('missing or malformed identities, missing sources, and incomplete census remain unknown', async t => {
  const f = await fixture(t);
  await f.write('1/status', 'Uid: 1 1 1 1\n');
  let p = data(await f.capture()); assert.equal(p.processes.length, 0); assert.ok(p.failures.some(e => e.reason === 'principal-unavailable'));
  await fs.unlink(path.join(f.root, 'net/tcp6'));
  p = data(await f.capture()); assert.equal(p.census.completeness, 'incomplete'); assert.ok(p.failures.some(e => e.reason === 'census-incomplete'));
  p = data(await f.capture({ processes: [{ role: 'runtime', pid: 999 }] })); assert.ok(p.failures.some(e => e.reason === 'census-identity-unavailable'));
  p = data(await f.capture({ processes: [] })); assert.ok(p.failures.some(e => e.reason === 'no-processes-selected'));
  assert.equal(p.status, 'unknown');
});

test('PID reuse, unreadable source, oversize and symlinked artifacts produce diagnostics', async t => {
  const f = await fixture(t); let count = 0;
  const changing = { ...fs, open: async (file, ...args) => {
    if (file.endsWith('/1/stat') && ++count === 3) await f.write('1/stat', stat(200));
    return fs.open(file, ...args);
  } };
  let p = data(await f.capture({ io: changing })); assert.ok(p.failures.some(e => e.reason === 'identity-changed'));
  await f.write('1/stat', stat());
  const denied = { ...fs, open: async (file, ...args) => {
    if (file.endsWith('/1/status')) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return fs.open(file, ...args);
  } };
  p = data(await f.capture({ io: denied })); assert.ok(p.failures.some(e => e.reason === 'EACCES'));
  await fs.symlink(path.join(f.root, 'definition'), path.join(f.root, 'link'));
  await f.write('large', Buffer.alloc(1024 * 1024 + 1));
  p = data(await f.capture({ artifacts: [{ role: 'lock', id: 'link', path: path.join(f.root, 'link') }, { role: 'journal', id: 'large', path: path.join(f.root, 'large') }] }));
  assert.ok(p.failures.some(e => e.reason === 'symbolic-link')); assert.ok(p.failures.some(e => e.reason === 'unsupported-or-oversize-file'));
  assert.equal(p.status, 'unknown');
});

test('rejects malformed selectors and refuses caller-provided process snapshots', async t => {
  const f = await fixture(t);
  await assert.rejects(f.capture({ processes: [{ role: 'controller', pid: 1, startTimeTicks: '100' }] }), /invalid process/);
  await assert.rejects(f.capture({ processes: [{ role: 'native-service', pid: 1 }] }), /invalid process/);
  await assert.rejects(f.capture({ artifacts: [{ role: 'lock', id: '../bad', path: '/tmp/a' }] }), /invalid artifact/);
  await assert.rejects(f.capture({ checkpoint: 'middle' }), /checkpoint/);
  await assert.rejects(f.capture({ limits: { processes: 0 } }), /invalid/);
});


test('boot drift after the census cannot become a continuous or authenticated claim', async t => {
  const f = await fixture(t); let count = 0;
  const io = { ...fs, open: async (file, ...args) => {
    if (file.endsWith('/sys/kernel/random/boot_id') && ++count === 3) await f.write('sys/kernel/random/boot_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n');
    return fs.open(file, ...args);
  } };
  const p = data(await f.capture({ io }));
  assert.ok(p.failures.some(e => e.reason === 'boot-id-changed-or-unavailable'));
  assert.equal(p.authentication, 'unavailable'); assert.equal(p.continuity, 'unavailable'); assert.equal(p.status, 'unknown');
});
