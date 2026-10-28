# Launcher and installer interface

These are the implemented commands. `A` is the absolute Pinokio app directory, `R=A/app/astrid`, `E=A/app/editor`, and `M=E/public/install-manifest.json`. Paths are quoted by the platform builder; Windows uses backslashes. Literal shell commands for all scripts, platforms and both production/ref sources are checked in [tests/commands.json](../tests/commands.json). That fixture includes spaces and an apostrophe in the app path.

## Sources and bootstrap

Pinokio seeds its generated `ENVIRONMENT` from `_ENVIRONMENT`. The launcher reads `ASTRID_APP_REF` from the process environment first, then `ENVIRONMENT`, then `_ENVIRONMENT`; an empty value selects production.

| Source | macOS / Linux bootstrap | Windows bootstrap | Manifest | Editor clone |
| --- | --- | --- | --- | --- |
| Empty ref | `https://astrid.haus/install` | `https://astrid.haus/install.ps1` | Bootstrap's production default | `banodoco/astrid-app`, branch `main` |
| Explicit ref `main` | `https://raw.githubusercontent.com/banodoco/astrid-app/main/public/install` | Same directory, `install.ps1` | Same directory, `install-manifest.json`, downloaded and passed with `--manifest` | Same repository, branch `main` |
| Fully local install/add | `sh E/public/install` | `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E/public/install.ps1` | Always `--manifest M` | Existing validated checkout |

Remote bootstrap commands download the script into a temporary directory before executing it. Ref commands download the manifest there too. POSIX uses `curl -fsSL URL -o FILE` and `sh FILE`; Windows uses TLS 1.2, `Invoke-WebRequest -UseBasicParsing URL -OutFile FILE`, and `& ([scriptblock]::Create((Get-Content -Raw -LiteralPath FILE)))`. The surrounding POSIX EXIT trap / PowerShell finally removes the temporary directory.

Install and Switch to fully local pass `--root R --managed-by pinokio` to the installer. Hosted Update still uses the ordinary `install` dispatch and shared C2 transaction with the remote manifest. Fully local Update pulls the Pinokio launcher, starts or reuses its existing local session, then runs the editor checkout's `npm run update`. The App updater selects the served App commit and uses the shared C2 transaction with that commit's manifest; it does not pull the editor checkout or run another installer bootstrap. Pinokio's existing session controller stays alive and handles the Runtime start/verify callback. The explicit CLI `--update` remains the hidden forced-restage action. Uninstall adds `--uninstall`; only the typed-delete action additionally passes `--delete-data`.

The current POSIX bootstrap honors a supplied manifest before preparing tool/source pins, so it can run from raw GitHub without an astrid.haus manifest request. It uses absolute public uv/GitHub download URLs, not a URL relative to its own script. The source smoke runs its actual bytes with fake curl, uv and package operations. Windows has the equivalent manifest-selection logic; its native execution remains unqualified here.

The POSIX bootstrap creates a disposable `bootstrap-venv` beside its supplied manifest. For checkout bootstraps the launcher removes `E/public/bootstrap-venv` in an EXIT trap, on success or failure, so Vite cannot copy it into `dist`. Windows bootstrap creates its venv in its own temporary directory. The bootstrap itself was not changed.

## Commands per action

The shell is Bash on macOS/Linux and PowerShell on Windows. `B(action)` below means the remote bootstrap selected above; `L(action)` means the checkout's own bootstrap plus `--manifest M`.

