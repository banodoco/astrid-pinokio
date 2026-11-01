'use strict';
// Diagnostic capture only. This module never accepts a source, factory, path or
// authority from its caller. R-36 must bind a protected executable and profile.
const { spawn } = require('node:child_process');
const path = require('node:path');
const PROFILE = 'macos-endpoint-security-process-v1-unbound';
const executable = path.join(__dirname, 'macos-observer');
const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 4096;
const keys = (o, fields) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join(',') === fields.slice().sort().join(',');
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x) && BigInt(x) <= 18446744073709551615n;
const integer = x => Number.isSafeInteger(x) && x >= 0 && x <= 2147483647;
function inspect(raw, exitCode) {
  const result = { source_profile: PROFILE, authority: 'none', status: 'unknown', reason: 'malformed', observations: [], continuity: { first_sequence: null, last_sequence: null, event_count: 0, gaps: 0, dropped: 0, terminal: false }, cleanup: 'unknown' };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES || !raw.endsWith('\n')) return result;
  let records;
  try { records = raw.slice(0, -1).split('\n').map(line => { const value = JSON.parse(line); if (JSON.stringify(value) !== line) throw new Error('noncanonical record'); return value; }); } catch { return result; }
  if (records.length > MAX_EVENTS + 2 || !records.length) return result;
  const first = records[0];
  if (keys(first, ['type', 'code']) && first.type === 'open-failed' && integer(first.code) && records.length === 1) { result.source_result = first; result.reason = 'client-unavailable'; return result; }
  if (keys(first, ['type', 'code', 'cleanup']) && first.type === 'subscribe-failed' && integer(first.code) && integer(first.cleanup) && records.length === 1) { result.source_result = first; result.cleanup = first.cleanup === 0 ? 'success' : 'failed'; result.reason = first.cleanup === 0 ? 'subscription-failed' : 'cleanup-failed'; return result; }
  if (!keys(first, ['type']) || first.type !== 'ready') return result;
  let previous = null;
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (r.type === 'terminal') {
      if (i !== records.length - 1 || !keys(r, ['type', 'stop', 'unsubscribe', 'barrier', 'cleanup', 'overflow']) || ![r.stop, r.barrier, r.overflow].every(x => x === 0 || x === 1) || !integer(r.unsubscribe) || !integer(r.cleanup)) return result;
      result.continuity.terminal = true;
      result.source_result = r;
      result.cleanup = r.cleanup === 0 ? 'success' : 'failed';
      if (r.cleanup !== 0 || r.unsubscribe !== 0) result.reason = 'cleanup-failed';
      else if (r.overflow) result.reason = 'overflow';
      else if (result.continuity.gaps) result.reason = 'sequence-gap';
      else if (!r.stop || !r.barrier) result.reason = 'closure-unproven';
      else if (exitCode !== 0) result.reason = 'child-failed';
      else if (!result.continuity.event_count) result.reason = 'sequence-unavailable';
      else result.reason = 'profile-unbound';
      return result;
    }
    if (!keys(r, ['type', 'version', 'sequence', 'mach_time', 'event', 'pid', 'pidversion', 'subject_pid', 'subject_version']) || r.type !== 'event' || !integer(r.version) || r.version <= 4 || !uint(r.sequence) || BigInt(r.sequence) === 0n || !uint(r.mach_time) || ![1, 2, 3].includes(r.event) || ![r.pid, r.pidversion, r.subject_pid, r.subject_version].every(integer) || !r.pid || !r.subject_pid) return result;
    const seq = BigInt(r.sequence);
    if (previous !== null && seq !== previous + 1n) {
      if (seq <= previous) { result.reason = 'sequence-regression'; return result; }
      result.continuity.gaps++;
      // Saturate rather than lose integer precision.
      const lost = seq - previous - 1n;
      result.continuity.dropped = Number(lost > BigInt(Number.MAX_SAFE_INTEGER - result.continuity.dropped) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(result.continuity.dropped) + lost);
    }
    previous = seq;
    result.continuity.first_sequence ??= r.sequence;
    result.continuity.last_sequence = r.sequence;
    result.continuity.event_count++;
    result.observations.push(r);
  }
  result.reason = 'terminal-missing';
  return result;
}
function startMacObserver() {
  if (process.platform !== 'darwin') return Promise.resolve({ ready: false, finish: async () => ({ source_profile: PROFILE, status: 'unknown', authority: 'none', reason: 'unsupported-host', cleanup: 'unknown' }) });
  return new Promise(resolve => {
    let output = '', overflow = false, settled = false, closed = false, closeResult;
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    const finish = () => { if (!closed) { closed = true; child.stdin.end('Q'); } return closeResult; };
    let resolveClose;
    closeResult = new Promise(r => { resolveClose = r; });
    const ready = value => { if (!settled) { settled = true; resolve({ ready: value, finish }); } };
    child.stdout.on('data', chunk => {
      if (Buffer.byteLength(output) + chunk.length > MAX_BYTES) { overflow = true; child.kill('SIGKILL'); return; }
      output += chunk.toString('utf8');
      if (output.startsWith('{"type":"ready"}\n')) ready(true);
    });
    child.on('error', () => ready(false));
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); ready(false); const r = inspect(output, code); if (overflow) r.reason = 'output-limit'; resolveClose(r); });
  });
}
module.exports = { startMacObserver, inspect };
