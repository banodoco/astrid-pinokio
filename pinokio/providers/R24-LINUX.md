# R-24 Linux live action and observation producer

Run the producer only on the Linux host that owns the already-running pinned
Pinokio daemon:

```text
python3 -B pinokio/providers/r24-linux.py REQUEST CONFIG [EXPORT_DIRECTORY]
```

`REQUEST` is canonical `astrid.r24.provider-request.v1` JSON. It binds the
recorded candidate tuple, the immutable provider commit and SHA-256 of every
path in `r24-linux.py:FILES`, the pinned Stop descriptor, a 32-hex run ID, and
the SHA-256 of canonical `CONFIG`. Canonical JSON is compact, sorted ASCII with
no duplicate keys or non-finite values. The provider checkout must be clean at
`provider.ref`; every candidate checkout must be clean, distinct, and at the
recorded tuple. The recorded tuple and manifest are an export candidate, not a
new qualification.

The bound Release-1 tuple is App
`ce1502e94b935fe6ef1e2f363fc6b55aade4a204`, Agent
`2de0726d1eaea7f7bd141251e088aa9fdf224525`, Runtime
`5453366458f7b4ee874c94d15ae7952e3e82d3c3`, and Pinokio
`3a6a98ae251ca126505245286e2d3e760f4348e9`. The App manifest SHA-256 is
`920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87`.

`CONFIG` has exactly these fields:

```json
{"checkouts":{"app":"/runner/app","agent":"/runner/agent","runtime":"/runner/runtime","pinokio":"/runner/pinokio"},"pterm":"/runner/pterm","pinokiod":"/runner/pinokiod","node":"/runner/node","node_sha256":"<sha256>","pterm_entry_sha256":"<sha256>","unws_sha256":"<sha256>","engine":{"pid":123,"boot_id":"<linux-boot-id>","start_ticks":"<proc-start-ticks>","pinokio_home":"/runner/pinokio-home","port":42000},"scratch_root":"/runner/private-existing-scratch"}
```

The collector checks the exact historical daemon checkout and pinned daemon
source hashes, PTerm ref and dependency bytes, Node bytes, Linux boot/process
birth, daemon cwd/executable/command, `PINOKIO_HOME`, and ownership of the
listening socket. `pinokio_home/api/astrid` must be an exact materialization of
the candidate Stop/lifecycle bytes and immutable provider action bytes. A real
managed Runtime must already be installed under
`pinokio_home/api/astrid/app/astrid`, with a selected realm and at least one
actual `running` or `cancel_requested` task. The producer does not create a
synthetic task and will fail closed if genuine busy state is absent.

The hosted installer environment is also bound to the authenticated daemon:
`HOME` must be `pinokio_home/user-home` and `XDG_DATA_HOME` must be
`pinokio_home/xdg-data`, both canonical runner-owned directories. The installed
Agent record must retain the exact lexical Linux venv interpreter at
`version_root/py/bin/python`, with an unlinked parent. A normal interpreter may
resolve inside `version_root`; a symlink may resolve outside it only to the
manifest-pinned uv target under
`XDG_DATA_HOME/astrid/bootstrap/python/cpython-<pin>-linux-<machine>-gnu/bin/python<major>.<minor>`.
The producer hashes and process-binds that resolved regular target but gives
the lifecycle action the lexical venv path. Lexical escapes, parent links,
wrong pins or platform shapes, linked bootstrap roots, target changes and
two-hop escapes fail closed.

The active task must have a claimed `execution_bindings` row whose
`session_id` and `runtime_epoch` equal the selected realm's live
`runtime_lifecycle` row. Runtime discovery, instance lock, catalog owner,
Linux process birth/executable, selected realm and database must agree. The raw
observations retain the real Runtime PID, instance, session, epoch, endpoint,
realm, task/run/binding/executor/target identities, and protected snapshots.
No producer-generated identifier substitutes for those Runtime facts.

## Venue-owned real Runtime setup

The same Linux job must start the installed candidate Runtime through its
normal Pinokio session, authenticate the installed Agent client to the selected
Runtime, select an installed local execution profile/capability, and use the
real client operations `health()`, `start_local_worker(...)` when needed,
`admit_task(..., execution_request={"target": ...})`, and `get_task(...)` until
the admitted task is genuinely `running`. The provider is invoked only then.
It never writes the Runtime database, registers a fake capability, or creates a
task itself. The venue remains responsible for bounded post-observation task
settlement and unchanged same-job artifact upload.

Those operations are pinned to these source bytes:

