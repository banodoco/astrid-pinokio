'use strict';

// Network and Start-client ownership for the venue observer. Only fixed labels
// and outcomes are retained; neither errors nor response contents are recorded.
function createObserverIO({ WebSocket, fetch, spawn, record, appRoot, ptermRoot, home, endpoint,
  connectMs = 15000, responseMs = 15000, resourceMs = 5000, runtimeMs = 5000,
  applicationMs = 10000, pollMs = 240000, cleanupMs = 2000 }) {
  const path = require('node:path');
  const sockets = new Set();
  const clients = new Set();
  const cancelled = new AbortController();
  const delay = ms => new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); cancelled.signal.removeEventListener('abort', done); resolve(); }
    cancelled.signal.addEventListener('abort', done, { once: true });
    if (cancelled.signal.aborted) done();
  });
  const note = (operation, category) => { if (operation) record({ operation, category, timestamp: new Date().toISOString() }); };
  const disposeSocket = socket => {
    sockets.delete(socket);
    // unws exposes the ws implementation on Node; terminate also closes a
    // connection that is still handshaking, unlike a graceful close handshake.
    try { socket.terminate(); } catch { try { socket.close(); } catch {} }
  };
  async function openSocket() {
    const socket = new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'r21-venue-observer' } });
    sockets.add(socket);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('engine websocket connection timeout')), connectMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('engine websocket connection failed')); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('engine websocket connection closed')); }, { once: true });
      });
      return socket;
    } catch (error) { disposeSocket(socket); throw error; }
  }
  async function status(localPath, operation) {
    note(operation, 'pending');
    let socket;
    try {
      socket = await openSocket();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('engine status timeout')), responseMs);
        socket.addEventListener('message', event => {
          clearTimeout(timer);
          let packet;
          try { packet = JSON.parse(String(event.data)); }
          catch { reject(new Error('engine status packet was not JSON')); return; }
          resolve(typeof packet.data === 'boolean' ? packet.data : 'unknown');
        }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('engine status error')); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('engine status closed')); }, { once: true });
        try { socket.send(JSON.stringify({ uri: localPath, status: true })); }
        catch { clearTimeout(timer); reject(new Error('engine status send failed')); }
      });
      note(operation, result === true ? 'success' : 'not-ready');
      return result;
    } catch (error) {
      note(operation, /timeout/i.test(error.message) ? 'timeout' : 'error');
      throw error;
    } finally { if (socket) disposeSocket(socket); }
  }
  async function waitForStatus(localPath, expected, label) {
    const deadline = Date.now() + pollMs;
    while (!cancelled.signal.aborted && Date.now() < deadline) {
      if (await status(localPath, 'start-status') === expected) return;
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    // Preserve the last operation and classify the polling deadline explicitly.
    note('start-status', 'timeout');
    throw new Error(`${label} did not reach explicit engine status ${expected} before timeout`);
  }
  async function request(operation, url, timeoutMs, check, options = {}) {
    note(operation, 'pending');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    cancelled.signal.addEventListener('abort', cancel, { once: true });
    if (cancelled.signal.aborted) cancel();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('request timeout')); }, timeoutMs);
      });
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
        if (controller.signal.aborted) reject(new Error('request aborted'));
      });
      const ready = await Promise.race([(async () => check(await fetch(url, { ...options, signal: controller.signal })))(), timeout, aborted]);
      note(operation, ready ? 'success' : 'not-ready');
      return ready;
    } catch (error) {
      note(operation, controller.signal.aborted ? 'timeout' : 'error');
      return false;
    } finally {
      clearTimeout(timer);
      cancelled.signal.removeEventListener('abort', cancel);
      controller.abort(); // release any unconsumed response body or connection
    }
  }
  const engineResourceReady = () => request('engine-resource', `http://127.0.0.1:42000/pinokio/resource/status?${new URLSearchParams({ ref: endpoint })}`, resourceMs, async response => {
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return Boolean(body && typeof body === 'object' && !Array.isArray(body) && typeof body.path === 'string' && body.path === appRoot
      && Array.isArray(body.running_scripts) && body.running_scripts.includes('pinokio/start.js'));
  });
  const runtimeReady = () => request('runtime', 'http://127.0.0.1:17340/api/runtime/v1/health', runtimeMs, async response => {
    const body = await response.json().catch(() => null);
    return response.status === 200 && body?.protocol === 'workspace.v1';
  });
  const applicationReady = () => request('application', 'https://astrid.haus/?connect=1', applicationMs, response => response.ok, { redirect: 'follow' });
  async function waitForReadiness() {
    const deadline = Date.now() + pollMs;
    while (!cancelled.signal.aborted && Date.now() < deadline) {
      if (await engineResourceReady() && await runtimeReady() && await applicationReady()) return;
      await delay(Math.min(1500, Math.max(0, deadline - Date.now())));
    }
    throw new Error('independent Runtime/application readiness timeout');
  }
  async function startOldLauncher() {
    const script = 'pinokio/start.js';
    note('start-client', 'pending');
    const child = spawn(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', script, '--ref', endpoint], {
      cwd: home, env: process.env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const entry = { child };
    clients.add(entry);
    entry.closed = new Promise(resolve => child.once('close', () => { clients.delete(entry); resolve(); }));
    const failure = new Promise(resolve => child.once('error', () => resolve(new Error('historical Start PTerm spawn failed'))));
    const phase = async promise => {
      const error = await Promise.race([promise.then(() => null), failure]);
      if (error) { note('start-client', 'error'); throw error; }
    };
    await phase(waitForStatus(path.join(appRoot, script), true, 'historical Start'));
    await phase(waitForReadiness());
    return child;
  }
  async function cleanup() {
    cancelled.abort();
    for (const socket of [...sockets]) disposeSocket(socket);
    await Promise.all([...clients].map(async entry => {
      const { child, closed } = entry;
      try { child.kill('SIGTERM'); } catch {}
      let timer;
      const wait = () => Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupMs); })]).finally(() => clearTimeout(timer));
      if (!await wait()) {
        try { child.kill('SIGKILL'); } catch {}
        if (!await wait()) child.unref();
      }
    }));
  }
  return { openSocket, disposeSocket, status, waitForStatus, engineResourceReady, runtimeReady, applicationReady, waitForReadiness, startOldLauncher, cleanup };
}
module.exports = { createObserverIO };
