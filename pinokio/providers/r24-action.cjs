'use strict';
// Protocol derived from .github/venue/observe.cjs. No packet payload is retained.
const { spawn } = require('node:child_process');

function observe({ connect, launch, uri, timeoutMs = 120000, delayMs = 3000 }) {
  return new Promise((resolve) => {
    let socket, child, timer, delay, finished = false, dispatched = false;
    let exit = null, signal = null, disconnects = 0, errors = 0, messages = 0, postTerminal = false, opened = false;
    const end = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(delay);
      if (socket) { try { socket.close(); } catch (_) {} }
      // Killing the client cannot establish remote cancellation or a fence.
      if (child && exit === null && signal === null) { try { child.kill(); } catch (_) {} }
      resolve({ dispatched, client_exit: exit, client_signal: signal, messages, disconnects,
        errors, post_terminal: postTerminal, end: reason, settlement: 'unknown' });
    };
    timer = setTimeout(() => end('timeout'), timeoutMs);
    try {
      socket = connect();
      socket.addEventListener('open', () => {
        if (opened || finished) { end('duplicate-open'); return; }
        opened = true;
        try { socket.send(JSON.stringify({ uri, mode: 'listen' })); }
        catch (_) { end('subscription-error'); return; }
        // The protocol has no subscription acknowledgement; this is not readiness proof.
        delay = setTimeout(() => {
          try {
            child = launch(); dispatched = true;
            child.on('error', () => end('client-error'));
            child.on('exit', (code, sig) => { exit = code; signal = sig; });
          } catch (_) { end('client-error'); }
        }, delayMs);
      });
      socket.addEventListener('message', event => {
        let packet;
        try { packet = JSON.parse(String(event.data)); } catch (_) { errors++; end('malformed-event'); return; }
        if (!packet || typeof packet !== 'object' || typeof packet.type !== 'string') { errors++; end('malformed-event'); return; }
        messages++;
        if (disconnects) postTerminal = true;
        if (packet.type === 'error') errors++;
        if (packet.type === 'disconnect') {
          disconnects++;
          if (!dispatched) end('premature-disconnect');
        }
        if (packet.type === 'error') end('daemon-error');
        // A disconnect has no authenticated request/task ID. Keep listening to
        // the deadline, so duplicate or post-disconnect messages remain visible.
      });
      socket.addEventListener('error', () => end('socket-error'));
      socket.addEventListener('close', () => end('socket-closed'));
    } catch (_) { end('socket-error'); }
  });
}

function launchStop(spawnFn, node, pterm) {
  const path = require('node:path');
  return spawnFn(node, [path.join(pterm, 'index.js'), 'start', 'pinokio/stop.js', '--ref', 'pinokio://127.0.0.1:42000/api/astrid'], { stdio: 'ignore' });
}

async function main() {
  const path = require('node:path');
  const pterm = process.argv[2], uri = process.argv[3];
  const { WebSocket } = require(path.join(pterm, 'node_modules/unws/src/node.cjs'));
  const result = await observe({
    uri,
    connect: () => new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'pterm' } }),
    launch: () => launchStop(spawn, process.execPath, pterm)
  });
  process.stdout.write(JSON.stringify(result));
}
if (require.main === module) main().catch(() => { process.stderr.write('action observer unavailable\n'); process.exitCode = 1; });
module.exports = { observe, launchStop };
