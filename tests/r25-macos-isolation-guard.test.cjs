'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ownerPid, validateStopOwner, verifyStopped } = require('../.github/venue/r25-macos-isolation.cjs');

const target = 'gui/501/haus.astrid.runtime';
const definition = { label: 'haus.astrid.runtime', program: '/private/tmp/run/pinokiod',
  arguments: ['/private/tmp/run/pinokiod', 'start'], plist_sha256: 'a'.repeat(64) };

function census(state, rawPrint = '', processes = []) {
  return { launchd: [{ target, state, raw_print: rawPrint }], processes };
}

test('P2 stop guard accepts only exact launchd PID present in fresh current-user process census', () => {
  const process = { pid: 92, executable_path: definition.program,
    command_line: definition.arguments.join(' '), collection_state: 'present' };
  const live = census('present', 'pid = 92\n', [process]);
  assert.equal(ownerPid(live.launchd[0].raw_print), 92);
  assert.deepEqual(validateStopOwner({ census: live, target, definition, uid: 501 }), {
    allowed: true, reason: null, owner_pid: 92, owner_identity: process,
  });
  assert.equal(validateStopOwner({ census: census('present', 'pid = 92\n', []), target, definition, uid: 501 }).allowed, false);
  assert.equal(validateStopOwner({ census: census('present', 'pid = 92\n', [{ ...process, executable_path: '/other' }]), target, definition, uid: 501 }).allowed, false);
});

test('P2 permits a no-owner result only with absent launchd target and fresh no-process census', () => {
  const noOwner = validateStopOwner({ census: census('absent'), target, definition, uid: 501 });
  assert.deepEqual(noOwner, { allowed: false, reason: 'no-live-owner', owner_pid: null, no_owner_verified: true });
  assert.equal(verifyStopped({ census: census('absent'), target, definition }).verified, true);
  assert.equal(validateStopOwner({ census: census('absent', '', [{ executable_path: definition.program,
    collection_state: 'present' }]), target, definition, uid: 501 }).no_owner_verified, undefined);
});

test('P2 refuses ambiguous PID, unavailable census, and incomplete definition', () => {
  assert.equal(ownerPid('pid = 92\npid = 93\n'), null);
  assert.equal(validateStopOwner({ census: {}, target, definition, uid: 501 }).reason, 'launchd-census-target-ambiguous');
  assert.equal(validateStopOwner({ census: census('present', 'pid = 92\n', [{ pid: 92,
    executable_path: definition.program, command_line: definition.arguments.join(' '), collection_state: 'present' }]), target,
  definition: { ...definition, plist_sha256: null }, uid: 501 }).reason, 'service-definition-unavailable');
});

test('workflow diagnostic selector dispatches backend macOS alone behind the published isolation input', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/r25-windows-setup-diagnostic.yml'), 'utf8');
  assert.match(workflow, /backend_start_only:[\s\S]*?type: boolean/);
  assert.match(workflow, /windows-setup-diagnostic:[\s\S]*?if: \(github\.event_name == 'workflow_dispatch' && inputs\.backend_start_only != true\)/);
  assert.match(workflow, /macos-setup-diagnostic:[\s\S]*?if: \(github\.event_name == 'workflow_dispatch' && inputs\.backend_start_only != true\)/);
  assert.match(workflow, /macos-backend-start-diagnostic:[\s\S]*?inputs\.backend_start_only == true && inputs\.mac_isolation_evidence == 'ORCHESTRATOR\.md#2026-11-03T08:22:46Z M-VENUE'/);
  assert.match(workflow, /R25_ISOLATION_EVIDENCE_REF: \$\{\{ inputs\.mac_isolation_evidence \}\}/);
});
