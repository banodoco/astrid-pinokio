# Task L validation and handoff

## GitHub CI

- **Unit** runs the launcher tests on Ubuntu, macOS and Windows with Node 20.19.4. The spec reporter prints skipped tests with their names and reasons.
- **Pinokio smoke** runs Install, Start, health, Stop, Update, ready/health without a manual Start, Stop, Start, health, Stop and Uninstall on macOS, Ubuntu and Windows inside a temporary Pinokio home. It checks the downloaded FFmpeg pin, cache/data paths, service registration and port cleanup.
- **Fully local** is manual-only (`workflow_dispatch`). It installs and builds the local editor on Ubuntu, starts it on port 5180, checks the Runtime health proxy, and confirms the hosted browser door port stays closed (`--hosted-origin off` creates no door).

CI runs for pushes to the configured release and production branches, pull requests, manual dispatches, and nightly upstream-drift checks.

Jobs have hang guards: 5 minutes for Unit and 15 minutes for Pinokio smoke and Fully local. The smoke harness logs START/END with elapsed seconds for each launcher action and HTTP check. Fully local curl requests have a 30-second per-request limit. Foreground commands run asynchronously so the long-lived Start process's output keeps draining; a noisy-server regression covers pipe backpressure and stdin EOF.

The smoke's disposable homes use native realpath so Windows runner TEMP aliases
such as `RUNNER~1` expand to their long names before paths reach the installer.
Runs 40340156815 and 40343571346 failed OMP's frozen Bun install under a DOS alias;
the Windows journey 40327893175 passed the same OMP/Bun pins under a long path.
This normalization removes that harness difference. It does not establish the
cause of the frozen-lockfile error; the canonical-path Windows smoke must pass
before treating that failure as harness-only.

## Known testing gaps

- Render did not settle during Pinokio smoke on macOS and Linux, so it is omitted from the required smoke flow. Revisit with the testing round.
- The fully local preview request hangs in the current smoke run; its manual-only job now bounds each curl request. Revisit with the testing round.
- Fully local does not run on push because it is manual-only. Revisit with the testing round.

The Track L environment work is in `/Users/hannahomalley/Developer/astrid-pinokio`. The source-backed Pinokio environment fixture was pushed first in its own commit. No package installation, login service, real Runtime or editor server was run locally. The actual POSIX bootstrap was executed only against fakes. Tests use a temporary HOME and `ASTRID_RUNTIME_DOOR_PORT=17341`; they do not probe the owner's live port or use real Astrid/agent state. Earlier launcher validation notes below remain as native qualification context.

The environment contract covers every lifecycle script, both install modes, darwin/linux/win32 shell handoffs, serve/build/status/down children, and installer-lock checks. A native child-process test runs through the shell wrapper with the contaminated fixture, verifies the actual child environment and exit status, and also exercises a nested installer shell on POSIX. Installed records retain their explicit tool environment; inherited XDG, Python, Git, package/model/browser configuration and Pinokio PATH entries are excluded. Native Windows and Linux Pinokio integration still require runner/tester qualification.

## Commands run

On Windows, seven tests report an explicit skip reason because they exercise native POSIX shell, process-group/signal, or `fcntl`/`flock` behavior that Windows does not provide. The six skips in `tests/process.test.mjs` cover failed-shell signaling, ref bootstrap, descendant cleanup, installer-failure cleanup, controlled Stop ordering, and busy/refusal retry with a lifetime lock. The skip in `tests/lifecycle.test.mjs` covers the real Python lock-helper fixture. The platform-independent lifecycle and launcher tests still run on Windows.

```sh
node --test --test-concurrency=1 tests/*.test.mjs
node tests/check-bootstrap.mjs /Users/hannahomalley/Developer/astrid-video/astrid-local/labs/pinokio-app-bootstrap/public/install
```

Track L ran `node --test tests/*.test.mjs` with Node 20.19.4: **46 passed, 0 failed, 0 skipped** on macOS. The bootstrap-source check passed for both raw-ref and checkout paths against `labs/pinokio-app/public/install`, with fake package operations. JavaScript syntax checks and `git diff --check` also passed. The Windows skip reasons above are printed on Windows; the three-platform environment/command matrix runs on every host. A legacy-record regression proves Start refuses Pinokio-owned tools/state while Reset still verifies the lock before removing program files.

