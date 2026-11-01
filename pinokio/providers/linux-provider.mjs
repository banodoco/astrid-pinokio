// Linux R-24 provider surface. The underlying producers retain bounded facts
// only; this facade deliberately has no qualification, removal, or retry API.
import { observeLinuxReset } from './linux-action-settlement.mjs';
import { captureLinuxCustodyCheckpoint } from './linux-custody-observations.mjs';
import { installPreflightOutputFault, withPreflightOutputFault } from './linux-preflight-fault.mjs';

const INTERFACE_SHA256 = '2f685c8aec21bef116f95645920717e4b12ef33c1ca820fe6185eb01ffea115d';

const COMMON_AWAIT = Object.freeze([
  Object.freeze({ id: 'R-36',
    reason: 'trusted collector, approved profiles, immutable binding and verifier are unbound' }),
]);

const M4_HARNESSES = Object.freeze({
  'M4-4a': Object.freeze({
    id: 'M4-4a',
    title: 'old-launcher first click, Stop/retry and Stop to Start',
    await: Object.freeze([
      Object.freeze({ id: 'R-21', reason: 'approved old-launcher stopped-path integration is unbound' }),
      ...COMMON_AWAIT,
    ]),
  }),
  'M4-4b': Object.freeze({
    id: 'M4-4b',
    title: 'fully-local controlled build failure and restoration',
    await: Object.freeze([
      Object.freeze({ id: 'R-21', reason: 'approved launcher integration for the Pinokio execution path is unbound' }),
      ...COMMON_AWAIT,
    ]),
  }),
  'M4-5': Object.freeze({
    id: 'M4-5',
    title: 'Pinokio Update from R1 to the approved stand-in R2',
    await: Object.freeze([
      Object.freeze({ id: 'R-06', reason: 'approved stand-in R2 input is unbound' }),
      Object.freeze({ id: 'R-15', reason: 'approved same-operation recovery input is unbound' }),
      Object.freeze({ id: 'R-21', reason: 'approved launcher integration for the Pinokio execution path is unbound' }),
      ...COMMON_AWAIT,
    ]),
  }),
});

function plan(harness) {
  if (typeof harness !== 'string' || !Object.hasOwn(M4_HARNESSES, harness)) {
    throw new TypeError('unknown Linux M4 harness');
  }
  const selected = M4_HARNESSES[harness];
  // Do not accept caller-supplied paths, digests, adapters or fixtures here.
  // The protected R-36 collector must bind approved inputs independently.
  return Object.freeze({
    kind: 'pinokio-linux-m4-harness',
    interface: 'astrid-qualification/v1',
    interfaceSha256: INTERFACE_SHA256,
    harness: selected.id,
    title: selected.title,
    state: 'not-run',
    qualification: 'closed',
    await: selected.await,
    producers: Object.freeze({
      settlement: 'diagnostic-only',
      preflightFault: 'diagnostic-only',
      custody: 'diagnostic-only',
    }),
  });
}

/**
 * Return the single Linux diagnostic-provider surface used by future harness
 * bindings. Calling a producer can retain only its documented raw observations;
 * none of these functions returns qualification or removal authority.
 */
export function createLinuxProviderSurface() {
  return Object.freeze({
    platform: 'linux',
    interface: 'astrid-qualification/v1',
    interfaceSha256: INTERFACE_SHA256,
    state: 'unbound',
    qualification: 'closed',
    settlement: Object.freeze({ observeReset: observeLinuxReset, state: 'unknown' }),
    fault: Object.freeze({ installPreflightOutputFault, withPreflightOutputFault, state: 'unknown' }),
    custody: Object.freeze({ captureCheckpoint: captureLinuxCustodyCheckpoint, state: 'unknown' }),
    prepareM4Harness: plan,
    requireTrustedQualification() {
      throw new Error('Linux provider output is unbound; R-36 trusted collector/verifier is required.');
    },
  });
}

export { INTERFACE_SHA256, M4_HARNESSES };
