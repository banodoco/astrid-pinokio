// Bounded, read-only checkpoint observations. No authority or continuity is inferred.
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = Object.freeze({ processes: 4096, fds: 65536, listeners: 8192,
  fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, resultBytes: 1024 * 1024 });
const MAX = Object.freeze({ processes: 16384, fds: 262144, listeners: 32768,
  fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, resultBytes: 1024 * 1024 });
const tables = ['net/tcp', 'net/tcp6', 'net/unix'];
const numeric = (s) => /^(0|[1-9][0-9]*)$/.test(s);
const identity = (s) => ({ dev: String(s.dev), ino: String(s.ino), size: String(s.size),
  mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseStat(text, pid) {
  const end = text.lastIndexOf(')');
  if (!text.startsWith(`${pid} (`) || end < 0) throw Error('invalid stat');
  const f = text.slice(end + 1).trim().split(/\s+/);
  if (f.length < 20 || !/^[A-Za-z]$/.test(f[0]) || !numeric(f[1]) || !numeric(f[19])) throw Error('invalid stat');
  const ppid = Number(f[1]);
  if (!Number.isSafeInteger(ppid)) throw Error('invalid parent PID');
  return { pid, parentPid: ppid, startTimeTicks: f[19] };
}

function parseListeners(text, table) {
  const lines = text.trimEnd().split('\n');
  if (!lines[0] || (table === 'net/unix' ? !lines[0].includes('Inode') : !lines[0].includes('local_address'))) throw Error('invalid listener header');
  const result = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f = line.trim().split(/\s+/);
    if (table === 'net/unix') {
      if (f.length < 7 || !/^[0-9A-Fa-f]+$/.test(f[3]) || !numeric(f[6])) throw Error('invalid unix socket row');
      if ((parseInt(f[3], 16) & 0x10000) !== 0) result.push({ protocol: 'unix', inode: f[6] });
    } else {
      if (f.length < 10 || !/^[0-9A-Fa-f]+:[0-9A-Fa-f]{4}$/.test(f[1]) || !/^[0-9A-Fa-f]{2}$/.test(f[3]) || !numeric(f[9])) throw Error('invalid TCP socket row');
      if (f[3].toUpperCase() === '0A') result.push({ protocol: table.slice(4), localAddressHex: f[1].toUpperCase(), inode: f[9] });
    }
  }
  return result;
}

/** Capture one initial or final checkpoint. completeness covers only this
 * source's visible, supported entries; host completeness is always unknown.
 * procRoot/io are source selection and fixture seams, not trust assertions.
 * Errors produce incomplete raw evidence.
 * No arguments, environments, executable content, or command output are read.
 */
export async function captureLinuxCensus({ checkpoint, procRoot = '/proc', limits = {}, io = fs } = {}) {
  if (!['initial', 'final'].includes(checkpoint)) throw TypeError('checkpoint must be initial or final');
  if (typeof procRoot !== 'string' || !procRoot || procRoot.length > 1024) throw TypeError('invalid proc root');
  if (!limits || typeof limits !== 'object' || Object.keys(limits).some((key) => !(key in DEFAULTS))) throw TypeError('invalid limits');
  const bound = { ...DEFAULTS, ...limits };
  for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(bound[key]) || bound[key] < 1 || bound[key] > MAX[key]) throw TypeError(`invalid ${key} limit`);
  if (bound.resultBytes < 4096) throw TypeError('invalid resultBytes limit');
  const out = { kind: 'linux-process-listener-census', checkpoint, source: { procRoot },
    completeness: 'incomplete', hostCompleteness: 'unknown', failures: [], bootId: null, processes: [], listeners: [],
    startedAt: new Date().toISOString(), finishedAt: null,
    limits: bound, limitations: ['checkpoint-only', 'continuity-unobserved', 'source-authenticity-unverified',
      'host-proc-visibility-unverified', 'exec-between-checks-not-excluded', 'non-tcp-ip-sockets-not-censused'] };
  let total = 0;
  let fdCount = 0;
  const fail = (stage, error, pid) => {
    if (out.failures.length < 128) out.failures.push({ stage, ...(pid === undefined ? {} : { pid }),
      reason: String(error?.code || error?.message || error).slice(0, 160) });
    else if (out.failures.length === 128) out.failures.push({ stage: 'failures', reason: 'failure-limit' });
  };
  async function read(rel) {
    const h = await io.open(path.join(procRoot, rel), 'r');
    try {
      const chunks = []; let n = 0;
      for (;;) {
        const remaining = Math.min(bound.fileBytes - n, bound.totalBytes - total);
        if (remaining < 0) throw Error('byte-limit');
        const b = Buffer.alloc(Math.min(65536, remaining + 1));
        const { bytesRead } = await h.read(b, 0, b.length, null);
        if (!bytesRead) break;
        n += bytesRead; total += bytesRead;
        if (n > bound.fileBytes || total > bound.totalBytes) throw Error('byte-limit');
        chunks.push(b.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await h.close(); }
  }
  async function entries(rel, max, countFds = false) {
    const dir = await io.opendir(path.join(procRoot, rel));
    const result = [];
    for await (const ent of dir) {
      if (countFds && ++fdCount > bound.fds) throw Error('fd-limit');
      if (result.length >= max) throw Error('entry-limit');
      result.push(ent.name);
    }
    return result.sort();
  }
  async function pids() {
    const names = await entries('.', bound.processes + 1024);
    const list = names.filter((n) => /^[0-9]+$/.test(n));
    if (list.length > bound.processes) throw Error('process-limit');
    if (list.some((n) => !numeric(n) || Number(n) < 1 || !Number.isSafeInteger(Number(n)))) throw Error('invalid PID entry');
    return list.sort((a, b) => Number(a) - Number(b));
  }
  async function snapshot(pid) {
    const stat = parseStat(await read(`${pid}/stat`), pid);
    const executableStat = await io.stat(path.join(procRoot, String(pid), 'exe'), { bigint: true });
    if (!executableStat.isFile()) throw Error('invalid executable object');
    const executable = identity(executableStat);
    const networkNamespace = identity(await io.stat(path.join(procRoot, String(pid), 'ns/net'), { bigint: true }));
    const names = await entries(`${pid}/fd`, bound.fds, true);
    if (names.some((name) => !numeric(name))) throw Error('invalid fd entry');
    const fds = [];
    for (const name of names) {
      const target = await io.readlink(path.join(procRoot, String(pid), 'fd', name));
      const match = /^socket:\[([0-9]+)\]$/.exec(target);
      // Retain only socket inode identities, never file paths or command data.
      fds.push([name, match ? match[1] : null]);
    }
    return { ...stat, executable, networkNamespace, fds };
  }
  try {
    if (process.platform !== 'linux') throw Error('linux-required');
    const boot = (await read('sys/kernel/random/boot_id')).trim();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)) throw Error('invalid boot ID');
    out.bootId = boot;
    const ns = identity(await io.stat(path.join(procRoot, 'self/ns/net'), { bigint: true }));
    const before = await pids();
    const observed = new Map();
    for (const name of before) {
      const pid = Number(name);
      try {
        const value = await snapshot(pid);
        observed.set(pid, value);
        if (value.networkNamespace.dev !== ns.dev || value.networkNamespace.ino !== ns.ino) fail('network-namespace', Error('unobserved-network-namespace'), pid);
      } catch (error) { fail('process-initial', error, pid); }
    }
    const rawTables = new Map();
    for (const table of tables) {
      try {
        const raw = await read(table); rawTables.set(table, raw);
        for (const listener of parseListeners(raw, table)) {
          if (out.listeners.length >= bound.listeners) throw Error('listener-limit');
          out.listeners.push({ ...listener, owners: [] });
        }
      } catch (error) { fail(table, error); }
    }
    const owners = new Map();
    const children = new Map();
    for (const p of observed.values()) {
      for (const inode of new Set(p.fds.map(([, inode]) => inode).filter(Boolean))) {
        if (!owners.has(inode)) owners.set(inode, []);
        owners.get(inode).push(p.pid);
      }
      if (!children.has(p.parentPid)) children.set(p.parentPid, []);
      if (p.pid !== p.parentPid) children.get(p.parentPid).push(p.pid);
    }
    const listenerInodes = new Set();
    for (const listener of out.listeners) {
      if (listenerInodes.has(listener.inode)) fail('listener-owner', Error('duplicate-listener-inode'));
      listenerInodes.add(listener.inode);
      listener.owners = owners.get(listener.inode) || [];
      if (listener.inode === '0' || listener.owners.length === 0) fail('listener-owner', Error('unresolved-listener-owner'));
      else if (listener.owners.length > 1) fail('listener-owner', Error('ambiguous-listener-owner'));
    }
    for (const [pid, first] of observed) {
      try {
        const last = await snapshot(pid);
        if (!equal(first, last)) fail('process-recheck', Error('process-or-fds-changed'), pid);
      } catch (error) { fail('process-recheck', error, pid); }
      const { fds, ...record } = first;
      record.children = children.get(pid) || [];
      out.processes.push(record);
      if (first.parentPid !== 0 && !observed.has(first.parentPid)) fail('parent', Error('unresolved-parent'), pid);
      if (first.parentPid === pid) fail('parent', Error('cyclic-parent'), pid);
    }
    // A longer parent cycle is also ambiguous.
    const checked = new Set();
    for (const [pid] of observed) {
      const seen = new Set(); let current = pid;
      while (observed.has(current) && current !== 0 && !checked.has(current)) {
        if (seen.has(current)) { fail('parent', Error('cyclic-parent'), pid); break; }
        seen.add(current); current = observed.get(current).parentPid;
      }
      for (const item of seen) checked.add(item);
    }
    for (const [table, raw] of rawTables) {
      try { if (await read(table) !== raw) fail(table, Error('listener-table-changed')); }
      catch (error) { fail(table, error); }
    }
    if (!equal(before, await pids())) fail('process-list', Error('process-list-changed'));
    if ((await read('sys/kernel/random/boot_id')).trim() !== boot) fail('boot-id', Error('boot-id-changed'));
    const nsAfter = identity(await io.stat(path.join(procRoot, 'self/ns/net'), { bigint: true }));
    if (ns.dev !== nsAfter.dev || ns.ino !== nsAfter.ino) fail('network-namespace', Error('collector-namespace-changed'));
  } catch (error) { fail('source', error); }
  out.finishedAt = new Date().toISOString();
  if (Buffer.byteLength(JSON.stringify(out)) > bound.resultBytes) {
    out.processes = []; out.listeners = [];
    out.failures = [{ stage: 'result', reason: 'result-byte-limit' }];
  }
  if (!out.failures.length) out.completeness = 'complete';
  return out;
}
