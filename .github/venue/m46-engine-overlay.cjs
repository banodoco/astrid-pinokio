'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PINOKIOD_REF = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const API_RELATIVE = 'kernel/api/index.js';
const API_SHA256 = 'acdd39ce8c058d42e7555b029c8798aa3173062e33c3249773a25b239dfc58a7';
const MAX_CAPTURE_ROWS = 128;
const MAX_CAPTURE_BYTES = 65536;
const UNSETTLED = Object.freeze({ accepted: null, queued: null, terminal_status: 'unknown', inner_exit: null, readback_sha256: null });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('value is outside the closed JSON binding');
}

function digestJson(value) {
  try { return sha256(Buffer.from(stableJson(value), 'utf8')); } catch { return null; }
}

function requestBinding(request, actionKey, input, steps) {
  const requestId = typeof request?.id === 'string' && request.id.length <= 256 ? request.id : null;
  const requestPath = typeof request?.path === 'string' ? request.path : null;
  return Object.freeze({
    request_id: requestId,
    request_path_sha256: requestPath === null ? null : sha256(Buffer.from(requestPath, 'utf8')),
    action: typeof actionKey === 'string' && actionKey.length <= 64 ? actionKey : null,
    input_sha256: digestJson(input),
    graph_sha256: digestJson(steps),
    graph_count: Array.isArray(steps) ? steps.length : null,
    mode: null,
    app_mapping: null,
  });
}

function correlateStep(binding, stepIndex, totalSteps, rpc) {
  return Object.freeze({
    request_id: binding?.request_id ?? null,
    request_path_sha256: binding?.request_path_sha256 ?? null,
    request_binding_sha256: binding ? digestJson(binding) : null,
    action: binding?.action ?? null,
    graph_sha256: binding?.graph_sha256 ?? null,
    graph_count: binding?.graph_count ?? null,
    step_index: Number.isInteger(stepIndex) && stepIndex >= 0 ? stepIndex : null,
    total_steps: Number.isInteger(totalSteps) && totalSteps >= 0 ? totalSteps : null,
    rpc_method: typeof rpc?.method === 'string' ? rpc.method.slice(0, 128) : null,
    rpc_sha256: digestJson(rpc),
    mode: null,
    app_mapping: null,
  });
}

function refuseSettlement() {
  return { ...UNSETTLED, refusal: 'protected collector, installed-app mapping, and actual child exit evidence unavailable' };
}

