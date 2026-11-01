'use strict';
// Capability probe only: no OS event subscription, custody session or export.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A deliberately closed diagnostic state machine for future parser work. These
// synthetic records are not OS events and cannot establish source continuity.
function diagnostic(records) {
  let next = 1, ended = false;
  if (!Array.isArray(records) || records.length === 0) return 'unknown:source-missing';
  for (const r of records) {
    if (ended) return 'unknown:after-terminal';
    if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !['event', 'loss', 'terminal'].includes(r.type)) return 'unknown:malformed';
    if (r.sequence !== next++) return 'unknown:gap';
    if (r.type === 'loss') return 'unknown:loss';
    if (r.type === 'terminal') ended = true;
  }
  return ended ? 'unknown:unapproved-source' : 'unknown:terminal-missing';
}
function parse(source, raw) {
  let x;
  try { x = JSON.parse(raw); } catch { throw Error('malformed-result'); }
  const fields = source === 'endpoint-security' ? ['new_client_result', 'delete_client_result'] : ['start_status', 'enable_status', 'stop_status'];
  if (!x || x.source !== source || Object.keys(x).sort().join(',') !== ['source', ...fields].sort().join(',') || fields.some(k => !Number.isSafeInteger(x[k]) || x[k] < -1 || x[k] > 4294967295)) throw Error('malformed-result');
  return x;
}
function run() {
  const platform = process.platform;
  const result = { platform, arch: process.arch, os_release: os.release(), node: process.version, status: 'unknown', continuity: 'unavailable', authority: 'none' };
  const opts = { encoding: 'utf8', timeout: 20000, maxBuffer: 4096, windowsHide: true };
  try {
    let raw, source;
    if (platform === 'darwin') {
      source = 'endpoint-security';
      const exe = path.join(os.tmpdir(), `r25-es-${process.pid}`);
      try {
        execFileSync('/usr/bin/clang', ['-fblocks', '-framework', 'EndpointSecurity', path.join(__dirname, 'macos.c'), '-o', exe], opts);
        raw = execFileSync(exe, [], opts);
      } finally { try { fs.unlinkSync(exe); } catch {} }
    } else if (platform === 'win32') {
      source = 'etw-kernel-process';
      raw = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows.ps1')], opts);
    } else { throw Error('unsupported-platform'); }
    result.probe = parse(source, raw);
    if (source === 'endpoint-security' && result.probe.new_client_result === 0 && result.probe.delete_client_result !== 0) result.cleanup = 'failed';
    if (source === 'etw-kernel-process' && result.probe.start_status === 0 && result.probe.stop_status !== 0) result.cleanup = 'failed';
  } catch (e) { result.error = e.message === 'unsupported-platform' || e.message === 'malformed-result' ? e.message : 'source-command-failed'; }
  fs.writeFileSync('observer-probe-result.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  if (result.cleanup === 'failed' || result.error) process.exitCode = 1;
}
if (require.main === module) run();
module.exports = { diagnostic, parse };
