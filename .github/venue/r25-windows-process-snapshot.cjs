'use strict';

// Capture only PID/PPID facts immediately before timeout cleanup. In
// particular, neither PowerShell errors nor process metadata beyond those two
// identifiers cross this module boundary.
const childProcess = require('node:child_process');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCHEMA = 'astrid.r25.windows-process-tree-snapshot.v1';
const DEFAULTS = Object.freeze({ timeoutMs: 5000, maxProcesses: 2048, maxOutputBytes: 128 * 1024, maxRoots: 64 });
const MAX_PID = 0xffffffff;
const ERRORS = new Set(['unsupported-platform', 'invalid-request', 'timeout', 'process-limit', 'output-limit', 'command-error', 'malformed-output']);

function failure(error, roots = []) {
  return { schema: SCHEMA, captured_at_utc: new Date().toISOString(), root_pids: roots, processes: [], status: 'error', error };
}

function validBound(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function parseRoots(rootPids, maxRoots) {
  if (!Array.isArray(rootPids) || rootPids.length > maxRoots) return null;
  const roots = [];
  const seen = new Set();
  for (const pid of rootPids) {
    if (!validBound(pid, 1, MAX_PID) || seen.has(pid)) return null;
    seen.add(pid);
    roots.push(pid);
  }
  return roots.sort((a, b) => a - b);
}

function powershellScript(roots, maxProcesses) {
  // All interpolated values have already passed integer range checks.
  const rootArray = roots.length ? `[uint32[]]@(${roots.join(',')})` : '[uint32[]]@()';
  const queryLimit = maxProcesses + 1;
  return [
    "$ErrorActionPreference='Stop'",
    'try {',
    `  $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | Select-Object -First ${queryLimit}); if ($rows.Count -gt ${maxProcesses}) { [Console]::Out.Write('{\"error\":\"process-limit\"}'); exit 0 }`,
    '  $ids = @($rows | ForEach-Object { [pscustomobject]@{ pid=[uint32]$_.ProcessId; parent_pid=[uint32]$_.ParentProcessId } })',
    `  $roots = ${rootArray}; $included = [System.Collections.Generic.HashSet[uint32]]::new(); foreach ($root in $roots) { [void]$included.Add($root) }`,
    '  do { $changed = $false; foreach ($row in $ids) { if ($included.Contains($row.parent_pid) -and $included.Add($row.pid)) { $changed = $true } } } while ($changed)',
    '  $selected = @($ids | Where-Object { $included.Contains($_.pid) } | Sort-Object pid | ForEach-Object { @{ pid=$_.pid; parent_pid=$_.parent_pid } })',
    '  $payload = @{ processes=[object[]]$selected }; [Console]::Out.Write((ConvertTo-Json -InputObject $payload -Compress))',
    '} catch { exit 3 }',
  ].join('; ');
}

function normalizeRows(value, roots, maxProcesses) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.processes)) return null;
  if (value.processes.length > maxProcesses) return 'process-limit';
  const seen = new Set();
  const rows = [];
  for (const row of value.processes) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'parent_pid,pid' ||
        !validBound(row.pid, 1, MAX_PID) || !validBound(row.parent_pid, 0, MAX_PID) || seen.has(row.pid)) return null;
    seen.add(row.pid);
    rows.push({ pid: row.pid, parent_pid: row.parent_pid });
  }
  rows.sort((a, b) => a.pid - b.pid);
  // The root list describes the requested tree even when every root exited
  // before this boundary; the process list records what was still present.
  void roots;
  return rows;
}

function captureWindowsProcessTree(options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  const bounds = {
    timeoutMs: options.timeoutMs === undefined ? DEFAULTS.timeoutMs : options.timeoutMs,
    maxProcesses: options.maxProcesses === undefined ? DEFAULTS.maxProcesses : options.maxProcesses,
    maxOutputBytes: options.maxOutputBytes === undefined ? DEFAULTS.maxOutputBytes : options.maxOutputBytes,
    maxRoots: options.maxRoots === undefined ? DEFAULTS.maxRoots : options.maxRoots,
  };
  if (!validBound(bounds.timeoutMs, 1, 30000) || !validBound(bounds.maxProcesses, 1, 4096) ||
      !validBound(bounds.maxOutputBytes, 128, 1024 * 1024) || !validBound(bounds.maxRoots, 1, 64)) {
    return Promise.resolve(failure('invalid-request'));
  }
  const roots = parseRoots(options.rootPids, bounds.maxRoots);
  if (!roots) return Promise.resolve(failure('invalid-request'));
  if (platform !== 'win32') return Promise.resolve(failure('unsupported-platform', roots));

  const execFile = options.execFile || childProcess.execFile;
  const startedAt = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const capturedAt = startedAt();
  return new Promise(resolve => {
    let settled = false;
    const done = result => { if (!settled) { settled = true; resolve({ schema: SCHEMA, captured_at_utc: capturedAt, root_pids: roots, ...result }); } };
    try {
      execFile(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript(roots, bounds.maxProcesses)], {
        windowsHide: true, timeout: bounds.timeoutMs, maxBuffer: bounds.maxOutputBytes + 1, encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return done({ processes: [], status: 'error', error: 'output-limit' });
          if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') return done({ processes: [], status: 'error', error: 'timeout' });
          return done({ processes: [], status: 'error', error: 'command-error' });
        }
        if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > bounds.maxOutputBytes) return done({ processes: [], status: 'error', error: 'output-limit' });
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { return done({ processes: [], status: 'error', error: 'malformed-output' }); }
        if (parsed && parsed.error === 'process-limit' && Object.keys(parsed).length === 1) return done({ processes: [], status: 'error', error: 'process-limit' });
        const processes = normalizeRows(parsed, roots, bounds.maxProcesses);
        if (processes === 'process-limit') return done({ processes: [], status: 'error', error: 'process-limit' });
        if (!processes) return done({ processes: [], status: 'error', error: 'malformed-output' });
        done({ processes, status: 'captured', error: null });
      });
    } catch {
      done({ processes: [], status: 'error', error: 'command-error' });
    }
  });
}

module.exports = { DEFAULTS, ERRORS, POWERSHELL, SCHEMA, captureWindowsProcessTree };