| Script | Back-end-only mode | Fully local mode |
| --- | --- | --- |
| `install.js` | Port preflight; create `A/app`; `B(install)`; save `backend` | — |
| `install-local.js` | — | If re-invoked on an existing install/session, safe Stop first; port preflight; create `A/app`; clone or validate/pull editor; `L(install)`; temporary build session; save `local` |
| `add-local.js` | Await Stop and lock release; port preflight; clone or validate/pull editor; `L(update)`; temporary build session; save `local` | Refuses |
| `update.js` | Pull launcher; `B(install)` shared transaction, which stages before its final fenced stop and starts/verifies the foreground session | Pull launcher; start/reuse the existing local session; run the editor checkout's `npm run update` through its live App launcher |
| `start.js` | Port preflight; foreground hosted session; publish hosted URL after readiness | Port preflight; foreground local session; publish local URL after readiness |
| `stop.js` | Preflight, await Runtime's final fenced stop, then stop the Start shell and verify the per-user installer lock | Same adapter ordering; native refusal veto remains an upstream dependency |
| `reset.js` | Await Stop and lock release; recursively remove only `A/app` | Same; no bootstrap/uninstaller |
| `uninstall.js` | Await Stop and lock release; port preflight; `B(uninstall)`; remove `A/app` | Same |
| `uninstall-delete-data.js` | Require exact `DELETE`; await Stop; port preflight; `B(uninstall --delete-data)`; remove `A/app` | Same |

The editor clone/pull commands used by Install and Switch to fully local on POSIX are:

```sh
git clone --branch '<ref-or-main>' --single-branch -- 'https://github.com/banodoco/astrid-app' 'E'
git -C 'E' pull --ff-only
```

Windows uses the same Git arguments with PowerShell single-quote escaping, and checks `$LASTEXITCODE`. Before those install-time pulls, both platforms require the checkout's current branch to equal `ASTRID_APP_REF` or `main` when empty. An existing editor must have a `.git` entry and the expected HTTPS origin. A missing or different checkout fails rather than being silently replaced. Fully local Update keeps the `Update` action in Pinokio and lets the App updater perform its own edit-preserving target checkout; detached tag/SHA updates remain unsupported by install-time ref handling.

Every shell step invokes `node A/pinokio/shell.mjs`, which builds the Astrid environment before spawning Bash or PowerShell with inherited stdio for live logs. Pinokio's `shell.run` env can only add variables, so it cannot perform this isolation itself. Shells run in the user's home so nested installer shells cannot recreate a Pinokio-owned `PWD`; commands use absolute paths, including `git -C A pull --ff-only` for launcher updates. POSIX runs `bash --noprofile --norc -c` with `set -eu` and unsets Bash's automatically exported `PWD`; PowerShell uses `-NoProfile`, `try/catch` and explicit native exit-code checks. The wrapper returns the child's exit code. The outer shell converts failure into `ASTRID_PINOKIO_FAILURE`, with a Pinokio `break: true` event, so a failing step cannot save a mode or continue. The marker is split in submitted shell source so terminal echo cannot trigger it. See the full wrapper bytes in the fixture.

