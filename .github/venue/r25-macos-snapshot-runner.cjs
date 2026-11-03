'use strict';

// Hosted macOS/Windows R-25 route.  This is a producer only: it binds the exact
// request and records real engine outcomes, but it never grants qualification.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const binding = require('../../pinokio/providers/r25-native-collector-binding.cjs');
const { createObserverIO } = require('./r21-observer-io.cjs');
const { ptermExit, createInstallDiagnostics, redactDiagnosticText, terminateChild } = require('./r21-observer-diagnostics.cjs');

const { createDiagnosticSettlement } = require('./r25-diagnostic-settlement.cjs');
const { applyPinokiodPtyInstrumentation } = require('./r25-pinokiod-pty-instrumentation.cjs');
const { applyCrossOsPtyDiagnostics } = require('./r25-cross-os-pty.cjs');
const { writeCondaPresence } = require('./r25-macos-diagnostic.cjs');

const AGENT_REF = binding.AGENT_SOURCE_REF;
const PINOKIO_SOURCE_REF = '95aafb5a029c3f53cb2268d8596909eab0deb3c4';
const PINOKIO_TUPLE_REF = '3a6a98ae251ca126505245286e2d3e760f4348e9';
const APP_REF = 'lane/M-APP/PINOKIO-APP-BINDING';
const APP_TUPLE_REF = '79f7e5397c044c4c97dc7e97b20ad96f787e5247';
const APP_URL = 'https://raw.githubusercontent.com/banodoco/astrid-app/';
const ACTIONS = binding.REQUIRED_ACTIONS;
const TARGET_OS = process.env.R25_TARGET_OS || 'windows';
const SLOT = process.env.R25_SLOT_ID || (TARGET_OS === 'macos' ? 'pinokio-fully-local-macos' : 'pinokio-fully-local-windows');
function routeConfig(targetOs, slot, launchdTarget) {
  if (targetOs === 'macos' && ['pinokio-backend-macos', 'pinokio-fully-local-macos'].includes(slot)) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const target = launchdTarget || (Number.isSafeInteger(uid) && uid > 0 ? `gui/${uid}/haus.astrid.runtime` : null);
    if (!target) throw new Error('macOS launchd target requires a positive dynamic uid');
    const fullyLocal = slot === 'pinokio-fully-local-macos';
    return {
      targets: { os: 'macos', launchd_targets: [target] },
      installScript: fullyLocal ? 'pinokio/install-local.js' : 'pinokio/install.js',
      installMode: fullyLocal ? 'local' : 'backend',
    };
  }
  if (targetOs === 'windows' && slot === 'pinokio-fully-local-windows') {
    return {
      targets: { os: 'windows', scheduled_task_paths: ['\\Astrid Runtime'], service_names: ['AstridRuntime'] },
      // Preserve the pre-existing Windows route; this adapter is macOS-only.
      installScript: 'pinokio/install.js', installMode: 'backend',
    };
  }
  throw new Error('R25_TARGET_OS and R25_SLOT_ID are incompatible');
}
const ROUTE = routeConfig(TARGET_OS, SLOT, process.env.R25_LAUNCHD_TARGET);
const TARGETS = ROUTE.targets;
const tupleExpected = {
  app: APP_TUPLE_REF, agent: 'ab43bad818ef65ca1e929b973a2f61cd9fc4bf61',
  runtime: '2776ba973b6c8f3555b5629b0840d9691a98d3c2', pinokio: PINOKIO_TUPLE_REF,
  manifest_sha256: 'b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f',
  artifacts: {
    'public/install': '100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d',
    'public/install.sh': '591c4c51b148fccef2a7d1c45782d9ff949d5fd03d46cd82b5591e3a23d1b285',
    'public/install.ps1': 'bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258',
  }, published_at: '2026-11-02T17:55:27Z',
};

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) result[argv[i].slice(2)] = argv[i + 1];
  return result;
}
function canonical(value) { return binding.canonical(value); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonDigest(value) { return digest(Buffer.from(`${canonical(value)}\n`, 'ascii')); }
function writeCanonical(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonical(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function envInt(name) { const value = Number.parseInt(process.env[name] || '', 10); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is not a positive integer`); return value; }
function fail(message, extra = {}) {
  const diagnostics = { schema: 'astrid.r25.pinokio-action-diagnostics.v1', first_error: String(message).slice(0, 240), ...extra };
  const file = path.join(process.env.R25_DIAGNOSTICS || process.cwd(), 'r25-failure.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(diagnostics, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
}

const DIAGNOSTIC_CAPTURE_LIMIT = 64 * 1024;
function createBoundedCapture(file, limit = DIAGNOSTIC_CAPTURE_LIMIT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w', 0o600);
  let bytes = 0;
  let truncated = false;
  let closed = false;
  return {
    append(value) {
      if (closed || bytes >= limit) { truncated = true; return; }
      const safe = redactDiagnosticText(String(value), limit);
      if (!safe) return;
      let data = Buffer.from(safe, 'utf8');
      if (bytes + data.length > limit) {
        data = data.subarray(0, limit - bytes);
        truncated = true;
      }
      if (data.length) { fs.writeSync(fd, data); bytes += data.length; }
    },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } },
    stats() { return { bytes, truncated }; },
  };
}
function copyBoundedTail(source, destination, limit = DIAGNOSTIC_CAPTURE_LIMIT) {
  if (!fs.existsSync(source)) return 'unavailable';
  const capture = createBoundedCapture(destination, limit);
  try {
    const size = fs.statSync(source).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(source, 'r');
    try { fs.readSync(fd, buffer, 0, length, Math.max(0, size - length)); } finally { fs.closeSync(fd); }
    capture.append(buffer);
    return 'captured';
  } catch {
    return 'unavailable';
  } finally { capture.close(); }
}
function captureProcessSnapshot(file, roots) {
  const rootPids = roots.filter(pid => Number.isInteger(pid) && pid > 0);
  try {
    const output = execFileSync('ps', [process.platform === 'darwin' ? '-axo' : '-eo', 'pid=,ppid=,state=,command='], {
      encoding: 'utf8', maxBuffer: 512 * 1024, timeout: 5000,
    });
    const rows = output.split('\n').map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      const command = redactDiagnosticText(match[4], 1024) || '';
      const lower = command.toLowerCase();
      const role = /pterm/.test(lower) ? 'pterm' : /pinokiod/.test(lower) ? 'daemon' : /shell\.mjs/.test(lower) ? 'helper' : /powershell|bash/.test(lower) ? 'shell' : /astrid install|\buv\b|\bcurl\b/.test(lower) ? 'installer' : 'other';
      return { pid: Number(match[1]), ppid: Number(match[2]), role, state: match[3].slice(0, 16), command };
    }).filter(row => row && Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid));
    const children = new Map();
    for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
    const wanted = new Set(rootPids);
    const queue = [...rootPids];
    while (queue.length) for (const row of children.get(queue.shift()) || []) if (!wanted.has(row.pid)) { wanted.add(row.pid); queue.push(row.pid); }
    const processes = rows.filter(row => wanted.has(row.pid)).sort((a, b) => a.pid - b.pid).slice(0, 128);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schema: 'astrid.r25.process-snapshot.v1', captured_at: new Date().toISOString(), roots: rootPids, processes, truncated: processes.length >= 128 }, null, 2)}\n`, { mode: 0o600, flag: 'w' });
    return 'captured';
  } catch {
    try { fs.writeFileSync(file, `${JSON.stringify({ schema: 'astrid.r25.process-snapshot.v1', captured_at: new Date().toISOString(), roots: rootPids, processes: [], unavailable: true })}\n`, { mode: 0o600, flag: 'w' }); } catch {}
    return 'unavailable';
  }
}

function childExitResult(child) {
  if (!child || (child.exitCode === null && child.signalCode === null)) return null;
  return { code: child.exitCode, signal: child.signalCode || null };
}

function waitForChildExit(child, timeoutMs) {
  const existing = childExitResult(child);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let timer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(result);
    };
    const onExit = (code, signal) => finish({ code, signal: signal || null });
    const onError = () => finish(childExitResult(child) || { code: null, signal: null });
    child.once('exit', onExit);
    child.once('error', onError);
    timer = setTimeout(() => finish(childExitResult(child)), timeoutMs);
    const afterAttach = childExitResult(child);
    if (afterAttach) finish(afterAttach);
  });
}

