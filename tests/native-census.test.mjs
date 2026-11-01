import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNativeCensus, parseMacProcesses, parseMacListeners } from '../.github/venue/adapters/native-census.cjs';

test('macOS census parses process births and listeners without granting custody', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return { stdout: command.endsWith('/ps') ? ' 42 1 Sun Nov  1 03:10:11 2026 /Applications/Pinokio App\n' : 'p42\nf12u\nn127.0.0.1:42000\n', stderr: '' };
  };
  const census = await collectNativeCensus({ platform: 'darwin', run });
  assert.deepEqual(census.processes, [{ pid: 42, ppid: 1, birth: 'Sun Nov  1 03:10:11 2026', executable: '/Applications/Pinokio App' }]);
  assert.deepEqual(census.listeners, [{ pid: 42, endpoint: '127.0.0.1:42000' }]);
  assert.equal(census.continuity, 'unavailable');
  assert.equal(census.authority, 'none');
  assert.equal(calls.length, 2);
});

test('macOS census fails closed on malformed rows and collection errors', async () => {
  assert.throws(() => parseMacProcesses('42 garbage\n'));
  assert.throws(() => parseMacListeners('n127.0.0.1:42000\n'));
  const ps = { stdout: '1 0 Sun Nov  1 03:10:11 2026 /sbin/launchd\n' };
  const noListeners = async command => { if (command.endsWith('/ps')) return ps; throw Object.assign(new Error('no matches'), { code: 1, stdout: '', stderr: '' }); };
  await assert.rejects(collectNativeCensus({ platform: 'darwin', run: noListeners }));
  const denied = async command => { if (command.endsWith('/ps')) return ps; throw Object.assign(new Error('denied'), { code: 1, stdout: '', stderr: 'permission denied' }); };
  await assert.rejects(collectNativeCensus({ platform: 'darwin', run: denied }));
});

test('Windows census preserves process incarnation and listener ownership', async () => {
  const data = { processes: [{ pid: 123, ppid: 1, birth: '2026-11-01T03:00:00.0000000Z', executable: 'C:\\Pinokio App\\daemon.exe', name: 'daemon.exe' }], listeners: [{ pid: 123, address: '::1', port: 42000 }] };
  const census = await collectNativeCensus({ platform: 'win32', run: async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-EncodedCommand'));
    return { stdout: JSON.stringify(data), stderr: '' };
  } });
  assert.deepEqual(census.processes, data.processes);
  assert.deepEqual(census.listeners, data.listeners);
  assert.equal(census.continuity, 'unavailable');
  assert.equal(census.authority, 'none');
});

test('Windows and unsupported platforms reject missing or ambiguous observations', async () => {
  const response = data => async () => ({ stdout: JSON.stringify(data), stderr: '' });
  await assert.rejects(collectNativeCensus({ platform: 'win32', run: response({ processes: [], listeners: [] }) }));
  const p = { pid: 3, ppid: 1, birth: 'time', executable: '' };
  await assert.rejects(collectNativeCensus({ platform: 'win32', run: response({ processes: [p, p], listeners: [] }) }));
  await assert.rejects(collectNativeCensus({ platform: 'win32', run: response({ processes: [p], listeners: [{ pid: 3, address: 'x', port: 70000 }] }) }));
  await assert.rejects(collectNativeCensus({ platform: 'win32', run: async () => { throw new Error('CIM unavailable'); } }));
  await assert.rejects(collectNativeCensus({ platform: 'linux' }));
});

test('native host can take a diagnostic census', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const census = await collectNativeCensus();
  assert.ok(census.processes.some(p => p.pid === process.pid));
  assert.equal(census.continuity, 'unavailable');
  assert.equal(census.authority, 'none');
});
