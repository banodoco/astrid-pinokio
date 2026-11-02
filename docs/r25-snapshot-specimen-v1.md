# R-25 snapshot producer specimen v1

This document defines the Pinokio-owned specimen at
`tests/fixtures/r25-snapshot-specimen-v1.json` for the R-36 snapshot checker.
It is a versioned interface fixture, not a hosted-run result.

## Non-evidence boundary

The fixture has `synthetic: true`, `execution_evidence: false`, and
`qualification: false`. Its workflow, run, attempt, job, and artifact fields
are synthetic sentinels. `artifact_id` is intentionally `null`. No checker may
accept this file as an execution receipt or qualification evidence.

The real producer refs and tuple hashes are retained so the fixture exercises
the binding shape without inventing a workflow identity:

- Pinokio producer/candidate: `95aafb5a029c3f53cb2268d8596909eab0deb3c4`
- Agent collector: `a6b68d5b5478326a4db1971966d33a2cfe61d091`
- R-36 interface reference: `010e8f25c70109f0a93a6fccb0a16f7f40e06739`
- `CURRENT-TUPLE.json` SHA-256: `71a738081dba7f84bea0b882a975cd540b62684e8f6f1fa0d99f572e62908e50`

## Exact request binding

The nested `request` is the request consumed by Agent's
`SnapshotSession` and validated by
`pinokio/providers/r25-native-collector-binding.cjs`:

| Request field | Binding |
| --- | --- |
| `schema` | `astrid.r25.pinokio-snapshot-request.v1` |
| `slot_id` | One of the four Pinokio macOS/Windows slots; this specimen uses `pinokio-backend-macos` |
| `tuple` | Exact `CURRENT-TUPLE.json`, including manifest and all three bootstrap/install hashes |
| `collector.agent_ref` | Agent collector head above |
| `collector.pinokio_ref` | Pinokio producer/candidate head above |
| `collector.sources` | Exact SHA-256 map for the three Agent collector modules and two Pinokio platform validators |
| `origin` | Repository/workflow/run/attempt/head/job/artifact fields; synthetic in this fixture and externally authenticated for a real run |
| `actions` | Exactly `start`, `ready`, `stop`, `update`, `rollback`, `uninstall`, in that order; unique action ID and digest per action |
| `targets` | Exact OS target set; macOS uses `launchd_targets`, Windows uses scheduled-task paths and service names |

The request binding digest is the SHA-256 of Agent's canonical JSON request
(sorted keys, compact separators, ASCII JSON). It is exposed by
`SnapshotSession.binding_digest` and copied into every observation and the
final receipt.

## Observation and finalization contract

For every action, the producer must retain this order:

1. `before`, sample `0`: immediately before invoking the action.
2. `during`, sample `0`: the immediate in-action sample.
3. Zero or more additional `during` samples, sampled at the configured interval
   and never beyond `max_poll_samples`.
4. `boundary`, sample `0`: the final after-action boundary sample.

In the existing Agent schema, `boundary` is the after-action snapshot; there
is no separate `after` phase. Each observation carries the request tuple,
origin, collector refs/source hashes, binding digest, action binding, action
index, phase, sample, timestamp, and platform structural digest. The minimum
closed inventory is 18 observation files (three per action); bounded polling
may add files.

Finalization must fail closed unless all six actions are present, ordered,
unique, and observed successfully; every action has one `before`, at least one
`during`, and one `boundary`; the request and all observations are regular
non-symlink files; the root contains only `request.json`, `observations/`, and
the generated `snapshot-receipt.json`; every declared file hash and JSON
binding still matches; and no extra or missing observation exists. The
producer emits `qualification: "requires-r36-verifier"` and
`m4_6_acceptance: false` even after local finalization.

## Authenticated joins required before qualification

R-36 must independently join all of the following; values copied from this
synthetic specimen are claims only:

1. Repository, workflow ref, workflow SHA, run ID, run attempt, and run head
   SHA to the hosted workflow run.
2. Producer job ID/name to the same run and the declared slot.
3. Artifact name and the platform-assigned artifact ID to the same producer
   job/run. A producer `artifact_id: null` is never authority; it requires an
   external artifact-origin join.
4. Candidate App/Agent/Runtime/Pinokio refs, manifest SHA-256, all three
   bootstrap/install hashes, and publication timestamp to the accepted
   `CURRENT-TUPLE.json`.
5. Agent/Pinokio refs and every declared collector-source SHA-256 to checked
   out immutable source files.
6. Request/binding digest, observation digests, platform structural digests,
   receipt inventory, and final receipt hash to the downloaded artifact bytes.
7. Slot identity and exact six-action order to the authenticated journey
   configuration; do not substitute a component probe artifact.
8. Action/filesystem evidence for candidate-write, stop-safety, and semantic
   data-preservation claims; snapshots alone do not prove those facts.

## What this specimen is missing by design

It has no authenticated workflow/run/job/attempt/artifact identity, no native
observations, no uploaded artifact bytes, no final artifact ID, no external
origin join, and no qualification verdict. It therefore cannot satisfy R-36
or any M4-6 row. The proposed fix is to have the real journey driver build the
same request at the exact candidate, wrap all six real action boundaries in
`SnapshotSession`, upload the closed receipt under an artifact named
`r25-snapshots-<slot>-<run>-<attempt>`, and let R-36 join the hosted metadata
and artifact ID before checking the retained files.

The four implemented slots in this specimen cover macOS and Windows only.
Linux backend and fully-local slots remain separate producer inputs.
