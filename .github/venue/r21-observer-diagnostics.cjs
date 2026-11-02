'use strict';

// All retained fields are fixed labels, bounded numbers, booleans, or timestamps.
const TRACE_LIMIT = 20;
const operations = ['start-client', 'start-status', 'engine-resource', 'runtime', 'application', 'app-runtime'];
const categories = ['pending', 'success', 'not-ready', 'timeout', 'error'];
const errorClasses = ['TypeError', 'Error', 'AbortError', 'other'];
const errorCodes = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'other'];
const actionPhases = ['install', 'first_click', 'stop', 'retry', 'cleanup'];
const actionOperations = ['socket-connect', 'subscription', 'pterm', 'disconnect', 'engine-status'];
const actionLabels = Object.freeze({ 'historical install': 'install', 'first Update': 'first_click',
  'historical Stop': 'stop', 'fresh Update retry': 'retry', 'bounded cleanup Stop': 'cleanup' });
const actionPhase = label => Object.hasOwn(actionLabels, label) ? actionLabels[label] : null;
// A known failed Install must not consume the initial-install allowance.  These
// two bounds cover only PTerm settlement after we have sent it TERM/KILL; the
// outer runner still owns process-group cleanup as a last resort.
const FAST_FAILURE_TERM_GRACE_MS = 5000;
const FAST_FAILURE_SETTLE_MS = 2000;
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
function ptermExit(child, label, timeoutMs, diagnostic = null, failureSignal = null, options = {}) {
  const note = (event, value) => { try { diagnostic?.(event, value); } catch {} };
  const started = Date.now();
  const termGraceMs = Number.isSafeInteger(options.termGraceMs) && options.termGraceMs >= 0
    ? options.termGraceMs : FAST_FAILURE_TERM_GRACE_MS;
  const settleMs = Number.isSafeInteger(options.settleMs) && options.settleMs >= 0
    ? options.settleMs : FAST_FAILURE_SETTLE_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let failureTimer = null;
    let settleTimer = null;
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(failureTimer);
      clearTimeout(settleTimer);
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      clear();
      resolve(value);
    };
    const knownFailure = failure => {
      if (settled) return;
      // The text itself never reaches this helper.  Keep only the fixed source
      // label in diagnostics so an attacker cannot use a packet to inject data.
      note('known-failure', { source: failure?.source === 'launcher_failure_marker'
        ? 'launcher_failure_marker' : 'inner_nonzero_exit' });
      try { child.kill('SIGTERM'); } catch {}
      failureTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        note('known-failure-kill');
        settleTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), settleMs);
      }, termGraceMs);
    };
    const timer = setTimeout(() => {
      const fired = Date.now();
      child.kill('SIGTERM');
      settled = true;
      clearTimeout(failureTimer);
      clearTimeout(settleTimer);
      reject(new Error(`${label} PTerm timeout`));
      note('timer-fire', { at: fired });
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clear();
      reject(new Error(`${label} PTerm spawn failed`));
      note('spawn-error');
    });
    child.once('exit', (code, signal) => {
      note('child-exit', { code, signal });
      finish({ code, signal: signal || null });
    });
    note('timer-start', { started, deadline: started + timeoutMs });
    if (failureSignal && typeof failureSignal.then === 'function') failureSignal.then(knownFailure, () => {});
  });
}

// The pinned engine emits start.data.current/total/method, and stream/result
// index/total. Never retain packet content, arbitrary method names, or error text.
const INSTALL_TRACE_LIMIT = 40;
const installKinds = ['start', 'stream', 'result', 'error', 'installer-failure-marker', 'stop', 'disconnect'];
const installMethods = ['shell.run', 'local.set', 'script.start', 'input'];
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const boundedIndex = value => Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
// Only these fixed signatures may leave the listener. Scan a bounded prefix;
// unrecognized native errors remain explicit rather than copying their text.
const firstErrorCodes = ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EEXIST', 'ECONNREFUSED',
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
const firstErrorReasons = ['unknown', 'installer_failure_marker', 'command_not_found',
  'file_not_found', 'permission_denied'];
