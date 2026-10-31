'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require(path.join(process.env.RUNNER_TEMP, 'pterm/node_modules/unws'));
const verify = require('./verify.cjs');
const out = path.join(process.env.RUNNER_TEMP, 'r20-evidence');
const uri = '/data/pinokio/api/astrid/pinokio/reset.js';
const ref = 'pinokio://127.0.0.1:42000/api/astrid';
const packets = [];
let child;
let timer;
async function main() {
  const socket = new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'pterm' } });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  socket.send(JSON.stringify({ uri, mode: 'listen' }));
  // The protocol does not acknowledge idle subscriptions. Give the daemon time
  // to register; missing any expected event is a hard failure, never a pass.
  await new Promise(resolve => setTimeout(resolve, 3000));
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('action did not settle within 120 seconds')), 120000);
    socket.addEventListener('message', event => {
      const packet = JSON.parse(String(event.data));
      // Retain only fields needed to verify this known action, never arbitrary output.
      packets.push({ type: packet.type, index: packet.index, total: packet.total, data: packet.type === 'result' ? packet.data : packet.type === 'event' ? packet.data : undefined });
      if (packet.type === 'error') reject(new Error('daemon reported action error'));
      if (packet.type === 'disconnect') resolve();
    });
    socket.addEventListener('close', () => reject(new Error('observer disconnected prematurely')));
  });
  child = spawn(process.execPath, [path.join(process.env.RUNNER_TEMP, 'pterm/index.js'), 'start', 'pinokio/reset.js', '--ref', ref], { stdio: ['ignore', 'ignore', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`pterm exit ${code} signal ${signal}`))); });
  await Promise.all([finished, exited]);
  clearTimeout(timer);
  const status = new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'pterm' } });
  await new Promise((resolve, reject) => { status.addEventListener('open', resolve); status.addEventListener('error', reject); });
  const state = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('status timeout')), 10000);
    status.addEventListener('message', event => { clearTimeout(deadline); resolve(JSON.parse(String(event.data)).data); });
    status.send(JSON.stringify({ uri, status: true }));
  });
  status.close(); socket.close();
  verify(packets, state);
  fs.writeFileSync(path.join(out, 'settlement.json'), JSON.stringify({ ref, uri, packets, running_after: state }, null, 2) + '\n');
}
main().catch(error => { clearTimeout(timer); if (child) child.kill(); fs.writeFileSync(path.join(out, 'observer-failure.json'), JSON.stringify({ error: error.message, packets }, null, 2) + '\n'); console.error(error.message); process.exit(1); });
