'use strict';

// This is a venue/source binding, not a custody provider.  It makes the
// existing macOS and Windows adapter builds addressable from the current
// Pinokio candidate while R-36 remains the authority for protected evidence.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const SCHEMA = 'astrid.r25.native-collector-binding.v1';
const SOURCE_REF = '47059b072889b489b2db20d3a3e86acf02e5a3d4';
const R30_INTERFACE_SHA256 = '2f685c8aec21bef116f95645920717e4b12ef33c1ca820fe6185eb01ffea115d';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sourceFiles = Object.freeze({
  '.github/venue/adapters/macos-observer.c': 'fd9d85ba033acaa96d229e79371e8dcb9b0e5124ba0abc439041b692800cdcdc',
  '.github/venue/adapters/macos-observer.cjs': '3ec42f318180403675b75d0b386c9744a4777f5c172f9bcee7203a724884819b',
  'tests/macos-observer.test.mjs': 'e8e61cafd3a8eceeb929c575d5092e9bdc99f0d93c2e26cc742d6cf21186ac13',
  'pinokio/windows-observer/adapter.mjs': 'd3bffec30339a3b17453cb6eab288cc835b52cc42fc7a7f0e806e76373f6b54b',
  'pinokio/windows-observer/etw-observer.cpp': 'c707c59b99b50dc4e3065944e4657c353cd9aee27c19d9134682e682554132a4',
  'tests/windows-observer-adapter.test.mjs': '79a6b604e103a0270d3a141c52eb153480b6649600ce849572fb13909f18dbbf',
  '.github/workflows/r25-os-adapters.yml': '0f7902418819ee28f62958cd13241e90b09bfc351a195c941c60cadb0dda9d24',
});

const profiles = Object.freeze({
  macos: Object.freeze({
    id: 'macos-endpoint-security-process-v1-unbound',
    sha256: '55355f43689faf3de623ad8bef76af3c092b124f97c6f2611280804b81ff579f',
    runner: 'macos-14',
    shell: 'sh',
    executable: '.github/venue/adapters/macos-observer',
    adapter: '.github/venue/adapters/macos-observer.cjs',
    test: 'tests/macos-observer.test.mjs',
    build: 'sdk=$(xcrun --sdk macosx --show-sdk-path); /usr/bin/clang -isysroot "$sdk" -O2 -Wall -Wextra -fblocks .github/venue/adapters/macos-observer.c -framework EndpointSecurity -lbsm -o .github/venue/adapters/macos-observer',
    run: 'node --test tests/macos-observer.test.mjs',
  }),
  windows: Object.freeze({
    id: 'windows-etw-kernel-process-v1;provider=22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716;keyword=0x10;level=5;headers-only;max=1024',
    sha256: '739bdd2a2a48c2e5476be982210eb58e1358f4994b48def98ccd49a530247920',
    runner: 'windows-2022',
    shell: 'powershell.exe',
    executable: 'pinokio/windows-observer/etw-observer.exe',
    adapter: 'pinokio/windows-observer/adapter.mjs',
    test: 'tests/windows-observer-adapter.test.mjs',
    build: 'vswhere + vcvars64.bat; cl /nologo /EHsc /W4 /O2 /Fetw-observer.exe pinokio/windows-observer/etw-observer.cpp /link advapi32.lib ole32.lib',
    run: 'node --test tests/windows-observer-adapter.test.mjs',
  }),
});

const slots = Object.freeze([
  ['pinokio-backend-macos', 'macos', 'backend'],
  ['pinokio-fully-local-macos', 'macos', 'fully-local'],
  ['pinokio-backend-linux', 'linux', 'backend'],
  ['pinokio-fully-local-linux', 'linux', 'fully-local'],
  ['pinokio-backend-windows', 'windows', 'backend'],
  ['pinokio-fully-local-windows', 'windows', 'fully-local'],
].map(([id, os, mode]) => Object.freeze({ id, os, mode, channel: 'pinokio' })));

