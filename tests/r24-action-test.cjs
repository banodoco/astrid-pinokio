'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observe, launchStop } = require('../pinokio/providers/r24-action.cjs');
class Socket extends EventEmitter {
  addEventListener(name, cb) { this.on(name, cb); }
  send(value) { this.sent = JSON.parse(value); }
  close() {}
}
(async () => {
  let invocation;
  launchStop((...args) => { invocation = args; }, '/node', '/pterm');
  assert.deepEqual(invocation, ['/node', ['/pterm/index.js', 'start', 'pinokio/stop.js', '--ref', 'pinokio://127.0.0.1:42000/api/astrid'], { stdio: 'ignore' }]);
  let socket = new Socket(), child = new EventEmitter(), launches = 0;
  child.kill = () => {};
  const result = observe({ connect: () => socket, uri: '/candidate/pinokio/stop.js', timeoutMs: 40, delayMs: 1,
    launch: () => { launches++; return child; } });
  socket.emit('open');
  await new Promise(r => setTimeout(r, 5));
  child.emit('exit', 0, null);
  socket.emit('message', { data: JSON.stringify({ type: 'disconnect', data: 'bearer secret' }) });
  socket.emit('message', { data: JSON.stringify({ type: 'disconnect', data: 'raw control secret' }) });
  const row = await result;
  assert.equal(launches, 1); assert.equal(socket.sent.mode, 'listen');
  assert.equal(row.dispatched, true); assert.equal(row.client_exit, 0);
  assert.equal(row.disconnects, 2); assert.equal(row.post_terminal, true);
  assert.equal(row.settlement, 'unknown'); assert(!JSON.stringify(row).includes('secret'));
  socket = new Socket(); launches = 0;
  const premature = observe({ connect: () => socket, uri: '/x', timeoutMs: 30, delayMs: 10,
    launch: () => { launches++; return child; } });
  socket.emit('open'); socket.emit('message', { data: '{"type":"disconnect"}' });
  assert.equal((await premature).end, 'premature-disconnect'); assert.equal(launches, 0);
  socket = new Socket();
  const malformed = observe({ connect: () => socket, uri: '/x', timeoutMs: 30, delayMs: 10, launch: () => child });
  socket.emit('open'); socket.emit('message', { data: 'bearer secret' });
  assert.equal((await malformed).end, 'malformed-event');
  console.log('3 local action protocol fixtures passed');
})().catch(() => { console.error('action protocol fixture failed'); process.exitCode = 1; });
