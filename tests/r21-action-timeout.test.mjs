import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const observer = fs.readFileSync('.github/venue/r21-observe.cjs', 'utf8');
const runner = fs.readFileSync('.github/venue/r21-real-engine.sh', 'utf8');

test('only initial historical Install gets the larger PTerm bound', async () => {
  const constants = observer.slice(observer.indexOf('const ACTION_TIMEOUT_MS'), observer.indexOf('let actionNumber'));
  const functions = observer.slice(observer.indexOf('function ptermExit('), observer.indexOf('\nasync function lockFree('));
  const calls = [...observer.matchAll(/await observeAction\([^\n;]+\)/g)].map(match => match[0]);
  assert.equal(calls.length, 5);
  const timers = [];
  const context = vm.createContext({
    path, appRoot: '/app', ptermRoot: '/pterm', home: '/home', ENDPOINT: 'pinokio://test',
    FIRST_REFUSAL: 'refusal', actionNumber: 0, progress: {}, process,
    openSocket: async () => {
      let onMessage;
      return { addEventListener: (_event, handler) => { onMessage = handler; },
        send: () => onMessage({ data: JSON.stringify({ type: 'disconnect' }) }) };
    },
    delay: async () => {}, isObject: value => value && typeof value === 'object',
    spawn: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0, null)); return child; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}, retainProgress: () => {}, io: { disposeSocket: () => {} },
    status: async () => false,
  });
  vm.runInContext(`${constants}\n${functions}`, context);
  const actual = [];
  for (const call of calls) {
    const start = timers.length;
    const result = await vm.runInContext(`(async () => ${call})()`, context);
    actual.push({ uri: result.action_uri, timeout: timers[start].ms });
  }
  assert.deepEqual(actual, [
    { uri: 'pinokio://test/pinokio/install.js', timeout: 35 * 60 * 1000 },
    { uri: 'pinokio://test/pinokio/update.js', timeout: 20 * 60 * 1000 },
    { uri: 'pinokio://test/pinokio/stop.js', timeout: 20 * 60 * 1000 },
    { uri: 'pinokio://test/pinokio/update.js', timeout: 20 * 60 * 1000 },
    { uri: 'pinokio://test/pinokio/stop.js', timeout: 20 * 60 * 1000 },
  ]);
  assert.match(runner, /\n  deadline=4200\n/);
  assert.ok(actual[0].timeout < 4200 * 1000, 'initial Install must leave watchdog time for the remaining journey');
});

test('PTerm timeout terminates the child and rejects', async () => {
  const fn = observer.slice(observer.indexOf('function ptermExit('), observer.indexOf('\nasync function observeAction('));
  let timer;
  const context = vm.createContext({ setTimeout: (callback, ms) => { timer = { callback, ms }; }, clearTimeout: () => {} });
  vm.runInContext(fn, context);
  const child = new EventEmitter();
  child.kill = signal => { child.signal = signal; };
  const pending = context.ptermExit(child, 'historical install', 35 * 60 * 1000);
  assert.equal(timer.ms, 35 * 60 * 1000);
  timer.callback();
  await assert.rejects(pending, /historical install PTerm timeout/);
  assert.equal(child.signal, 'SIGTERM');
});