All Astrid process starts use `pinokio/environment.js`: install, fully local install, update, add-local, reset/stop lock checks, both uninstall actions, serve/build/status and graceful down. The editor origin check and Git shell steps use it too. The builder verifies the `<Pinokio home>/api/<app>` layout, including the canonical home when symlinks are involved. Its base allowlist provides parity with the login-service environment, with uppercase and lowercase `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `ALL_PROXY`. Ambient `ASTRID_*` values are excluded; only the launcher's intentional settings and the installed version's `record.env` are added.

Inherited PATH entries inside Pinokio's home are removed, including relative entries that resolve there. Installed sessions use the recorded PATH with the pinned Node directory prepended. Only the launcher's program root `R` and editor directory `E` and their contents may appear as environment paths inside Pinokio's home. Other recorded Pinokio paths are excluded. Start/build refuse such older tool/state records with a Reset/reinstall error; the lock verifier still runs with the recorded Python and clean environment so Reset/Uninstall can recover the install. Pinokio's Python, Git, package, model, browser and XDG_HOME settings never reach Astrid. Data, skills, packs, selection records and caches therefore use the same OS locations as a terminal install, outside Pinokio's disposable server cache. Pinokio removes `*SSH*` variables from its shells, so `SSH_AUTH_SOCK` is unavailable to Astrid under Pinokio while a macOS LaunchAgent receives it from launchd.

Pinokio's temp values are removed. macOS restores `TMPDIR` from `/usr/bin/getconf DARWIN_USER_TEMP_DIR`, leaving it unset on failure; Windows restores `TEMP` and `TMP` to `%LOCALAPPDATA%\\Temp`; Linux leaves temp variables unset. HOME/user identity and non-Pinokio PATH entries survive. The bootstrap's ffmpeg/ffprobe search cannot select Pinokio's conda binaries.

## Pinned tools and sessions

The launcher reads `R/current`, validates the version identifier, then reads `R/versions/<id>/version.json`. It uses `env.ASTRID_NODE_EXECUTABLE` as the authoritative Node. It validates that Node is inside that version. The installer handoff pins Node 20.19.4; the launcher does not substitute ambient Node or download a second npm version.

Each session starts using:

```text
<PINNED_NODE> A/pinokio/session.mjs build R E local
<PINNED_NODE> A/pinokio/session.mjs serve R E backend
<PINNED_NODE> A/pinokio/session.mjs serve R E local
```

Shell commands resolve the pointer at execution time, after install/update. POSIX uses `V/py/bin/python -I -c <read-version-json>` to locate Node, then `exec`s Node. Windows uses `Get-Content | ConvertFrom-Json`, validates the Node path, and invokes `& $node ...`. The exact resolution commands are in the fixture.

`session.mjs` also reads `R/install.json` and requires `owner=haus.astrid.runtime`, `managed_by=pinokio`, and an absolute recorded data root. Its child invocations are:

| Operation | macOS / Linux | Windows |
| --- | --- | --- |
| Hosted Runtime | `R/run` | `cmd.exe /d /s /c ""R\run.cmd""` |
| Local Runtime, including temporary build | `R/run --hosted-origin off` | `cmd.exe /d /s /c ""R\run.cmd" --hosted-origin off"` |
| Graceful Runtime stop | `<record.python> -I -m astrid_runtime down --profile astrid --data-root <recorded-data-root> --source-manifest <record.profile> --json` | Same argument array |
| Runtime readiness/status | `<record.python> -I -m astrid_runtime status --data-root <recorded-data-root> --json` | Same argument array |
| Editor dependencies | `<Node> <npx-cli.js> -y npm@11 ci --no-audit --no-fund` | Same argument array |
| Editor build | `<Node> scripts/dev-local-workspace.mjs --build` | Same argument array |
| Editor serve | `<Node> scripts/dev-local-workspace.mjs --preview --preview-dir E/dist` | Same argument array |

Windows batch invocation uses `windowsVerbatimArguments: true`. Install paths containing `%`, double quotes or newlines are refused to avoid cmd expansion/quoting errors. Spaces, apostrophes, ampersands and `!` are supported by the command construction and still require native qualification.

`npm-cli.js` and sibling `npx-cli.js` are located from the authoritative Node:

- POSIX: `dirname(Node)/../lib/node_modules/npm/bin/npm-cli.js`.
- Windows: `dirname(Node)/node_modules/npm/bin/npm-cli.js`.

The dependency step invokes the installed Node's `npx-cli.js` and requests npm 11, matching the app README. Node's directory is added to PATH for package scripts. `npm_execpath` and `npm_node_execpath` identify the bundled pinned npm and Node for package scripts. No unpacked POSIX npm/npx symlink is required.

The editor gets the allowlisted base and installed version's environment plus explicit `ASTRID_RUNTIME_PYTHON=<record.python>`, `ASTRID_RUNTIME_SOURCE_MANIFEST=<record.profile>`, `ASTRID_RUNTIME_DATA_ROOT=<install.data_root>`, `ASTRID_SUPPORT_ROOT` and `ASTRID_WORKSPACE_DISCOVERY=<data>/runtime/discovery.json`. There is no environment deny-list. `PORT=5180`, `VITE_ASTRID_DYNAMIC_PROXY_PORT=17336`, `ASTRID_RUNTIME_DOOR_PORT=17340` and `ASTRID_INSTALL_MANAGED_BY=pinokio` are fixed.

Local sessions additionally set `ASTRID_APP_LOOPBACK_ORIGIN=off`. Hosted sessions clear that variable. `ASTRID_START_COMMAND` names the actual `R/run` or `R/run.cmd`, for diagnostics only. The installer does not provide `start` or `with-env`. An upstream editor error hint still derives nonexistent `with-env` from this variable; actual attach/start resolution uses the explicit Python/profile/data environment, not that hint.

The editor's `--build` requires a live Runtime and does not run `up`. A build session installs npm dependencies, starts one foreground Runtime with its door off, waits for Runtime status, builds, then invokes the installed Runtime’s `down` before draining its owned children. npm/build failures and interruption also enter cleanup. If cleanup is refused as busy or unknown, the supervisor and controller stay available for a successful retry before the failed build returns. It never publishes an Open URL or switches mode on a failed shell step.

Normal local Start runs the foreground Runtime first, waits for status, then starts preview. `dev-local-workspace` validates discovery/credentials/schema/realm and attaches before starting its proxy/Vite server. `ASTRID_START_COMMAND` is not a mechanism for starting or attaching to Runtime. The editor can call `astrid-runtime up` itself if it loses discovery; the supervisor watches its owned Runtime and requires successful Runtime `down` before tearing down the editor after that process exits. That custody race is a native qualification item.

## Readiness and menu

Before Start, TCP port 17340 is probed. A `workspace.v1` health response, the Astrid-specific unavailable/identity-mismatch response, or the hosted-origin-required response identifies Astrid. Other responses or a non-HTTP listener identify another program. This preflight runs again when Start executes, not only when the menu renders.

The session refuses an already healthy Runtime at its recorded data root. A local serve session also refuses any existing listener on 5180. Readiness then requires:

- Both modes: installed `astrid_runtime status` exits zero, `support.healthy=true`, no stale discovery, and `health.status=ok`.
- Hosted: HTTP 200 at `http://127.0.0.1:17340/api/runtime/v1/health`, with Origin `https://astrid.haus`, `status=ok` and `protocol=workspace.v1`.
- Local: HTTP success at `http://127.0.0.1:5180/tools/video-editor`, plus a successful `/runtime-config/v1/workspace.json` with `schemaVersion=1` and the same realm and Runtime instance as status discovery. This works with the door off and rejects an unrelated HTTP server.

