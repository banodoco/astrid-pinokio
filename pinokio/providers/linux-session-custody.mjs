// Raw Linux custody checkpoints only. Inputs select sources; they do not authenticate them.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureLinuxCensus } from './linux-census.mjs';

const roles = new Set(['engine', 'controller', 'runtime', 'editor']);
const artifactRoles = new Set(['manager-definition', 'action-definition', 'owned-root', 'lock', 'journal']);
const MAX_EXEC = 16 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const meta = (s) => ({ dev: String(s.dev), ino: String(s.ino), size: String(s.size),
  mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs), mode: String(s.mode), uid: String(s.uid), gid: String(s.gid) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function boundedText(file, io, limit = 65536) {
  const h = await io.open(file, 'r');
  try {
    const buf = Buffer.alloc(limit + 1); let pos = 0;
    while (pos < buf.length) { const { bytesRead } = await h.read(buf, pos, buf.length - pos, null); if (!bytesRead) break; pos += bytesRead; }
    if (pos > limit) throw Error('byte-limit');
    return buf.subarray(0, pos).toString('utf8');
  } finally { await h.close(); }
}
function birth(text, pid) {
  const end = text.lastIndexOf(')');
  if (!text.startsWith(`${pid} (`) || end < 0) throw Error('invalid-stat');
  const parts = text.slice(end + 1).trim().split(/\s+/);
  if (parts.length < 20 || !/^[0-9]+$/.test(parts[1]) || !/^[0-9]+$/.test(parts[19])) throw Error('invalid-stat');
  return { parentPid: Number(parts[1]), startTimeTicks: parts[19] };
}
function principal(text) {
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text);
  const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text);
  if (!uid || !gid) throw Error('principal-unavailable');
  return { uid: uid.slice(1), gid: gid.slice(1) };
}
async function hashFile(file, io, limit, budget, noFollow) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0);
  const h = await io.open(file, flags);
  try {
    const before = await h.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw Error('unsupported-or-oversize-file');
    const digest = createHash('sha256'); let size = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(65536, limit - size + 1, MAX_TOTAL - budget.used + 1));
      const { bytesRead } = await h.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      size += bytesRead; budget.used += bytesRead;
      if (size > limit || budget.used > MAX_TOTAL) throw Error('byte-limit');
      digest.update(buf.subarray(0, bytesRead));
    }
    const after = await h.stat({ bigint: true });
    if (!same(meta(before), meta(after)) || BigInt(size) !== after.size) throw Error('file-changed');
    return { object: meta(after), sha256: digest.digest('hex'), size };
  } finally { await h.close(); }
}

/** Source selectors and labels are untrusted hints, never ownership or authentication.
 * The result includes a raw payload and its exact-byte file/observation references,
 * not an R-23 export, session, removal plan, or proof of event continuity.
 */
export async function captureLinuxSessionCustody({ checkpoint, processes = [], artifacts = [], procRoot = '/proc', limits = {}, io = fs } = {}) {
  if (!['initial', 'final'].includes(checkpoint)) throw TypeError('invalid checkpoint');
  if (!Array.isArray(processes) || processes.length > 4 || !Array.isArray(artifacts) || artifacts.length > 16) throw TypeError('invalid selections');
  const seen = new Set();
  for (const p of processes) {
    if (!p || !roles.has(p.role) || seen.has(p.role) || !Number.isSafeInteger(p.pid) || p.pid < 1 || Object.keys(p).some(k => !['role', 'pid'].includes(k))) throw TypeError('invalid process selection');
    seen.add(p.role);
  }
  const names = new Set();
  for (const a of artifacts) {
    if (!a || !artifactRoles.has(a.role) || typeof a.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) || names.has(a.id) || typeof a.path !== 'string' || !path.isAbsolute(a.path) || a.path.length > 1024 || Object.keys(a).some(k => !['role', 'id', 'path'].includes(k))) throw TypeError('invalid artifact selection');
    names.add(a.id);
  }
  const census = await captureLinuxCensus({ checkpoint, procRoot, limits, io });
  const payload = { kind: 'custody-census', version: 1, checkpoint, startedAt: new Date().toISOString(),
    source: 'linux-proc-and-selected-paths', authentication: 'unavailable', continuity: 'unavailable',
    status: 'unknown', census, processes: [], artifacts: [], failures: [],
    limitations: ['untrusted-source-selectors', 'role-labels-not-ownership', 'no-authenticated-session', 'no-loss-detecting-source', 'no-removal-authority', 'definition-bytes-not-retained', 'path-and-host-visibility-unverified'] };
  const fail = (stage, id, error) => payload.failures.push({ stage, id, reason: String(error?.code || error?.message || error).slice(0, 120) });
  const budget = { used: 0 };
  for (const { role, pid } of processes) {
    try {
      const base = path.join(procRoot, String(pid));
      const found = census.processes.find(p => p.pid === pid);
      if (!found || !census.bootId) throw Error('census-identity-unavailable');
      const first = birth(await boundedText(path.join(base, 'stat'), io), pid);
      const who = principal(await boundedText(path.join(base, 'status'), io));
      const executable = await hashFile(path.join(base, 'exe'), io, MAX_EXEC, budget, false);
      const second = birth(await boundedText(path.join(base, 'stat'), io), pid);
      const whoAfter = principal(await boundedText(path.join(base, 'status'), io));
      if (!same(first, second) || !same(who, whoAfter) || first.parentPid !== found.parentPid || first.startTimeTicks !== found.startTimeTicks || !Object.entries(found.executable).every(([k, v]) => executable.object[k] === v)) throw Error('identity-changed');
      payload.processes.push({ role, pid, bootId: census.bootId, ...first, principal: who, executable });
    } catch (error) { fail('process', role, error); }
  }
  for (const { role, id, path: file } of artifacts) {
    try {
      const before = await io.lstat(file, { bigint: true });
      if (before.isSymbolicLink()) throw Error('symbolic-link');
      if (role === 'owned-root') {
        if (!before.isDirectory()) throw Error('root-not-directory');
        const after = await io.lstat(file, { bigint: true });
        if (!same(meta(before), meta(after))) throw Error('object-changed');
        payload.artifacts.push({ role, id, object: meta(after) });
      } else {
        const measured = await hashFile(file, io, MAX_FILE, budget, true);
        const after = await io.lstat(file, { bigint: true });
        if (!same(meta(before), measured.object) || !same(meta(after), measured.object)) throw Error('object-changed');
        payload.artifacts.push({ role, id, ...measured });
      }
    } catch (error) { fail('artifact', id, error); }
  }
  try {
    const bootAfter = (await boundedText(path.join(procRoot, 'sys/kernel/random/boot_id'), io)).trim();
    if (!census.bootId || bootAfter !== census.bootId) throw Error('boot-id-changed-or-unavailable');
  } catch (error) { fail('source', 'boot-id', error); }
  if (!processes.length) fail('selection', 'processes', Error('no-processes-selected'));
  if (census.completeness !== 'complete') fail('source', 'census', Error('census-incomplete'));
  payload.finishedAt = new Date().toISOString();
  let bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > 1024 * 1024) bytes = Buffer.from(JSON.stringify({ kind: 'custody-census', version: 1, checkpoint, status: 'unknown', authentication: 'unavailable', continuity: 'unavailable', failures: [{ stage: 'result', id: 'payload', reason: 'result-byte-limit' }] }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = `raw/custody-${checkpoint}.json`;
  return { payload: bytes, observation: { id: `custody-${checkpoint}`, kind: 'custody-census', file, sha256, sequence: 1 }, file: { path: file, role: 'custody-census', sha256, size: bytes.length } };
}