| Owner/path | SHA-256 |
|---|---|
| Agent `astrid_runtime_client/generated.py` | `a37270d78067610509b25f64f45ac55a57d9e43506fc172a0747277069845c79` |
| Runtime `runtime_protocol/server.py` | `15c0b2ed0ccdce05ff4f854211a3536d906f99b5f0c71df6ee990beef69160b7` |
| Runtime `runtime_protocol/service.py` | `2459624249500779bc65aa409e28da607a21d1592e2e02aa438821da2686fe66` |
| Runtime `runtime_protocol/daemon.py` | `7f1ebbc9a658785a61ade692d4b27c259daae4b07f8ae184546f91057353dfeb` |
| Runtime `runtime_protocol/local_worker.py` | `168b15be9801fc13b3d0da4565255deeac6f1afb200ad1dab09351442ed9e03d` |
| Runtime `runtime_protocol/local_execution_supervisor.py` | `bdffdf2d22c3ee2196ddc4747b0ad215fb20e75df0e1bdbd66c37b8e9536f5fd` |
| Runtime `contract/openapi/workspace-v1.yaml` | `5d34e8e475406224bd1c6b95fa8f07b0a54c5b3e2f153fe06b03587495ed699b` |
| Runtime `contract/schemas/task.json` | `15e7e63186eae0eec8132198ff7a70a5f7d1e5d3df88f6136fa41f2c4347c07b` |

`r24-linux-binding.json` contains this inventory, and validation checks every
checkout file and Git blob before the controller is invoked.

The controller uses fixed Pinokio endpoints
`~/api/astrid/pinokio/providers/r24-live-action.js` and
`~/api/astrid/pinokio/stop.js`. Each exact request ID is that endpoint plus the
query `?r24-session=<session>-<phase>`; this is both uniquely correlated and a
valid stoppable ID for the pinned engine. Each action is dispatched on the socket
that subscribed before processing, and
only packets carrying that exact ID are accepted. A probe requires one result,
the engine `stop` event, disconnect, and an idle status query. Busy is read by
the engine-loaded `r24-live-action.js` through the candidate's actual
`preflightStop`; the candidate `stop.js` must then refuse and name every real
blocker. The exact request is fenced with Pinokio's listen/stop/status protocol.

For the safely handled unknown case, the action invokes the same installed
Runtime preflight but supplies a single-use runner that accepts only the exact
pinned Python command and preflight code. It holds that child with `SIGSTOP`,
records the child identity, waits until the observer has disconnected and the
venue-side control is armed, then closes its pipes and sends `SIGKILL`. No
Runtime controller or mutation command is called. The abandoned engine request
is fenced explicitly. Restoration reruns the real preflight and must reproduce
the same blocker set with a complete result/stop/disconnect terminal and an
idle status. Independent read-only snapshots before and after must match,
including installed records, catalog/discovery/instance records, selected
realm/database identity, and the actual active-task census.

Success reserves stdout for one complete `astrid.r24.provider-result.v1`; its
exact v1 shape is unchanged. The busy raw observation also contains
`astrid.r24.action-invocation.v1`: request/run/session/source and
Pinokio-engine binding, signed inner return code (plus explicit exit/signal),
and the exact bounded controller stdout and stderr as Base64 with byte counts
and SHA-256. `raw_result_validated=true` only after the decoded stdout passes
the complete live-result validator; the other two observations bind its
canonical digest. Failure exits nonzero, emits no result, and writes a
diagnostic to stderr. If the controller started, that diagnostic retains the
same bounded invocation record; errors raised before dispatch retain only the
fixed unknown action diagnostic. A socket close, client exit, missing drain,
mismatched blocker, changed protected state, unavailable restoration, or export
error can never become success. Control files are removed only after all live
checks pass.

If `EXPORT_DIRECTORY` is supplied, it must be an absolute nonexistent leaf
under existing non-symlink directories. A successful run creates exactly:

- `junit.xml`
- `manifest.json`
- `observation-result.json`
- `observation-busy.json`
- `observation-unknown.json`
- `observation-restoration.json`

The three raw observations retain the source-backed engine/process, request,
session, run, fence, drain, task, and protected-state bindings. The manifest
contains their byte counts and SHA-256 values and explicitly says
`qualification: not-evaluated`. The JUnit case is skipped. There is no
caller-supplied observation input.

This producer establishes runner-local source and action/session bindings. It
does not authenticate GitHub Actions identity, artifact custody, or R-24
qualification. The venue must upload the unchanged six-file directory from the
same invocation and bind its dispatch/session record. The C-06g-R5 consumer
must receive `lane.repo` plus an exact hosted `lane.source` containing
`repo`, `workflow_path`, `workflow_revision`, `run_id`, `run_attempt`, `job_id`,
`artifact_id`, `artifact_name`, and `head_sha`; it independently checks the
successful run/job, artifact identity and archive digest. Canonical Linux
M4-4a/M4-4b/M4-5 receipts and the downstream qualification decision remain
separately required.