function realPath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function readOwnedProcessTable() {
  const uid = currentUid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('process-census-uid-unavailable');
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error(`process-census-unsupported-platform:${process.platform}`);
  const output = execFileSync('ps', ['-u', String(uid), '-o', 'pid=,ppid=,uid=,state=,command='], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000,
  });
  const rows = output.split('\n').map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) return null;
    return { pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), state: match[4], command: match[5] || '' };
  }).filter(row => row && Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid) && row.uid === uid);
  if (!rows.length) throw new Error('process-census-empty');
  return { uid, rows };
}

function ownedProcessCensus(rootPid, runRoot) {
  const base = {
    schema: 'astrid.r25.owned-process-census.v1', source: 'ps-user-process-table',
    captured_at: new Date().toISOString(), root_pid: rootPid, run_root: runRoot,
    available: false, processes: [], residuals: [], truncated: false,
  };
  try {
    const root = realPath(runRoot);
    if (!root || root === path.parse(root).root || !Number.isSafeInteger(rootPid) || rootPid < 1) {
      return { ...base, reason: 'owned-process-census-root-unavailable' };
    }
    const table = readOwnedProcessTable();
    const children = new Map();
    for (const row of table.rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
    const wanted = new Map();
    const queue = [{ pid: rootPid, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      if (wanted.has(current.pid)) continue;
      wanted.set(current.pid, current.depth);
      for (const row of children.get(current.pid) || []) queue.push({ pid: row.pid, depth: current.depth + 1 });
    }
    const processes = [];
    const residuals = [];
    for (const [pid, depth] of wanted) {
      const identity = readProcessIdentity(pid);
      if (!identity.available) {
        residuals.push({ kind: 'descendant-identity', pid, status: 'unknown', reason: identity.reason || 'identity-unavailable' });
        continue;
      }
      const owned = identity.uid === table.uid && pathWithin(root, identity.cwd);
      if (!owned) {
        residuals.push({ kind: 'descendant-ownership', pid, status: 'unknown', reason: 'uid-or-cwd-outside-run-root' });
        continue;
      }
      processes.push({ depth, ...identity });
    }
    const unavailable = residuals.length > 0 || !processes.some(item => item.pid === rootPid);
    return {
      ...base, available: !unavailable, uid: table.uid, run_root: root,
      processes: processes.sort((left, right) => left.depth - right.depth || left.pid - right.pid),
      residuals,
      reason: unavailable ? (residuals[0]?.reason || 'root-not-in-census') : null,
    };
  } catch (error) {
    return { ...base, reason: error.code || error.message || 'owned-process-census-failed' };
  }
}

function finalOwnedProcessCensus(runRoot, expectedProcesses) {
  const base = {
    schema: 'astrid.r25.owned-process-census.v1', source: 'ps-user-process-table',
    captured_at: new Date().toISOString(), root_pid: null, run_root: runRoot,
    available: false, processes: [], residuals: [], truncated: false,
  };
  try {
    const root = realPath(runRoot);
    if (!root || root === path.parse(root).root) return { ...base, reason: 'owned-process-final-root-unavailable' };
    const table = readOwnedProcessTable();
    const expected = new Map((expectedProcesses || []).map(item => [item.pid, item]));
    const processes = [];
    const residuals = [];
    for (const row of table.rows) {
      const identity = readProcessIdentity(row.pid);
      const expectedIdentity = expected.get(row.pid);
      if (!identity.available) {
        const stillPresent = (() => {
          try { return readOwnedProcessTable().rows.some(item => item.pid === row.pid); } catch { return true; }
        })();
        if (stillPresent && (expectedIdentity || row.command.includes(root))) {
          residuals.push({ kind: 'descendant-identity', pid: row.pid, status: 'unknown', reason: identity.reason || 'identity-unavailable' });
        }
        continue;
      }
      const sameExpected = expectedIdentity && identity.start_identity === expectedIdentity.start_identity;
      const inRunRoot = pathWithin(root, identity.cwd);
      if (sameExpected || inRunRoot) processes.push({ ...identity, expected: Boolean(sameExpected), in_run_root: inRunRoot });
    }
    return {
      ...base, available: residuals.length === 0, uid: table.uid, run_root: root,
      processes: processes.sort((left, right) => left.pid - right.pid), residuals,
      reason: residuals.length ? residuals[0].reason : null,
    };
  } catch (error) {
    return { ...base, reason: error.code || error.message || 'owned-process-final-census-failed' };
  }
}

function readLsofPath(pid, descriptor) {
  const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', descriptor, '-Fn'], {
    encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 2000,
  });
  const rows = output.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  return rows.length === 1 ? realPath(rows[0]) : null;
}

function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return { available: false, reason: 'invalid-pid', pid };
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end < 0) throw new Error('proc-stat-format');
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const uidLine = status.split('\n').find(line => line.startsWith('Uid:'));
      const uidFields = uidLine ? uidLine.trim().split(/\s+/).slice(1) : [];
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const ppid = Number(fields[1]);
      const startTicks = fields[19];
      const uid = Number(uidFields[1] || uidFields[0]);
      if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(startTicks) || !Number.isSafeInteger(uid) || !argv.length || !boot) {
        throw new Error('proc-identity-fields-unavailable');
      }
      return {
        available: true, pid, ppid, uid, executable: realPath(`/proc/${pid}/exe`),
        cwd: realPath(`/proc/${pid}/cwd`), argv,
        start_identity: `linux:${boot}:${startTicks}`,
      };
    }
    if (process.platform === 'darwin') {
      const ps = format => execFileSync('ps', ['-p', String(pid), '-o', format], {
        encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 2000,
      }).trim();
      const ppid = Number(ps('ppid='));
      const uid = Number(ps('uid='));
      const commandLine = ps('command=');
      const start = ps('lstart=');
      const executable = readLsofPath(pid, 'txt');
      const cwd = readLsofPath(pid, 'cwd');
      if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid) || !commandLine || !start || !executable || !cwd) {
        throw new Error('macos-identity-fields-unavailable');
      }
      return {
        available: true, pid, ppid, uid, executable, cwd, command_line: commandLine,
        start_identity: `macos:${start}`,
      };
    }
    return { available: false, pid, reason: `unsupported-platform:${process.platform}` };
  } catch (error) {
    return { available: false, pid, reason: `identity-read-failed:${error.code || error.message || 'unknown'}` };
  }
}

