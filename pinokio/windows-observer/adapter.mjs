import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This identity describes the implementation, not an approved completeness profile.
const PROFILE = 'windows-etw-kernel-process-v1;provider=22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716;keyword=0x10;level=5;headers-only;max=1024';
export const sourceProfileSha256 = createHash('sha256').update(PROFILE).digest('hex');
const executable = fileURLToPath(new URL('./etw-observer.exe', import.meta.url));
const summaryKeys = ['start', 'enable', 'opened', 'process', 'stop', 'close', 'timed_out', 'events_lost', 'buffers_lost', 'realtime_buffers_lost', 'consumer_buffers_lost', 'overflow', 'terminal', 'events'];
const eventKeys = ['sequence', 'emitter_pid', 'event_id', 'opcode', 'version'];
const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const keysEqual = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const unknown = reason => ({ status: 'unknown', reason, authority: 'none', source_profile: PROFILE, source_profile_sha256: sourceProfileSha256, observations: [], continuity: null, cleanup: 'unknown' });

// Parsing is intentionally incapable of granting authority or a passing result.
export function evaluateWindowsCapture(capture) {
  if (!keysEqual(capture, summaryKeys) || !['opened', 'timed_out', 'terminal'].every(k => typeof capture[k] === 'boolean') || !summaryKeys.filter(k => !['opened', 'timed_out', 'terminal', 'events'].includes(k)).every(k => uint(capture[k])) || !Array.isArray(capture.events) || capture.events.length > 1024) return unknown('malformed');
  for (let i = 0; i < capture.events.length; i++) {
    const event = capture.events[i];
    if (!keysEqual(event, eventKeys) || !eventKeys.every(k => uint(event[k])) || event.sequence !== i + 1 || event.event_id > 65535 || event.opcode > 255 || event.version > 255) return unknown('gap-or-malformed-event');
  }
  const dropped = capture.events_lost + capture.buffers_lost + capture.realtime_buffers_lost + capture.consumer_buffers_lost + capture.overflow;
  const cleanup = capture.start !== 0 ? 'not-started' : capture.stop === 0 && (!capture.opened || (capture.close === 0 && capture.terminal && capture.process === 0)) ? 'complete' : 'failed';
  let reason = 'unapproved-source-profile';
  if (capture.start !== 0 || capture.enable !== 0 || !capture.opened) reason = 'source-unavailable';
  else if (dropped !== 0) reason = 'source-loss';
  else if (!capture.terminal) reason = 'terminal-missing';
  else if (capture.timed_out || capture.process !== 0) reason = 'consumer-incomplete';
  else if (cleanup !== 'complete') reason = 'cleanup-failed';
  return {
    status: 'unknown', reason, authority: 'none', source_profile: PROFILE, source_profile_sha256: sourceProfileSha256,
    source_status: { start: capture.start, enable: capture.enable, opened: capture.opened, process: capture.process, stop: capture.stop, close: capture.close, timed_out: capture.timed_out },
    observations: capture.events,
    continuity: { first_sequence: capture.events.length ? 1 : null, last_sequence: capture.events.length || null, event_count: capture.events.length, gaps: 0, dropped, terminal: capture.terminal, sequence_origin: 'adapter-callback', source_sequence_available: false, loss_counters: { events: capture.events_lost, log_buffers: capture.buffers_lost, realtime_buffers: capture.realtime_buffers_lost, consumer_buffers: capture.consumer_buffers_lost, adapter_overflow: capture.overflow } },
    cleanup,
  };
}

// Exactly one result frame may follow the optional ready frame; EOF alone is not closure.
export function decodeWindowsOutput(output, exitCode) {
  if (exitCode !== 0) return unknown('source-unavailable-or-child-failed');
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 262144) return unknown('output-limit');
  const lines = output.split('\n');
  const readySeen = lines[0] === '{"ready":true}';
  const valid = readySeen ? lines.length === 3 && lines[2] === '' : lines.length === 2 && lines[1] === '';
  if (!valid) return unknown('terminal-missing-or-extra-data');
  try { return evaluateWindowsCapture(JSON.parse(lines[readySeen ? 1 : 0])); } catch { return unknown('malformed'); }
}

// A fixed executable and fixed provider are used; callers cannot supply a source,
// executable, platform, authority, or a serialized session. The native helper has
// its own 30-second watchdog. A killed child leaves cleanup explicitly unknown.
export function openWindowsObservation() {
  let resolveReady, resolveResult;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const result = new Promise(resolve => { resolveResult = resolve; });
  if (process.platform !== 'win32') {
    resolveReady(false); resolveResult(unknown('unsupported-platform'));
    return Object.freeze({ ready, result, stop() {} });
  }
  let child, output = '', finished = false, readySeen = false, stopRequested = false;
  const finish = value => { if (finished) return; finished = true; clearTimeout(timer); resolveReady(false); resolveResult(value); };
  const timer = setTimeout(() => { child?.kill(); finish(unknown('child-timeout')); }, 45000);
  try {
    child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.on('error', () => finish(unknown('source-unavailable')));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > 262144) { child.kill(); finish(unknown('output-limit')); return; }
      if (!readySeen && output.startsWith('{"ready":true}\n')) { readySeen = true; resolveReady(true); }
    });
    child.on('close', code => {
      if (finished) return;
      finish(decodeWindowsOutput(output, code));
    });
  } catch { finish(unknown('source-unavailable')); }
  return Object.freeze({ ready, result, stop() { if (!stopRequested && !finished) { stopRequested = true; child?.stdin.end('x'); } } });
}
