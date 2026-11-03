'use strict';

// Run only the real Pinokio actions whose first effective operation is the
// already-bound R-24 busy Stop fence.  The controller never treats an engine
// accept/disconnect or its own exit as action success.  Each expected refusal
// is followed by the same exact-request stop/disconnect/idle fence used by the
// R-24 controller.
const fs = require('node:fs');
const path = require('node:path');
const r24 = require('./r24-action.cjs');

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const URIS = Object.freeze({
  update: '~/api/astrid/pinokio/update.js',
  keep_data_uninstall: '~/api/astrid/pinokio/uninstall.js',
});
const OPERATIONS = Object.freeze({
  backend: ['update', 'keep_data_uninstall'],
  'fully-local': ['keep_data_uninstall'],
});

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('invalid R-25 mode-action control');
  }
}

function readControl(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    throw new Error('invalid R-25 mode-action control file');
  }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  exact(value, ['schema', 'pterm', 'session', 'request_sha256', 'mode']);
  if (value.schema !== 'astrid.r25.linux-mode-action-control.v1' ||
      !HEX32.test(value.session) || !HEX64.test(value.request_sha256) ||
      !Object.hasOwn(OPERATIONS, value.mode) ||
      typeof value.pterm !== 'string' || !path.isAbsolute(value.pterm)) {
    throw new Error('invalid R-25 mode-action identity');
  }
  return value;
}

function socketFactory(control) {
  const implementation = require(path.join(control.pterm, 'node_modules/unws/src/node.cjs'));
  return () => new implementation.WebSocket('ws://127.0.0.1:42000', {
    headers: { 'x-pinokio-client': 'pterm' },
  });
}

function requestId(uri, session, operation) {
  if (!Object.values(URIS).includes(uri) || !HEX32.test(session) ||
      !Object.hasOwn(URIS, operation)) {
    throw new Error('invalid R-25 mode-action request identity');
  }
  return `${uri}?r25-session=${session}-${operation.replaceAll('_', '-')}`;
}

async function refusedAction(create, control, operation) {
  const uri = URIS[operation];
  const id = requestId(uri, control.session, operation);
  const run = await r24.runAction(create, { id, uri });
  if (typeof run.error !== 'string' || !run.error.trim() ||
      run.packets.filter(packet => packet.type === 'error').length !== 1 ||
      run.packets.some(packet => packet.type === 'result')) {
    throw new Error('mode action did not produce one terminal refusal');
  }
  const fence = await r24.fence(create, id, uri);
  return { operation, uri, request_id: id, error: run.error, fence };
}

async function collect(control, create = socketFactory(control)) {
  const actions = [];
  for (const operation of OPERATIONS[control.mode]) {
    actions.push(await refusedAction(create, control, operation));
  }
  return {
    schema: 'astrid.r25.linux-mode-action-control-result.v1',
    session: control.session,
    request_sha256: control.request_sha256,
    mode: control.mode,
    actions,
  };
}

async function main() {
  if (process.argv.length !== 3) throw new Error('control file required');
  process.stdout.write(JSON.stringify(await collect(readControl(process.argv[2]))));
}

if (require.main === module) main().catch(() => {
  process.stderr.write(JSON.stringify({
    schema: 'astrid.r25.linux-mode-action-control-error.v1', status: 'unknown',
  }) + '\n');
  process.exitCode = 1;
});

module.exports = { URIS, OPERATIONS, readControl, requestId, refusedAction, collect };
