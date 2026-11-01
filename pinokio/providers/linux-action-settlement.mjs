// Diagnostic producer for the R-20 Linux Reset socket protocol. It does not
// establish execution identity, source continuity, or an R-30 trusted export.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureProcess } from './linux-observations.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_EVENTS = 4096;
const MAX_FRAME = 1024 * 1024;

// This is a deliberately allowlisted projection, not a raw socket transcript:
// stream output, RPC arguments, shell state and arbitrary result fields may
// contain credentials. Preserve exact request bytes and the selected facts only.
function project(packet) {
  const result = {};
  for (const key of ['id', 'type', 'index', 'total']) {
    if (typeof packet[key] === 'string' || Number.isSafeInteger(packet[key])) result[key] = packet[key];
  }
  if (packet.type === 'event' && packet.data === 'stop') result.data = 'stop';
  if (packet.type === 'result' && packet.data && typeof packet.data === 'object') {
    result.data = {};
    for (const key of ['stopped', 'lockFree', 'reset', 'dataKept']) {
      if (typeof packet.data[key] === 'boolean') result.data[key] = packet.data[key];
    }
  }
  return result;
}

function checkpoint(record) {
  return { pid: record.pid, bootId: record.bootId, startTimeTicks: record.startTimeTicks,
    executablePath: record.executablePath, executableSha256: record.executableSha256,
    limitations: record.limitations };
}

/** Dispatch the actual request through the pinned daemon's WebSocket route.
 * WebSocket must implement the standard addEventListener/send/close interface.
 * Caller controls endpoint and must establish daemon/process identity externally.
 * The daemon subscribes this same socket before invoking process(req), but does
 * not acknowledge admission or provide a unique execution ID. Always unknown.
 */
