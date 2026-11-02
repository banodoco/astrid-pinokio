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

The controller uses request IDs of the form `r24-session=<session>-<phase>`.
Each action is dispatched on the socket that subscribed before processing, and
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

Success reserves stdout for one complete `astrid.r24.provider-result.v1`.
Failure exits nonzero, emits no result, and writes only a fixed redacted
diagnostic to stderr. A socket close, client exit, missing drain, mismatched
blocker, changed protected state, unavailable restoration, or export error can
never become success. Control files are removed only after all live checks pass.

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
