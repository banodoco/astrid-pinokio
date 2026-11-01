# Headless Pinokio venue spike

This lane-push and manually dispatched workflow is separate from the fake-kernel CI smoke. Linux builds pinokiod at `add4a674ad1ba95bb62ec427fce519fe5bf0e9bf` from its upstream Dockerfile and installs PTerm at `5be43718701c448b43daf0ce51d8935f170065bb` using its lockfile. The Dockerfile itself uses a mutable Node base and downloads additional unpinned seed dependencies; record this limitation when interpreting a run.

The disposable registered Astrid checkout contains no installation. PTerm starts the real `pinokio/reset.js` against `pinokio://127.0.0.1:42000/api/astrid`. A separate daemon socket must observe both Reset step results, the normal stop event, and disconnect; a fresh status query must report not running. The host checks that the program directory remains absent. A CLI exit alone is not accepted. This proves only this empty-state action, not install, runtime ownership, or the six M4-6 scenarios. Missing events, timeouts, or errors fail closed.

macOS and Windows probe source checkout, native npm dependency installation and a bounded native daemon launch; they do not execute an Astrid action. Artifact data is deliberately restricted to fixed identity fields and selected action events; arbitrary daemon output, npm logs and the Pinokio home are not uploaded because they may contain sensitive data. GitHub Actions retains its own job logs. Obtain artifacts and their SHA256 checksums from the dispatched run before asserting venue results.

## Native census adapter (R-25 preparation)

`adapters/native-census.cjs` takes one macOS or Windows diagnostic process and
TCP-listener census. macOS uses `ps` and `lsof`; Windows uses CIM process data
and `Get-NetTCPConnection`. Rows include process parent/birth information and
listener owners where the OS reports them. Collection, parsing, timeout and
size errors fail the call. Process or listener sets can change during the
separate queries; executable paths can be unavailable or lack a verified byte
identity, and macOS birth times have only second precision. Outputs may contain local paths and addresses: do not upload them
without the future approved capture/redaction profile.

A census explicitly returns `continuity: unavailable` and `authority: none`.
It is not a loss-detecting source, trusted session, engine/action observer,
removal authorization, complete descendant census, or an R-30 evidence
export. R-24/R-36 must bind approved platform sources, isolation, identities,
continuity, authenticated authority and independent verification before any
M4-6 slot can execute or qualify. All six slots remain mandatory. The native
workflow runs the focused adapter tests on both hosted operating systems; the
Linux job is disabled for the R-25 lane, whose Linux jobs use the broker.

## Native observer-source capability probe (R-25-SOURCES)

`.github/workflows/r25-observer-source.yml` runs only on the named source lane.
It builds a short Endpoint Security client on macOS and calls `es_new_client`,
then deletes any created client. It tries a unique, real-time ETW session on
Windows, enables `Microsoft-Windows-Kernel-Process` (keyword `0x10`, level 5),
and stops that session in a `finally` block. It creates no ETL file, subscribes
to no macOS events, does not consume ETW events and retains no process records.
The Windows session is stopped immediately; enable success does not prove the
provider produced or delivered any events. Session start/enable/stop codes are
Win32 status codes; `4294967295` means that step was not reached. Apple codes
are from the runner SDK; the result includes the three relevant SDK constants
and explicit client-created/cleanup flags. The runner is not elevated by this
workflow. A command error or failed cleanup makes the probe step fail; a denied
source is a valid diagnostic result, never a successful custody observation.

The artifact contains only OS release, architecture, Node version and fixed
status fields. It always reports `status: unknown`, `continuity: unavailable`,
and `authority: none`. The synthetic diagnostic state machine in the focused
tests rejects missing, malformed, gapped, lost and post-terminal records; it
is not an operating-system event parser. Neither platform has an approved
source profile or complete process identity/descendant, event-loss, terminal,
initial/final census, isolation or exact-child integration here. No serialized
result grants removal authority, and these probes are not R-30 exports.

Apple requires a restricted entitlement, Full Disk Access consent and root for
Endpoint Security; message sequence numbers detect certain client drops:
[client requirements](https://developer.apple.com/documentation/endpointsecurity/es_new_client%28_%3A_%3A%29),
[sequence](https://developer.apple.com/documentation/endpointsecurity/es_message_t/seq_num),
[client result](https://developer.apple.com/documentation/endpointsecurity/es_new_client_result_t).
ETW has session loss statistics and consumer buffer callbacks; control requires
appropriate privileges: [ETW](https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing),
[control permissions](https://learn.microsoft.com/en-us/windows/win32/etw/controlling-event-tracing-sessions),
[consumer](https://learn.microsoft.com/en-us/windows/win32/etw/consuming-events).
Those API capabilities alone do not establish end-to-end completeness, or the
required terminal barrier and custody facts. R-24 and R-36 bindings remain
prerequisites; all six M4-6 slots remain unexecuted.