export async function observeLinuxReset({ WebSocket, endpoint, uri, daemonPid, timeoutMs = 120000 }) {
  if (process.platform !== 'linux') throw new Error('Linux required');
  let address;
  try { address = new URL(endpoint); } catch {}
  if (typeof WebSocket !== 'function' || !address || address.protocol !== 'ws:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname) ||
      address.username || address.password || address.pathname !== '/' || address.search || address.hash ||
      typeof uri !== 'string' || !path.isAbsolute(uri) || path.normalize(uri) !== uri ||
      path.basename(uri) !== 'reset.js' || path.basename(path.dirname(uri)) !== 'pinokio' ||
      !Number.isSafeInteger(daemonPid) || daemonPid < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('invalid Reset observation parameters');
  }
  const records = [];
  const issues = new Set(['engine-execution-id-unavailable', 'subscription-and-source-continuity-unverified',
    'profile-and-provenance-unbound', 'installer-journal-and-readiness-unobserved']);
  const record = (kind, value) => records.push({ kind, collected_at: new Date().toISOString(), ...value });
  try { record('process-before', { process: checkpoint(await captureProcess(daemonPid)) }); }
  catch {
    // An absent daemon process must not trigger a mutating request.
    throw new Error('daemon process checkpoint unavailable; request not dispatched');
  }
  const request = JSON.stringify({ uri, source: 'pterm', client: { source: 'pterm' } });
  const requestBytes = Buffer.from(request);
  record('engine-request', { request_utf8: request, request_sha256: sha256(requestBytes), resource: uri,
    engine_request_id: null, engine_execution_id: null });

  let action, status;
  let terminalCount = 0, disconnectCount = 0, sawDisconnect = false, statusValue = null;
  let finishAction;
  const actionDone = new Promise(resolve => { finishAction = resolve; });
  let timer, observedBytes = 0;
  let actionActive = true, dispatchAllowed = true;
  try {
    action = new WebSocket(endpoint, { headers: { 'x-pinokio-client': 'pterm' } });
    const timed = new Promise(resolve => { timer = setTimeout(() => { dispatchAllowed = false; issues.add('action-timeout'); resolve(); }, timeoutMs); });
    action.addEventListener('open', () => {
      if (!actionActive || !dispatchAllowed) return;
      dispatchAllowed = false;
      try { action.send(request); record('dispatch', { sent: true }); }
      catch { issues.add('dispatch-failed'); finishAction(); }
    });
    action.addEventListener('error', () => { if (actionActive) { dispatchAllowed = false; issues.add('action-socket-error'); finishAction(); } });
    action.addEventListener('close', () => { if (actionActive) { dispatchAllowed = false; if (!sawDisconnect) issues.add('action-socket-closed-early'); finishAction(); } });
    action.addEventListener('message', event => {
      if (!actionActive) return;
      try {
        const bytes = Buffer.from(event.data);
        observedBytes += bytes.length;
        if (bytes.length > MAX_FRAME || observedBytes > 16 * 1024 * 1024 || records.length >= MAX_EVENTS - 8) throw new Error('limit');
        const packet = JSON.parse(bytes.toString('utf8'));
        if (!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.type !== 'string') throw new Error('packet');
        const selected = project(packet);
        if (selected.id !== undefined && selected.id !== uri) issues.add('foreign-resource');
        if (selected.id === undefined && (packet.type === 'result' || packet.type === 'event' || packet.type === 'disconnect')) issues.add('event-resource-unavailable');
        if (sawDisconnect) issues.add('event-after-disconnect');
        if (terminalCount && packet.type !== 'disconnect') issues.add('event-after-terminal');
        if (packet.type === 'event' && packet.data === 'stop') terminalCount++;
        if (packet.type === 'error') issues.add('engine-error-event');
        record('engine-event',
          { source: 'pinokiod-websocket', packet: selected, projection: 'r20-reset-allowlist', frame_sha256: sha256(bytes) });
        if (packet.type === 'disconnect') { disconnectCount++; sawDisconnect = true; finishAction(); }
      } catch { issues.add('invalid-or-overlimit-action-frame'); finishAction(); }
    });
    await Promise.race([actionDone, timed]);
    clearTimeout(timer);
    // Keep the action listener open during the separate, same-resource status
    // query; a disconnect packet alone is not a terminal success or a barrier.
    status = new WebSocket(endpoint, { headers: { 'x-pinokio-client': 'pterm' } });
    await new Promise(resolve => {
      let done = false;
      const end = () => { if (!done) { done = true; clearTimeout(deadline); resolve(); } };
      const deadline = setTimeout(() => { issues.add('status-timeout'); end(); }, Math.min(timeoutMs, 10000));
      status.addEventListener('open', () => {
        if (done) return;
        const statusRequest = JSON.stringify({ uri, status: true });
        record('idle-request', { request_utf8: statusRequest });
        try { status.send(statusRequest); } catch { issues.add('status-send-failed'); end(); }
      });
      status.addEventListener('message', event => {
        if (done) return;
        try {
          const bytes = Buffer.from(event.data);
          if (bytes.length > MAX_FRAME) throw new Error('limit');
          const packet = JSON.parse(bytes.toString('utf8'));
          if (!packet || typeof packet.data !== 'boolean') throw new Error('status');
          statusValue = packet.data;
          record('idle-observation', { running: packet.data, frame_sha256: sha256(bytes) });
        } catch { issues.add('invalid-status-response'); }
        end();
      });
      status.addEventListener('error', () => { issues.add('status-socket-error'); end(); });
      status.addEventListener('close', () => { if (!done) { issues.add('status-socket-closed-early'); end(); } });
    });
  } catch { issues.add('socket-setup-failed'); }
  finally { actionActive = false; dispatchAllowed = false; clearTimeout(timer); try { action?.close(); } catch {} try { status?.close(); } catch {} }
  if (terminalCount !== 1) issues.add(terminalCount ? 'duplicate-terminal' : 'terminal-unavailable');
  if (disconnectCount !== 1) issues.add(disconnectCount ? 'duplicate-disconnect' : 'disconnect-unavailable');
  if (statusValue !== false) issues.add('idle-not-observed');
  try {
    const after = checkpoint(await captureProcess(daemonPid));
    record('process-after', { process: after });
    const before = records.find(item => item.kind === 'process-before')?.process;
    if (!before || before.bootId !== after.bootId || before.startTimeTicks !== after.startTimeTicks || before.executableSha256 !== after.executableSha256) issues.add('daemon-incarnation-unverified');
  } catch { issues.add('daemon-process-after-unavailable'); }
  // IDs and hashes can be placed into the R-23 envelope by the protected
  // collector after profiles, binding and provenance are approved. These are
  // diagnostic payload bytes, not schema-valid qualification evidence.
  const payloads = records.map((item, index) => {
    const sequence = index + 1;
    // This number orders local captures only. The socket supplies no source
    // sequence and therefore cannot prove that events were not lost.
    const bytes = Buffer.from(JSON.stringify({ ...item, capture_sequence: sequence }) + '\n');
    return { id: `obs-${String(sequence).padStart(6, '0')}`, kind: item.kind,
      sequence, file: `settlement/${String(sequence).padStart(6, '0')}.json`, sha256: sha256(bytes), bytes };
  });
  return { state: 'unknown', issues: [...issues], payloads };
}
