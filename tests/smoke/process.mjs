import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function boundedFileDiagnostic(filename, maxBytes = 64 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const { size } = fs.fstatSync(descriptor);
    const retained = Buffer.alloc(Math.min(size, maxBytes));
    const offset = Math.max(0, size - retained.length);
    const bytesRead = retained.length ? fs.readSync(descriptor, retained, 0, retained.length, offset) : 0;
    const bytes = retained.subarray(0, bytesRead);
    return {
      status: 'present',
      bytes: bytes.toString('utf8'),
      sourceBytes: size,
      retainedOffset: offset,
      retainedBytes: bytesRead,
      truncated: size > bytesRead,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: `${error.code || error.name}: ${error.message}` };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Start's output pipes must keep draining while render/HTTP commands wait for
// it. A synchronous subprocess blocks that drain and can deadlock the server.
export async function runTool(command, args, environment) {
  const pending = execute(command, args, {
    encoding: 'utf8', env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  pending.child.stdin.end();
  const { stdout } = await pending;
  return stdout;
}

export async function timedStep(name, action, log) {
  const started = performance.now();
  log(`START ${name}`);
  let result = 'failed';
  try {
    const value = await action();
    result = 'passed';
    return value;
  } finally {
    log(`END ${name}: ${result} (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  }
}

// The log is encoded in small lines so Actions' failed-job log relay can retain
// it without depending on the installer's disposable home surviving cleanup.
export function completeFileDiagnostic(filename) {
  try {
    const bytes = fs.readFileSync(filename);
    const text = bytes.toString('utf8');
    // Do not publish a log that appears to contain credentials or an env dump.
    if (/(?:password|passwd|secret|token|api[_-]?key|authorization|credential)\s*[=:]\s*["']?[^\s"',}]+|\bBearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@|(?:^|\n)(?:[A-Z_][A-Z0-9_]*=.*\n){4}/im.test(text)) {
      return { status: 'withheld', reason: 'credential-like content or environment dump detected' };
    }
    return { status: 'present', sourceBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable', error: error.code || error.name };
  }
}

export function redactArguments(args) {
  let hideNext = false;
  return args.map((arg) => {
    if (hideNext) { hideNext = false; return '[REDACTED]'; }
    if (/^(?:--?[^=]*(?:token|secret|pass|credential|api[-_]?key|auth)[^=]*|-c)$/i.test(arg)) {
      hideNext = true;
      return arg;
    }
    if (/(?:token|secret|pass|credential|api[-_]?key|auth)/i.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || /:\/\/[^/\s]*@|[?&]/.test(arg)) return '[REDACTED]';
    return arg;
  });
}

const unknown = (reason) => ({ status: 'unknown', reason });
const within = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// Linux /proc/locks associates a kernel lock with device/inode, not a path.
// Only follow the matching owner and its ancestors; never enumerate processes.
export function linuxLockDiagnostic(filename, roots, { platform = process.platform, proc = '/proc' } = {}) {
  const result = { observedAt: new Date().toISOString(), path: filename || unknown('HOME unavailable'), lock: unknown('not inspected'), owners: [] };
  if (platform !== 'linux') { result.lock = unknown('Linux /proc is unavailable on this platform'); return result; }
  if (!filename || !roots.some((root) => within(path.resolve(filename), path.resolve(root)))) {
    result.lock = unknown('lock path is outside the disposable smoke roots'); return result;
  }
  let stat;
  try { stat = fs.lstatSync(filename, { bigint: true }); }
  catch (error) { result.lock = error.code === 'ENOENT' ? { state: 'absent', owner: unknown('lock file absent') } : unknown(`lstat: ${error.code || error.name}`); return result; }
  try {
    const resolved = fs.realpathSync(filename);
    if (!roots.some((root) => within(resolved, fs.realpathSync(root)))) {
      result.lock = unknown('resolved lock path is outside the disposable smoke roots'); return result;
    }
  } catch (error) { result.lock = unknown(`realpath: ${error.code || error.name}`); return result; }
  const fileType = stat.isFile() ? 'regular file' : stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other';
  if (!stat.isFile()) { result.lock = { fileType, state: 'unknown', reason: 'not a regular file; not followed' }; return result; }
  const dev = stat.dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  let lines;
  try { lines = fs.readFileSync(path.join(proc, 'locks'), 'utf8').split('\n'); }
  catch (error) { result.lock = { fileType, state: 'unknown', reason: `/proc/locks: ${error.code || error.name}` }; return result; }
  const matches = [];
  for (const line of lines) {
    // Waiters marked -> are not owners.
    const m = line.match(/^\s*\d+:\s+(?:(->)\s+)?(\S+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+(\S+)\s+(\S+)/i);
    if (m && BigInt(`0x${m[6]}`) === major && BigInt(`0x${m[7]}`) === minor && BigInt(m[8]) === stat.ino) {
      matches.push({ waiter: Boolean(m[1]), type: m[2], advisory: m[3], mode: m[4], pid: Number(m[5]), range: [m[9], m[10]] });
    }
  }
  result.lock = { fileType, device: `${major.toString(16)}:${minor.toString(16)}`, inode: stat.ino.toString(), state: matches.some((m) => !m.waiter) ? 'locked' : 'no matching kernel lock observed', entries: matches };
  if (!matches.some((m) => !m.waiter)) result.lock.owner = unknown('no matching owner in /proc/locks at observation time');
  let ticks;
  try { ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()); } catch { /* unknown below */ }
  let boot;
  try { boot = Number(fs.readFileSync(path.join(proc, 'stat'), 'utf8').match(/^btime (\d+)$/m)?.[1]); } catch { /* unknown below */ }
  const inspect = (pid, anchored) => {
    const dir = path.join(proc, String(pid));
    let fields;
    try {
      const raw = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    } catch (error) { return { pid, details: unknown(`process stat: ${error.code || error.name}`) }; }
    const ppid = Number(fields[1]);
    let cwd;
    try { cwd = fs.readlinkSync(path.join(dir, 'cwd')); } catch { /* unavailable */ }
    if (!anchored && !roots.some((root) => cwd && within(path.resolve(cwd), path.resolve(root)))) {
      return { pid, details: unknown('ancestor is outside disposable smoke roots or cwd unavailable') };
    }
    const item = { pid, ppid, startTicks: fields[19], startTime: ticks > 0 && boot > 0 ? new Date((boot + Number(fields[19]) / ticks) * 1000).toISOString() : unknown('boot time or clock ticks unavailable') };
    try { item.executable = fs.readlinkSync(path.join(dir, 'exe')); } catch (error) { item.executable = unknown(`exe: ${error.code || error.name}`); }
    try {
      const args = fs.readFileSync(path.join(dir, 'cmdline')).toString().split('\0').filter(Boolean);
      item.commandLine = args.length ? redactArguments(args) : unknown('empty /proc cmdline');
    } catch (error) { item.commandLine = unknown(`cmdline: ${error.code || error.name}`); }
    try {
      item.openFds = fs.readdirSync(path.join(dir, 'fd')).sort((a, b) => Number(a) - Number(b)).map((fd) => {
        try {
          const fdPath = path.join(dir, 'fd', fd);
          const target = redactArguments([fs.readlinkSync(fdPath)])[0];
          let matchesLock = unknown('fd stat unavailable');
          try { const fdStat = fs.statSync(fdPath, { bigint: true }); matchesLock = fdStat.dev === stat.dev && fdStat.ino === stat.ino; } catch { /* descriptor may have closed */ }
          return { fd: Number(fd), target, matchesLock };
        }
        catch (error) { return { fd: Number(fd), target: unknown(`readlink: ${error.code || error.name}`) }; }
      });
    } catch (error) { item.openFds = unknown(`fd: ${error.code || error.name}`); }
    try {
      const after = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const afterTicks = after.slice(after.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      if (afterTicks !== fields[19]) return { pid, details: unknown('PID changed during inspection') };
    } catch (error) { item.identityCheck = unknown(`process disappeared during inspection: ${error.code || error.name}`); }
    return item;
  };
  for (const entry of matches.filter((m) => !m.waiter)) {
    if (entry.pid <= 0) { result.owners.push(unknown('kernel did not expose an owner PID')); continue; }
    const ancestry = [];
    const seen = new Set();
    let pid = entry.pid;
    while (pid > 0 && !seen.has(pid) && ancestry.length < 32) {
      seen.add(pid);
      const item = inspect(pid, ancestry.length === 0);
      ancestry.push(item);
      if (!item.ppid || pid === process.pid) break;
      pid = item.ppid;
    }
    result.owners.push({ kernelPid: entry.pid, ancestry, caveat: 'PID is the kernel lock record owner; inherited flock descriptors can outlive that process' });
  }
  return result;
}
