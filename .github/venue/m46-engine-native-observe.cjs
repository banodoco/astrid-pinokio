'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocket } = require(path.join(process.env.RUNNER_TEMP, 'pterm/node_modules/unws'));

const out = path.join(process.env.RUNNER_TEMP, 'm46-engine-evidence');
const uri = process.env.R20_ACTION_URI;
const ref = 'pinokio://127.0.0.1:42000/api/astrid';
const packets = [];
let child;
let timer;

async function main() {
  if (!uri) throw new Error('disposable Reset URI missing');
  const socket = new WebSocket('ws://127.0.0.1:42000', { headers: { 'x-pinokio-client': 'pterm' } });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  socket.send(JSON.stringify({ uri, mode: 'listen' }));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const stream = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('request stream exceeded 120-second bound')), 120000);
    socket.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(String(event.data)); } catch { reject(new Error('non-JSON daemon packet')); return; }
      const data = packet.type === 'result'
        ? { stopped: packet.data?.stopped, lockFree: packet.data?.lockFree, reset: packet.data?.reset, dataKept: packet.data?.dataKept }
        : packet.type === 'event' && ['stop', 'disconnect'].includes(packet.data) ? packet.data : undefined;
      packets.push({ type: packet.type, index: packet.index, total: packet.total, data });
      if (packet.type === 'error') reject(new Error('daemon reported request error'));
      if (packet.type === 'disconnect') resolve();
    });
    socket.addEventListener('close', () => reject(new Error('observer socket closed before request disconnect')));
  });
  child = spawn(process.execPath, [path.join(process.env.RUNNER_TEMP, 'pterm/index.js'), 'start', 'pinokio/reset.js', '--ref', ref], { stdio: ['ignore', 'ignore', 'ignore'] });
  const ptermExit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve({ code, signal, pid: child.pid }) : reject(new Error(`PTerm exit ${code} signal ${signal}`)));
  });
  const [events, exit] = await Promise.all([stream, ptermExit]);
  clearTimeout(timer);
  socket.close();
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(out, 'request-observation.json'), JSON.stringify({ uri, ref, uid: process.getuid(), pterm_pid: exit.pid, pterm_exit: exit, pterm_script_sha256: digest(path.join(process.env.RUNNER_TEMP, 'pterm/index.js')), node_executable: process.execPath, node_executable_sha256: digest(process.execPath), events }, null, 2) + '\n');
}

main().catch(error => {
  clearTimeout(timer);
  if (child) child.kill();
  fs.writeFileSync(path.join(out, 'first-failure.json'), JSON.stringify({ stage: 'request', failure: error.message, pterm_pid: child?.pid ?? null, events: packets }, null, 2) + '\n');
  console.error(error.message);
  process.exit(1);
});
