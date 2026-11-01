# R-25 journey-config publish receipt

Status: `PUBLISHED_DISPATCH_INPUT_TEMPLATE` / `NO_HOSTED_EVIDENCE`

This receipt records the documentation-only publication of the accepted,
non-empty M4-4a bridge on a lane derived from the accepted R-25 venue packet.
It does not alter product behavior, dispatch a hosted job, or claim R-20,
R-21, R-24, or R-25 acceptance.

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Lane | `lane/M-PIN/R-25-JOURNEY-CONFIG-PUBLISH` |
| Lane head | Final immutable remote SHA is recorded in the task-folder receipt after commit/push verification |
| Base lane | `lane/M-PIN/R-25-VENUE-PACKET-R2` |
| Base commit / parent | `ca8b3bf6e6b2283c90e131c189e2ebd3e53148d6` / `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| Scope | `docs/merge-plan/venue/M-PIN/R-25/` only |

## Publication disposition

- The five accepted R2 packet files are retained. The three packet payload
  files (`RC-0-EXECUTOR-CONFIGS.json`, `SLOT-MAPPING.md`, and
  `R-21-R7-DISPATCH.md`) are unchanged byte-for-byte; `SHA256SUMS.md`-style
  inventory and this receipt are updated only to record the bridge.
- `M4-4A-JOURNEY-CONFIGS.json` and `CONFIG-BINDING.md` are copied byte-for-byte
  from the accepted `R-25-JOURNEY-CONFIG` deliverables.
- The bridge root is exactly `linux`, `macos`, `windows`; each OS has one
  `pinokio-backend` and one `pinokio-fully-local` row, for exactly six unique
  slots. No D9 row, product source, workflow, Agent harness, or frozen
  six-slot semantic was changed.
- Runtime remains
  `47e5949465cb6f3afdfd1cb8a0e90009fd9d4020`.
- Agent remains
  `020877f12ea490308a9e5f9564c8f4a4bf77ede1`.
- App is refreshed to
  `9d3ccda1e81383082258943207745086da2aabe4`.
- Pinokio remains
  `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4`.
- `R-21-R7-DISPATCH.md` retains request `R-21-R7`, workflow
  `.github/workflows/r21-real-engine.yml`, head/runner ref
  `fd2ef3aec33d4649747c769cff6f37dc434ef2ae`, and confirmation
  `REAL_ENGINE_UPDATE_STOP_RETRY`.

## Generated-file hashes

```text
f64139c53918493b7c940dc8d44be536dd16bcf4e29870711ef51d5dd985f9e8  M4-4A-JOURNEY-CONFIGS.json
e06d802e938da252b3285d3a9e9b5b336dc186d3144268ba96a1b8bd516e2fcc  CONFIG-BINDING.md
```

`SHA256SUMS` inventories the three retained packet payload files plus these
two generated files. This report and the checksum file are not self-listed to avoid a
self-referential digest; the task-folder receipt records its final hash.

## Commands and results

| Command/check | Result |
|---|---|
| `df -h .` | PASS; 4.5 GB available, above the required 2 GB floor |
| `/home/user/merge/kit/codex/task-clone.sh astrid-pinokio <task-folder>/astrid-pinokio ca8b3bf6e6b2283c90e131c189e2ebd3e53148d6` | PASS; exact accepted packet base |
| exact base / branch creation | PASS; base `ca8b3bf6e6b2283c90e131c189e2ebd3e53148d6`, parent `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| source-to-venue `cmp` | PASS; JSON and binding note byte-for-byte identical to accepted source |
| JSON root/schema/six-slot assertion | PASS; root exactly `linux`, `macos`, `windows`; six unique mapped slots |
| tuple and credential-like material scans | PASS; tuple exact; no credential material or invented provider identity |
| `sha256sum` and `sha256sum -c SHA256SUMS` | PASS; five retained packet payload/receipt hashes and two added-file hashes |
| `git diff --check` | PASS |
| changed-path allowlist | PASS; only bridge, binding note, `SHA256SUMS`, and `REPORT.md` under venue path |
| commit / non-force push / `git ls-remote` | Recorded in the task-folder receipt after publication |
| hosted dispatcher / GitHub Actions / RunPod API | NOT RUN |

## Coverage inventory and paths

M-VENUE can fetch the lane and consume:

- `docs/merge-plan/venue/M-PIN/R-25/RC-0-EXECUTOR-CONFIGS.json`
- `docs/merge-plan/venue/M-PIN/R-25/SLOT-MAPPING.md`
- `docs/merge-plan/venue/M-PIN/R-25/R-21-R7-DISPATCH.md`
- `docs/merge-plan/venue/M-PIN/R-25/M4-4A-JOURNEY-CONFIGS.json`
- `docs/merge-plan/venue/M-PIN/R-25/CONFIG-BINDING.md`

The hash manifest and this report are also included:

- `docs/merge-plan/venue/M-PIN/R-25/SHA256SUMS`
- `docs/merge-plan/venue/M-PIN/R-25/REPORT.md`

The packet binds all six rows to:

```text
Runtime  47e5949465cb6f3afdfd1cb8a0e90009fd9d4020
Agent    020877f12ea490308a9e5f9564c8f4a4bf77ede1
App      9d3ccda1e81383082258943207745086da2aabe4
Pinokio  89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4
```

## Limitations and handoff

This is transport only. The bridge is a non-empty dispatch-input template, not
a hosted-ready provider binding. Its runner checkout tokens must be
materialized and all listed refs/file hashes reverified by M-VENUE. No real
Pinokio engine/adoption provider, provider executable identity, platform spec,
runtime identity, installed-product identity, fixture, or credential identity
is asserted or fabricated. Missing provider/spec/hash/action-array checks are
hard pre-dispatch failures.

The pinned Agent custom-step seam remains unresolved: `ci_journey.py` requires
`{"kind":"custom","name":"preflightStop"}`, while the backend validator
requires `{"kind":"custom","bootstrap_action":"preflightStop"}`. This
task changes no Agent-owned file. M-QUAL/M-VENUE must resolve or gate that seam
before treating the config as dispatchable. No hosted receipt exists and no
R-20, R-21, R-24, or R-25 acceptance is claimed.

`PEER: M-VENUE: fetch lane/M-PIN/R-25-JOURNEY-CONFIG-PUBLISH at the exact immutable SHA in the task-folder receipt; hash-verify M4-4A-JOURNEY-CONFIGS.json and CONFIG-BINDING.md, wire all three OS objects without {} fallback, pass the frozen manifest, set fail-fast: false, and keep hosted qualification fail-closed until the provider and pinned Agent schema seam are resolved.`