const R36 = Object.freeze({
  contract: 'astrid-qualification/v1',
  interface_sha256: R30_INTERFACE_SHA256,
  state: 'unbound',
  owner: 'R-36 control-plane / M-QUAL verifier',
  required: Object.freeze([
    'qualification-freeze and closed inventory with one obligation per slot',
    'signed run grant and authenticated origin/execution records',
    'loss-aware collector seal with R-23 export, checks and file digests',
    'transport record, plan completion and aggregate verifier result',
    'approved per-OS source profile and exact-child finalization',
  ]),
  provider_calls: Object.freeze([
    'PLATFORM_SESSION_PROVIDER.open_authenticated_session',
    'session.bind_exact_custody',
    'session.authorize_exact_removal',
    'session.finalize_after_removal',
    'session.abort',
    'PINOKIO_CUSTODY_PROVIDER.create_owner',
  ]),
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertTuple(tuple) {
  if (!tuple || typeof tuple !== 'object' || Array.isArray(tuple)) throw new Error('tuple must be an object');
  for (const key of ['app', 'agent', 'runtime', 'pinokio']) {
    if (typeof tuple[key] !== 'string' || !HEX40.test(tuple[key])) throw new Error(`tuple.${key} must be a commit SHA`);
  }
  assertDigest(tuple.manifest_sha256, 'tuple.manifest_sha256');
  return tuple;
}

function validateSourceRoot(root, sourceRef = SOURCE_REF) {
  if (sourceRef !== SOURCE_REF) throw new Error(`source ref must be ${SOURCE_REF}`);
  const failures = [];
  for (const [relative, expected] of Object.entries(sourceFiles)) {
    const file = path.join(root, relative);
    let actual;
    try { actual = sha256(fs.readFileSync(file)); } catch { failures.push(`${relative}: missing`); continue; }
    if (actual !== expected) failures.push(`${relative}: sha256 ${actual} != ${expected}`);
  }
  if (failures.length) throw new Error(`native collector source mismatch: ${failures.join('; ')}`);
  return { source_ref: sourceRef, files: sourceFiles };
}

function selectedSlots(targetOs = 'both', mode = 'both') {
  const oses = targetOs === 'both' ? ['macos', 'windows'] : [targetOs];
  const modes = mode === 'both' ? ['backend', 'fully-local'] : [mode];
  if (!oses.every(os => ['macos', 'windows'].includes(os))) throw new Error('target_os must be macos, windows, or both');
  if (!modes.every(value => ['backend', 'fully-local'].includes(value))) throw new Error('mode must be backend, fully-local, or both');
  return slots.filter(slot => oses.includes(slot.os) && modes.includes(slot.mode));
}

function buildDispatch(tuple, { candidateRef, sourceRef = SOURCE_REF, targetOs = 'both', mode = 'both' } = {}) {
  assertTuple(tuple);
  if (typeof candidateRef !== 'string' || !HEX40.test(candidateRef)) throw new Error('candidate_ref must be an immutable Pinokio commit');
  if (sourceRef !== SOURCE_REF) throw new Error(`source_ref must be ${SOURCE_REF}`);
  const selected = selectedSlots(targetOs, mode);
  return {
    schema: SCHEMA,
    candidate_ref: candidateRef,
    published_tuple: {
      app: tuple.app,
      agent: tuple.agent,
      runtime: tuple.runtime,
      pinokio: tuple.pinokio,
      manifest_sha256: tuple.manifest_sha256,
    },
    source: { ref: sourceRef, files: sourceFiles },
    r36: R36,
    slots: selected.map(slot => ({
      ...slot,
      runner: profiles[slot.os].runner,
      shell: profiles[slot.os].shell,
      source_profile: profiles[slot.os].id,
      source_profile_sha256: profiles[slot.os].sha256,
      build_command: profiles[slot.os].build,
      collector_command: profiles[slot.os].run,
      execution: 'component-probe-only',
      qualification: 'closed-until-r36-binding',
    })),
  };
}

function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), argv[index + 1]]);
    return pairs;
  }, []));
  const tuple = JSON.parse(args['tuple-json'] || '{}');
  const result = buildDispatch(tuple, {
    candidateRef: args['candidate-ref'], sourceRef: args['source-ref'] || SOURCE_REF,
    targetOs: args['target-os'] || 'both', mode: args.mode || 'both',
  });
  if (args['source-root']) validateSourceRoot(args['source-root'], args['source-ref'] || SOURCE_REF);
  const output = JSON.stringify(result, null, 2) + '\n';
  if (args.output) fs.writeFileSync(args.output, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  process.stdout.write(output);
}

module.exports = { SCHEMA, SOURCE_REF, R30_INTERFACE_SHA256, R36, profiles, slots, sourceFiles, sha256, validateSourceRoot, buildDispatch };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`native collector binding refused: ${error.message}\n`); process.exitCode = 1; }
}