After these checks the supervisor emits `ASTRID_PINOKIO_READY`. Pinokio's `done: true` listener retains that shell in the daemon script; only the next `local.set` stores `{url, mode}`. Request timeouts bound individual probes; production startup has a 180-second readiness deadline. The subprocess smoke supplies an unlimited startup deadline and uses no test timeouts.

| State | Menu |
| --- | --- |
| No installed mode/run entry, port free | Install; Install fully local |
| Installed backend, stopped | Start; Update; Switch to fully local; Reset; Uninstall; Uninstall and delete all Astrid data… |
| Installed local, stopped | Start; Update; Reset; Uninstall; Uninstall and delete all Astrid data… |
| Start running, no published URL | Starting Astrid…; Stop |
| Ready owned Start | Open Astrid; Update and restart (hosted) or Update (local); Stop |
| Detached owned local session, ready | Open Astrid; Update; Stop |
| Detached owned local session, not ready | Starting Astrid…; Stop |
| Install/add/update/reset/uninstall/delete/stop active | Operation status only |
| External Astrid on 17340 | Explanation; Open Astrid only (hosted URL) |
| Other program on 17340 | Conflict message only |

Start is the default stopped menu item. Hosted Open displays `https://astrid.haus/?connect=1` in Pinokio's popout panel; its relative href keeps Pinokio's default-selection scheme check on the app page, and `target_full` carries the hosted URL. The panel opens the browser only after a click. Local Open is `http://127.0.0.1:5180/tools/video-editor?connect=1`, `popout: false`. A detached local session is shown as ready only after Runtime status, preview HTTP, and workspace instance/realm binding checks succeed; it does not probe the hosted door port. The owned running menu reads the published URL and does not synthesize Open while startup is pending; once ready, Open Astrid is the default menu item.

## Stop hook, graceful shutdown and installer lock

Inspected historical source: pinokiod `add4a674ad1ba95bb62ec427fce519fe5bf0e9bf` (package 8.1.1, fetched from its upstream repository for this review). The deployed Pinokio build is unknown.

