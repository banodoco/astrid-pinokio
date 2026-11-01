# R-25 venue packet — RC-0 cross-machine transport

Status: `TRANSPORT_ONLY` / `DISPATCH_INPUT_ONLY`

This report records publication of the already accepted, sanitized RC-0
executor packet and slot mapping for M-VENUE, together with the exact R-21-R7
dispatch inputs. It does not alter product behavior, dispatch a hosted job, or
claim R-25 or R-21 acceptance.

## Repository and lane

| Field | Value |
|---|---|
| Repository | `banodoco/astrid-pinokio` |
| Lane | `lane/M-PIN/R-25-VENUE-PACKET` |
| Base | `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` |
| Base parents | `1d90ddfc9f1994bc35345be9190fcb970973f031`, `9dbb6f5aa568f134b125d4c39e81066fa83ee79e` |
| Working tree before packet | clean |
| Lane head | this ordinary commit; verify with `git rev-parse HEAD` after fetch |
| Scope | `docs/merge-plan/venue/M-PIN/R-25/` only |

## Packet coverage

- Six RC-0 executor rows are copied byte-for-byte from the canonical executor
  packet.
- The canonical one-to-one six-slot mapping is copied byte-for-byte.
- The RC-0 tuple is preserved: Runtime
  `47e5949465cb6f3afdfd1cb8a0e90009fd9d4020`, Agent
  `af5ae8afdb9829beb2bba4f811dbe97765bd72b2`, App
  `a55bec9ff384b5bbfee5535962880084ab2adb1b`, Pinokio
  `89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4`.
- `R-21-R7-DISPATCH.md` records the exact workflow, published lane head,
  runner ref, request ID, and confirmation supplied for R-21-R7.

## Commands and results

| Command/check | Result |
|---|---|
| `df -h .` | PASS; 5.5 GB available, above the required 2 GB floor |
| `task-clone.sh astrid-pinokio <task-folder>/repo 89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4` | PASS; exact base cloned |
| `git status --short --branch` before edits | PASS; clean branch at base |
| `sha256sum` canonical inputs | PASS; supplied hashes match |
| `python3 -m json.tool RC-0-EXECUTOR-CONFIGS.json` | PASS |
| six-count/tuple assertions | PASS; six records, six unique slots and request IDs, exact RC-0 tuple |
| credential scan | PASS; no credential-like material in packet, mapping, or dispatch input |
| `git diff --check` | PASS |
| hosted dispatch/API call | NOT RUN |

## Hashes

The packet hashes are recorded in `SHA256SUMS` and must be verified after
fetching. The canonical values are:

```text
5b3fd9a798a475f7cfa08087644e88db416d0f03c69e1ed6ac715ff138194256  RC-0-EXECUTOR-CONFIGS.json
0c6ab15d4298b00fb353d2de17ec9581dd1d5eb654c75bdfa573bd4a34b67349  SLOT-MAPPING.md
```

## Limits and handoff

This is transport only. No product files, workflows, providers, installer
code, Agent/Runtime/App, `int/r1`, credentials, prior task folders, or hosted
dispatch/API state were modified. The packet contains no terminal receipts and
does not establish R-25 or R-21 acceptance.

`PEER: M-VENUE: fetch lane/M-PIN/R-25-VENUE-PACKET at the pushed SHA; consume
the three packet paths and dispatch six RC-0 rows plus R-21-R7.`
