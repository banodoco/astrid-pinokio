# R-24 Linux Stop observation prototype

Run `python3 -B pinokio/providers/r24-linux.py REQUEST CONFIG` on Linux. REQUEST
uses the provisional `astrid.r24.provider-request.v1` shape: exact current tuple,
provider commit and SHA-256 of each of `r24-linux.py`, `r24-action.cjs`,
`r24-linux-binding.json`, and `r24-schema.json` under `pinokio/providers/`, the
pinned Stop descriptor, a 32-hex run ID, and SHA-256 of canonical CONFIG.
Canonical JSON is sorted, compact ASCII JSON with no NaN. Duplicate keys are
rejected. The producer checkout must be clean at `provider.ref` and separate
from each clean candidate checkout. CONFIG has exactly `checkouts` (absolute
app/agent/runtime/pinokio checkout roots), `pterm` (absolute checkout at the
binding's historical ref), `node` (absolute executable), and `node_sha256`,
`pterm_entry_sha256`, `unws_sha256` (raw file hashes). The `unws` hash refers to
`node_modules/unws/src/node.cjs`. These locally selected dependency hashes do not
establish an approved execution profile. The full tuple manifest and Stop bytes
are checked; this does not authenticate runner or daemon identity.

The native daemon must already be running on loopback port 42000 with the
candidate checkout registered as `/api/astrid`; the listener URI is the absolute
candidate Stop path. This is a necessary materializer input, not a verified
registration. The process invokes the historical PTerm `start pinokio/stop.js`
with the venue's fixed ref after subscribing. No shell command or caller-selected
action is executed. It keeps only counters, bounded exit data, and fixed status
strings. It does not export packets, control files, tokens or process output.
A disconnect and client exit do not identify an engine task or prove terminal
settlement; no remote cancellation is inferred from a client timeout. The
listener has no readiness acknowledgement or loss-detection, and the Stop
binding cannot prove the daemon actually used those bytes. Treat the result as
an untrusted diagnostic, never as evidence of safe Stop or qualification.

No authentic busy/transport-unknown injection or fencing/restoration seam is
bound. This prototype executes no such control, does not automatically retry,
and explicitly reports not-run/unknown. It cannot produce the provisional
`astrid.r24.provider-result.v1` because that parser requires three `safe: true`
rows and cannot express unavailable facts. M-QUAL needs a result variant with
explicit not-run/unknown and independently checked evidence semantics before
this can be consumed. An R-23/R-30 export requires the separately owned binding,
collector/session and authentic observation profiles; this is not that export.
Do not dispatch until M-VENUE provides the runner-local materializer for these
inputs and the daemon/action mapping and M-QUAL provides the compatible consumer.

CONFIG example (all values must be materialized for the actual runner; the
placeholder text below is not executable):

```json
{"checkouts":{"app":"/runner/app","agent":"/runner/agent","runtime":"/runner/runtime","pinokio":"/runner/pinokio"},"pterm":"/runner/pterm","node":"/runner/node","node_sha256":"<sha256>","pterm_entry_sha256":"<sha256>","unws_sha256":"<sha256>"}
```

The materializer also has to supply REQUEST with the exact immutable producer
ref and four source hashes. No local configuration creates an authenticated
observer, a qualifying session, a fault injection profile, or a remote fence.