function patchSource(source, { expectedSha256 = API_SHA256 } = {}) {
  const input = Buffer.from(source, 'utf8');
  const actualSha256 = sha256(input);
  if (actualSha256 !== expectedSha256) throw new Error('pinokiod API source hash differs; refusing engine overlay');

  const anchors = [
    ['api-helper-anchor', 'const escapeHtml = (value) => String(value || "")\n'],
    ['resolved-graph-anchor', '            if (!Array.isArray(steps) || steps.length === 0) {\n'],
    ['rpc-dispatch-anchor', '            result = this.logSessions\n              ? await this.logSessions.withRunContext(request, runEndpoint)\n              : await runEndpoint()\n'],
  ];
  for (const [name, needle] of anchors) {
    const count = source.split(needle).length - 1;
    if (count !== 1) throw new Error(`pinokiod API anchor ${name} is not unique; refusing engine overlay`);
  }

  const helper = String.raw`// M46 venue-only request/step readback. Rows are local, bounded and unprotected.
const __m46Crypto = require('crypto')
const __m46Bindings = new Map()
function __m46Json(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(__m46Json).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + __m46Json(value[key])).join(',') + '}'
  throw new TypeError('outside closed JSON')
}
function __m46Digest(value) {
  try { return __m46Crypto.createHash('sha256').update(__m46Json(value)).digest('hex') } catch { return null }
}
function __m46Key(request) { return typeof request?.id === 'string' && request.id ? request.id : (typeof request?.path === 'string' ? request.path : null) }
function __m46Emit(kind, fields) {
  const file = process.env.ASTRID_M46_ENGINE_CAPTURE_FILE
  if (!file || !['action-resolved', 'rpc-dispatch', 'rpc-return'].includes(kind)) return
  const row = { schema: 'astrid.pinokio.engine-observation.v1', kind, observed_at: new Date().toISOString(), ...fields }
  try {
    const exists = require('fs').existsSync(file)
    const priorStat = exists ? require('fs').statSync(file) : null
    const previous = priorStat && priorStat.size <= 65536 ? require('fs').readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-127) : []
    const line = JSON.stringify(row)
    if (Buffer.byteLength(line, 'utf8') > 4096) return
    const rows = [...previous, line]
    while (rows.length > 128 || Buffer.byteLength(rows.join('\n') + '\n', 'utf8') > 65536) rows.shift()
    require('fs').mkdirSync(require('path').dirname(file), { recursive: true })
    require('fs').writeFileSync(file, rows.join('\n') + '\n', { mode: 0o600 })
  } catch {}
}
function __m46Bind(request, action, input, steps) {
  const id = __m46Key(request)
  const binding = { request_id: typeof request?.id === 'string' && request.id.length <= 256 ? request.id : null,
    request_path_sha256: typeof request?.path === 'string' ? __m46Crypto.createHash('sha256').update(request.path).digest('hex') : null,
    action: typeof action === 'string' && action.length <= 64 ? action : null,
    input_sha256: __m46Digest(input), graph_sha256: __m46Digest(steps), graph_count: Array.isArray(steps) ? steps.length : null,
    mode: null, app_mapping: null }
  if (id) __m46Bindings.set(id, binding)
  while (__m46Bindings.size > 128) __m46Bindings.delete(__m46Bindings.keys().next().value)
  __m46Emit('action-resolved', binding)
}
function __m46Step(request, index, total, rpc) {
  const binding = __m46Bindings.get(__m46Key(request)) || null
  const fields = { request_id: binding?.request_id ?? null, request_path_sha256: binding?.request_path_sha256 ?? null,
    request_binding_sha256: binding ? __m46Digest(binding) : null, action: binding?.action ?? null,
    graph_sha256: binding?.graph_sha256 ?? null, graph_count: binding?.graph_count ?? null,
    step_index: Number.isInteger(index) && index >= 0 ? index : null, total_steps: Number.isInteger(total) && total >= 0 ? total : null,
    rpc_method: typeof rpc?.method === 'string' ? rpc.method.slice(0, 128) : null, rpc_sha256: __m46Digest(rpc),
    mode: null, app_mapping: null }
  __m46Emit('rpc-dispatch', fields)
  return fields
}
function __m46Forget(request) { const id = __m46Key(request); if (id) __m46Bindings.delete(id) }

`;
  let patched = source.replace(anchors[0][1], `${helper}${anchors[0][1]}`);
  patched = patched.replace(anchors[1][1], `            __m46Bind(request, actionKey, initialPayload, steps)\n${anchors[1][1]}`);
  patched = patched.replace(anchors[2][1], `            const __m46StepFields = __m46Step(request, i, total, rpc)\n${anchors[2][1]}            __m46Emit('rpc-return', __m46StepFields)\n`);
  return { sourceSha256: actualSha256, patchedSha256: sha256(Buffer.from(patched, 'utf8')), replacements: anchors.map(([name]) => name), source: patched };
}

function applyPinokiodEngineOverlay(pinokiodRoot, { verifyGit = true } = {}) {
  if (typeof pinokiodRoot !== 'string' || !pinokiodRoot) throw new Error('pinokiod root is required');
  if (verifyGit) {
    let head;
    try { head = execFileSync('git', ['-C', pinokiodRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch { throw new Error('pinokiod checkout identity unavailable; refusing engine overlay'); }
    if (head !== PINOKIOD_REF) throw new Error('pinokiod checkout is not the exact pinned ref; refusing engine overlay');
  }
  const file = path.join(pinokiodRoot, API_RELATIVE);
  const result = patchSource(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, result.source, { encoding: 'utf8', flag: 'w' });
  if (sha256(fs.readFileSync(file)) !== result.patchedSha256) throw new Error('pinokiod engine overlay verification failed');
  return { enabled: true, pinokiod_ref: PINOKIOD_REF, source_sha256: result.sourceSha256, patched_sha256: result.patchedSha256, replacements: result.replacements, capture_is_protected: false, settlement: refuseSettlement() };
}

module.exports = { API_RELATIVE, API_SHA256, MAX_CAPTURE_BYTES, MAX_CAPTURE_ROWS, PINOKIOD_REF, applyPinokiodEngineOverlay, correlateStep, digestJson, patchSource, refuseSettlement, requestBinding, sha256, stableJson };
