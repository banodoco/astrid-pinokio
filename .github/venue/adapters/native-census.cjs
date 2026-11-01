'use strict';

// A point-in-time diagnostic census only. This is not a custody source: it
// cannot detect activity between snapshots and grants no removal authority.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const limits = { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };

const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  if ($null -eq $_.CreationDate -or [string]::IsNullOrWhiteSpace($_.Name)) { throw 'incomplete process identity' }
  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; birth = $_.CreationDate.ToUniversalTime().ToString('o'); executable = [string]$_.ExecutablePath; name = [string]$_.Name }
})
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort }
})
[pscustomobject]@{ processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress
`;

function parseMacProcesses(raw) {
  return raw.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/);
    if (!m) throw new Error('unparseable macOS process row');
    return { pid: Number(m[1]), ppid: Number(m[2]), birth: m[3], executable: m[4] };
  });
}
function parseMacListeners(raw) {
  let pid;
  const listeners = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    if (line[0] === 'p' && /^\d+$/.test(line.slice(1))) pid = Number(line.slice(1));
    else if (line[0] === 'f' && pid !== undefined && line.length > 1) continue;
    else if (line[0] === 'n' && pid !== undefined && line.length > 1) listeners.push({ pid, endpoint: line.slice(1) });
    else throw new Error('unparseable macOS listener row');
  }
  return listeners;
}
function validate(processes, listeners) {
  if (!Array.isArray(processes) || !processes.length || !Array.isArray(listeners)) throw new Error('incomplete census');
  const ids = new Set();
  for (const p of processes) {
    if (!Number.isSafeInteger(p.pid) || p.pid <= 0 || !Number.isSafeInteger(p.ppid) || p.ppid < 0 || typeof p.birth !== 'string' || !p.birth.trim() || typeof p.executable !== 'string') throw new Error('invalid process identity');
    if (ids.has(p.pid)) throw new Error('duplicate process identity');
    ids.add(p.pid);
  }
  for (const l of listeners) {
    if (!Number.isSafeInteger(l.pid) || l.pid < 0 || (typeof l.endpoint !== 'string' && !(typeof l.address === 'string' && Number.isInteger(l.port) && l.port >= 0 && l.port <= 65535))) throw new Error('invalid listener identity');
  }
}
async function collectNativeCensus({ platform = process.platform, run = execFileAsync } = {}) {
  let processes, listeners;
  if (platform === 'darwin') {
    const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], limits);
    if (ps.stderr?.trim()) throw new Error('ps reported incomplete observation');
    processes = parseMacProcesses(ps.stdout);
    // Exit 1 is ambiguous (no matches or an error), so it cannot prove absence.
    const sockets = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], limits);
    if (sockets.stderr?.trim()) throw new Error('lsof reported incomplete observation');
    listeners = parseMacListeners(sockets.stdout);
  } else if (platform === 'win32') {
    const encoded = Buffer.from(windowsScript, 'utf16le').toString('base64');
    const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], limits);
    if (result.stderr?.trim()) throw new Error('Windows census reported an error');
    const data = JSON.parse(result.stdout);
    ({ processes, listeners } = data);
  } else throw new Error('unsupported native census platform');
  validate(processes, listeners);
  return { platform, processes, listeners, continuity: 'unavailable', authority: 'none' };
}
module.exports = { collectNativeCensus, parseMacProcesses, parseMacListeners };
