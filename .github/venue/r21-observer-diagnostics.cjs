'use strict';

// All retained fields are fixed labels, bounded numbers, booleans, or timestamps.
const TRACE_LIMIT = 20;
const operations = ['start-client', 'start-status', 'engine-resource', 'runtime', 'application'];
const categories = ['pending', 'success', 'not-ready', 'timeout', 'error'];
const errorClasses = ['TypeError', 'Error', 'AbortError', 'other'];
const errorCodes = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'other'];
const actionPhases = ['install', 'first_click', 'stop', 'retry', 'cleanup'];
const actionOperations = ['socket-connect', 'subscription', 'pterm', 'disconnect', 'engine-status'];
const actionLabels = Object.freeze({ 'historical install': 'install', 'first Update': 'first_click',
  'historical Stop': 'stop', 'fresh Update retry': 'retry', 'bounded cleanup Stop': 'cleanup' });
const actionPhase = label => Object.hasOwn(actionLabels, label) ? actionLabels[label] : null;
function projectActionFailure(value) {
  if (!actionPhases.includes(value?.phase) || !actionOperations.includes(value?.operation)
      || !['timeout', 'error'].includes(value?.status)) return null;
  return { phase: value.phase, operation: value.operation, status: value.status };
}
function createActionTracker() {
  let failure = null;
  return {
    async run(phase, fn) {
      let operation = 'socket-connect';
      failure = null;
      try { return await fn(value => { operation = value; }); }
      catch (error) {
        failure = projectActionFailure({ phase, operation,
          status: /timeout/i.test(typeof error?.message === 'string' ? error.message : '') ? 'timeout' : 'error' });
        throw error;
      }
    },
    failure() { return failure; },
  };
}
function ptermExit(child, label, timeoutMs, diagnostic = null, { signal = null } = {}) {
  const note = (event, value) => { try { (typeof diagnostic === 'function' ? diagnostic : diagnostic?.pterm)?.(event, value); } catch {} };
  const beforeTimeout = value => { try { diagnostic?.beforeTimeout?.(value); } catch {} };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => settle(reject, new Error(`${label} installer failure marker`));
    timer = setTimeout(() => {
      const fired = Date.now();
      beforeTimeout({ at: fired, pid: child.pid });
      child.kill('SIGTERM');
      settle(reject, new Error(`${label} PTerm timeout`));
      note('timer-fire', { at: fired });
    }, timeoutMs);
    child.once('error', () => { settle(reject, new Error(`${label} PTerm spawn failed`)); note('spawn-error'); });
    child.once('exit', (code, childSignal) => { settle(resolve, { code, signal: childSignal || null }); note('child-exit', { code, signal: childSignal }); });
    child.once('close', (code, childSignal) => note('child-close', { code, signal: childSignal || null }));
    note('timer-start', { started, deadline: started + timeoutMs });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// The pinned engine emits start.data.current/total/method, and stream/result
// index/total. Never retain packet content, arbitrary method names, or errors.
const INSTALL_TRACE_LIMIT = 40;
const installKinds = ['start', 'stream', 'result', 'error', 'installer-failure-marker', 'stop', 'disconnect'];
const installMethods = ['shell.run', 'local.set', 'script.start', 'input'];
const installStages = ['daemon-spawn', 'daemon-ready', 'observer-open', 'observer-subscribe',
  'pterm-spawn', 'pterm-timer-start', 'pterm-timer-fire', 'pterm-exit', 'pterm-close',
  'process-snapshot-before-timeout', 'installer-output-before-timeout', 'process-snapshot-before-failure-marker',
  'installer-output-before-failure-marker', 'installer-output-capture', 'setup-complete', 'cleanup-start'];
const INSTALL_TEXT_LIMIT = 2048;
const INSTALL_STAGE_LIMIT = 40;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const boundedIndex = value => Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
const boundedPid = value => Number.isInteger(value) && value > 0 && value <= 10000000 ? value : null;
function redactDiagnosticText(value, limit = INSTALL_TEXT_LIMIT) {
  if (value === undefined || value === null) return null;
  let text = typeof value === 'string' ? value : (value instanceof Error ? value.message
    : typeof value?.message === 'string' ? value.message : typeof value?.error === 'string' ? value.error : '');
  if (!text) return null;
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:authorization|bearer|token|password|passwd|secret|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:--?(?:token|password|passwd|secret|api[-_ ]?key)|bearer)\s+)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?[REDACTED]');
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const suffix = '…[TRUNCATED]';
  return `${Buffer.from(text, 'utf8').subarray(0, Math.max(0, limit - Buffer.byteLength(suffix))).toString('utf8')}${suffix}`;
}
function projectInstallEvidence(raw, binding) {
  const timer = raw?.timer || {};
  const child = raw?.child || {};
  const projectEvent = item => !installKinds.includes(item?.kind) || !timestamp(item.timestamp) ? null :
    { timestamp: timestamp(item.timestamp), kind: item.kind,
      index: boundedIndex(item.index), total: boundedIndex(item.total),
      method: installMethods.includes(item.method) ? item.method : null,
      ...(redactDiagnosticText(item.text) ? { text: redactDiagnosticText(item.text) } : {}) };
  const selectEvent = (item, kinds) => kinds.includes(item?.kind) ? projectEvent(item) : null;
  const events = Array.isArray(raw?.events) ? raw.events.slice(-INSTALL_TRACE_LIMIT).map(projectEvent).filter(Boolean) : [];
  const stages = Array.isArray(raw?.stages) ? raw.stages.slice(-INSTALL_STAGE_LIMIT)
    .filter(item => installStages.includes(item?.stage) && timestamp(item?.timestamp))
    .map(item => ({ stage: item.stage, timestamp: item.timestamp })) : [];
  const preCleanup = raw?.pre_cleanup || {};
  return { schema: 1, binding, events, last_activity: projectEvent(raw?.last_activity),
    last_native_event: selectEvent(raw?.last_native_event, ['start', 'stream', 'result', 'error', 'installer-failure-marker']),
    last_start: selectEvent(raw?.last_start, ['start']),
    last_result: selectEvent(raw?.last_result, ['result']),
    last_error: selectEvent(raw?.last_error, ['error', 'installer-failure-marker']),
    last_terminal: selectEvent(raw?.last_terminal, ['stop', 'disconnect']),
    stages,
    pre_cleanup: {
      timestamp: timestamp(preCleanup.timestamp),
      pterm_pid: boundedPid(preCleanup.pterm_pid),
      process_snapshot: ['captured', 'unavailable'].includes(preCleanup.process_snapshot) ? preCleanup.process_snapshot : null,
      installer_output: ['captured', 'unavailable'].includes(preCleanup.installer_output) ? preCleanup.installer_output : null,
    },
    timer: { started_at: timestamp(timer.started_at), deadline_at: timestamp(timer.deadline_at), fired_at: timestamp(timer.fired_at) },
    child: { spawn_error_at: timestamp(child.spawn_error_at), exited_at: timestamp(child.exited_at),
      code: Number.isInteger(child.code) && child.code >= 0 && child.code <= 255 ? child.code : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'].includes(child.signal) ? child.signal : null,
      signal_observed: typeof child.signal_observed === 'boolean' ? child.signal_observed : null,
      close_at: timestamp(child.close_at),
      close_code: Number.isInteger(child.close_code) && child.close_code >= 0 && child.close_code <= 255 ? child.close_code : null,
      close_signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'].includes(child.close_signal) ? child.close_signal : null,
      close_observed: typeof child.close_observed === 'boolean' ? child.close_observed : null } };
}
function createInstallDiagnostics(binding, save, now = () => Date.now()) {
  const state = { events: [], stages: [], timer: {}, child: {}, pre_cleanup: {} };
  let lastStreamWrite = -Infinity;
  // Only a transient suffix is used to recognize a marker split across packets.
  // It is never included in the retained projection.
  const failureMarker = 'ASTRID_PINOKIO_FAILURE';
  let streamTail = '';
  const iso = ms => new Date(ms).toISOString();
  const persist = () => { try { save(projectInstallEvidence(state, binding)); } catch {} };
  persist();
  return {
    packet(packet) {
      const raw = packet?.type === 'stream' && typeof packet.data?.raw === 'string' ? packet.data.raw : '';
      const marker = packet?.type === 'stream' && (streamTail + raw).includes(failureMarker);
      streamTail = packet?.type === 'stream' ? (streamTail + raw).slice(-(failureMarker.length - 1)) : '';
      const kind = packet?.type === 'event' && packet.data === 'stop' ? 'stop' :
        marker ? 'installer-failure-marker' : packet?.type;
      if (!installKinds.includes(kind)) return;
      const ms = now();
      const rpc = packet.type === 'start' ? packet.data : packet.rpc;
      const text = packet.type === 'stream' ? raw : packet.type === 'error' ? redactDiagnosticText(packet.data) : null;
      const item = { timestamp: iso(ms), kind, index: boundedIndex(packet.index ?? rpc?.current),
        total: boundedIndex(packet.total ?? rpc?.total), method: installMethods.includes(rpc?.method) ? rpc.method : null,
        ...(text ? { text: redactDiagnosticText(text) } : {}) };
      // Consecutive stream samples represent the latest observed activity, so
      // keep step boundaries and errors instead of filling the ring with output.
      const previous = state.events.at(-1);
      if (kind === 'stream' && previous?.kind === 'stream'
          && state.events.at(-1)?.index === item.index) state.events.pop();
      state.last_activity = item;
      if (!['stop', 'disconnect'].includes(kind)) state.last_native_event = item;
      if (kind === 'start') state.last_start = item;
      if (kind === 'result') state.last_result = item;
      if (kind === 'error' || kind === 'installer-failure-marker') state.last_error = item;
      if (kind === 'stop' || kind === 'disconnect') state.last_terminal = item;
      state.events.push(item);
      if (state.events.length > INSTALL_TRACE_LIMIT) state.events.shift();
      // Update the in-memory last event for every packet. Persist immediately
      // when the step changes; later timer or terminal writes flush samples.
      if (kind === 'stream' && ms - lastStreamWrite < 1000
          && previous?.kind === 'stream' && previous?.index === item.index) return;
      if (kind === 'stream') lastStreamWrite = ms;
      persist();
    },
    pterm(event, value) {
      const at = iso(now());
      if (event === 'timer-start') { state.timer.started_at = iso(value.started); state.timer.deadline_at = iso(value.deadline); }
      if (event === 'timer-fire') state.timer.fired_at = iso(value.at);
      if (event === 'spawn-error') state.child.spawn_error_at = at;
      if (event === 'child-exit') { state.child.exited_at = at; state.child.code = value.code;
        state.child.signal = value.signal; state.child.signal_observed = value.signal !== null && value.signal !== undefined; }
      if (event === 'child-close') { state.child.close_at = at; state.child.close_code = value.code;
        state.child.close_signal = value.signal; state.child.close_observed = true; }
      const stage = { 'timer-start': 'pterm-timer-start', 'timer-fire': 'pterm-timer-fire',
        'child-exit': 'pterm-exit', 'child-close': 'pterm-close' }[event];
      if (stage) { state.stages.push({ stage, timestamp: at }); if (state.stages.length > INSTALL_STAGE_LIMIT) state.stages.shift(); }
      persist();
    },
    stage(name, at = now()) {
      if (!installStages.includes(name)) return;
      state.stages.push({ stage: name, timestamp: iso(at) });
      if (state.stages.length > INSTALL_STAGE_LIMIT) state.stages.shift();
      persist();
    },
    beforeTimeout(value = {}) {
      state.pre_cleanup = { timestamp: iso(value.at || now()), pterm_pid: value.pid,
        process_snapshot: value.process_snapshot, installer_output: value.installer_output };
      persist();
    },
  };
}

