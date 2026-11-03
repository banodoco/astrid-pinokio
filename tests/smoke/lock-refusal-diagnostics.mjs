import fs from 'node:fs';
import path from 'node:path';

const UNKNOWN = 'unknown';

function linuxDeviceParts(device) {
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${major.toString(16)}:${minor.toString(16)}`;
}

function safeArgv(procRoot, pid) {
  try {
    const values = fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0').filter(Boolean).slice(0, 6);
    if (!values.length) return UNKNOWN;
    let redactNext = false;
    return values.map((value, index) => {
      if (index === 0) return path.basename(value).slice(0, 80) || UNKNOWN;
      const sensitive = /password|passwd|token|secret|credential|authorization|api[-_]?key/i.test(value);
      if (redactNext) {
        redactNext = false;
        return '<redacted>';
      }
      if (sensitive) {
        redactNext = !value.includes('=');
        return '<redacted>';
      }
      if (value.startsWith('/') || value.includes('://') || value.length > 80) return '<redacted>';
      return value.replace(/[\r\n\t]/g, ' ').slice(0, 80);
    }).join(' ');
  } catch {
    return UNKNOWN;
  }
}

function processIdentity(procRoot, pid, lockStat, lockPathLabel) {
  let comm = UNKNOWN;
  let ppid = UNKNOWN;
  try { comm = fs.readFileSync(path.join(procRoot, String(pid), 'comm'), 'utf8').trim().slice(0, 80) || UNKNOWN; } catch { /* process exited or procfs is restricted */ }
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (/^\d+$/.test(fields[1] || '')) ppid = Number(fields[1]);
  } catch { /* process exited or procfs is restricted */ }

  let parent = UNKNOWN;
  if (typeof ppid === 'number' && ppid > 0) {
    let parentComm = UNKNOWN;
    try { parentComm = fs.readFileSync(path.join(procRoot, String(ppid), 'comm'), 'utf8').trim().slice(0, 80) || UNKNOWN; } catch { /* parent exited or procfs is restricted */ }
    parent = { pid: ppid, comm: parentComm, argv: safeArgv(procRoot, ppid) };
  }

  let fdLink = { status: UNKNOWN };
  try {
    const fdRoot = path.join(procRoot, String(pid), 'fd');
    const names = fs.readdirSync(fdRoot).slice(0, 64);
    fdLink = { status: 'not-found' };
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(fdRoot, name), { bigint: true });
        if (stat.dev === lockStat.dev && stat.ino === lockStat.ino) {
          const linkTarget = fs.readlinkSync(path.join(fdRoot, name));
          fdLink = {
            status: 'matched-lock-inode',
            fd_number: name,
            target: `${lockPathLabel}${linkTarget.endsWith(' (deleted)') ? ' (deleted)' : ''}`,
          };
          break;
        }
      } catch { /* descriptor closed during bounded scan */ }
    }
  } catch { /* procfs is restricted or process exited */ }
  return { pid, ppid, comm, argv: safeArgv(procRoot, pid), fd_symlink: fdLink, parent };
}

/** Read-only snapshot for a Linux flock refusal. No lock is opened or probed. */
export function captureLockRefusal({ lockPath, lockPathLabel = '$LOCK_ROOT/astrid-install.lock', procRoot = '/proc' }) {
  const record = {
    kind: 'pinokio-lock-refusal-diagnostic',
    schema: 1,
    observed_at: new Date().toISOString(),
    platform: process.platform,
    lock_path: lockPathLabel,
    device: UNKNOWN,
    inode: UNKNOWN,
    holder_pid: UNKNOWN,
    holders: [],
    limitations: [],
  };

  let lockStat;
  try {
    lockStat = fs.statSync(lockPath, { bigint: true });
    record.device = linuxDeviceParts(lockStat.dev);
    record.inode = String(lockStat.ino);
  } catch (error) {
    record.limitations.push(error?.code === 'ENOENT' ? 'lock-path-not-present-at-capture' : 'lock-path-stat-unavailable');
    return record;
  }

  let lockLines;
  try {
    lockLines = fs.readFileSync(path.join(procRoot, 'locks'), 'utf8').slice(0, 128 * 1024).split('\n');
  } catch {
    record.limitations.push('proc-locks-unavailable');
    return record;
  }

  const target = [...record.device.split(':').map((part) => BigInt(`0x${part}`)), BigInt(record.inode)];
  const pids = [];
  for (const line of lockLines) {
    // Linux /proc/locks: id: FLOCK ADVISORY WRITE|READ PID major:minor:inode ...
    const match = line.match(/^\s*\d+:\s+FLOCK\s+ADVISORY\s+\S+\s+(\d+)\s+([0-9a-f]+:[0-9a-f]+:\d+)\s+/i);
    if (!match) continue;
    const [major, minor, inode] = match[2].split(':');
    const candidate = [BigInt(`0x${major}`), BigInt(`0x${minor}`), BigInt(inode)];
    if (candidate.every((part, index) => part === target[index]) && pids.length < 4)
      pids.push(Number(match[1]));
  }
  const uniquePids = [...new Set(pids)];
  if (uniquePids.length === 1) record.holder_pid = uniquePids[0];
  else if (uniquePids.length > 1) record.holder_pid = 'multiple';
  else record.limitations.push('matching-kernel-flock-holder-not-visible');
  record.holders = uniquePids.map((pid) => processIdentity(procRoot, pid, lockStat, lockPathLabel));
  return record;
}
