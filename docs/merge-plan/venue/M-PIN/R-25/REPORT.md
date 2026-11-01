# R-25 journey-config schema reconciliation receipt

Status: `DISPATCH_INPUT_ONLY` / `NO_HOSTED_EVIDENCE`

This receipt records the documentation-only publication of the accepted,
non-empty M4-4a bridge on a lane derived from the accepted R-25 venue packet.
It does not alter product behavior, dispatch a hosted job, or claim R-20,
R-21, R-24, or R-25 acceptance.

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Lane | `lane/M-PIN/R-25-SCHEMA-R1` |
| Lane head | Final immutable remote SHA is recorded in the task-folder `R-25-SCHEMA-R1/REPORT.md` after commit/push verification |
| Base lane | `lane/M-PIN/R-25-JOURNEY-CONFIG-PUBLISH` |
| Base commit / parent | `58e7191d915777db86a8b597f01a98b687e02bb7` / `ca8b3bf6e6b2283c90e131c189e2ebd3e53148d6` |
| Scope | `docs/merge-plan/venue/M-PIN/R-25/` only |

## Publication disposition

- The three accepted R2 packet payload files (`RC-0-EXECUTOR-CONFIGS.json`,
  `SLOT-MAPPING.md`, and `R-21-R7-DISPATCH.md`) are unchanged byte-for-byte.
- The retry custom step in `M4-4A-JOURNEY-CONFIGS.json` is corrected for all
  three OS configurations from stale `name` syntax to the resolved M-QUAL
  contract `{"kind":"custom","bootstrap_action":"preflightStop"}`.
  The per-OS contract annotation identifies
  `banodoco/astrid-agent lane/M-QUAL/R-05-CUSTOM-STEP-SCHEMA-R1@258ccddc4fc02de864487518a45ca745e0a23855`.
- `CONFIG-BINDING.md`, this receipt, and `SHA256SUMS` are updated only to bind
  and inventory this correction.
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
05af45fb505d773dedf146ead35d3c5d46cde7735bbe81eb1361afdac895eb10  M4-4A-JOURNEY-CONFIGS.json
d9bafc0e1354af2bbf3a9e7b8d7fd4b3a8e4f1bd0a8055b2bdd369939f488b8e  CONFIG-BINDING.md
```

`SHA256SUMS` inventories the three retained packet payload files plus these
two generated files. This report and the checksum file are not self-listed to avoid a
self-referential digest; the task-folder receipt records its final hash.

## Commands and results

| Command/check | Result |
|---|---|
| `df -h .` before setup and checks | PASS; 2.2 GB then 3.2 GB available, above the required 2 GB floor |
| `/home/user/merge/kit/codex/task-clone.sh astrid-pinokio <task-folder>/product 58e7191d915777db86a8b597f01a98b687e02bb7` | PASS; exact bridge base |
| exact source verification | PASS; M-QUAL source `258ccddc4fc02de864487518a45ca745e0a23855` is fetched and its validator requires `bootstrap_action: preflightStop` |
| JSON root/schema/six-slot assertion | PASS; root exactly `linux`, `macos`, `windows`; six unique mapped slots |
| tuple and credential-like material scans | PASS; tuple exact; no credential material or invented provider identity |
| `sha256sum` and `sha256sum -c SHA256SUMS` | PASS; five retained packet payload/binding hashes |
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

The resolved M-QUAL source contract is
`{"kind":"custom","bootstrap_action":"preflightStop"}`. This task changes
no Agent-owned file. Hosted execution, provider authority, installed-product
identity, R-24 evidence, R-36 verification, and R-25 acceptance remain open
unless independently supplied. No hosted receipt exists.

PEER: M-VENUE: fetch lane/M-PIN/R-25-SCHEMA-R1 at the exact immutable SHA in the task-folder receipt; hash-verify M4-4A-JOURNEY-CONFIGS.json, CONFIG-BINDING.md, and SHA256SUMS; wire all three OS objects without `{}` fallback, pass the frozen manifest, set fail-fast: false, and keep hosted qualification fail-closed until provider authority and required terminal evidence are independently supplied.

PEER: M-QUAL: the `name`-spelled M4-4a bridge on lane/M-PIN/R-25-JOURNEY-CONFIG-PUBLISH is superseded by this lane's M-QUAL-source-aligned `bootstrap_action` bridge.