function transportFailure(error) {
  const name = error?.name;
  const code = error?.cause?.code ?? error?.code;
  return { kind: 'transport', error_class: errorClasses.includes(name) ? name : 'other',
    error_code: errorCodes.includes(code) ? code : 'other' };
}
function projectOperation(value) {
  const timestamp = value?.timestamp;
  if (!operations.includes(value?.operation) || !categories.includes(value?.category)
      || typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      || Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) return null;
  const result = { operation: value.operation, category: value.category, timestamp };
  const detail = value.runtime;
  if (value.operation === 'runtime' && detail?.kind === 'transport'
      && errorClasses.includes(detail.error_class) && errorCodes.includes(detail.error_code)) {
    result.runtime = { kind: 'transport', error_class: detail.error_class, error_code: detail.error_code };
  } else if (value.operation === 'runtime' && detail?.kind === 'http'
      && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599
      && (typeof detail.protocol_match === 'boolean' || detail.protocol_match === null)) {
    result.runtime = { kind: 'http', status: detail.status, protocol_match: detail.protocol_match };
  }
  return result;
}
function createTrace() {
  const entries = [];
  return {
    record(value) { const item = projectOperation(value); if (item) { entries.push(item); if (entries.length > TRACE_LIMIT) entries.shift(); } },
    snapshot() { return entries.slice(); },
  };
}
module.exports = { TRACE_LIMIT, transportFailure, projectOperation, createTrace, actionPhase, projectActionFailure, createActionTracker, ptermExit,
  INSTALL_TRACE_LIMIT, INSTALL_TEXT_LIMIT, redactDiagnosticText, projectInstallEvidence, createInstallDiagnostics };
