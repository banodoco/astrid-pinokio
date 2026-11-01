// Linux custody *checkpoint* evidence. PID arguments select sources, not owners.
// This module does not authenticate a session, establish source completeness or
// continuity, construct an R-30 export, or authorize any operation.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_PROC_BYTES = 16384;
const MAX_EXE_BYTES = 128 * 1024 * 1024;
const ROLES = ['controller', 'runtime', 'editor'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readLimited(handle, limit, hasher = null) {
  let size = 0;
  const chunks = [];
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > limit) throw new Error('source-limit');
    if (hasher) hasher.update(buffer.subarray(0, bytesRead));
    else chunks.push(buffer.subarray(0, bytesRead));
  }
  return hasher ? size : Buffer.concat(chunks, size);
}

async function readProc(file) {
  const handle = await fs.open(file, 'r');
  try { return await readLimited(handle, MAX_PROC_BYTES); }
  finally { await handle.close(); }
}

function parseStat(bytes, pid) {
  const text = bytes.toString('utf8').trim();
  const end = text.lastIndexOf(')');
  if (!text.startsWith(`${pid} (`) || end < 0) throw new Error('invalid-stat');
  const fields = text.slice(end + 1).trim().split(/\s+/);
  // Fields after comm start with field 3 (state); starttime is field 22.
  if (fields.length < 20 || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1])) {
    throw new Error('invalid-stat');
  }
  return { parentPid: Number(fields[1]), startTimeTicks: fields[19] };
}

function parseStatus(bytes, pid) {
  const text = bytes.toString('utf8');
  const match = (name, pattern) => {
    const lines = text.split('\n').filter((line) => line.startsWith(`${name}:`));
    if (lines.length !== 1) throw new Error('invalid-status');
    const value = lines[0].slice(name.length + 1).trim();
    if (!pattern.test(value)) throw new Error('invalid-status');
    return value;
  };
  if (match('Pid', /^\d+$/) !== String(pid)) throw new Error('invalid-status');
  return { uid: match('Uid', /^\d+\s+\d+\s+\d+\s+\d+$/).split(/\s+/),
    gid: match('Gid', /^\d+\s+\d+\s+\d+\s+\d+$/).split(/\s+/) };
}

async function capturePid(pid) {
  const root = `/proc/${pid}`;
  const statBefore = await readProc(`${root}/stat`);
  const statusBefore = await readProc(`${root}/status`);
  const identity = parseStat(statBefore, pid);
  const principal = parseStatus(statusBefore, pid);
  const linkBefore = await fs.readlink(`${root}/exe`);
  if (Buffer.byteLength(linkBefore) > MAX_PROC_BYTES) throw new Error('source-limit');
  const executable = await fs.open(`${root}/exe`, 'r');
  let executableSha256;
  try {
    const before = await executable.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_EXE_BYTES)) throw new Error('source-limit');
    const hasher = createHash('sha256');
    const bytesRead = await readLimited(executable, MAX_EXE_BYTES, hasher);
    const after = await executable.stat({ bigint: true });
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      if (before[field] !== after[field]) throw new Error('executable-changed');
    }
    if (BigInt(bytesRead) !== before.size) throw new Error('executable-changed');
    executableSha256 = hasher.digest('hex');
  } finally { await executable.close(); }
  const linkAfter = await fs.readlink(`${root}/exe`);
  const statAfter = await readProc(`${root}/stat`);
  const statusAfter = await readProc(`${root}/status`);
  const afterIdentity = parseStat(statAfter, pid);
  const afterPrincipal = parseStatus(statusAfter, pid);
  if (identity.startTimeTicks !== afterIdentity.startTimeTicks ||
      identity.parentPid !== afterIdentity.parentPid || linkBefore !== linkAfter ||
      JSON.stringify(principal) !== JSON.stringify(afterPrincipal)) throw new Error('identity-changed');
  return { pid, ...identity, principal, executablePath: linkBefore, executableSha256,
    raw: { statBefore: statBefore.toString('base64'), statusBefore: statusBefore.toString('base64'),
      statAfter: statAfter.toString('base64'), statusAfter: statusAfter.toString('base64') } };
}

function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647; }

/**
 * Return one raw, hashed custody-census fragment for a collector. The caller
 * must allocate a unique sequence across its export and persist the exact bytes.
 * The checkpoint has no authenticated binding, profile or interval coverage.
 */
export async function captureLinuxCustodyCheckpoint({ phase, pids = {}, sequence = 1 } = {}) {
  if (!['initial', 'final'].includes(phase)) throw new TypeError('invalid phase');
  if (!pids || typeof pids !== 'object' || Array.isArray(pids) ||
      Object.keys(pids).some((role) => !ROLES.includes(role))) throw new TypeError('invalid roles');
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 4096) throw new TypeError('invalid sequence');
  const sources = [];
  const bootBefore = await readProc('/proc/sys/kernel/random/boot_id').catch(() => null);
  const boot = bootBefore?.toString('utf8').trim();
  const validBoot = typeof boot === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(boot);
  const selected = ROLES.map((role) => pids[role]).filter(validPid);
  for (const role of ROLES) {
    const pid = pids[role];
    if (!validPid(pid)) { sources.push({ role, state: 'unavailable', reason: 'missing-or-invalid-pid' }); continue; }
    if (selected.indexOf(pid) !== selected.lastIndexOf(pid)) {
      sources.push({ role, pid, state: 'unavailable', reason: 'ambiguous-role-pid' }); continue;
    }
    try { sources.push({ role, state: 'observed', ...await capturePid(pid) }); }
    catch (error) {
      const allowed = ['source-limit', 'invalid-stat', 'invalid-status', 'executable-changed', 'identity-changed'];
      sources.push({ role, pid, state: 'unavailable', reason: allowed.includes(error.message) ? error.message : 'source-unavailable' });
    }
  }
  const bootAfter = await readProc('/proc/sys/kernel/random/boot_id').catch(() => null);
  const bootStable = validBoot && bootAfter !== null && bootBefore.equals(bootAfter);
  const payload = { kind: 'custody-census', version: 1, phase, collectedAt: new Date().toISOString(),
    source: 'linux-proc-checkpoint', sourceProfileSha256: null, sourceInstance: null,
    bootId: bootStable ? boot : null, sources,
    identity: 'unauthenticated', sourceCompleteness: 'unknown', continuity: 'unknown',
    limitations: ['caller-selected-pids', 'not-a-process-census', 'exec-race-not-excluded',
      'descendants-listeners-roots-locks-and-manager-unobserved', 'no-loss-detecting-source', 'no-removal-authority'] };
  const bytes = Buffer.from(JSON.stringify(payload));
  const id = `obs-${String(sequence).padStart(6, '0')}`;
  const file = `observations/${id}.json`;
  const sha256 = digest(bytes);
  return { observation: { id, kind: 'custody-census', file, sha256, sequence },
    file: { path: file, role: 'custody-census', sha256, size: bytes.length }, bytes };
}
