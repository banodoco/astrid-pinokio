# C6 macOS setup: integrated judgment

Owner: M-PIN / R-PIN-C6-MAC-ROWS. Base: published Pinokio int/r1 `3a6a98ae251ca126505245286e2d3e760f4348e9`. Mode: diagnostic; no qualification or release handoff.

Both terminal Luna reports were integrated before choosing the next attempt. Raw runs 41581740465, 41623159755, 41623908537 and 41625801442 distinguish three independent stops:

| Surface | First observed failure | Actual inner exit | Judgment |
|---|---|---|---|
| Backend native macOS, 41581740465 | `R-25 start PTerm timeout` at 05:38:39Z | Start/Runtime task unknown; setup PTerm transport exit 0 | Runner awaits the exit of a daemon-backed Start before reaching its later Ready/Stop. Start emitted `ASTRID_PINOKIO_READY`; independent readiness was never reached. |
| Fully-local native macOS, 41623159755 / 41623908537 | `R-25 diagnostic terminated-shell` at 10:57:48.916Z / 11:04:21.991Z | Unknown; PTY 0/signal 9 and PTerm 0 are separate wrappers | Prompt and Conda-presence checks passed. Index 2 result follows refusal; index 3 starts 45/59 ms after refusal with no result. No captured native installer error explains the marker. |
| Backend journey macOS, 41625801442 | `M4-4a executor config must explicitly disable source overrides` | No Pinokio action ran | Config/materializer/native-control seam refusal; unrelated to the PTerm wait. No invented JSON config is supplied. |

Pinned daemon `add4a674ad1ba95bb62ec427fce519fe5bf0e9bf` calls `Shell.kill()` after a stable completion prompt (`kernel/shell.js:1861-1894`); `kill()` resolves the shell, kills the PTY and emits `Terminated Shell` (`:1547-1622`). This makes routine teardown a concrete explanation for the C2 marker. The native inner command exit and signal sender remain unproven. PTerm `5be43718701c448b43daf0ce51d8935f170065bb` exits zero on stop/disconnect and its SIGTERM handler requests engine Stop. Preserve the marker refusal until a bound native exit is captured.

The earlier `95ef7e42` sentinel candidate is not sufficient unchanged: `materializeProduct()` fetches the published `3a6a98ae` product, whose shell helper lacks the sentinel, and does not retain the app-side journal. This packet adds a diagnostic-only materialization/copy-out patch. It records baseline/executed shell hashes, explicitly marks the overlay `proof_mode: diag`, and retains the bounded helper journal on first refusal without bypassing cleanup. It changes no installer transaction, matcher, refusal, terminal predicate, timeout or identity gate. It runs exactly one `macos-15` fully-local setup slot through the existing workflow path. It does not run keep-going or any Linux seed work.

Local verification: backend candidate `430de39610d5c0b239fcff2ea227e57b1d7767ff` passes 47 focused tests; patched sentinel source `95ef7e4201681f3d998744437b742e3b746e3b6d` passes 39. A separate local materialization control copies the helper into an actual disposable app and retains a real controlled inner exit 23, distinct from the wrapper exit. This is Linux control evidence, not native Pinokio execution. YAML and every Bash block parse; single-job/dispatch-only invariants and `git diff --check` pass.

`admin/row-signatures.py` reports four repeated C2 diagnostic stops and two backend config refusals; no ROW SINCE/ATTEMPTS or qualification count is changed. Existing Mac cleanup holds remain: identity unavailable, no direct daemon signal, descendants unknown. M-VENUE's `M-VENUE-MAC-HOSTED-ISOLATION-0803.md` permits a distinct disposable hosted worker/home; it does not clear or authorize signaling the old worker. R4 seed `182c91ee` / run 41631276362 remains M-VENUE's active work and is not duplicated.

See `DISPATCH-REQUEST.md` for exact single-slot requests and discriminating outcomes. The task-folder canonical receipt binds final head, test exits and artifact SHA-256 values. All setup/native inner exits remain unknown until actual native artifacts arrive.
