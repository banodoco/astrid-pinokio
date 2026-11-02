# R-24 Linux Stop observation producer

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
binding cannot prove the daemon actually used those bytes.

No authentic busy/transport-unknown injection or fencing/restoration seam is
bound. This prototype executes no such control and does not automatically retry.
V1 is success-only: stdout is reserved for a complete
`astrid.r24.provider-result.v1`; failures exit nonzero with no stdout result and
a separate redacted JSON diagnostic on stderr. The caller must retain stderr as
a separate diagnostic artifact, never as a result. The current collector always
returns unavailable, so the production path cannot emit a result. It reports
not-run/unknown even if the Stop client exits successfully. Validation failures
produce a fixed `astrid.r24.producer-error.v1` diagnostic on stderr.

The internal serializer checks exactly one busy, actual safely handled unknown,
and restoration observation, each with the same request hash, run and session,
the pinned source digest, safe outcome and matching nonempty evidence bytes. It
exports only the consumer's fields and evidence digests. It does not authenticate
those inputs. Only an internal collector may supply them; no request, config,
environment variable or action output is accepted as a collector. The current
collector is deliberately closed. A future collector must independently bind the
real invocation and session, authenticate immutable sources and observations,
and establish safe controls and restoration before returning anything. The
serializer and synthetic tests do not provide those guarantees or custody.

An R-23/R-30 export requires the separately owned binding, collector/session and
authentic observation profiles; this is not that export. M-VENUE must provide
the runner-local materializer and daemon/action mapping. M-QUAL's downstream
gate and independently authenticated custody remain required.

CONFIG example (all values must be materialized for the actual runner; the
placeholder text below is not executable):

```json
{"checkouts":{"app":"/runner/app","agent":"/runner/agent","runtime":"/runner/runtime","pinokio":"/runner/pinokio"},"pterm":"/runner/pterm","node":"/runner/node","node_sha256":"<sha256>","pterm_entry_sha256":"<sha256>","unws_sha256":"<sha256>"}
```

The materializer also has to supply REQUEST with the exact immutable producer
ref and four source hashes. No local configuration creates an authenticated
observer, a qualifying session, a fault injection profile, or a remote fence.
