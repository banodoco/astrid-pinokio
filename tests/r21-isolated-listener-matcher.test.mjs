import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = '.github/venue/r21-isolated-wildcard-bind.sh';
const row = (address, pid = '2624', state = 'LISTEN') =>
  `${state} 0 511 ${address} *:* users:(("node",pid=${pid},fd=20))\n`;
const matches = (capture, pid = '2624') => {
  const result = spawnSync('bash', [script, '--match-listener', pid], { input: capture, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return result.status === 0;
};

for (const address of ['*:42000', '0.0.0.0:42000']) {
  test(`accepts owned wildcard ${address}`, () => assert.equal(matches(row(address)), true));
}
for (const [name, capture, pid] of [
  ['another PID', row('*:42000', '2625')],
  ['PID prefix', row('*:42000', '26240')],
  ['PID suffix', row('*:42000', '12624')],
  ['another port', row('*:42001')],
  ['port suffix', row('*:420000')],
  ['loopback', row('127.0.0.1:42000')],
  ['specific IPv4 address', row('192.0.2.1:42000')],
  ['IPv6 wildcard', row('[::]:42000')],
  ['non-listening socket', row('*:42000', '2624', 'ESTAB')],
  ['owner on a different row', row('*:42000', '2625') + row('127.0.0.1:42000')],
  ['missing owner', 'LISTEN 0 511 *:42000 *:*\n'],
  ['invalid PID', row('*:42000'), '26.*'],
]) {
  test(`rejects ${name}`, () => assert.equal(matches(capture, pid), false));
}
test('finds a matching row among unrelated listeners', () => {
  assert.equal(matches(row('127.0.0.1:42000', '99') + row('*:42000')), true);
});
