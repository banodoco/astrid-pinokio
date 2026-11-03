'use strict';

const fs = require('node:fs');
const PROBE_MS = 90_000;
const CAPTURE_BYTES = 131072;
const MARKERS = ['ASTRID_PINOKIO_FAILURE', 'Terminated Shell'];

// A diagnostic observer, never an acceptance predicate. Qualification callers
// do not construct it. Read the complete bounded sidecar: its writer rewrites
// a ring, so append offsets would silently lose later prompt observations.
function createDiagnosticSettlement({ captureFile, record = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, setPoll = setInterval, clearPoll = clearInterval } = {}) {
  const abort = new AbortController();
  const state = { schema: 'astrid.r25.diagnostic-settlement.v1',
    observer_awaits: 'child.exit', pterm_awaits: ['packet.type=stop', 'packet.type=disconnect'],
    emitted: { stop: 0, disconnect: 0, event_stop: 0, event_disconnect: 0, error: 0 },
    probes: [], failure: null };
  let timer = null;
  let interval = null;
  let stopped = false;
  let tail = '';
  const probes = new Map();
  const persist = () => { try { record(snapshot()); } catch {} };
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  function fail(reason, prompt = null) {
    if (stopped || state.failure) return;
    state.failure = { reason, at: new Date(now()).toISOString(), prompt_ordinal: prompt,
      native_exit: null, diagnostic_refusal: true };
    clearTimer(timer);
    timer = null;
    persist();
    abort.abort(new Error(`R-25 diagnostic ${reason}`));
  }
  function schedule() {
    clearTimer(timer);
    timer = null;
    const pending = [...probes.values()].filter(probe => !probe.resolved);
    if (!pending.length || stopped || state.failure) return;
    const first = pending.sort((a, b) => a.deadline - b.deadline)[0];
    timer = setTimer(() => fail('probe-unanswered-90s', first.ordinal), Math.max(0, first.deadline - now()));
  }
  function scan() {
    if (stopped || state.failure || !captureFile) return;
    let data;
    try {
      const fd = fs.openSync(captureFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size > CAPTURE_BYTES) return fail('capture-overflow');
        const buffer = Buffer.alloc(CAPTURE_BYTES + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length > CAPTURE_BYTES) return fail('capture-overflow');
        data = buffer.subarray(0, length).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') fail('capture-read-error'); return; }
    let rows;
    try {
      const capture = JSON.parse(data);
      if (!Array.isArray(capture.prompt_probes) || capture.prompt_probes.length > 32) throw new Error('not a probe journal');
      rows = capture.prompt_probes.flatMap(probe => [
        ...(probe.written_at ? [{kind: 'prompt-probe-write-return', prompt_ordinal: probe.prompt_ordinal, at: probe.written_at}] : []),
        ...(probe.resolved_at ? [{kind: 'prompt-recognized', prompt_ordinal: probe.prompt_ordinal, at: probe.resolved_at}] : []),
      ]);
    } catch { rows = data.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
    for (const row of rows) {
      const ordinal = row.prompt_ordinal;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 10000) continue;
      if (['prompt-probe-write', 'prompt-probe-write-return'].includes(row.kind) && !probes.has(ordinal)) {
        const stamp = Date.parse(row.at);
        if (!Number.isFinite(stamp)) continue;
        if (probes.size >= 32) return fail('probe-limit');
        probes.set(ordinal, { ordinal, at: row.at, deadline: Math.min(stamp, now()) + PROBE_MS, resolved: false });
      }
      if (row.kind === 'prompt-recognized' || (row.kind === 'prompt-processing' && row.done === true)) {
        const probe = probes.get(ordinal);
        if (probe) probe.resolved = true;
      }
    }
    state.probes = [...probes.values()];
    schedule();
    persist();
  }
  return {
    signal: abort.signal,
    start() { if (!interval && !stopped) { scan(); interval = setPoll(scan, 100); } },
    scan,
    packet(packet) {
      if (stopped || state.failure) return;
      const type = packet?.type;
      if (type === 'stop' || type === 'disconnect' || type === 'error') state.emitted[type] += 1;
      if (type === 'event' && (packet.data === 'stop' || packet.data === 'disconnect')) state.emitted['event_' + packet.data] += 1;
      if (type === 'error' || type === 'installer-failure-marker') return fail(type === 'error' ? 'error-event' : 'failure-marker');
      const raw = type === 'stream' && typeof packet.data?.raw === 'string' ? packet.data.raw : '';
      if (type === 'stream') {
        const combined = tail + raw;
        tail = combined.slice(-64);
        if (MARKERS.some(marker => combined.includes(marker))) return fail(combined.includes(MARKERS[0]) ? 'failure-marker' : 'terminated-shell');
      }
      persist();
    },
    stop() { stopped = true; clearTimer(timer); clearPoll(interval); timer = null; interval = null; persist(); },
    snapshot,
  };
}

module.exports = { PROBE_MS, createDiagnosticSettlement };
