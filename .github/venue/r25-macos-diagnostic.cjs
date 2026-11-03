'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RAW_LIMIT = 8192;
const EVENT_LIMIT = 64;
const EVENT_TYPES = new Set(['start', 'stream', 'result', 'error', 'stop', 'disconnect', 'installer-failure-marker']);
const TERMINAL_TEXT = /Terminated Shell/i;
const FAILURE_TEXT = /ASTRID_PINOKIO_FAILURE/;

function condaPresence(home, env = process.env, fsApi = fs) {
  const miniforgeRoot = path.join(home, 'bin', 'miniforge');
  const condaPath = path.join(miniforgeRoot, 'bin', 'conda');
  const pathEntries = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const inPath = pathEntries.some(entry => {
    try { return path.resolve(entry) === path.dirname(condaPath); } catch { return false; }
  });
  const exists = value => { try { return fsApi.statSync(value).isFile(); } catch { return false; } };
  const executable = value => { try { fsApi.accessSync(value, fsApi.constants.X_OK); return true; } catch { return false; } };
  return {
    schema: 'astrid.r25.macos-conda-presence.v1',
    miniforge_root_exists: (() => { try { return fsApi.statSync(miniforgeRoot).isDirectory(); } catch { return false; } })(),
    conda_path_exists: exists(condaPath),
    conda_executable: executable(condaPath),
    conda_directory_on_path: inPath,
  };
}

function writeCondaPresence(home, diagnosticsDir, env = process.env, fsApi = fs) {
  if (typeof diagnosticsDir !== 'string' || diagnosticsDir.length === 0) throw new TypeError('diagnosticsDir is required');
  const destination = path.join(diagnosticsDir, 'pre-shell-conda-presence.json');
  fsApi.mkdirSync(diagnosticsDir, { recursive: true });
  const value = { ...condaPresence(home, env, fsApi), observed_before: 'pinokio-setup-shell.run' };
  fsApi.writeFileSync(destination, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  return value;
}

// Diagnostic-only observer for the macOS setup action. Call probeWritten only
// after the probe is sent, onData for each raw PTerm onData payload, and
// promptResolved only when the expected prompt response is observed.
function createMacPtyDiagnostics({ probe, failFastMs = 90_000, rawLimit = RAW_LIMIT,
  eventLimit = EVENT_LIMIT, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onFailure = () => {} } = {}) {
  if (typeof probe !== 'string' || probe.length === 0) throw new TypeError('probe must be non-empty text');
  let raw = Buffer.alloc(0);
  let textTail = '';
  let rawBytesSeen = 0;
  let probeAt = null;
  let promptAt = null;
  let timer = null;
  let failure = null;
  const events = [];
  const state = { echo: 'pending', probe_written_at_ms: null, prompt_resolved_at_ms: null,
    terminal_wait: null, daemon_terminal_emitted: null };
  const fail = reason => {
    if (failure) return;
    failure = reason;
    state.fail_fast = reason;
    onFailure(reason);
  };
  function probeWritten() {
    if (probeAt !== null) throw new Error('probe already written');
    probeAt = now();
    state.probe_written_at_ms = probeAt;
    timer = setTimer(() => fail('probe-prompt-timeout'), failFastMs);
  }
  function promptResolved() {
    if (promptAt !== null) return;
    promptAt = now();
    state.prompt_resolved_at_ms = promptAt;
    state.echo = state.echo === 'observed' ? 'observed' : 'not-observed';
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function onData(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    rawBytesSeen += bytes.length;
    if (raw.length < rawLimit) raw = Buffer.concat([raw, bytes.subarray(0, rawLimit - raw.length)]);
    const text = textTail + bytes.toString('utf8');
    if (probeAt !== null && text.includes(probe)) state.echo = 'observed';
    textTail = text.slice(-128);
    return inspectText(text);
  }
  function inspectText(text) {
    if (FAILURE_TEXT.test(text)) fail('failure-marker');
    else if (TERMINAL_TEXT.test(text)) fail('terminated-shell');
    return failure;
  }
  function packet(packet) {
    const type = typeof packet?.type === 'string' && EVENT_TYPES.has(packet.type) ? packet.type : 'unknown';
    const event = { type, at_ms: now(), index: Number.isInteger(packet?.index) ? packet.index : null,
      method: packet?.rpc?.method === 'shell.run' ? 'shell.run' : null };
    if (events.length < eventLimit) events.push(event);
    if (type === 'error') fail('error-event');
    const rawData = packet?.data?.raw ?? packet?.data;
    if (typeof rawData === 'string') inspectText(rawData);
    return event;
  }
  function terminalWait(event) { state.terminal_wait = event; }
  function daemonTerminal(event, emitted) { state.daemon_terminal_emitted = { event, emitted: Boolean(emitted) }; }
  function snapshot() {
    return { schema: 'astrid.r25.macos-pty-diagnostics.v1', ...state,
      failure, raw_on_data: { encoding: 'base64', bytes_seen: rawBytesSeen, bytes_retained: raw.length,
        truncated: rawBytesSeen > raw.length, data: raw.toString('base64') }, events: [...events] };
  }
  return { probeWritten, promptResolved, onData, packet, terminalWait, daemonTerminal, snapshot,
    dispose() { if (timer !== null) clearTimer(timer); timer = null; } };
}

module.exports = { condaPresence, writeCondaPresence, createMacPtyDiagnostics, RAW_LIMIT, EVENT_LIMIT };