const shellResultClasses = ['empty', 'object', 'other'];
const FIRST_ERROR_SCAN_LIMIT = 8192;
const failureMarker = 'ASTRID_PINOKIO_FAILURE';
const FIRST_CAUSE_TEXT_LIMIT = 512;
const firstCauseSources = ['launcher_failure_marker', 'inner_nonzero_exit'];
const firstCauseSignals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'];
function redactFirstCauseText(value) {
  if (typeof value !== 'string') return null;
  // Action stream text is hostile input.  Keep a small human-readable window
  // but remove common credential, URL, filesystem, and opaque-token forms
  // before it is ever persisted.  The publisher repeats this projection.
  let text = value.slice(-FIRST_ERROR_SCAN_LIMIT)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\b(?:https?|file):\/\/[^\s'"<>]+/gi, '[redacted-url]')
    .replace(/\b(?:authorization|cookie|token|secret|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*([:=])\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:ghp|github_pat|glpat|sk)-?[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/(?:^|[\s'"=])\/(?:[^\s/'"]+\/)*[^\s'",;:]*/g, '$1[redacted-path]')
    .replace(/\b[A-Za-z0-9+/_=-]{33,}\b/g, '[redacted]')
    .replace(/\b(?:secret|credential|password|token)[A-Za-z0-9._-]*\b/gi, '[redacted]')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length > FIRST_CAUSE_TEXT_LIMIT) text = text.slice(-FIRST_CAUSE_TEXT_LIMIT);
  return text;
}
function projectFirstCause(value, child = {}) {
  if (!firstCauseSources.includes(value?.source)) return null;
  return {
    source: value.source,
    text: redactFirstCauseText(value.text),
    inner_exit: {
      code: Number.isInteger(child.code) && child.code >= 0 && child.code <= 255 ? child.code : null,
      signal: firstCauseSignals.includes(child.signal) ? child.signal : null,
    },
  };
}
function classifyError(data) {
  const object = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const directCode = typeof object?.code === 'string' && firstErrorCodes.includes(object.code) ? object.code : null;
  const message = typeof data === 'string' ? data : typeof object?.message === 'string' ? object.message : '';
  const sample = message.slice(0, FIRST_ERROR_SCAN_LIMIT);
  const code = directCode || firstErrorCodes.find(value => new RegExp(`\\b${value}\\b`).test(sample)) || 'unknown';
  const reason = /\bcommand not found\b/i.test(sample) ? 'command_not_found' :
    /\bno such file or directory\b/i.test(sample) ? 'file_not_found' :
      /\bpermission denied\b/i.test(sample) ? 'permission_denied' : 'unknown';
  return { reason, code };
}
function projectFirstError(value) {
  if (!timestamp(value?.timestamp) || !['engine_error', 'installer_failure_marker'].includes(value?.source)) return null;
  return { timestamp: timestamp(value.timestamp), source: value.source,
    index: boundedIndex(value.index), total: boundedIndex(value.total),
    method: installMethods.includes(value.method) ? value.method : null,
    reason: firstErrorReasons.includes(value.reason) ? value.reason : 'unknown',
    code: firstErrorCodes.includes(value.code) ? value.code : 'unknown' };
}
function projectInstallEvidence(raw, binding) {
  const timer = raw?.timer || {};
  const child = raw?.child || {};
  const projectEvent = item => !installKinds.includes(item?.kind) || !timestamp(item.timestamp) ? null :
    { timestamp: timestamp(item.timestamp), kind: item.kind,
      index: boundedIndex(item.index), total: boundedIndex(item.total),
      method: installMethods.includes(item.method) ? item.method : null };
  const selectEvent = (item, kinds) => kinds.includes(item?.kind) ? projectEvent(item) : null;
  const events = Array.isArray(raw?.events) ? raw.events.slice(-INSTALL_TRACE_LIMIT).map(projectEvent).filter(Boolean) : [];
  const shellResult = raw?.shell_result || {};
  return { schema: 1, binding, events, last_activity: projectEvent(raw?.last_activity),
    last_native_event: selectEvent(raw?.last_native_event, ['start', 'stream', 'result', 'error', 'installer-failure-marker']),
    last_start: selectEvent(raw?.last_start, ['start']),
    last_result: selectEvent(raw?.last_result, ['result']),
    last_error: selectEvent(raw?.last_error, ['error', 'installer-failure-marker']),
    first_error: projectFirstError(raw?.first_error),
    first_cause: projectFirstCause(raw?.first_cause, child),
    last_terminal: selectEvent(raw?.last_terminal, ['stop', 'disconnect']),
    shell_result: { observed: shellResult.observed === true,
      class: shellResultClasses.includes(shellResult.class) ? shellResult.class : null },
    timer: { started_at: timestamp(timer.started_at), deadline_at: timestamp(timer.deadline_at), fired_at: timestamp(timer.fired_at) },
    child: { spawn_error_at: timestamp(child.spawn_error_at), exited_at: timestamp(child.exited_at),
      code: Number.isInteger(child.code) && child.code >= 0 && child.code <= 255 ? child.code : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'].includes(child.signal) ? child.signal : null,
      signal_observed: typeof child.signal_observed === 'boolean' ? child.signal_observed : null } };
}
function createInstallDiagnostics(binding, save, now = () => Date.now()) {
  const state = { events: [], timer: {}, child: {} };
  let lastStreamWrite = -Infinity;
  // A prefix length, never stream text, bridges a marker split between packets.
  let markerPrefix = 0;
  let markerIndex = null;
  const iso = ms => new Date(ms).toISOString();
  const persist = () => { try { save(projectInstallEvidence(state, binding)); } catch {} };
  persist();
  return {
    packet(packet) {
      let markerSeen = false;
      if (packet?.type === 'stream' && typeof packet.data?.raw === 'string') {
        const index = boundedIndex(packet.index ?? packet.rpc?.current);
        if (index !== markerIndex) markerPrefix = 0;
        markerIndex = index;
        const raw = packet.data.raw;
        for (const char of raw.slice(0, FIRST_ERROR_SCAN_LIMIT)) {
          if (char === failureMarker[markerPrefix]) markerPrefix++;
          else markerPrefix = char === failureMarker[0] ? 1 : 0;
          if (markerPrefix === failureMarker.length) { markerSeen = true; markerPrefix = 0; break; }
        }
        if (raw.length > FIRST_ERROR_SCAN_LIMIT) markerPrefix = 0;
      } else { markerPrefix = 0; markerIndex = null; }
      const kind = packet?.type === 'event' && packet.data === 'stop' ? 'stop' :
        markerSeen ? 'installer-failure-marker' : packet?.type;
      if (!installKinds.includes(kind)) return;
      const ms = now();
      const rpc = packet.type === 'start' ? packet.data : packet.rpc;
      const item = { timestamp: iso(ms), kind, index: boundedIndex(packet.index ?? rpc?.current),
        total: boundedIndex(packet.total ?? rpc?.total), method: installMethods.includes(rpc?.method) ? rpc.method : null };
      if (!state.first_error && (kind === 'error' || kind === 'installer-failure-marker')) {
        state.first_error = projectFirstError({ ...item,
          source: kind === 'error' ? 'engine_error' : 'installer_failure_marker',
          ...(kind === 'error' ? classifyError(packet.data) : { reason: 'installer_failure_marker', code: 'unknown' }) });
      }
      // Consecutive stream samples represent the latest observed activity, so
      // keep step boundaries and errors instead of filling the ring with output.
      const previous = state.events.at(-1);
      if (kind === 'stream' && previous?.kind === 'stream'
          && state.events.at(-1)?.index === item.index) state.events.pop();
      state.last_activity = item;
      if (!['stop', 'disconnect'].includes(kind)) state.last_native_event = item;
      if (kind === 'start') state.last_start = item;
      if (kind === 'result') state.last_result = item;
      // The exact historical Install has four steps and step 2 is shell.run.
      // Retain only the result shape: the pinned engine returns an empty string
      // if the parent action is inactive and an object for a launched shell.
      // Neither shape proves that an inner installer subcommand succeeded.
      if (kind === 'result' && item.index === 2 && item.total === 4) {
        state.shell_result = { observed: true, class: packet.data === '' ? 'empty' :
          packet.data && typeof packet.data === 'object' && !Array.isArray(packet.data) ? 'object' : 'other' };
      }
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
      firstCause(value) {
        if (!state.first_cause) state.first_cause = projectFirstCause(value, state.child);
        persist();
      },
    pterm(event, value) {
      const at = iso(now());
      if (event === 'timer-start') { state.timer.started_at = iso(value.started); state.timer.deadline_at = iso(value.deadline); }
      if (event === 'timer-fire') state.timer.fired_at = iso(value.at);
      if (event === 'spawn-error') state.child.spawn_error_at = at;
      if (event === 'child-exit') { state.child.exited_at = at; state.child.code = value.code;
        state.child.signal = value.signal; state.child.signal_observed = value.signal !== null && value.signal !== undefined; }
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
module.exports = { TRACE_LIMIT, transportFailure, projectOperation, createTrace, actionPhase, projectActionFailure, createActionTracker, ptermExit, INSTALL_TRACE_LIMIT, projectInstallEvidence, createInstallDiagnostics };
