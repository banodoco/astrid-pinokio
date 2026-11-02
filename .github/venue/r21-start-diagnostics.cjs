'use strict';

// A deliberately small, request-bound projection for the first historical
// Start.  This file never serializes a command, path, packet, status body,
// process id, or exception.  It is diagnostic evidence only.
const net = require('node:net');

const RUNTIME_STATUS_TIMEOUT_MS = 15_000;
const PORT_LISTENER_TIMEOUT_MS = 2_000;
const statusClasses = ['pending', 'exit', 'timeout', 'spawn-error', 'unavailable'];
const boundedExit = value => Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
const bool = value => value === true ? true : value === false ? false : null;

function projectStartDiagnostics(raw, binding) {
  const statusClass = statusClasses.includes(raw?.runtime_status?.class) ? raw.runtime_status.class : 'pending';
  return {
    schema: 1,
    binding,
    installed_tuple_present: bool(raw?.installed_tuple_present),
    install_marker_observed: bool(raw?.install_marker_observed),
    start: {
      engine_error: bool(raw?.start?.engine_error),
      terminal_stop: bool(raw?.start?.terminal_stop),
      terminal_disconnect: bool(raw?.start?.terminal_disconnect),
    },
    runtime_status: { class: statusClass, code: statusClass === 'exit' ? boundedExit(raw?.runtime_status?.code) : null },
    port_17340_listener: bool(raw?.port_17340_listener),
  };
}

function createStartDiagnostics(binding, save) {
  const state = {
    installed_tuple_present: null,
    install_marker_observed: null,
    start: { engine_error: null, terminal_stop: null, terminal_disconnect: null },
    runtime_status: { class: 'pending', code: null },
    port_17340_listener: null,
  };
  const persist = () => { try { save(projectStartDiagnostics(state, binding)); } catch {} };
  persist();
  return {
    install({ installedTuplePresent, installMarkerObserved }) {
      state.installed_tuple_present = bool(installedTuplePresent);
      state.install_marker_observed = bool(installMarkerObserved);
      persist();
    },
    startListener() {
      state.start = { engine_error: false, terminal_stop: false, terminal_disconnect: false };
      persist();
    },
    startPacket(packet) {
      // A packet is meaningful only after an action subscription established
      // the false baseline.  Never turn an unavailable listener into a false
      // observation.
      if (state.start.engine_error === null) return;
      if (packet?.type === 'error') state.start.engine_error = true;
      if (packet?.type === 'event' && packet.data === 'stop') state.start.terminal_stop = true;
      if (packet?.type === 'disconnect') state.start.terminal_disconnect = true;
      persist();
    },
    runtimeStatus(outcome) {
      const statusClass = statusClasses.includes(outcome?.class) ? outcome.class : 'spawn-error';
      state.runtime_status = { class: statusClass, code: statusClass === 'exit' ? boundedExit(outcome?.code) : null };
      persist();
    },
    listener(present) { state.port_17340_listener = bool(present); persist(); },
    snapshot() { return projectStartDiagnostics(state, binding); },
  };
}

function requireInitialInstallForStart({ install, installedTuplePresent }) {
  if (install?.inner_exit?.code !== 0 || install?.terminal?.disconnect !== true || install?.terminal?.stop !== true) {
    throw new Error('historical installation did not settle');
  }
  if (installedTuplePresent !== true || install.installer_success !== true) {
    throw new Error('historical installation lacks the published tuple or installer success marker');
  }
}

// The supplied spec remains private.  This terminates only the observer's
// independent status child; it cannot alter the retained old launcher.
function runBoundedRuntimeStatus({ spawn, spec, timeoutMs = RUNTIME_STATUS_TIMEOUT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || typeof spec.cwd !== 'string') {
    return Promise.resolve({ class: 'unavailable', code: null });
  }
  return new Promise(resolve => {
    let child;
    let settled = false;
    let timer;
    let escalation;
    const finish = (outcome, keepEscalation = false) => {
      if (settled) return;
      settled = true;
      clearTimer(timer); if (!keepEscalation) clearTimer(escalation);
      resolve(outcome);
    };
    const signal = value => {
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, value);
        else child?.kill(value);
      } catch { try { child?.kill(value); } catch {} }
    };
    try {
      child = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: 'ignore', detached: process.platform !== 'win32' });
    } catch { finish({ class: 'spawn-error', code: null }); return; }
    if (!child || typeof child.once !== 'function') { finish({ class: 'spawn-error', code: null }); return; }
    timer = setTimer(() => {
      signal('SIGTERM');
      escalation = setTimer(() => signal('SIGKILL'), 2_000);
      finish({ class: 'timeout', code: null }, true);
    }, timeoutMs);
    child.once('error', () => finish({ class: 'spawn-error', code: null }));
    child.once('exit', code => {
      if (settled) { clearTimer(escalation); return; }
      finish({ class: 'exit', code: boundedExit(code) });
    });
  });
}

// A TCP accept is intentionally distinct from an HTTP health check.  It sends
// no application request and retains only a boolean result.
function probePort17340({ connect = net.createConnection, timeoutMs = PORT_LISTENER_TIMEOUT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise(resolve => {
    let socket;
    let settled = false;
    let timer;
    const finish = present => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      try { socket?.destroy(); } catch {}
      resolve(present);
    };
    try {
      socket = connect({ host: '127.0.0.1', port: 17340 });
      if (!socket || typeof socket.once !== 'function') { finish(false); return; }
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      timer = setTimer(() => finish(false), timeoutMs);
    } catch { finish(false); }
  });
}

module.exports = { RUNTIME_STATUS_TIMEOUT_MS, PORT_LISTENER_TIMEOUT_MS, projectStartDiagnostics,
  createStartDiagnostics, requireInitialInstallForStart, runBoundedRuntimeStatus, probePort17340 };
