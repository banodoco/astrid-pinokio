# R-23 — Pinokio observation producers

Design only; submitted for direct M-INT approval. **NEEDS: R-23 design review.**

Base: published Pinokio `int/r1` `8d8e1b46948f6a0cdf8d3f81f4db3f14c21f11b2`.
Interface: approved R-30 `astrid-qualification/v1`, especially §§3–5 and §10,
at `docs/merge-plan/handoff/inputs/M-QUAL-R-30-verifier-interface.md`, SHA-256
`2f685c8aec21bef116f95645920717e4b12ef33c1ca820fe6185eb01ffea115d`.
The 2026-10-31T23:37:14Z M-PIN orchestration direction overrides that packet's
signing provisions: **no signing/PKI**. Execution provenance comes from the
orchestrator's RunPod broker journal and GitHub Actions run IDs, with retained
records and artifact hashes bound into an evidence index. Hashes bind bytes;
producer declarations and workflow success do not establish their truth.

## 1. Boundaries and current evidence

R-23 specifies producers of facts with observation IDs. R-24 implements Linux;
R-25 supplies native macOS/Windows bindings. R-36 owns qualification predicates,
trusted collection/session wiring, provenance validation and aggregation. This
packet implements nothing, changes no shared schema, and claims no live result.
M-INT must approve this document's raw-byte digest together with the interface
digest and the no-PKI direction before `contract_sha256` has an authorized value.

At the base, `pinokio/lib.js:stopOwnedStart` orders read-only preflight,
controller shutdown, native engine stop and installer-lock verification.
`pinokio/lifecycle.mjs` supplies the installed-Python preflight, private loopback
controller request and bounded calls; `pinokio/session.mjs` owns foreground
Runtime/editor children, final fenced `down`, and readiness/identity probes.
These are product seams, not authenticated observation producers. Never export
the controller bearer token or raw control file.

R-20 branch `lane/M-PIN/R-20` at `dcb20e9a56874c47136f1934fb5c0d537e776454`
contains an empty-state Reset probe: two step results, stop/disconnect events,
then an idle query. It has no authentic venue receipt here, and this combination
does not establish a general engine terminal source. The existing Agent
`PinokioRequestSettlement` likewise keeps result/stop/disconnect unknown without
task readback; its live owner refuses admission and its OS observer is polling
only. Preserve those refusals. Historical daemon `add4a674…` and PTerm
`5be43718…` identify inspected inputs, not approved deployment pins.

## 2. Export and observation contract

Use the exact R-30 §3.1 export schema, without extra envelope fields:

```text
kind="r23-export", version=1, owner_kind="pinokio"
binding={qualification_id,tuple_sha256,inventory_sha256,obligation_id,
         attempt_id,nonce,origin_sha256,execution_sha256}
contract_sha256, session_id, status, checks, observations, continuity, files
observation={id,kind,file,sha256,sequence}
file={path,role,sha256,size}; check={id,result,observations:[observation IDs]}
```

The broker/approved collector supplies the binding and opaque session; caller
JSON, environment values and a checkout SHA alone cannot create authority.
Origin/execution records retain broker request/job identity or Actions repository,
workflow revision, run ID/attempt and numeric job ID, plus observed runner,
command/input and collector/provider byte identities. Logical slot IDs remain
distinct from numeric jobs. Preserve family/scenario/OS/mode/channel and selected
attempt in the frozen inventory mapping, even when two scenarios share a job.

Allocate IDs such as `obs-000001` once per export, scoped by binding/session;
sequences start at 1, increase contiguously, and are never reused or renumbered
to conceal loss. Each observation refers to an exact raw payload file and hash
also present in `files`. Payloads record phase, source/parser profile digest,
source instance/sequence and collection time, request/operation/incarnation
references as applicable, and the observed values or explicit unavailable/error
facts. Payload schemas and parser revisions must be frozen with R-36 before
admission; the field groups below are their required content, not new envelope
properties. An inferred relationship records its supporting observation IDs.

`checks` use inventory-approved IDs and reference those raw IDs. Provider
`pass` means only the named capture/producer check completed; it cannot certify
settlement, stop safety, custody or a release scenario. R-36 recomputes those
predicates. Distinguish an observed expected refusal from a collector failure.
Missing facts yield `unknown`, a known contradiction/cleanup failure yields
`fail`, and an unexecuted capture yields `not-run`; none qualifies. If mandatory
binding/profile/continuity fields cannot be truthfully populated, retain a
failure diagnostic for R-36's missing-evidence closure rather than fabricating
a schema-valid successful export or placeholder digest.

## 3. Required producers (R-30 §5)

