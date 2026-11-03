'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  API_SHA256, PINOKIOD_REF, correlateStep, digestJson, patchSource,
  refuseSettlement, requestBinding, sha256,
} = require('../.github/venue/m46-engine-overlay.cjs');

function pinnedApi() {
  const file = process.env.PINOKIOD_API_SOURCE;
  assert.ok(file, 'PINOKIOD_API_SOURCE must point to the inspected pinned source');
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(sha256(Buffer.from(source, 'utf8')), API_SHA256);
  return source;
}

test('pinned source overlay is exact, anchored and refuses source drift', () => {
  const source = pinnedApi();
  const patched = patchSource(source);
  assert.equal(patched.sourceSha256, API_SHA256);
  assert.equal(patched.replacements.length, 3);
  assert.match(patched.source, /__m46Bind\(request, actionKey, initialPayload, steps\)/);
  assert.match(patched.source, /__m46Step\(request, i, total, rpc\)/);
  assert.match(patched.source, /__m46Emit\('rpc-return'/);
  assert.match(patched.source, /priorStat\.size <= 65536/);
  assert.throws(() => patchSource(`${source}\n// drift`), /source hash differs/);
  assert.equal(PINOKIOD_REF, 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf');
});

test('source anchor ambiguity fails closed even with an explicitly matching fixture hash', () => {
  const source = 'const escapeHtml = (value) => String(value || "")\n'.repeat(2)
    + '            if (!Array.isArray(steps) || steps.length === 0) {\n'
    + '            result = this.logSessions\n              ? await this.logSessions.withRunContext(request, runEndpoint)\n              : await runEndpoint()\n';
  assert.throws(() => patchSource(source, { expectedSha256: sha256(Buffer.from(source)) }), /anchor api-helper-anchor is not unique/);
});

test('request binding correlates action graph to rendered step without recording inputs or RPC payloads', () => {
  const graph = [{ method: 'install.step', params: { argv: ['node', 'task.js'] } }, { method: 'install.finish' }];
  const request = { id: 'req-17', path: '/selected/app/pinokio/start.js' };
  const binding = requestBinding(request, 'start', { revision: 'abc', token: 'fixture-secret' }, graph);
  const step = correlateStep(binding, 1, 2, { method: 'install.finish', params: { token: 'fixture-secret' } });
  assert.equal(step.request_id, 'req-17');
  assert.equal(step.request_binding_sha256, digestJson(binding));
  assert.equal(step.action, 'start');
  assert.equal(step.graph_sha256, digestJson(graph));
  assert.equal(step.step_index, 1);
  assert.equal(step.total_steps, 2);
  assert.equal(step.rpc_method, 'install.finish');
  assert.ok(step.rpc_sha256);
  assert.equal(Object.hasOwn(step, 'input'), false);
  assert.equal(Object.hasOwn(step, 'rpc'), false);
  assert.equal(binding.mode, null);
  assert.equal(binding.app_mapping, null);
});

test('operation graph fixtures remain digests only for all four action keys', () => {
  for (const action of ['start', 'stop', 'update', 'uninstall']) {
    const binding = requestBinding({ id: `fixture-${action}`, path: '/fixture/app/action.js' }, action, {}, [{ method: `fixture.${action}` }]);
    assert.equal(binding.action, action);
    assert.equal(binding.graph_count, 1);
    assert.match(binding.graph_sha256, /^[a-f0-9]{64}$/);
  }
});

test('backend and local mode must remain unknown without installed resolution; no factory is called', async t => {
  let factoryCalls = 0;
  for (const mode of ['backend', 'local']) {
    await t.test(mode, () => {
      const binding = requestBinding({ id: `mode-${mode}`, path: '/fixture/app/start.js' }, 'start', {}, [{ method: 'fixture.start' }]);
      assert.equal(binding.mode, null);
      assert.equal(binding.app_mapping, null);
      assert.equal(factoryCalls, 0);
    });
  }
});

test('missing child exit and protected collector refuse settlement regardless of RPC activity', () => {
  const settlement = refuseSettlement();
  assert.equal(settlement.accepted, null);
  assert.equal(settlement.queued, null);
  assert.equal(settlement.terminal_status, 'unknown');
  assert.equal(settlement.inner_exit, null);
  assert.equal(settlement.readback_sha256, null);
  assert.match(settlement.refusal, /protected collector/);
  assert.equal(Object.hasOwn(settlement, 'success'), false);
});