function ownedDirectory(value, uid) {
  const resolved = realPath(value);
  if (!resolved || resolved !== path.resolve(value) || resolved === path.parse(resolved).root) return null;
  try {
    const stat = fs.statSync(resolved);
    return stat.isDirectory() && (uid === null || stat.uid === uid) ? resolved : null;
  } catch { return null; }
}

function pathWithin(root, child) {
  return Boolean(root && child && (child === root || child.startsWith(`${root}${path.sep}`)));
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function identityMismatches(observed, expected, platform = process.platform) {
  const reasons = [];
  if (!observed?.available) return [observed?.reason || 'current-identity-unavailable'];
  if (observed.pid !== expected.pid) reasons.push('pid-changed');
  if (observed.ppid !== expected.ppid) reasons.push('ppid-changed');
  if (observed.uid !== expected.uid) reasons.push('uid-changed');
  if (observed.executable !== expected.executable) reasons.push('executable-changed');
  if (observed.cwd !== expected.cwd) reasons.push('cwd-changed');
  if (observed.start_identity !== expected.start_identity) reasons.push('birth-identity-changed');
  if (platform === 'linux' && !sameArray(observed.argv, expected.argv)) reasons.push('argv-changed');
  if (platform === 'darwin') {
    const commandAvailable = typeof observed.command_line === 'string' && observed.command_line.length > 0;
    if (!commandAvailable || typeof expected.command_line !== 'string' || expected.command_line.length === 0) {
      reasons.push('command-identity-unavailable');
    } else if (observed.command_line !== expected.command_line) {
      reasons.push('command-changed');
    }
    if (commandAvailable && expected.script && !observed.command_line.includes(expected.script)) reasons.push('script-changed');
    if (commandAvailable && typeof expected.executable === 'string' && expected.executable.length > 0
      && !observed.command_line.includes(path.basename(expected.executable))) reasons.push('executable-command-changed');
  }
  if (!pathWithin(expected.run_root, observed.cwd)) reasons.push('cwd-outside-run-root');
  return reasons;
}

function captureOwnedDaemonIdentity(daemon, { cwd, runRoot, args }) {
  const pid = daemon?.pid;
  const uid = currentUid();
  const root = ownedDirectory(runRoot, uid);
  const expectedCwd = ownedDirectory(cwd, uid);
  const executable = realPath(process.execPath);
  const script = args?.[0] ? realPath(args[0]) : null;
  const observed = readProcessIdentity(pid);
  const expected = {
    pid, ppid: process.pid, uid, executable, cwd: expectedCwd, run_root: root,
    script, argv: executable && script ? [executable, script, ...(args.slice(1))] : null,
    command_line: observed.command_line, start_identity: observed.start_identity,
  };
  const reasons = [];
  if (!root) reasons.push('run-root-identity-unavailable');
  if (!expectedCwd) reasons.push('daemon-cwd-identity-unavailable');
  if (!executable || !script) reasons.push('daemon-executable-identity-unavailable');
  if (!observed.available) reasons.push(observed.reason);
  if (reasons.length === 0) reasons.push(...identityMismatches(observed, expected));
  return {
    schema: 'astrid.r25.daemon-identity.v1', available: reasons.length === 0,
    captured_at: new Date().toISOString(), expected, observed,
    reasons: [...new Set(reasons)],
  };
}

function releaseUnsignalledDaemon(daemon) {
  try { daemon.unref(); } catch {}
}

function validatedSignal(expected, runRoot, signal) {
  const current = readProcessIdentity(expected.pid);
  const mismatches = identityMismatches(current, {
    pid: expected.pid, ppid: expected.ppid, uid: expected.uid,
    executable: expected.executable, cwd: expected.cwd,
    start_identity: expected.start_identity, run_root: runRoot,
    argv: expected.argv, script: expected.script, command_line: expected.command_line,
  });
  if (mismatches.length) return { ok: false, pid: expected.pid, mismatches, observed: current };
  try {
    process.kill(expected.pid, signal);
    return { ok: true, pid: expected.pid, signal, observed: current };
  } catch (error) {
    return { ok: false, pid: expected.pid, reason: error.code || error.message || 'signal-failed', observed: current };
  }
}

async function cleanupOwnedDaemon(daemon, { identity = null, killMs = 1000 } = {}) {
  const base = {
    schema: 'astrid.r25.daemon-cleanup.v1', status: 'failed', cleanup_verified: false,
    direct_signal_attempted: false, signal: null, bounded: false,
  };
  const alreadyExited = childExitResult(daemon);
  if (alreadyExited) return {
    ...base, bounded: true, exit: alreadyExited,
    failure: 'daemon-exited-with-descendants-unverified',
    residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: 'daemon exited before independent census' }],
  };
  if (!identity?.available) {
    releaseUnsignalledDaemon(daemon);
    return {
      ...base, bounded: true, failure: 'daemon-identity-unavailable', identity: identity || null,
      residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: 'daemon identity unavailable' }],
    };
  }
  const observed = readProcessIdentity(identity.expected.pid);
  const mismatches = identityMismatches(observed, identity.expected);
  if (mismatches.length) {
    releaseUnsignalledDaemon(daemon);
    return {
      ...base, bounded: true, failure: 'daemon-identity-mismatch',
      identity: { ...identity, cleanup_observed: observed, mismatches },
      residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: 'daemon identity mismatch' }],
    };
  }
  const initialCensus = ownedProcessCensus(identity.expected.pid, identity.expected.run_root);
  if (!initialCensus.available) {
    releaseUnsignalledDaemon(daemon);
    return {
      ...base, bounded: true, failure: 'descendant-census-unavailable', identity,
      initial_census: initialCensus,
      residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: initialCensus.reason || 'independent descendant census unavailable' }],
    };
  }
  const stopped = [];
  const stoppedPids = new Set();
  let stableCensus = null;
  let containmentFailure = null;
  for (let round = 0; round < 4; round += 1) {
    const census = ownedProcessCensus(identity.expected.pid, initialCensus.run_root);
    if (!census.available) {
      containmentFailure = { reason: census.reason || 'containment-census-unavailable', census };
      break;
    }
    const processes = census.processes.sort((left, right) => left.depth - right.depth || left.pid - right.pid);
    for (const expected of processes) {
      if (stoppedPids.has(expected.pid)) continue;
      const result = validatedSignal(expected, initialCensus.run_root, 'SIGSTOP');
      if (!result.ok) {
        containmentFailure = { reason: 'identity-or-stop-failed', signal_failure: result, census };
        break;
      }
      stoppedPids.add(expected.pid);
      stopped.push(expected.pid);
    }
    if (containmentFailure) break;
    const afterStop = ownedProcessCensus(identity.expected.pid, initialCensus.run_root);
    if (!afterStop.available) {
      containmentFailure = { reason: afterStop.reason || 'post-stop-census-unavailable', census: afterStop };
      break;
    }
    const newProcesses = afterStop.processes.filter(item => !stoppedPids.has(item.pid));
    stableCensus = afterStop;
    if (newProcesses.length === 0 && afterStop.processes.length === stoppedPids.size) break;
    if (round === 3) containmentFailure = { reason: 'containment-census-did-not-stabilize', census: afterStop };
  }
  if (containmentFailure || !stableCensus) {
    const releaseTargets = [...new Map([
      ...initialCensus.processes,
      ...(containmentFailure?.census?.processes || []),
    ].map(item => [item.pid, item])).values()].sort((left, right) => right.depth - left.depth || right.pid - left.pid);
    const releaseSignals = [];
    for (const expected of releaseTargets) {
      if (!stoppedPids.has(expected.pid)) continue;
      releaseSignals.push(validatedSignal(expected, initialCensus.run_root, 'SIGKILL'));
    }
    releaseUnsignalledDaemon(daemon);
    return {
      ...base, bounded: true, failure: containmentFailure?.reason || 'containment-census-did-not-stabilize', identity,
      initial_census: initialCensus, containment_census: containmentFailure?.census || null,
      stopped_processes: stopped, release_signals: releaseSignals,
      residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: containmentFailure?.reason || 'containment-census-did-not-stabilize' }],
    };
  }
  const descendantProcesses = stableCensus.processes
    .filter(item => item.pid !== identity.expected.pid)
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
  const signalled = [];
  const signalFailures = [];
  for (const expected of descendantProcesses) {
    const result = validatedSignal(expected, stableCensus.run_root, 'SIGKILL');
    if (result.ok) signalled.push(expected.pid);
    else signalFailures.push({ pid: expected.pid, reason: result.reason || result.mismatches?.join(',') || 'identity-or-signal-failure' });
  }
  let signalError = null;
  const daemonSignal = validatedSignal(identity.expected, stableCensus.run_root, 'SIGKILL');
  const daemonCurrent = daemonSignal.observed;
  const daemonMismatches = daemonSignal.mismatches || [];
  if (!daemonSignal.ok) signalError = daemonSignal.reason || 'daemon-identity-changed-before-signal';
  if (signalError) {
    releaseUnsignalledDaemon(daemon);
    return {
      ...base, bounded: true, failure: 'direct-sigkill-failed', signal_error: signalError,
      identity: { ...identity, cleanup_observed: observed, cleanup_signal_observed: daemonCurrent, cleanup_signal_mismatches: daemonMismatches },
      initial_census: initialCensus, signalled_descendants: signalled,
      residuals: [{ kind: 'daemon-descendants', status: 'unknown', reason: signalError }],
    };
  }
  const exit = await waitForChildExit(daemon, killMs);
  if (!exit) releaseUnsignalledDaemon(daemon);
  let finalCensus = finalOwnedProcessCensus(initialCensus.run_root, initialCensus.processes);
  const censusDeadline = Date.now() + killMs;
  while (finalCensus.available && finalCensus.processes.length > 0 && Date.now() < censusDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    finalCensus = finalOwnedProcessCensus(initialCensus.run_root, initialCensus.processes);
  }
  const residuals = finalCensus.processes.map(item => ({
    kind: 'daemon-descendant', pid: item.pid, status: 'present',
    reason: item.expected ? 'captured descendant remains alive' : 'run-root process remains alive',
  }));
  const unknown = signalFailures.length > 0 || !finalCensus.available;
  const complete = Boolean(exit && !unknown && residuals.length === 0);
  return {
    ...base, status: complete ? 'verified' : 'failed', cleanup_verified: complete,
    direct_signal_attempted: true, direct_target: identity.expected.pid, signal: 'SIGKILL', exit,
    bounded: Boolean(exit), failure: complete ? null : (signalFailures.length ? 'descendant-identity-or-signal-failure' : (finalCensus.available ? 'descendants-remain' : 'final-census-unavailable')),
    stopped_processes: stopped, signalled_descendants: signalled, signal_failures: signalFailures,
    containment_census: stableCensus,
    initial_census: initialCensus, final_census: finalCensus,
    residuals: residuals.length ? residuals : (unknown ? [{ kind: 'daemon-descendants', status: 'unknown', reason: finalCensus.reason || 'descendant signal/census uncertainty' }] : []),
    identity: { ...identity, cleanup_observed: observed },
  };
}

