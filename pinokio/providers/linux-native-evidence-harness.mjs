// Bounded real-engine diagnostic binding for the Linux Pinokio venue.
// It deliberately does not produce an R-30 envelope, a trusted receipt, or a
// protected M4 result. The caller supplies the pinned PTerm invocation; this
// module observes the real daemon and returns raw-producer references only.
import { captureActionSources } from './linux-observations.mjs';
import { observeLinuxReset } from './linux-action-settlement.mjs';
import { captureLinuxCustodyCheckpoint } from './linux-custody-observations.mjs';

export const EXTERNAL_AWAIT = Object.freeze({
  'R-06': Object.freeze({ id: 'R-06', receipt: 'approved stand-in R2 identity and Pinokio-path receipt',
    reason: 'no approved stand-in R2 binding is available' }),
  'R-15': Object.freeze({ id: 'R-15', receipt: 'approved same-operation recovery receipt',
    reason: 'no approved busy/unknown recovery binding is available' }),
  'R-21': Object.freeze({ id: 'R-21', receipt: 'accepted old-launcher real-engine first-click receipt',
    reason: 'launcher Stop/retry binding is unavailable' }),
  'R-36': Object.freeze({ id: 'R-36', receipt: 'trusted collector and verifier receipt',
    reason: 'authenticated collection and qualification are unavailable' }),
});

export const JOURNEY_AWAITS = Object.freeze({
  'M4-4a': Object.freeze([EXTERNAL_AWAIT['R-21'], EXTERNAL_AWAIT['R-36']]),
  'M4-4b': Object.freeze([EXTERNAL_AWAIT['R-21'], EXTERNAL_AWAIT['R-36']]),
  'M4-5': Object.freeze([EXTERNAL_AWAIT['R-06'], EXTERNAL_AWAIT['R-15'], EXTERNAL_AWAIT['R-21'], EXTERNAL_AWAIT['R-36']]),
});

const checkpointReference = ({ observation, file }) => Object.freeze({ observation, file });
const sourceReference = ({ files, limitations }) => Object.freeze({
  files: Object.freeze(files.map(({ path, sha256, size }) => Object.freeze({ path, sha256, size }))),
  limitations: Object.freeze([...limitations]),
});
const externalAwait = (ids) => Object.freeze(ids.map((id) => EXTERNAL_AWAIT[id]));

function journeyState(id) {
  return Object.freeze({
    id,
    state: 'not-run',
    qualification: 'closed',
    externalAwait: JOURNEY_AWAITS[id],
  });
}

function notDispatched(reason) {
  return Object.freeze({
    kind: 'pinokio-linux-native-diagnostic',
    state: 'unknown',
    qualification: 'closed',
    dispatched: false,
    issues: Object.freeze([reason]),
    externalAwait: externalAwait(['R-06', 'R-15', 'R-36']),
    journeys: Object.freeze({ 'M4-4a': journeyState('M4-4a'), 'M4-4b': journeyState('M4-4b'), 'M4-5': journeyState('M4-5') }),
  });
}

/**
 * Bind the existing source, settlement and custody producers around one real
 * native Reset action. Reset is only a disposable venue diagnostic: it is not
 * a substitute for the R-21 old-launcher, R-22 restoration or R-06 update
 * journeys. `startAction` must invoke pinned PTerm against the native daemon.
 */
export async function runNativeResetDiagnostic({ WebSocket, endpoint, uri, daemonPid,
  pinokioDirectory, startAction, timeoutMs = 120000, subscriptionDelayMs = 3000 }) {
  if (typeof pinokioDirectory !== 'string' || !pinokioDirectory || typeof startAction !== 'function') {
    throw new TypeError('native diagnostic requires its source directory and pinned PTerm action');
  }
  let sources;
  try { sources = await captureActionSources(pinokioDirectory); }
  catch { return notDispatched('source-checkpoint-unavailable'); }

  const pids = { controller: daemonPid };
  const initial = await captureLinuxCustodyCheckpoint({ phase: 'initial', pids, sequence: 1 });
  let settlement;
  try {
    settlement = await observeLinuxReset({ WebSocket, endpoint, uri, daemonPid, timeoutMs,
      startAction, subscriptionDelayMs, sequence: 2, reserveSequences: 1 });
  } catch (error) {
    settlement = { state: 'unknown', issues: ['settlement-observer-unavailable'], payloads: [],
      error: error instanceof Error ? error.message : 'unknown-error' };
  }
  // The raw producers share one diagnostic stream. Their IDs are locally
  // contiguous but remain merely collector inputs, never proof of continuity.
  const final = await captureLinuxCustodyCheckpoint({ phase: 'final', pids,
    sequence: 2 + settlement.payloads.length });
  return Object.freeze({
    kind: 'pinokio-linux-native-diagnostic',
    state: 'unknown',
    qualification: 'closed',
    dispatched: true,
    externalAwait: externalAwait(['R-06', 'R-15', 'R-36']),
    settlement: Object.freeze({ state: settlement.state, issues: Object.freeze([...settlement.issues]),
      payloads: Object.freeze(settlement.payloads.map(({ id, kind, sequence, file, sha256 }) =>
        Object.freeze({ id, kind, sequence, file, sha256 }))) }),
    custody: Object.freeze({ initial: checkpointReference(initial), final: checkpointReference(final),
      state: 'unknown', limitations: Object.freeze(['caller-role-is-daemon-only', 'unauthenticated', 'continuity-unknown']) }),
    fullyLocalRestoration: Object.freeze({
      state: 'not-run',
      source: sourceReference(sources),
      externalAwait: externalAwait(['R-21', 'R-36']),
      reason: 'R-22 source bytes are checkpointed only; no controlled build failure or restoration was executed',
    }),
    fault: Object.freeze({
      state: 'not-run',
      provider: 'linux-preflight-output-fault',
      externalAwait: externalAwait(['R-15', 'R-21', 'R-36']),
      reason: 'no accepted Runtime busy/unknown control path is bound; no synthetic fault was injected',
    }),
    journeys: Object.freeze({ 'M4-4a': journeyState('M4-4a'), 'M4-4b': journeyState('M4-4b'), 'M4-5': journeyState('M4-5') }),
  });
}
