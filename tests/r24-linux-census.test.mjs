import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureLinuxCensus } from '../pinokio/providers/linux-census.mjs';

const boot = '12345678-1234-1234-1234-123456789abc';
const tcpHead = '  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const tcpRow = '  0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345\n';
const unixHead = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
const unixRow = '0000: 00000002 00000000 00010000 0001 01 23456 /private/path\n';
function stat(pid, parent, start = '100') {
  return `${pid} (name with ) parens) S ${parent} ${Array(17).fill('0').join(' ')} ${start} 0\n`;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r24-census-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(rel, value) {
    const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
  }
  await write('sys/kernel/random/boot_id', `${boot}\n`);
  await write('net/tcp', tcpHead + tcpRow); await write('net/tcp6', tcpHead); await write('net/unix', unixHead + unixRow);
  await write('namespace', 'ns'); await write('executable', 'object');
  await fs.mkdir(path.join(root, 'self/ns'), { recursive: true });
  await fs.symlink(path.join(root, 'namespace'), path.join(root, 'self/ns/net'));
  for (const [pid, parent] of [[1, 0], [2, 1]]) {
    await write(`${pid}/stat`, stat(pid, parent, String(pid * 100)));
    await fs.mkdir(path.join(root, String(pid), 'ns'), { recursive: true });
    await fs.mkdir(path.join(root, String(pid), 'fd'), { recursive: true });
    await fs.symlink(path.join(root, 'namespace'), path.join(root, String(pid), 'ns/net'));
    await fs.symlink(path.join(root, 'executable'), path.join(root, String(pid), 'exe'));
  }
  await fs.symlink('socket:[12345]', path.join(root, '2/fd/3'));
  await fs.symlink('socket:[23456]', path.join(root, '1/fd/4'));
  return { root, write, capture: (options = {}) => captureLinuxCensus({ checkpoint: 'initial', procRoot: root, ...options }) };
}
const has = (result, stage, reason) => result.failures.some((f) => f.stage === stage && (!reason || f.reason.includes(reason)));

test('complete initial and final checkpoints include identities, ancestry and socket owners', async (t) => {
  const f = await fixture(t);
  for (const checkpoint of ['initial', 'final']) {
    const r = await f.capture({ checkpoint });
    assert.equal(r.completeness, 'complete', JSON.stringify(r.failures));
    assert.equal(r.hostCompleteness, 'unknown');
    assert.equal(r.bootId, boot);
    assert.deepEqual(r.processes.map((p) => [p.pid, p.parentPid, p.startTimeTicks, p.children]), [[1, 0, '100', [2]], [2, 1, '200', []]]);
    assert.match(r.processes[0].executable.ino, /^\d+$/);
    assert.deepEqual(r.listeners.map((l) => [l.protocol, l.inode, l.owners]), [['tcp', '12345', [2]], ['unix', '23456', [1]]]);
    assert.ok(r.limitations.includes('continuity-unobserved'));
    assert.ok(!JSON.stringify(r).includes('/private/path'));
  }
});

test('unreadable, malformed and missing sources are incomplete', async (t) => {
  const f = await fixture(t);
  const denied = { ...fs, open: async (file, ...args) => {
    if (file.endsWith('/2/stat')) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return fs.open(file, ...args);
  } };
  let r = await f.capture({ io: denied });
  assert.equal(r.completeness, 'incomplete'); assert.ok(has(r, 'process-initial', 'EACCES'));
  await f.write('net/tcp6', 'garbage\n');
  r = await f.capture(); assert.ok(has(r, 'net/tcp6', 'invalid'));
  await fs.unlink(path.join(f.root, 'net/tcp6'));
  r = await f.capture(); assert.ok(has(r, 'net/tcp6', 'ENOENT'));
  const fdDenied = { ...fs, opendir: async (file, ...args) => {
    if (file.endsWith('/2/fd')) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return fs.opendir(file, ...args);
  } };
  r = await f.capture({ io: fdDenied }); assert.ok(has(r, 'process-initial', 'EACCES'));
  await fs.unlink(path.join(f.root, '1/exe'));
  r = await f.capture(); assert.ok(has(r, 'process-initial', 'ENOENT'));
});