async function githubJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}` } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}
function resolveProducerJob(jobs, { jobId, runId, runAttempt, headSha, slotId }) {
  const suffix = ` / ${jobId}`;
  const slotMarker = `(${slotId})`;
  const matches = (jobs || []).filter(job =>
    typeof job.name === 'string' &&
    (job.name === jobId || job.name.endsWith(suffix)) &&
    job.name.includes(slotMarker) &&
    job.run_id === runId &&
    job.run_attempt === runAttempt &&
    job.head_sha === headSha &&
    Number.isSafeInteger(job.id) && job.id > 0
  );
  return matches.length === 1 ? matches[0] : null;
}
async function resolveOrigin(artifactName) {
  const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
  const [repo, workflowList] = await Promise.all([
    githubJson(base), githubJson(`${base}/actions/workflows?per_page=100`),
  ]);
  const workflow = (workflowList.workflows || []).find(item => item.path === (process.env.R25_CROSS_OS_DIAGNOSTIC === '1' ? '.github/workflows/r25-windows-setup-diagnostic.yml' : '.github/workflows/r25-snapshot-journey.yml'));
  if (!workflow) throw new Error('workflow id was not independently resolved');
  let jobs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    jobs = await githubJson(`${base}/actions/runs/${envInt('GITHUB_RUN_ID')}/jobs?per_page=100`);
    const job = resolveProducerJob(jobs.jobs, {
      jobId: process.env.GITHUB_JOB,
      runId: envInt('GITHUB_RUN_ID'),
      runAttempt: envInt('GITHUB_RUN_ATTEMPT'),
      headSha: process.env.GITHUB_SHA,
      slotId: SLOT,
    });
    if (job) {
      return {
        repository_id: repo.id, repository_full_name: process.env.GITHUB_REPOSITORY,
        workflow_id: workflow.id, workflow_ref: process.env.GITHUB_WORKFLOW_REF,
        workflow_sha: process.env.GITHUB_WORKFLOW_SHA || process.env.GITHUB_SHA,
        run_id: envInt('GITHUB_RUN_ID'), run_attempt: envInt('GITHUB_RUN_ATTEMPT'),
        head_sha: process.env.GITHUB_SHA, producer_job_id: job.id, producer_job_name: job.name,
        artifact_id: null, artifact_name: artifactName,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('producer job id was not independently resolved');
}

function resolveLocalOrigin(file, artifactName) {
  const origin = readJson(path.resolve(file));
  if (origin.artifact_name !== artifactName) throw new Error('local origin artifact name differs');
  if (!String(origin.workflow_ref || '').startsWith('local-macos:')) throw new Error('local origin must be explicitly labeled local-macos');
  if (!String(origin.producer_job_name || '').startsWith('local-macos-')) throw new Error('local producer job must be explicitly labeled local-macos');
  return origin;
}

function materializeProduct(productRoot, appRoot) {
  fs.mkdirSync(path.dirname(productRoot), { recursive: true });
  execFileSync('git', ['init', productRoot], { stdio: 'ignore' });
  execFileSync('git', ['-C', productRoot, 'remote', 'add', 'origin', 'https://github.com/banodoco/astrid-pinokio.git'], { stdio: 'ignore' });
  execFileSync('git', ['-C', productRoot, 'fetch', '--filter=blob:none', '--no-tags', '--depth=1', 'origin', PINOKIO_TUPLE_REF], { stdio: 'inherit' });
  execFileSync('git', ['-C', productRoot, 'checkout', '--detach', 'FETCH_HEAD'], { stdio: 'ignore' });
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.cpSync(productRoot, appRoot, { recursive: true });
  if (execFileSync('git', ['-C', appRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== PINOKIO_TUPLE_REF) throw new Error('Pinokio product checkout differs from CURRENT-TUPLE');
}
async function fetchHash(url) { const response = await fetch(url); if (!response.ok) throw new Error(`App candidate fetch ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
async function verifyAppCandidate(tuple) {
  if (tuple.app !== APP_TUPLE_REF) throw new Error('App tuple is not the approved current candidate');
  const manifest = await fetchHash(`${APP_URL}${APP_REF}/public/install-manifest.json`);
  if (digest(manifest) !== tuple.manifest_sha256) throw new Error('App manifest hash differs from CURRENT-TUPLE');
  for (const file of ['public/install', 'public/install.ps1']) {
    if (digest(await fetchHash(`${APP_URL}${APP_REF}/${file}`)) !== tuple.artifacts[file]) throw new Error(`${file} hash differs from CURRENT-TUPLE`);
  }
}