The tests load `pinokio.js` and every action module with fake kernel/info/app objects. The exact command fixture covers darwin, linux and win32, both modes, empty ref and `feat/pinokio`, including quoting of spaces/apostrophes. It tests menu state, URL publication ordering, stop awaiting, delete confirmation, pinned-tool/data selection, port classification, and success/failure/interrupt cleanup. Native POSIX subprocess fixtures also prove successful builds, failed builds whose leader exits before descendants, and interrupted builds leave no live fixture descendants.

The optional bootstrap-source check executes the actual POSIX bootstrap supplied on its command line with fake curl, uv, Python-environment creation and package installation. Real Python only executes the bootstrap's standard-library handoff code. It verifies that only the two selected raw-ref URLs are requested, the manifest reaches the installer CLI, and temporary files are removed. It does not test internet availability, GitHub access, real package resolution or installation.

Sources inspected: agent `70de7d77a`, app-bootstrap `c56946787`, editor worktree `833a848c8`, pinokiod `add4a67`; Runtime foreground changes in `labs/pinokio-runtime-run`. The coordinator must combine the bootstrap/editor changes and repin agent/Runtime before testing a published ref. Production endpoints were not assumed to contain those commits.

## Native qualification checklist

These checks require the real Pinokio version and native operating system; the fake matrix does not establish them.

1. Fresh install of each choice from production and with an explicit `ASTRID_APP_REF` branch in a dedicated test environment. Confirm bootstrap source, manifest pins, selected branch, program root, external data root, `managed_by=pinokio`, and no login service. On Windows prove PowerShell 5.1 argument forwarding, local `-File` Bypass behavior under the host's policy, UTF-8, native exit status, paths with spaces/apostrophes/ampersands/`!`, and the explicit refusal for `%`/quotes/newlines.
2. Hosted Start: Open is absent until the health JSON is ready; it opens `https://astrid.haus/?connect=1` in a popout. Confirm the real CORS/browser connection, permissions, projects, and agent discovery.
3. Local Start: no door on 17340; preview listens only on 127.0.0.1:5180; proxy on 17336 works; workspace config identifies the owned Runtime; Open appears only after attach and HTTP readiness. Confirm a schema/pin mismatch fails without Open. Confirm the editor works offline after installation and astrid.haus cannot connect or trigger a permission prompt.
4. **Native Stop/Quit refusal veto is unsatisfied.** The inspected historical pinokiod 8.1.1 source at `add4a674ad1ba95bb62ec427fce519fe5bf0e9bf` swallows direct-method hook errors before killing the shell tree; Quit and signal handlers bypass the hook. The deployed Pinokio version is not recorded, and no compatible upstream veto API/worktree was supplied. Do not mark native Stop/Quit safe from these adapter tests. Require a deployed-version record and upstream contract that preserves the session when the hook refuses, then run busy and idle controls on each supported OS. Capture Runtime, editor, controller, Worker and descendant PIDs; verify every refused path leaves them live and exposes blocker details, then retry the same session after work settles.
5. Kill the owned Runtime while local preview is attaching and after it is ready. The supervisor must stop the editor. Check the app wrapper's possible `astrid-runtime up` handoff does not leave a replacement daemon outside Pinokio's tree. Also stop/quit during this handoff and during a slow build. This race cannot be established by the fake children or normal POSIX build smoke.
6. Trigger npm install/build failure and interrupt a local install/update. Confirm temporary Runtime/proxy/Vite processes are gone, no local mode was saved early, and `public/bootstrap-venv` is absent. Retry successfully. Confirm the built preview serves the newly emitted dist and no installer venv was copied into it.
7. Update each choice while running (invoke its action directly if the running menu hides it), and Switch to fully local from a running hosted install. Busy/unknown/timeout must preserve the Runtime, editor, controller, lock and mode; no cleanup, removal, activation or mode write may follow refusal. Update pulls the launcher and delegates admission to the shared installer transaction, which preflights before staging and stages before Runtime down. It returns only after the foreground session is ready. Pending-journal recovery must precede new launcher/editor pulls or manifest work. Confirm the previous version returns on start/readiness failure, then Stop and Start the updated version separately. Changing a local ref requires Reset/reinstall; detached tag/SHA updates are unsupported.
8. Put a separate Astrid on 17340, then an unrelated HTTP and non-HTTP program there. Confirm explanation/Open-only versus conflict and no second owner. Occupy 5180 with another editor/program and check local Start fails without stopping it. A healthy Runtime on the selected data root with no door must also cause a refusal.
9. Reset removes only app program/editor files and leaves projects/data untouched. Uninstall stops first and uses the Astrid uninstaller while retaining data. Wrong/cancelled `DELETE` changes nothing; exact `DELETE` invokes `--delete-data`. Cover Windows locked files and reinstall after Reset/Uninstall.
10. Verify Pinokio renders operation-only menus, pending Start/Stop, and published URLs correctly; Start is the default stopped menu item. Verify the installed-environment npm entrypoint works without npm/npx symlinks on PATH.
11. Fully local Update keeps the Pinokio **Update** action, starts/reuses the existing `runSession` owner, and invokes the App checkout's `npm run update` without pulling that checkout or running a second installer bootstrap. Verify authenticated local-update begin/runtime/end calls over the existing controller; the expected selected version and transaction operation ID must be ready before App verification completes. Interrupt an E1 transaction and retry Update: the fresh session must launch in local journal-recovery mode, retain the controller while App recovery starts Runtime, and publish normal READY only after local App/Runtime binding passes. Keep recovery journal and prepared checkout/resources if recovery refuses.
12. The App's native local-update canary is documented at [local-update-canary.md](../../astrid-app/docs/local-update-canary.md). Its previous served App → `npm run update` → served build identity + Runtime health/handshake legs are required on Ubuntu, Windows and macOS. The native installed-backend legs are written, not run; the fake caller/session/control tests do not qualify those OS integrations or native Pinokio Stop/Quit behavior.