test('PID reuse, executable change, fd change, table change and process-list change fail closed', async (t) => {
  for (const mutation of ['pid', 'exe', 'fd', 'table', 'list', 'boot']) await t.test(mutation, async (st) => {
    const f = await fixture(st); let triggered = false;
    const io = { ...fs, open: async (file, ...args) => {
      if (!triggered && file.endsWith('/net/tcp')) {
        triggered = true;
        if (mutation === 'pid') await f.write('2/stat', stat(2, 1, '999'));
        if (mutation === 'exe') await f.write('executable', 'changed object');
        if (mutation === 'fd') await fs.unlink(path.join(f.root, '2/fd/3'));
        if (mutation === 'list') await fs.mkdir(path.join(f.root, '3'));
        if (mutation === 'boot') await f.write('sys/kernel/random/boot_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n');
      }
      if (mutation === 'table' && triggered && file.endsWith('/net/tcp6')) await f.write('net/tcp', tcpHead);
      return fs.open(file, ...args);
    } };
    const r = await f.capture({ io }); assert.equal(r.completeness, 'incomplete', mutation);
    assert.ok(mutation === 'table' ? has(r, 'net/tcp', 'changed') : mutation === 'list' ? has(r, 'process-list', 'changed') : mutation === 'boot' ? has(r, 'boot-id', 'changed') : has(r, 'process-recheck', 'changed'));
  });
});

test('unresolved and shared listener ownership, parent gaps and network namespace gaps fail closed', async (t) => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '2/fd/3'));
  let r = await f.capture(); assert.ok(has(r, 'listener-owner', 'unresolved'));
  await fs.symlink('socket:[12345]', path.join(f.root, '2/fd/3'));
  await fs.symlink('socket:[12345]', path.join(f.root, '1/fd/5'));
  await f.write('2/stat', stat(2, 99));
  await f.write('other-namespace', 'other');
  await fs.unlink(path.join(f.root, '2/ns/net'));
  await fs.symlink(path.join(f.root, 'other-namespace'), path.join(f.root, '2/ns/net'));
  r = await f.capture();
  assert.equal(r.completeness, 'incomplete');
  assert.ok(has(r, 'listener-owner', 'ambiguous')); assert.ok(has(r, 'parent', 'unresolved')); assert.ok(has(r, 'network-namespace', 'unobserved'));
  await f.write('1/stat', stat(1, 2)); await f.write('2/stat', stat(2, 1));
  r = await f.capture(); assert.ok(has(r, 'parent', 'cyclic'));
});

test('all configured bounds and invalid options fail closed', async (t) => {
  const f = await fixture(t);
  for (const limits of [{ processes: 1 }, { fds: 1 }, { listeners: 1 }, { fileBytes: 10 }, { totalBytes: 80 }]) {
    const r = await f.capture({ limits });
    assert.equal(r.completeness, 'incomplete', JSON.stringify(limits)); assert.ok(r.failures.length);
  }
  await assert.rejects(f.capture({ limits: { fds: 0 } }), /invalid/);
  await assert.rejects(f.capture({ limits: { unknown: 3 } }), /invalid/);
  await assert.rejects(f.capture({ limits: { resultBytes: 1 } }), /invalid/);
  await assert.rejects(f.capture({ checkpoint: 'middle' }), /checkpoint/);
  await f.write('net/tcp', tcpHead + tcpRow.repeat(80));
  const duplicate = await f.capture();
  assert.ok(has(duplicate, 'listener-owner', 'duplicate-listener-inode'));
  const r = await f.capture({ limits: { resultBytes: 4096 } });
  assert.equal(r.completeness, 'incomplete');
  assert.ok(has(r, 'result', 'result-byte-limit'));
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 4096);
});
