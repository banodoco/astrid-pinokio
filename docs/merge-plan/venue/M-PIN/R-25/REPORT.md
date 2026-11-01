# R-25 venue packet R1 — RC-0 cross-machine transport

Status: `TRANSPORT_ONLY` / `DISPATCH_INPUT_ONLY`

This report records the one-time refresh of the sanitized RC-0 executor packet
after Agent publication. It does not alter product behavior, dispatch a hosted
job, or claim R-25 or R-21 acceptance.

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Lane | `lane/M-PIN/R-25-VENUE-PACKET-R1` |
| Lane head | `HEAD` — the one ordinary commit verified by final `git ls-remote` |
| Base | `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| Base parents | `1d90ddfc9f1994bc35345be9190fcb970973f031`, `9dbb6f5aa568f134b125d4c39e81066fa83ee79e` |
| Prior packet superseded | `lane/M-PIN/R-25-VENUE-PACKET` @ `04f3cd83be9b56013766399a487bbc75f3ca5942` |
| Scope | `docs/merge-plan/venue/M-PIN/R-25/` only |

## Refresh disposition

- The six canonical D9 M4-6 records, slot IDs, OS/runner/shell/channel/mode
  mapping, required scenario groups, stop-safety outcomes, and unset terminal
  fields are preserved.
- The only stale tuple field refreshed is Agent:
  `020877f12ea490308a9e5f9564c8f4a4bf77ede1`.
- Runtime remains
  `47e5949465cb6f3afdfd1cb8a0e90009fd9d4020`; App remains
  `a55bec9ff384b5bbfee5535962880084ab2adb1b); Pinokio remains
  `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4`.
- `R-21-R7-DISPATCH.md` is retained exactly: request `R-21-R7`, workflow
  `.github/workflows/r21-real-engine.yml`, runner ref and published lane head
  `fd2ef3aec33d4649747c769cff6f37dc434ef2ae`, confirmation
  `REAL_ENGINE_UPDATE_STOP_RETRY`.

## Commands and results

| Command/check | Result |
|---|---|
| `df -h .` | PASS; 5.5 GB available, above the required 2 GB floor |
| `task-clone.sh astrid-pinokio <task-folder>/repo 89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` | PASS; exact published Pinokio base |
| `git status --short --branch` before edits | PASS; clean lane at base |
| remote prior lane verification | PASS; old packet lane resolved to `04f3cd83be9b56013766399a487bbc75f3ca5942` |
| exact base / four tuple SHA assertions | PASS before editing |
| JSON parsing | PASS |
| six-count, duplicate, tuple, required-group, unset-terminal assertions | PASS |
| credential scan | PASS; no credential-like material found in packet |
| `sha256sum` and `sha256sum -c SHA256SUMS` | PASS |
| `git diff --check` | PASS |
| changed-path allowlist | PASS; only the five requested venue files |
| hosted dispatcher / GitHub Actions / RunPod API | NOT RUN |

## Coverage inventory and packet paths

M-VENUE can fetch the lane and consume:

- `docs/merge-plan/venue/M-PIN/R-25/RC-0-EXECUTOR-CONFIGS.json`
- `docs/merge-plan/venue/M-PIN/R-25/SLOT-MAPPING.md`
- `docs/merge-plan/venue/M-PIN/R-25/R-21-R7-DISPATCH.md`

The hash manifest and this report are also included:

- `docs/merge-plan/venue/M-PIN/R-25/SHA256SUMS`
- `docs/merge-plan/venue/M-PIN/R-25/REPORT.md`

The packet binds all six rows to:

```text
Runtime  47e5949465cb6f3afdfd1cb8a0e90009fd9d4020
Agent    020877f12ea490308a9e5f9564c8f4a4bf77ede1
App      a55bec9ff384b5bbfee5535962880084ab2adb1b
Pinokio  89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4
```

## Hashes

The final SHA-256 values for the three transport inputs are recorded below
after file generation; `SHA256SUMS` additionally covers this report.

```text
ed35b9dd6f4a3336dcc19f9b2bec96bd4f416937a9e5ff1518be895f83794767  RC-0-EXECUTOR-CONFIGS.json
803dbfe26a97a0b6dbe8b0d281afe1020dc851a46182bce9e9548f056a513f67  SLOT-MAPPING.md
36779788a73034b6b25636d2c7fb9a08d3114b7a1b93bb90162d8c808be19d85  R-21-R7-DISPATCH.md
PENDING_REPORT_HASH  REPORT.md
```

## Limitations and handoff

This is transport only. No product behavior, workflow, provider, installer,
Agent/Runtime/App repository, `int/r1`, credential, prior task folder, or
hosted job/API state was modified. The packet has no terminal receipts and
makes no R-25 or R-21 acceptance claim. The App re-pin has not landed, so the
published App SHA supplied for this refresh remains bound.

`PEER: M-VENUE: fetch lane/M-PIN/R-25-VENUE-PACKET-R1 at the immutable head reported by final git ls-remote; consume the exact five packet paths under docs/merge-plan/venue/M-PIN/R-25/ and run the six RC-0 rows plus the R-21-R7 request.`

`PEER: M-QUAL: prior packet lane/M-PIN/R-25-VENUE-PACKET @ 04f3cd83be9b56013766399a487bbc75f3ca5942 is superseded; use lane/M-PIN/R-25-VENUE-PACKET-R1 and the refreshed packet paths above.`