async function digestTree(root) {
  const rows = [];
  async function visit(current, relative = '') {
    let entries = [];
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name).replaceAll('\\', '/');
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) {
        const data = await fsp.readFile(full); rows.push([rel, digest(data), data.length]);
      }
    }
  }
  await visit(root);
  return { sha256: jsonDigest(rows), files: rows.length };
}

function captureMacCensus(agentRoot, target) {
  const output = execFileSync(process.env.PYTHON || 'python', [
    path.join(agentRoot, 'scripts', 'pinokio_snapshot_macos.py'), '--launchd-target', target,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
  return JSON.parse(output);
}

async function filesystemState(home, appRoot, protectedData) {
  const files = ['app/install-mode.json', 'app/astrid/current', 'app/astrid/install.json', 'app/astrid/update-transaction.json'];
  const rows = [];
  for (const relative of files) {
    const file = path.join(home, relative);
    try { const data = await fsp.readFile(file); rows.push([relative, digest(data), data.length]); } catch { rows.push([relative, null, null]); }
  }
  let data = null;
  if (protectedData) {
    let sentinel = null;
    try { sentinel = digest(await fsp.readFile(protectedData.sentinel)); } catch {}
    data = {
      root: protectedData.root,
      sentinel: protectedData.sentinel,
      sentinel_sha256: sentinel,
      sentinel_expected_sha256: protectedData.sha256,
      sentinel_preserved: sentinel === protectedData.sha256,
      tree: await digestTree(protectedData.root),
    };
  }
  return { schema: 'astrid.r25.pinokio-filesystem-record.v1', protected: rows, app_tree: await digestTree(appRoot), data };
}

function portFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      if (['ECONNREFUSED', 'EHOSTUNREACH'].includes(error.code)) resolve(true);
      else reject(error);
    });
  });
}

async function waitForRouteReadiness(trace, timeoutMs = 120000) {
  if (ROUTE.installMode === 'backend') return trace.waitForReadiness();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [page, health, hostedDoorFree] = await Promise.all([
        fetch('http://127.0.0.1:5180/tools/video-editor', { signal: AbortSignal.timeout(5000) }),
        fetch('http://127.0.0.1:5180/api/runtime/v1/health', { signal: AbortSignal.timeout(5000) }),
        portFree(17340),
      ]);
      const pageBody = await page.text().catch(() => '');
      const body = await health.json().catch(() => null);
      if (await trace.engineResourceReady() && page.status === 200 && /<html/i.test(pageBody) && body?.protocol === 'workspace.v1'
          && health.status === 200 && hostedDoorFree) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('independent fully-local editor/Runtime readiness timeout');
}

async function observeAction({ io, ptermRoot, home, endpoint, appRoot, script, action, logRoot, timeoutMs = 30 * 60 * 1000, diagnostic = null, spawnProcess = spawn }) {
  const socket = await io.openSocket();
  diagnostic?.stage('observer-open');
  let terminal = { stop: false, disconnect: false, error: false };
  let firstError = null;
  let markerTail = '';
  let childPid = null;
  const abort = new AbortController();
  let child;
  const settlement = diagnostic?.cross_os ? createDiagnosticSettlement({ captureFile: diagnostic.pty_capture_file,
    record: value => fs.writeFileSync(diagnostic.settlement_file, JSON.stringify(value) + '\n', { mode: 0o600 }) }) : null;
  const onMessage = event => {
    try {
      const packet = JSON.parse(String(event.data));
      diagnostic?.packet(packet);
      settlement?.packet(packet);
      const raw = packet?.type === 'stream' && typeof packet.data?.raw === 'string' ? packet.data.raw : '';
      const markerSeen = (markerTail + raw).includes('ASTRID_PINOKIO_FAILURE');
      markerTail = packet?.type === 'stream' ? (markerTail + raw).slice(-('ASTRID_PINOKIO_FAILURE'.length - 1)) : '';
      if (packet?.type === 'event' && packet.data === 'stop') terminal.stop = true;
      if (packet?.type === 'event' && packet.data === 'disconnect') terminal.disconnect = true;
      if (packet?.type === 'error' || packet?.type === 'installer-failure-marker' || markerSeen) {
        terminal.error = true;
        if (!firstError) firstError = { kind: packet.type === 'error' ? 'engine-error' : 'installer-failure-marker' };
        if (packet?.type !== 'error') {
          diagnostic?.beforeFailureMarker?.({ at: Date.now(), pid: childPid });
          abort.abort();
        }
      }
    } catch { if (!firstError) firstError = { kind: 'malformed-engine-packet' }; }
  };
  socket.addEventListener('message', onMessage);
  try {
    socket.send(JSON.stringify({ uri: path.join(appRoot, script), mode: 'listen' }));
    diagnostic?.stage('observer-subscribe');
    fs.mkdirSync(logRoot, { recursive: true });
    const stdoutPath = path.join(logRoot, `${action}.stdout.log`);
    const stderrPath = path.join(logRoot, `${action}.stderr.log`);
    const bounded = diagnostic?.stdio || null;
    const stdout = bounded ? null : fs.openSync(stdoutPath, 'wx', 0o600);
    const stderr = bounded ? null : fs.openSync(stderrPath, 'wx', 0o600);
    child = spawnProcess(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', script, '--ref', endpoint], {
      cwd: home, env: process.env, stdio: bounded ? ['ignore', 'pipe', 'pipe'] : ['ignore', stdout, stderr],
    });
    childPid = child.pid;
    settlement?.start();
    diagnostic?.stage('pterm-spawn');
    if (bounded) {
      child.stdout.on('data', chunk => bounded.stdout.append(chunk));
      child.stderr.on('data', chunk => bounded.stderr.append(chunk));
      child.stdout.on('close', () => bounded.stdout.close());
      child.stderr.on('close', () => bounded.stderr.close());
    }
    let innerExit;
    try { innerExit = await ptermExit(child, `R-25 ${action}`, timeoutMs, diagnostic ? { pterm: diagnostic.pterm, beforeTimeout: diagnostic.beforeTimeout } : null, { signal: settlement?.signal || abort.signal }); }
    finally { if (bounded) { bounded.stdout.close(); bounded.stderr.close(); } else { fs.closeSync(stdout); fs.closeSync(stderr); } }
    await new Promise(resolve => setTimeout(resolve, 500));
    return { script, inner_exit: innerExit, terminal, first_error: firstError,
      logs: { stdout: stdoutPath, stderr: stderrPath },
      status_after: await io.status(path.join(appRoot, script), `${action}-status`) };
  } finally {
    if (settlement?.signal.aborted) await terminateChild(child);
    settlement?.stop();
    io.disposeSocket(socket);
  }
}
async function workerSend(worker, value) { worker.stdin.write(`${JSON.stringify(value)}\n`); return new Promise((resolve, reject) => {
  const onData = chunk => { const line = String(chunk).trim().split('\n')[0]; if (!line) return; worker.stdout.off('data', onData); try { const result = JSON.parse(line); if (!result.ok) reject(new Error(result.error || 'snapshot worker refused')); else resolve(result); } catch (error) { reject(error); } };
  worker.stdout.on('data', onData);
}); }
function actionPlan(action, index, tuple, origin) {
  const script = ({ start: 'pinokio/start.js', ready: null, stop: 'pinokio/stop.js', update: 'pinokio/update.js', rollback: `pinokio/reset.js + ${ROUTE.installScript}`, uninstall: 'pinokio/uninstall.js' })[action];
  const plan = { schema: 'astrid.r25.pinokio-action-plan.v1', action, action_id: `r25-${action}-${origin.run_id}-${origin.run_attempt}`, action_index: index, slot_id: SLOT, tuple, origin: { run_id: origin.run_id, run_attempt: origin.run_attempt, producer_job_id: origin.producer_job_id }, operation: action === 'rollback' ? 'reset-and-reinstall-recovery-boundary' : action, script };
  return { plan, action_sha256: jsonDigest(plan) };
}

