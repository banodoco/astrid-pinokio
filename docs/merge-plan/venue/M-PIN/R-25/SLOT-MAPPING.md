# R-25 RC-0 M4-6 slot mapping

This is the canonical M-QUAL/M-VENUE mapping for the six D9 Pinokio slots.
Each slot is attributable exactly once. The mapping is a dispatch input only;
it is not a terminal receipt or an R-25 acceptance result.

| Slot ID | OS | Runner | Shell | Channel | Mode | Venue | Required groups | Receipt |
|---|---|---|---|---|---|---|---|---|
| `pinokio-backend-macos` | macOS | `macos-14` | `sh` | `pinokio-backend` | `backend` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |
| `pinokio-backend-linux` | Linux | `ubuntu-24.04` | `sh` | `pinokio-backend` | `backend` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |
| `pinokio-backend-windows` | Windows | `windows-2022` | `powershell.exe` | `pinokio-backend` | `backend` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |
| `pinokio-fully-local-macos` | macOS | `macos-14` | `sh` | `pinokio-fully-local` | `fully-local` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |
| `pinokio-fully-local-linux` | Linux | `ubuntu-24.04` | `sh` | `pinokio-fully-local` | `fully-local` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |
| `pinokio-fully-local-windows` | Windows | `windows-2022` | `powershell.exe` | `pinokio-fully-local` | `fully-local` | M-VENUE | `interruption_recovery`, `failed_candidate_rollback`, `keep_data_uninstall`, `stop_safety` (`refused`, `unknown`) | awaiting terminal receipt |

## Immutable binding

All six rows bind to the same published RC-0 tuple:

```text
Runtime  = 47e5949465cb6f3afdfd1cb8a0e90009fd9d4020
Agent    = af5ae8afdb9829beb2bba4f811dbe97765bd72b2
App      = a55bec9ff384b5bbfee5535962880084ab2adb1b
Pinokio  = 89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4
```

The Pinokio base is the immutable published RC-0 SHA above. The nominal
documentation lane is `lane/M-PIN/R-25-EXECUTOR-CONFIG`; no product commit is
made or required.

## Handoff and acceptance boundary

Canonical packet: `RC-0-EXECUTOR-CONFIGS.json` in this task folder. M-VENUE
should consume that packet and dispatch all six rows, returning one authentic
terminal receipt per slot. M-QUAL should use this table to prevent duplicate
execution mapping.

The packet intentionally leaves run/job IDs, inner exits, checkout evidence,
`requirements/runtime.lock` SHA-256, installed-product digests, per-scenario
evidence, artifact hashes, accepted R-24/provider binding, and trusted R-36
collector/verifier results unset. Dispatch metadata, queued runs, component
native probes, and bounded adapter diagnostics do not satisfy the terminal
receipt contract. No R-25 acceptance is claimed here.