- `kernel/api/index.js:599-602` awaits `this.process(script.on.stop)` before `:617-622` kills the script's shell groups. However the direct-method process path catches and logs hook errors instead of rethrowing them (`:2104-2114`), after which `api.stop` still kills the shell groups. A refused hook therefore does **not** veto native Stop in this inspected version.
- An `on.stop` request with a `uri` does not wait for all script steps: the URI branch of `process()` calls `this.queue(...)` at `:2035` and returns. The direct-method branch instead awaits `this.run(...)` at `:2086`. Therefore Start declares a direct **`shell.run`** hook, not a URI to another script. `shell.run` is itself awaited by its kernel API implementation.
- `kernel/api/script/index.js:stop` does not await `kernel.api.stop`; the menu and maintenance helper therefore await `kernel.api.stop` directly.
- `kernel/shell.js:1591,1606` recursively force-kills shell groups with SIGKILL after the hook.
- **Quit bypasses the stop hook** in this inspected version: `server/index.js:486-505` resets shells and kills the daemon directly. The inspected SIGINT/SIGTERM handlers also shut down the server and shell tree. No native Pinokio Stop, Quit, or signal path is proven to preserve a busy Runtime. The matching deployed version and an upstream refusal-veto contract remain unresolved; do not treat these native paths as safe during active work.

`start.js` includes `on: { stop: <direct shell.run request> }`, even when the install mode is missing. The hook resolves the current pinned Node using the same version-record command as Start, then runs:

```text
<Node> A/pinokio/lifecycle.mjs stop R
```

Full Bash/PowerShell resolution and wrapper bytes are the `stopHook` entries in `tests/commands.json`. The helper reads the private `R/pinokio-control.json`, containing a random bearer token, supervisor PID and an ephemeral loopback port. Only an authenticated POST to `/stop` is accepted. There is no global Runtime endpoint or ambient data-root lookup in that request. A dead supervisor's stale record is removed on the next Start; a live PID is never stolen. Normal shutdown removes the record.

During a fully local App update the same controller also accepts `/local-update-begin`, `/local-update-runtime`, and `/local-update-end`. They require the same bearer token, loopback peer, and exact `Host`; the controller refuses Stop while update maintenance is active. Begin keeps the current session owner alive while the App launcher stops Vite. Runtime start reloads `R/current`'s installed record and rebuilds this session's Runtime, status and down commands, validates the selected version and operation ID, and returns only after Runtime reports the expected transaction binding. The same owner then monitors and stops the selected Runtime. End resumes ordinary Runtime-exit monitoring only after Runtime is healthy. The App updater sends these callbacks over the installed `pinokio-control.json`; it does not create a second supervisor or issue Runtime `down` itself.

### Exact stop sequence

Runtime `down` is the only Pinokio stop check. Its read-only admission and final C1 fence run inside Runtime. Pinokio uses the installed version, environment and recorded data root, and preserves the CLI JSON error message and details through the controller. The command is:

```text
<record.python> -I -m astrid_runtime down --profile astrid --data-root <install.data_root> --source-manifest <record.profile> --json
```

The Python is normally `R/versions/<current>/py/bin/python` on macOS/Linux and `R\versions\<current>\py\Scripts\python.exe` on Windows; the record is authoritative.

| Phase | macOS / Linux | Windows |
| --- | --- | --- |
| Runtime | Execute the final fenced `down`, bounded by 25 seconds. Wait up to 5 seconds for the owned foreground child to exit. | Same Python argument array and bounds. The foreground child is the owned `cmd.exe /d /s /c` / `run.cmd` tree. |
| Local editor and remaining owned children | Only after `down` succeeds, terminate the editor/temporary children and wait for them to exit. | Only after `down` succeeds, use `taskkill /T /F` for the owned child tree. |
| Refusal | Busy, unknown, unreadable, or timed-out shutdown returns failure before editor termination, Runtime termination, controller close, forced tree cleanup, or lock cleanup. The same controller remains available for retry. | Same refusal behavior in the Astrid adapter. Native Pinokio may still kill after swallowing the error; the upstream veto dependency is unresolved. |
| Maintenance/Stop menu lock gate | Execute the installed Python lock verifier below; wait for the actual per-user lock to become available. | Same verifier, using Runtime's Windows lock implementation. |