Known source issue for the coordinator: the editor's diagnostics derive `<root>/with-env` from `ASTRID_START_COMMAND`, although the new installer has no such entry. The launcher uses the real `run`/`run.cmd` for the start hint and explicit recorded Python/profile/data for actual attach. A friendly Runtime-up hint can therefore be unusable on an editor validation error; it needs an upstream diagnostic change. No bootstrap or app source was changed by Task L or this follow-up.


## Files changed

- `ENVIRONMENT`, `README.md`, `pinokio.js`.
- `docs/INTERFACE.md`, `docs/VALIDATION.md`.
- `pinokio/lib.js`, `pinokio/session.mjs`, `pinokio/lifecycle.mjs`, `pinokio/installer-lock.py`.
- `pinokio/platforms/posix.js`, `pinokio/platforms/windows.js`.
- `pinokio/install.js`, `pinokio/install-local.js`, `pinokio/add-local.js`, `pinokio/update.js`.
- `pinokio/start.js`, `pinokio/stop.js`, `pinokio/reset.js`, `pinokio/uninstall.js`, `pinokio/uninstall-delete-data.js`.
- `tests/launcher.test.mjs`, `tests/process.test.mjs`, `tests/check-bootstrap.mjs`, `tests/lifecycle.test.mjs`, `tests/commands.json`.


## Graceful-stop follow-up

Stop-hook evidence is pinned to `add4a674ad1ba95bb62ec427fce519fe5bf0e9bf`: `kernel/api/index.js:599-602` awaits the on.stop request before `:617-622` shell killing, but the direct-method dispatch catches hook errors without rethrowing. `server/index.js:486-505` bypasses this hook on quit. Both native Stop and Quit need upstream refusal-veto support; neither is established by these launcher changes. The exact adapter sequence and production bounds are in INTERFACE.md.

The updated tests cover authenticated controller shutdown, idempotent/retryable stop, exact installed-Python/profile/data invocation, Runtime-down-before-editor cleanup, busy/unknown preservation, and maintenance refusal. A real POSIX fixture exercises a busy-to-idle retry with live Runtime/editor/descendant PIDs and the actual loopback controller. It does not prove Runtime durable-work semantics or native Pinokio's kill veto. No real Runtime, installer lock, user data root or port 17340/5180 is used; controller tests bind only ephemeral loopback ports.

Additional native checks: force the control endpoint to stall (45-second request bound), Runtime down to stall/fail (25-second command bound), and the editor to ignore SIGTERM. Confirm all refusals preserve the session and prevent maintenance mutation, then retry successfully. Inspect actual durable-work reconciliation under Runtime down; the fixture proves process/controller preservation and ordering, not Runtime persistence behavior. Verify exited-child and controllerless cleanup both require the selected installed Runtime down, with structured refusal details preserved. Native Pinokio Stop/Quit remains blocked until the deployed kernel's refusal veto is established.


Follow-up files: `pinokio/lib.js`, `pinokio/start.js`, `pinokio/session.mjs`, new `pinokio/lifecycle.mjs` and `pinokio/installer-lock.py`; `tests/launcher.test.mjs`, `tests/process.test.mjs`, new `tests/lifecycle.test.mjs`, `tests/commands.json`; `docs/INTERFACE.md` and `docs/VALIDATION.md`.