| Producer / proposed observation kinds | Raw facts and source boundary |
|---|---|
| Engine/action: `engine-binding`, `action-snapshot` | Measured daemon/PTerm executable hashes and versions, engine instance/boot, registered app/resource/root, launcher checkout and exact request bytes; evaluated start/stop/update descriptors and static/dynamic helper/dependency closure. Capture pre-pull assembled actions and post-pull inputs separately, including wrappers and selected installed tools. Unresolved dynamic imports close admission. |
| Settlement: `engine-request`, `engine-event`, `engine-terminal`, `installer-journal`, `readiness` | Request-to-engine execution/task mapping, ordered source events and terminal outcome; installer operation ID, durable journal phase/terminal record and linked native job IDs; independent final process, selected executable and readiness responses. Terminal source remains open (§8). |
| Busy/unknown: `fault-before`, `fault-installed`, `fault-observed`, `fault-after` | Real precondition and exact seam/profile, request and controller incarnation, injection scope/time, independent refusal or uncertainty, protected-state and mutation observations (§5). Retain actual structured errors; injected stdout is insufficient. |
| Restoration: `fault-removed`, `fence`, `restoration`, `final-census` | Original and restored transport/controller/checkout/Runtime identities, pending request disposition, exact-child completion, independent readiness/data/sentinel facts and cleanup failures (§6). |
| Session/custody: `session-binding`, `custody-census`, `custody-event`, `removal-plan` | Principal, manager/engine definition and action bytes, controller/Runtime/editor/descendant PID plus birth and boot identities, executable hashes, listener owners, roots and lock/journal identities, exact removal set, event-source loss counters and final census (§7). |
| M4-4a: `old-launcher-action`, `first-click`, `stop-retry` | Authentic assembled old action and helper closure, old/new provenance, first-click outcome, Stop/retry, immediate readiness and Stop → Start observations. Adopted ancestry/profile must be reconciled; historical constants are insufficient. |
| M4-4b: `editor-before`, `editor-advance`, `build-failure`, `build-restoration` | Real editor advance, controlled build failure, before/after checkout and selected Runtime identities, readiness and semantic data. The base still updates Runtime before building; the directed R-22 staged-build change is an unmet prerequisite, not an implemented guarantee. |
| M4-6: reuse the above with explicit scenario phases | Same-operation interruption/recovery and terminal journal, failed-candidate rollback to the actual healthy R0 executable, keep-data uninstall, refused and unknown stop-safety observations; project/document/preferences/CAS facts, absence of owned processes/service and survival of an unrelated sentinel. R-36 evaluates the conjunction. |

## 4. Settlement correlation

Subscribe and establish observer readiness before dispatch; bind one request to
one approved engine instance, app/resource and evaluated action. Record any
engine-assigned task ID and its actual mapping to the request, then every
ordered event through exactly one engine terminal outcome and source closure.
Do not assume a client request ID is echoed by the engine or synthesize task
IDs from timestamps. Correlate installer operation/journal/native jobs through
observed identifiers, not coincident log lines. Engine terminal success and
installed health are separate facts; neither substitutes for the other.

Queued/accepted status, PTerm exit, socket disconnect, a ready sentinel and
workflow success are supplemental facts only. A daemon Start can remain active
after readiness; record readiness separately and require the profile's terminal
observation at its eventual Stop. Missing/unrelated/duplicate terminal events,
post-terminal action data, ambiguous correlation, timeout, engine restart or
source loss close the attempt as unknown/fail. R-20 must establish the genuine
terminal API/event/readback, its semantics and correlation on an adopted engine.
If no adequate source exists, record that limitation and keep live admission
closed; no terminal endpoint or successful engine behavior is invented here.

## 5. Busy and unknown injection

Run separate refused and unknown cases for each required slot. Begin with an
independent census of controller/Runtime/editor incarnations, selection,
checkout, journal and semantic data, plus an unrelated sentinel. Retain observer
coverage for candidate filesystem writes, downloads, job admission and retries;
equal before/after snapshots alone cannot prove their absence during the test.

For **busy**, establish a real Runtime task/blocker through an approved product
path, observe its ID/state and the actual preflight/fenced-down refusal, and
retain its progress plus unchanged protected identities. Do not replace the
command with a scripted busy message. For **unknown**, interrupt the real
read-only stop-safety/controller transport at an approved seam before mutating
stop authority can be exercised, observing dropped/delayed/unreadable transport
and the caller's uncertainty independently. Do not kill the Runtime to create
unknown, or forge a return value. The precise venue seam and profile are open.

The observed refusal/uncertainty must precede native tree cleanup, candidate
write/download/admission, selection changes or automatic retry; record any
violation as failure. An uncertain reply to an already dispatched mutating stop
cannot prove this unchanged-state case: fence and reconcile it, retain the
failure/unknown outcome, and do not retry or reinterpret it as success.
Existing dependency-injected unit tests are development evidence only.

## 6. Restoration and fencing

Save exact seam configuration and original identities before installation.
In an unconditional finalizer, stop new dispatch, remove the seam, and drain or
cancel/fence every in-flight callback/request against the bound controller and
engine incarnation. A local timeout does not cancel remote work. Record a
source-backed barrier/terminal disposition; if the venue cannot prove fencing,
invalidate the session, prohibit reuse and retain cleanup failure. Never issue
an automatic mutating retry. A deliberate post-restoration test retry needs
its own request ID within the approved scenario; a replacement attempt needs
a fresh session/nonce and retains the previous failure.

