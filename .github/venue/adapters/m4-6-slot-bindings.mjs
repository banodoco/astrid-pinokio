'use strict';

export const M46_SCENARIO_GROUPS = Object.freeze([
  'interruption_recovery',
  'failed_candidate_rollback',
  'keep_data_uninstall',
  'stop_safety',
]);
export const M46_STOP_OUTCOMES = Object.freeze(['refused', 'unknown']);

const providerCandidate = Object.freeze({
  state: 'pending-acceptance',
  lane: 'lane/M-PIN/R-24-R3',
  commit: 'afbfc2076cb084fe030cfaac9d643fe4557eff62',
  note: 'candidate diagnostic only; not an authentic qualification receipt',
});
const r36Binding = Object.freeze({
  state: 'pending',
  owner: 'R-36',
  required: Object.freeze([
    'trusted collector',
    'frozen inventory and obligation identifiers',
    'protected parser profile',
    'independent verifier and authenticated completion',
  ]),
});
const platforms = Object.freeze([
  Object.freeze({ os: 'macos', runner: 'macos-14', shell: 'sh' }),
  Object.freeze({ os: 'linux', runner: 'ubuntu-24.04', shell: 'sh' }),
  Object.freeze({ os: 'windows', runner: 'windows-2022', shell: 'powershell.exe' }),
]);
const modes = Object.freeze(['backend', 'fully-local']);

function pendingSlot(platform, mode) {
  return Object.freeze({
    id: 'pinokio-' + mode + '-' + platform.os,
    obligation_key: Object.freeze({
      qualification_id: null,
      obligation_id: null,
      family: 'm4-6',
      scenario_id: 'm4-6',
      os: platform.os,
      mode,
      channel: 'pinokio',
    }),
    venue: Object.freeze({ runner: platform.runner, shell: platform.shell, state: 'unbound' }),
    required: Object.freeze({
      scenario_groups: M46_SCENARIO_GROUPS,
      stop_outcomes: M46_STOP_OUTCOMES,
    }),
    bindings: Object.freeze({
      provider: providerCandidate,
      trusted_collection_and_verifier: r36Binding,
      source_profile: Object.freeze({ state: 'pending-approval' }),
    }),
    execution: Object.freeze({
      status: 'pending-inputs',
      receipt: 'pending',
      qualification: 'closed',
    }),
  });
}

export const PENDING_M46_SLOT_BINDINGS = Object.freeze(
  modes.flatMap(mode => platforms.map(platform => pendingSlot(platform, mode))),
);

export function getPendingM46Slot(id) {
  return PENDING_M46_SLOT_BINDINGS.find(slot => slot.id === id) || null;
}

export function isM46ExecutionEligible(slot) {
  return Boolean(
    slot
      && slot.execution.status === 'ready'
      && slot.execution.receipt === 'pending'
      && slot.bindings.provider.state === 'ready'
      && slot.bindings.trusted_collection_and_verifier.state === 'ready'
      && slot.bindings.source_profile.state === 'ready'
      && slot.obligation_key.qualification_id
      && slot.obligation_key.obligation_id,
  );
}
