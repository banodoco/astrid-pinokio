# R-25 venue packet R2 — RC-0 cross-machine transport

Status: `TRANSPORT_ONLY` / `DISPATCH_INPUT_ONLY`

This report records the one-time refresh of the sanitized RC-0 executor packet
after the coherent published installable tuple became available. It does not
alter product behavior, dispatch a hosted job, or claim R-25 or R-21 acceptance.

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Lane | `lane/M-PIN/R-25-VENUE-PACKET-R2` |
| Lane head | `HEAD` — one ordinary commit; final immutable remote SHA is recorded in the task-folder report and handoff |
| Base | `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| Base parents | `1d90ddfc9f1994bc35345be9190fcb970973f031`, `9dbb6f5aa568f134b125d4c39e81066fa83ee79e` |
| Superseded packet | `lane/M-PIN/R-25-VENUE-PACKET-R1` @ `59bfb56163cd6b3b07efe1921a4f1a0e4a277cce` |
| Earlier packet superseded | `lane/M-PIN/R-25-VENUE-PACKET` @ `04f3cd83be9b56013766399a487bbc75f3ca5942` |
| Scope | `docs/merge-plan/venue/M-PIN/R-25/` only |

## Refresh disposition

- All six canonical D9 M4-6 records, unique slot/request IDs, OS/runner/shell/
  channel/mode mapping, required scenario groups, stop-safety outcomes, and
  unset terminal fields are preserved.
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

## Commands and results

| Command/check | Result |
|---|---|
| `df -h .` | PASS; 5.5 GB available, above the required 2 GB floor |
| `task-clone.sh astrid-pinokio <task-folder>/repo 89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` | PASS; exact published Pinokio base |
| exact base / clean status / remote lane head | PASS; base exact and R1 remote head `59bfb56163cd6b3b07efe1921a4f1a0e4a277cce`; R2 absent before push |
| four tuple SHA assertions | PASS before edits and after edits |
| JSON parsing | PASS |
| six-count, duplicate, tuple, required-group, unset-terminal assertions | PASS |
| credential scan | PASS; no credential-like material found in packet |
| `sha256sum` and `sha256sum -c SHA256SUMS` | PASS after manifest generation |
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
App      9d3ccda1e81383082258943207745086da2aabe4
Pinokio  89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4
```

## Hashes

The final SHA-256 values for the three transport inputs are recorded below
after file generation; `SHA256SUMS` additionally covers this report.

```text
790afd81d1ea59179e0bb6c5c83dacfb40ad0309caa696e03993193b61756cf6  RC-0-EXECUTOR-CONFIGS.json
5cb5ea6eed59932bb63cbd48bf8fa949eab9e037a036b1c5dee1a9dfe9c20b77  SLOT-MAPPING.md
36779788a73034b6b25636d2c7fb9a08d3114b7a1b93bb90162d8c808be19d85  R-21-R7-DISPATCH.md
PENDING_REPORT_HASH  REPORT.md
```

## Limitations and handoff

This is transport only. No product behavior, workflow, provider, installer,
Agent/Runtime/App repository, `int/r1`, credential, prior task folder, or
hosted job/API state was modified. The packet has no terminal receipts and
makes no R-25 or R-21 acceptance claim. M-VENUE must dispatch only from the
pushed immutable R2 lane and should hash-verify the five files before use.

`PEER: M-VENUE: fetch lane/M-PIN/R-25-VENUE-PACKET-R2 at the immutable head in the final task-folder report; consume the exact five packet paths under docs/merge-plan/venue/M-PIN/R-25/ and the six RC-0 rows plus exact R-21-R7 request.`

`PEER: M-QUAL: lane/M-PIN/R-25-VENUE-PACKET and lane/M-PIN/R-25-VENUE-PACKET-R1 are superseded; use lane/M-PIN/R-25-VENUE-PACKET-R2 and the refreshed packet paths above. No R-25 or R-21 acceptance is claimed.`
