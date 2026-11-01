// Read-only Linux checkpoint observations. These records are not authority,
// an R-30 export, a complete process census, or continuous custody evidence.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_SOURCE_BYTES = 1024 * 1024;
const ACTION_FILES = Object.freeze([
  'start.js', 'stop.js', 'update.js', 'lib.js', 'lifecycle.mjs', 'session.mjs',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readBounded(handle, limit) {
  const chunks = [];
  let size = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(65536, limit + 1 - size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > limit) throw new Error('source exceeds capture limit');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, size);
}

// Open source files without following the final component and reject changes
// while reading. The parent directory is a caller-selected checkout, not a
// security boundary; a protected collector must establish its identity.
async function captureFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('source is not a regular file');
    const bytes = await readBounded(handle, MAX_SOURCE_BYTES);
    const after = await handle.stat({ bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      if (before[key] !== after[key]) throw new Error('source changed during capture');
    }
    return { bytes, sha256: hash(bytes), size: bytes.length };
  } finally { await handle.close(); }
}

/** Capture the fixed launcher source subset, retaining exact bytes.
 * Dynamic action assembly and dependency closure must be observed separately.
 */
export async function captureActionSources(pinokioDirectory) {
  const files = [];
  for (const name of ACTION_FILES) {
    const captured = await captureFile(path.join(pinokioDirectory, name));
    files.push({ path: name, ...captured });
  }
  return { kind: 'action-source-checkpoint', files,
    limitations: ['not-evaluated-action', 'dependency-closure-unobserved'] };
}

function parseStat(bytes, pid) {
  // Linux comm may itself contain spaces and parentheses. The last closing
  // parenthesis precedes field 3; starttime is field 22.
  const text = bytes.toString('utf8').trimEnd();
  const close = text.lastIndexOf(')');
  if (close < 0 || !text.startsWith(`${pid} (`)) throw new Error('invalid proc stat');
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('invalid proc starttime');
  return fields[19];
}

/** Read a single process checkpoint. No command line, environment or control
 * record is read, because these may contain credentials. PID and birth checks
 * detect some races; they cannot prove continuity or an absence of execs.
 */
export async function captureProcess(pid) {
  if (process.platform !== 'linux') throw new Error('Linux procfs required');
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('invalid pid');
  const root = `/proc/${pid}`;
  const bootBefore = await fs.readFile('/proc/sys/kernel/random/boot_id');
  const statBefore = await fs.readFile(`${root}/stat`);
  const startBefore = parseStat(statBefore, pid);
  const status = await fs.readFile(`${root}/status`);
  if (status.length > MAX_SOURCE_BYTES) throw new Error('proc status exceeds capture limit');
  const exe = await fs.readlink(`${root}/exe`);
  // Open proc's magic link itself so the digest belongs to the executable
  // object, not to a replacement subsequently installed at the pathname.
  const executable = await fs.open(`${root}/exe`, constants.O_RDONLY);
  let executableSha256;
  try {
    const digest = createHash('sha256');
    for await (const chunk of executable.createReadStream({ autoClose: false })) digest.update(chunk);
    executableSha256 = digest.digest('hex');
  } finally { await executable.close(); }
  const statAfter = await fs.readFile(`${root}/stat`);
  const bootAfter = await fs.readFile('/proc/sys/kernel/random/boot_id');
  if (!bootBefore.equals(bootAfter) || startBefore !== parseStat(statAfter, pid)) {
    throw new Error('process incarnation changed during capture');
  }
  return { kind: 'process-checkpoint', pid, bootId: bootBefore.toString('utf8').trim(),
    startTimeTicks: startBefore, executablePath: exe, executableSha256,
    raw: { statBefore, status, statAfter, bootId: bootBefore },
    limitations: ['checkpoint-only', 'exec-race-not-excluded', 'ownership-not-established'] };
}
