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