async function main() {
  const cli = args(process.argv.slice(2));
  const crossDiagnostic = cli['cross-os-diagnostic'] === 'true' && cli['setup-only'] === 'true';
  const backendStartDiagnostic = cli['backend-start-diagnostic'] === 'true' && cli['setup-only'] === 'true';
  if (cli['cross-os-diagnostic'] === 'true' && !crossDiagnostic) throw new Error('cross-OS diagnostics require setup-only');
  if (cli['backend-start-diagnostic'] === 'true'
      && (!backendStartDiagnostic || TARGET_OS !== 'macos' || SLOT !== 'pinokio-backend-macos' || process.platform !== 'darwin'
        || !String(process.env.R25_ISOLATION_EVIDENCE_REF || '').trim())) {
    throw new Error('backend Start diagnostics require a setup-only macOS backend-slot run');
  }
  const tuple = JSON.parse(cli.tuple || process.env.R25_TUPLE_JSON || '{}');
  binding.validateRequest({ schema: 'astrid.r25.pinokio-snapshot-request.v1', slot_id: SLOT, tuple, origin: { repository_id: 1, repository_full_name: 'x/y', workflow_id: 1, workflow_ref: 'x', workflow_sha: '0000000000000000000000000000000000000000', run_id: 1, run_attempt: 1, head_sha: '0000000000000000000000000000000000000000', producer_job_id: 1, producer_job_name: 'x', artifact_id: null, artifact_name: `r25-snapshots-${SLOT}-x` }, collector: { agent_ref: AGENT_REF, pinokio_ref: PINOKIO_SOURCE_REF, sources: binding.flattenedSources }, actions: ACTIONS.map((action, index) => ({ action, action_id: `x-${index}`, action_sha256: '0'.repeat(64) })), targets: TARGETS });
  if (canonical(tuple) !== canonical(tupleExpected)) throw new Error('tuple differs from pinned CURRENT-TUPLE');
  const output = path.resolve(cli.output || process.env.R25_OUTPUT || path.join(process.env.TEMP || '.', 'r25-snapshot-output'));
  const diagnostics = process.env.R25_DIAGNOSTICS || path.join(path.dirname(output), 'r25-diagnostics');
  fs.mkdirSync(diagnostics, { recursive: true });
  let artifactName;
  let origin;
  if (cli['local-origin']) {
    const candidate = readJson(path.resolve(cli['local-origin']));
    artifactName = candidate.artifact_name;
    origin = resolveLocalOrigin(cli['local-origin'], artifactName);
    if (TARGET_OS !== 'macos' || process.platform !== 'darwin') throw new Error('local origin route requires a real macOS host');
  } else {
    artifactName = `r25-snapshots-${SLOT}-${envInt('GITHUB_RUN_ID')}-${envInt('GITHUB_RUN_ATTEMPT')}`;
    origin = await resolveOrigin(artifactName);
  }
  const plans = ACTIONS.map((action, index) => actionPlan(action, index, tuple, origin));
  const actions = plans.map(item => ({ action: item.plan.action, action_id: item.plan.action_id, action_sha256: item.action_sha256 }));
  const request = binding.buildRequest(tuple, { slotId: SLOT, candidateRef: PINOKIO_SOURCE_REF, origin, actions, targets: TARGETS });
  // SnapshotSession owns the artifact's request.json and requires its output
  // directory to be absent. Keep the worker input beside (not inside) it.
  const requestPath = path.join(path.dirname(output), 'r25-request.json');
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  const productRoot = path.join(path.dirname(output), 'pinokio-product');
  const home = path.join(path.dirname(output), 'pinokio-home');
  const isolatedUserHome = path.join(path.dirname(output), 'user-home');
  const isolatedDataHome = path.join(path.dirname(output), 'data-home');
  const appRoot = path.join(home, 'api', 'astrid');
  const ptermRoot = cli.pterm || process.env.PTERM_ROOT;
  const pinokiodRoot = cli.pinokiod || process.env.PINOKIOD_ROOT;
  if (!ptermRoot || !pinokiodRoot || !cli['agent-root']) throw new Error('runner roots are incomplete');
  if (crossDiagnostic) {
    applyPinokiodPtyInstrumentation(pinokiodRoot, { diagnosticFile: path.join(diagnostics, 'r25-pty-diagnostics.jsonl') });
    const patched = applyCrossOsPtyDiagnostics(pinokiodRoot);
    fs.writeFileSync(path.join(diagnostics, 'cross-os-instrumentation.json'), JSON.stringify(patched) + '\n', { mode: 0o600 });
  }
  await verifyAppCandidate(tuple);
  binding.validateSourceRoots({ agentRoot: path.resolve(cli['agent-root']), pinokioRoot: process.cwd(), agentRef: AGENT_REF });
  materializeProduct(productRoot, appRoot);
  const environment = path.join(appRoot, '_ENVIRONMENT');
  fs.writeFileSync(environment, '# R-25 run-owned candidate pin\nASTRID_APP_REF=lane/M-APP/PINOKIO-APP-BINDING\n', { encoding: 'utf8', flag: 'w', mode: 0o600 });
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.mkdirSync(isolatedUserHome, { recursive: true });
  fs.mkdirSync(isolatedDataHome, { recursive: true });
  const diagnosticEnabled = Boolean(process.env.R25_DIAGNOSTICS);
  const logRoot = path.join(diagnostics, 'engine-logs');
  const daemonOutput = diagnosticEnabled ? {
    stdout: createBoundedCapture(path.join(diagnostics, 'daemon.stdout.log')),
    stderr: createBoundedCapture(path.join(diagnostics, 'daemon.stderr.log')),
  } : null;
  const setupOutput = diagnosticEnabled ? {
    stdout: createBoundedCapture(path.join(logRoot, 'setup-install.stdout.log')),
    stderr: createBoundedCapture(path.join(logRoot, 'setup-install.stderr.log')),
  } : null;
  let daemon;
  const setupDiagnostic = diagnosticEnabled ? createInstallDiagnostics({
    action: 'setup-install', script: ROUTE.installScript, slot_id: SLOT,
    run_id: origin.run_id, run_attempt: origin.run_attempt,
  }, value => fs.writeFileSync(path.join(diagnostics, 'setup-install-diagnostics.json'), `${JSON.stringify(value)}\n`, {
    encoding: 'utf8', flag: 'w', mode: 0o600,
  })) : null;
  const setupDiagnosticView = setupDiagnostic ? Object.assign({}, setupDiagnostic, {
    stdio: setupOutput,
    cross_os: crossDiagnostic,
    pty_capture_file: path.join(diagnostics, 'cross-os-pty.json'),
    settlement_file: path.join(diagnostics, 'setup-install-settlement.json'),
    beforeFailureMarker(value = {}) {
      captureProcessSnapshot(path.join(diagnostics, 'process-snapshot-before-failure-marker.json'), [value.pid, daemon?.pid]);
      setupDiagnostic.stage('process-snapshot-before-failure-marker');
      copyBoundedTail(path.join(isolatedUserHome, 'Library', 'Logs', 'Astrid Runtime', 'install.log'), path.join(diagnostics, 'installer-output-before-failure-marker.log'));
      setupDiagnostic.stage('installer-output-before-failure-marker');
    },
    beforeTimeout(value) {
      const processSnapshot = captureProcessSnapshot(path.join(diagnostics, 'process-snapshot-before-timeout.json'), [value.pid, daemon?.pid]);
      setupDiagnostic.stage('process-snapshot-before-timeout');
      const installerOutput = copyBoundedTail(path.join(isolatedUserHome, 'Library', 'Logs', 'Astrid Runtime', 'install.log'), path.join(diagnostics, 'installer-output.log'));
      setupDiagnostic.stage('installer-output-before-timeout');
      setupDiagnostic.beforeTimeout({ ...value, process_snapshot: processSnapshot, installer_output: installerOutput });
    },
  }) : null;
  const daemonEnv = { ...process.env, HOME: isolatedUserHome, XDG_DATA_HOME: isolatedDataHome, PINOKIO_HOME: home, PINOKIO_HTTPS_ACTIVE: '0', PINOKIO_NETWORK_ACTIVE: '0',
    ...(diagnosticEnabled ? { ASTRID_R25_SETUP_DIAGNOSTICS: '1' } : {}) };
  if (crossDiagnostic) Object.assign(daemonEnv, { ASTRID_R25_CROSS_OS_DIAGNOSTIC: '1', ASTRID_R25_PTY_CAPTURE_FILE: path.join(diagnostics, 'r25-pty-diagnostics.jsonl'), ASTRID_R25_CROSS_CAPTURE_FILE: path.join(diagnostics, 'cross-os-pty.json') });
  daemon = spawn(process.execPath, [path.join(pinokiodRoot, 'script', 'index.js')], {
    cwd: pinokiodRoot,
    env: daemonEnv,
    stdio: daemonOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
  });
  const daemonScript = path.join(pinokiodRoot, 'script', 'index.js');
  const daemonIdentity = captureOwnedDaemonIdentity(daemon, {
    cwd: pinokiodRoot, runRoot: path.dirname(pinokiodRoot), args: [daemonScript],
  });
  if (daemonOutput) {
    daemon.stdout.on('data', chunk => daemonOutput.stdout.append(chunk));
    daemon.stderr.on('data', chunk => daemonOutput.stderr.append(chunk));
    daemon.stdout.on('close', () => daemonOutput.stdout.close());
    daemon.stderr.on('close', () => daemonOutput.stderr.close());
    setupDiagnostic.stage('daemon-spawn');
  }
  let trace = null;
  const observerEvents = [];
  let worker = null;
  let finalCensus = null;
  let cleanupResult = null;
  try {
    let daemonReady = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      if (daemon.exitCode !== null) break;
      try { const response = await fetch('http://127.0.0.1:42000/pinokio/version'); if (response.ok) { daemonReady = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!daemonReady) throw new Error('native pinokiod did not reach readiness');
    setupDiagnostic?.stage('daemon-ready');
    const { WebSocket } = require(path.join(ptermRoot, 'node_modules', 'unws'));
    trace = createObserverIO({ WebSocket, fetch, spawn, record: value => { if (observerEvents.length < 128) observerEvents.push(value); }, appRoot, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', pollMs: 120000 });
    // Installation is disposable preparation, outside the six measured
    // boundaries. It is still driven through the real Pinokio engine and is
    // allowed to fail closed before an evidence session can begin.
    if (crossDiagnostic) writeCondaPresence(home, diagnostics, daemonEnv);
    const preparation = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: ROUTE.installScript, action: 'setup-install', logRoot, timeoutMs: 45 * 60 * 1000, diagnostic: setupDiagnosticView });
    if (setupDiagnostic) {
      copyBoundedTail(path.join(isolatedUserHome, 'Library', 'Logs', 'Astrid Runtime', 'install.log'), path.join(diagnostics, 'installer-output.log'));
      setupDiagnostic.stage('installer-output-capture');
      setupDiagnostic.stage('setup-complete');
    }
    if (preparation.first_error || preparation.inner_exit.code !== 0 || preparation.terminal.error) throw new Error('disposable Pinokio install preparation failed');
    if (crossDiagnostic) {
      writeCanonical(path.join(diagnostics, 'r25-setup-result.json'), { schema: 'astrid.r25.setup-diagnostic-result.v1', diagnostic_only: true, preparation });
      return;
    }
    if (backendStartDiagnostic) {
      const startOutput = {
        stdout: createBoundedCapture(path.join(diagnostics, 'start.stdout.log'), 16 * 1024),
        stderr: createBoundedCapture(path.join(diagnostics, 'start.stderr.log'), 16 * 1024),
      };
      let readyText = '';
      let readiness = null;
      let client = null;
      let terminal = { stop: 0, disconnect: 0, error: 0, malformed: 0 };
      try {
        const pterm = await trace.startOldLauncher({
          onOutput(stream, chunk) {
            const value = Buffer.from(chunk);
            startOutput[stream].append(value.toString('utf8'));
            if (stream === 'stdout') {
              readyText = (readyText + value.toString('utf8')).slice(-512);
            }
          },
          onReadiness(value) { readiness = value; },
          onTerminal(value) { terminal = value; },
          onClientState(value) { client = value; },
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
        const readySentinel = readyText.includes('ASTRID_PINOKIO_READY');
        const refusal = !readySentinel ? 'ready-sentinel-unobserved'
          : terminal.error || terminal.stop || terminal.disconnect ? 'top-level-terminal-packet-observed'
            : terminal.malformed ? 'terminal-packet-observation-malformed'
            : !readiness || Object.values(readiness).some(value => value !== true) ? 'independent-readiness-incomplete'
              : !client || client.exited || !client.still_owned ? 'start-client-not-live-and-owned' : null;
        const result = {
          schema: 'astrid.r25.backend-start-diagnostic.v1', diagnostic_only: true,
          slot_id: SLOT, isolation_evidence_ref: process.env.R25_ISOLATION_EVIDENCE_REF,
          readiness, ready_sentinel_observed: readySentinel, terminal_observation_window_ms: 2000,
          terminal_packets: terminal, client_lifecycle: {
            pid: pterm.pid || null, exited: client?.exited || null,
            alive_after_readiness: Boolean(client && !client.exited && client.still_owned),
            settlement: 'long-lived-client-observed; no exit result claimed',
          },
          observer_events: observerEvents, refusal,
        };
        writeCanonical(path.join(diagnostics, 'backend-start-diagnostic.json'), result);
        if (refusal) throw new Error(`backend Start diagnostic refused: ${refusal}`);
      } finally {
        for (const capture of Object.values(startOutput)) capture.close();
      }
      return;
    }
    const mode = readJson(path.join(appRoot, 'app', 'install-mode.json'));
    if (mode.schema_version !== 1 || mode.mode !== ROUTE.installMode) throw new Error(`preparation did not retain ${ROUTE.installMode} install mode`);
    const install = readJson(path.join(appRoot, 'app', 'astrid', 'install.json'));
    const dataRoot = path.resolve(install.data_root || '');
    const isolatedRoot = path.resolve(path.dirname(output));
    if (!path.isAbsolute(install.data_root || '') || (dataRoot !== isolatedRoot && !dataRoot.startsWith(`${isolatedRoot}${path.sep}`))) {
      throw new Error('installed data root escaped the isolated run root');
    }
    fs.mkdirSync(dataRoot, { recursive: true });
    const sentinel = path.join(dataRoot, 'r25-option-b-sentinel.json');
    const sentinelBytes = Buffer.from(`${canonical({ schema: 'astrid.r25.option-b-sentinel.v1', slot_id: SLOT, tuple })}\n`, 'ascii');
    fs.writeFileSync(sentinel, sentinelBytes, { flag: 'wx', mode: 0o600 });
    const protectedData = { root: dataRoot, sentinel, sha256: digest(sentinelBytes) };
    const initialCensus = TARGET_OS === 'macos'
      ? captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]) : null;
    if (initialCensus) writeCanonical(path.join(diagnostics, 'census', 'initial.json'), initialCensus);
    worker = spawn(process.env.PYTHON || 'python', [path.join(process.cwd(), '.github', 'venue', 'r25-snapshot-worker.py'), requestPath, output], { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: path.resolve(cli['agent-root']) }, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = [];
    for (const item of plans) {
      const action = item.plan.action;
      await workerSend(worker, { op: 'open', action });
      const before = await filesystemState(home, appRoot, protectedData);
      let engine;
      if (action === 'ready') {
        await waitForRouteReadiness(trace);
        engine = { script: null, execution_kind: 'engine-readiness-probe', inner_exit: { code: 0, signal: null }, terminal: { stop: true, disconnect: true, error: false }, first_error: null, status_after: true };
      } else if (action === 'rollback') {
        const reset = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: 'pinokio/reset.js', action: 'rollback-reset', logRoot });
        const reinstall = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: ROUTE.installScript, action: 'rollback-reinstall', logRoot });
        const rollbackMode = readJson(path.join(appRoot, 'app', 'install-mode.json'));
        if (rollbackMode.schema_version !== 1 || rollbackMode.mode !== ROUTE.installMode) throw new Error(`rollback did not retain ${ROUTE.installMode} install mode`);
        engine = { execution_kind: 'real-engine-reset-and-reinstall', steps: [reset, reinstall], inner_exit: reinstall.inner_exit, terminal: reinstall.terminal, first_error: reset.first_error || reinstall.first_error, status_after: reinstall.status_after };
      } else {
        engine = await observeAction({ io: trace, ptermRoot, home, endpoint: 'pinokio://127.0.0.1:42000/api/astrid', appRoot, script: item.plan.script, action, logRoot });
      }
      const after = await filesystemState(home, appRoot, protectedData);
      const failed = Boolean(engine.first_error || engine.inner_exit?.code !== 0 || engine.terminal?.error || !after.data?.sentinel_preserved || engine.steps?.some(step => step.inner_exit?.code !== 0 || step.first_error));
      const record = { schema: 'astrid.r25.pinokio-filesystem-record.v1', action, action_id: item.plan.action_id, action_sha256: item.action_sha256, tuple, origin: { run_id: origin.run_id, run_attempt: origin.run_attempt, producer_job_id: origin.producer_job_id }, before, after, engine, status: failed ? 'failed' : 'completed' };
      results.push(record);
      writeCanonical(path.join(diagnostics, 'action-records', `${String(item.plan.action_index).padStart(2, '0')}-${action}.json`), record);
      await workerSend(worker, { op: 'close', failed });
      if (failed) throw new Error(`${action} real engine boundary failed`);
    }
    finalCensus = TARGET_OS === 'macos'
      ? captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]) : null;
    if (finalCensus) writeCanonical(path.join(diagnostics, 'census', 'final.json'), finalCensus);
    await workerSend(worker, { op: 'finalize' });
    for (const item of plans) writeCanonical(path.join(output, 'actions', `${String(item.plan.action_index).padStart(2, '0')}-${item.plan.action}.json`), item.plan);
    for (const record of results) writeCanonical(path.join(output, 'filesystem', `${record.action}.json`), record);
    if (initialCensus) writeCanonical(path.join(output, 'census', 'initial.json'), initialCensus);
    if (finalCensus) writeCanonical(path.join(output, 'census', 'final.json'), finalCensus);
  } finally {
    setupDiagnostic?.stage('cleanup-start');
    if (TARGET_OS === 'macos' && !finalCensus) {
      try {
        finalCensus = captureMacCensus(path.resolve(cli['agent-root']), TARGETS.launchd_targets[0]);
        writeCanonical(path.join(diagnostics, 'census', 'final.json'), finalCensus);
      } catch {}
    }
    try { if (trace) await trace.cleanup(); } finally {
      if (worker?.exitCode === null) worker.kill();
      cleanupResult = await cleanupOwnedDaemon(daemon, { identity: daemonIdentity });
      const cleanupFile = path.join(process.env.R25_DIAGNOSTICS || path.dirname(output), 'daemon-cleanup.json');
      try {
        fs.mkdirSync(path.dirname(cleanupFile), { recursive: true });
        fs.writeFileSync(cleanupFile, `${JSON.stringify(cleanupResult, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' });
      } catch {}
      daemonOutput?.stdout.close();
      daemonOutput?.stderr.close();
      if (crossDiagnostic && !cleanupResult.cleanup_verified) {
        // Preserve failed identity validation; a fresh hosted runner owns the residuals.
        daemon.stdout?.destroy(); daemon.stderr?.destroy(); daemon.unref();
      }
    }
  }
  if (cleanupResult && cleanupResult.status !== 'verified') throw new Error(`daemon cleanup failed closed: ${cleanupResult.failure}`);
}

module.exports = {
  main, actionPlan, routeConfig, createBoundedCapture, copyBoundedTail, captureProcessSnapshot,
  readProcessIdentity, identityMismatches, captureOwnedDaemonIdentity,
  ownedProcessCensus, finalOwnedProcessCensus, cleanupOwnedDaemon, resolveProducerJob, observeAction,
};
if (require.main === module) {
  main().catch(error => { fail(error.message, { run_id: process.env.GITHUB_RUN_ID || null, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null }); process.stderr.write(`${String(error.stack || error)}\n`); process.exitCode = 1; });
}