When a Runtime child exists, Stop does not signal it directly, including before readiness. Requests share an in-flight shutdown promise; a failed request clears that promise so the same session can retry. Successful repeated requests are idempotent.

An owned Runtime child that has positively exited can leave editor/controller remnants. The supervisor requires an idempotent `down` before cleaning up those remnants, since child exit alone cannot prove durable work is idle or exclude a replacement owner. The hosted updater releases Runtime's C1 fence before requesting controller cleanup, so the supervisor's `down` is never nested inside that fence. Unexpected child failures still report failure. A completed `down` is retained only within that same supervisor so an editor-cleanup retry does not issue another stop.

The control request has a 45-second deadline. Runtime `down` has a 25-second process deadline. A failed `down` leaves the editor, Runtime, controller, and remaining session processes available for retry; Astrid does not invoke Pinokio's forced cleanup itself.

The Stop menu, Reset, Uninstall, typed data deletion and Switch to fully local (`add-local.js`) call the same `stopOwnedStart` function:

1. Request the controller's Runtime `down` and retain its result. Without a live controller, resolve and validate the selected installed version and run that Runtime's actual `down` before lock admission. Missing or incomplete installed records fail closed when program files exist.
2. Call `kernel.api.stop` only after successful Runtime shutdown. Busy, unknown, and timeout errors return before native tree cleanup or lock checks.
3. Wait for the actual installer lock after successful stop, even when Start was already idle. These maintenance steps do not pull, bootstrap, build, remove files, or save a mode after refusal. Update delegates preflight and staging to the shared installer transaction, which stages before the final Runtime fence; pending-journal recovery runs before new launcher/editor pulls or manifest work.

If the controller is unresponsive, its request fails closed. Astrid leaves the session intact and permits another Stop request. Lock verification has a 10-second poll budget and 12-second subprocess deadline after a successful shutdown. These are production operation bounds; no test has a harness timeout.

An active Start with no controller refuses native cleanup. If controller shutdown succeeded but native `kernel.api.stop` then failed, a later request with an absent controller also fails closed; absence cannot authorize another forced tree kill. Resolving that native partial-cleanup case requires upstream ownership evidence. No unbound success flag or persisted cleanup authority is added here.

### Installer lock gate

Agent `70de7d77a` makes foreground `run` hold the per-user installer lock for its lifetime. The descriptor survives POSIX exec but is restored to close-on-exec before Runtime children start; Windows keeps it in the foreground Python. Install/update/uninstall acquire the same lock nonblocking and refuse while it is held.

The launcher verifies release with:

```text
<record.python> -I A/pinokio/installer-lock.py 10
```

The verifier imports `astrid.installer.service.installer_lock_path(Path.home(), sys.platform)` and uses the installed `runtime_protocol.platform.lock_file(..., blocking=False)` / `unlock_file`. For pre-70de installers without that function it uses their identical inline formula from `cli.py`. It does not create a missing lock file or installer directory.

| Platform | Lock path |
| --- | --- |
| macOS | `~/.local/share/astrid-install.lock` |
| Linux | `$XDG_DATA_HOME/astrid-install.lock`, or `~/.local/share/astrid-install.lock` |
| Windows | `%LOCALAPPDATA%\Astrid Installer\astrid-install.lock` |

The lock is **not** beneath `R` and is not the Runtime data-root owner lock. The probe polls nonblocking acquisition for up to 10 seconds, then releases it immediately. The subsequent installer remains responsible for reacquiring it for its transaction; if a different installer/Runtime wins that race its own fail-fast refusal remains authoritative. Reset does not remove files until verification succeeds. An existing partial app without a usable installed verifier fails closed. With no program directory there is no removal to protect.

Direct SIGINT/SIGTERM/SIGHUP/SIGBREAK interruption and temporary build completion also run read-only preflight and final Runtime `down` before child cleanup. Refusal leaves the processes and controller alive. POSIX cleanup has TERM/KILL group escalation after successful shutdown; Windows uses `taskkill /T /F`. Native process/PTY/ConPTY and durable-work reconciliation remain in the qualification checklist.
