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
function ptermExit(child, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label} PTerm timeout`));
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${label} PTerm spawn failed`)); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal: signal || null }); });
  });
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
module.exports = { TRACE_LIMIT, transportFailure, projectOperation, createTrace, actionPhase, projectActionFailure, createActionTracker, ptermExit };
