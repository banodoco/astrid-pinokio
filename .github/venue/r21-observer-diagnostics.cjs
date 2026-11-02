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
function ptermExit(child, label, timeoutMs, diagnostic = null) {
  const note = (event, value) => { try { diagnostic?.(event, value); } catch {} };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const fired = Date.now();
      child.kill('SIGTERM');
      reject(new Error(`${label} PTerm timeout`));
      note('timer-fire', { at: fired });
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${label} PTerm spawn failed`)); note('spawn-error'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal: signal || null }); note('child-exit', { code, signal }); });
    note('timer-start', { started, deadline: started + timeoutMs });
  });
}

// The pinned engine emits start.data.current/total/method, and stream/result
// index/total. Never retain packet content, arbitrary method names, or errors.
const INSTALL_TRACE_LIMIT = 40;
const installKinds = ['start', 'stream', 'result', 'error', 'installer-failure-marker', 'stop', 'disconnect'];
const installMethods = ['shell.run', 'local.set', 'script.start', 'input'];
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const boundedIndex = value => Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
function projectInstallEvidence(raw, binding) {
  const timer = raw?.timer || {};
  const child = raw?.child || {};
  const projectEvent = item => !installKinds.includes(item?.kind) || !timestamp(item.timestamp) ? null :
    { timestamp: timestamp(item.timestamp), kind: item.kind,
      index: boundedIndex(item.index), total: boundedIndex(item.total),
      method: installMethods.includes(item.method) ? item.method : null };
  const events = Array.isArray(raw?.events) ? raw.events.slice(-INSTALL_TRACE_LIMIT).map(projectEvent).filter(Boolean) : [];
  return { schema: 1, binding, events, last_activity: projectEvent(raw?.last_activity),
    last_error: projectEvent(raw?.last_error), last_terminal: projectEvent(raw?.last_terminal),
    timer: { started_at: timestamp(timer.started_at), deadline_at: timestamp(timer.deadline_at), fired_at: timestamp(timer.fired_at) },
    child: { spawn_error_at: timestamp(child.spawn_error_at), exited_at: timestamp(child.exited_at),
      code: Number.isInteger(child.code) && child.code >= 0 && child.code <= 255 ? child.code : null,
      signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'].includes(child.signal) ? child.signal : null,
      signal_observed: typeof child.signal_observed === 'boolean' ? child.signal_observed : null } };
}
function createInstallDiagnostics(binding, save, now = () => Date.now()) {
  const state = { events: [], timer: {}, child: {} };
  let lastStreamWrite = -Infinity;
  const iso = ms => new Date(ms).toISOString();
  const persist = () => { try { save(projectInstallEvidence(state, binding)); } catch {} };
  persist();
  return {
    packet(packet) {
      const kind = packet?.type === 'event' && packet.data === 'stop' ? 'stop' :
        packet?.type === 'stream' && typeof packet.data?.raw === 'string' && packet.data.raw.includes('ASTRID_PINOKIO_FAILURE')
          ? 'installer-failure-marker' : packet?.type;
      if (!installKinds.includes(kind)) return;
      const ms = now();
      if (kind === 'stream' && ms - lastStreamWrite < 1000) return;
      if (kind === 'stream') lastStreamWrite = ms;
      const rpc = packet.type === 'start' ? packet.data : packet.rpc;
      const item = { timestamp: iso(ms), kind, index: packet.index ?? rpc?.current,
        total: packet.total ?? rpc?.total, method: rpc?.method };
      // Consecutive stream samples represent the latest observed activity, so
      // keep step boundaries and errors instead of filling the ring with output.
      if (kind === 'stream' && state.events.at(-1)?.kind === 'stream'
          && state.events.at(-1)?.index === item.index) state.events.pop();
      state.last_activity = item;
      if (kind === 'error' || kind === 'installer-failure-marker') state.last_error = item;
      if (kind === 'stop' || kind === 'disconnect') state.last_terminal = item;
      state.events.push(item);
      if (state.events.length > INSTALL_TRACE_LIMIT) state.events.shift();
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