Independently re-observe original transport configuration, controller and
selected Runtime/checkout identities, readiness, semantic data and sentinel,
then complete the final census and reap the exact collector child. Busy-task
release uses its approved product path after the preservation interval.
Restoration grants no new process-kill or data-restore authority. Failed seam
removal, late work, identity drift or incomplete cleanup fails finalization
even when the product correctly refused the original request.

## 7. Live session and custody

Retain the R-30 §5 API order: `open_authenticated_session(binding, owner)` →
`bind_exact_custody(binding, owner)` → single-use
`authorize_exact_removal(request, owner)` → independently verified
`finalize_after_removal(observation, owner)`; `abort(reason)` permanently revokes
the context. The binding/observation arguments constrain collection; they do
not supply authority. No serialized session or environment-selected factory.
Keep `PINOKIO_CUSTODY_PROVIDER.create_owner(...)` as the fixed six-slot factory:
`pinokio-{backend,fully-local}-{linux,macos,windows}`. No native-service fallback.

Bind an approved observer before mutation. At authorization and finalization,
recheck principal, engine/manager/action definitions, exact controller/Runtime
and descendant incarnations, executable bytes, listener owners, owned roots,
locks/journal and removal-set equality. Refuse PID reuse, unknown descendants,
definition drift or expanded removal. Observe final absence of owned objects
and survival of unrelated objects independently of the removal return value.

Continuous custody requires loss-detecting OS sources with initial/final
censuses and source sequence, gap/drop and terminal counters. Export continuity
as `{source_profile_sha256,first_sequence,last_sequence,event_count,gaps,
dropped,terminal}` with the R-30 relations; contiguous export numbering does
not prove complete OS coverage. Polling and equal snapshots cannot establish
continuity. Loss, overflow, observer/collector fork or lineage loss, EOF before
closure, code drift, unknown exit or failed exact-child reap aborts the parent
session. Per-OS source completeness and isolation are still unbound (§8).

## 8. Evidence export and implementation prerequisites

Use R-30-CJSON-1 for structured bytes (unique keys, safe integers, no floats,
unknown fields or versions); raw files are hashed without normalization.
Sort files by path, checks by ID and observations by sequence; reject duplicate
identities/sequences, dangling references and mismatched hashes. Copy only
run-owned allowlisted evidence using stable handles and recheck bytes/identity;
reject link/reparse traversal, unsafe relative paths and portable-name collisions.
Keep required failure and cleanup logs, with secrets omitted and any truncation
explicit. Missing required evidence cannot become a passing capture.

Respect R-30 §4 limits: 1,024 payload files, 4,096 observations, 1 MiB per
structured record, 50 MiB total payload/archive, or tighter inventory limits.
`export.files` lists raw evidence, claims bundle and required legacy receipt,
excluding the export and external provenance/index records. Hash the export,
claims bundle and canonical file list, then the finished archive. An external
evidence index binds those digests, immutable artifact location, binding and
selected attempt to retained broker-journal records and Actions run/attempt/job
records, workflow/code revisions and terminal command/job results. The index
does not include its own hash; its digest is recorded in the review/handoff.
No signatures, keys, PKI or synthetic signature records. R-36 checks provenance
against the orchestrator's records and recomputes predicates from raw bytes.

| Open binding | Required before affected live implementation/admission |
|---|---|
| R-30 O1 / contract | M-INT approval binding this design commit/file hash, interface hash, no-PKI direction, adopted payload/parser profiles and provider code identity. This packet supplies the proposed agreement, not an approval receipt. |
| R-20 / O4 engine and faults | Authentic Linux action evidence; adopted engine/PTerm/app identities; actual terminal source, request/task/journal correlation and event closure; real busy/unknown seams and source-backed restoration/fencing. Current R-20 report/awaiting note leave these unresolved. |
| R-20 / R-25 venues | Native macOS/Windows dependency, process, path, stop and observation findings plus authentic action/custody evidence. Linux cannot prove them. D9 retains all six M4-6 Pinokio slots; no reduction is made. Linux uses the approved broker venue; native legs use Actions. |
| R-30 O2/O3/O5 / R-36 | Complete frozen tuple/inventory/phase identities and commands, broker/Actions-to-index mapping, protected collector/session boundary, per-OS loss-detecting sources, exact-child finalization, independent data/journal/listener probes and retention profile. No unavailable identity is filled with a historical default or zero. |
| R-21/R-22/R-06/R-15 | Authentic old-launcher stopped-path evidence, staged-editor-build failure behavior, approved stand-in R2 and recovery bindings. `docs/INTERFACE.md` flags historical native Stop swallowing hook errors and Quit bypassing the hook; no busy/unknown safety claim for these paths is established. |

R-24/R-25 should verify the producer boundaries with missing/foreign/duplicate
terminals, source loss, genuine busy/unknown conditions, delayed callbacks and
failed seam restoration on their adopted venues. R-36 owns adversarial
provenance/schema checks and every release predicate. Fake-kernel/local-process
smoke remains separately labelled PR feedback. Approval of this short design
neither clears these prerequisites nor qualifies M4-4a/M4-4b/M4-5/M4-6.
