#!/bin/bash
# Run both macOS Option-B snapshot rows outside GitHub Actions.
set -u
umask 077

usage() {
  printf 'usage: %s RUN_ROOT AGENT_ROOT PINOKIOD_ROOT PTERM_ROOT\n' "$0" >&2
  exit 64
}

[ "$#" -eq 4 ] || usage
run_root="$1"
agent_root="$2"
pinokiod_root="$3"
pterm_root="$4"
venue_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)" || exit 1

[ "$(uname -s)" = Darwin ] || { printf 'R-25 local route requires macOS\n' >&2; exit 69; }
[ "$(id -un)" = astrid-runner ] || { printf 'R-25 local route requires the astrid-runner account\n' >&2; exit 77; }
case "$run_root" in /*) ;; *) printf 'RUN_ROOT must be absolute\n' >&2; exit 64;; esac
[ -d "$run_root" ] && [ ! -L "$run_root" ] || { printf 'RUN_ROOT must be an existing non-symlink directory\n' >&2; exit 73; }
[ ! -e "$run_root/results" ] || { printf 'RUN_ROOT/results must be absent\n' >&2; exit 73; }
mkdir -m 700 "$run_root/results" || exit 1

node_version="$(node --version 2>/dev/null || true)"
python_bin="${PYTHON:-python3.11}"
if [ "${python_bin#/}" = "$python_bin" ]; then
  python_bin="$(command -v "$python_bin" 2>/dev/null || true)"
fi
python_version="$("$python_bin" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))' 2>/dev/null || true)"
python_executable="$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.executable))' 2>/dev/null || true)"
[ "$node_version" = v20.19.4 ] || { printf 'Node v20.19.4 is required (found %s)\n' "$node_version" >&2; exit 69; }
[ "$python_version" = 3.11 ] || { printf 'Python 3.11 is required (found %s)\n' "$python_version" >&2; exit 69; }
[ -x "$python_executable" ] || { printf 'Python executable is not usable: %s\n' "$python_bin" >&2; exit 69; }

agent_ref=a6b68d5b5478326a4db1971966d33a2cfe61d091
pinokiod_ref=add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
pterm_ref=5be43718701c448b43daf0ce51d8935f170065bb
venue_head="$(git -C "$venue_root" rev-parse HEAD)" || exit 1
[ "$(git -C "$agent_root" rev-parse HEAD)" = "$agent_ref" ] || { printf 'Agent ref differs\n' >&2; exit 65; }
[ "$(git -C "$pinokiod_root" rev-parse HEAD)" = "$pinokiod_ref" ] || { printf 'pinokiod ref differs\n' >&2; exit 65; }
[ "$(git -C "$pterm_root" rev-parse HEAD)" = "$pterm_ref" ] || { printf 'PTerm ref differs\n' >&2; exit 65; }

tuple='{"app":"79f7e5397c044c4c97dc7e97b20ad96f787e5247","agent":"ab43bad818ef65ca1e929b973a2f61cd9fc4bf61","runtime":"2776ba973b6c8f3555b5629b0840d9691a98d3c2","pinokio":"3a6a98ae251ca126505245286e2d3e760f4348e9","manifest_sha256":"b2584f0bb5a949890364004572a0182f2b568adcdba061e73b739e1d3d2d623f","artifacts":{"public/install":"100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d","public/install.sh":"591c4c51b148fccef2a7d1c45782d9ff949d5fd03d46cd82b5591e3a23d1b285","public/install.ps1":"bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258"},"published_at":"2026-11-02T17:55:27Z"}'
uid="$(id -u)"
case "$uid" in ''|*[!0-9]*|0) printf 'astrid-runner must have a positive numeric uid\n' >&2; exit 77;; esac
launchd_target="gui/$uid/haus.astrid.runtime"

wait_for_port() {
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if node -e 'const n=require("node:net");const s=n.createServer();s.once("error",()=>process.exit(1));s.listen(42000,"127.0.0.1",()=>s.close(()=>process.exit(0)));'; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

run_slot() {
  slot="$1"
  ordinal="$2"
  slot_root="$run_root/results/$slot"
  diagnostics="$slot_root/diagnostics"
  output="$slot_root/output"
  origin="$slot_root/local-origin.json"
  mkdir -m 700 "$slot_root" "$diagnostics" || return 1
  run_id="$(date -u +%s)"
  producer_id=$(( $$ + ordinal ))
  artifact="r25-snapshots-$slot-local-$run_id-$ordinal"
  node - "$origin" "$slot" "$venue_head" "$run_id" "$producer_id" "$artifact" <<'NODE'
const fs = require('node:fs');
const [file, slot, head, runId, producerId, artifact] = process.argv.slice(2);
const value = {
  repository_id: 1,
  repository_full_name: 'banodoco/astrid-pinokio',
  workflow_id: 1,
  workflow_ref: `local-macos:${head}`,
  workflow_sha: head,
  run_id: Number(runId),
  run_attempt: 1,
  head_sha: head,
  producer_job_id: Number(producerId),
  producer_job_name: `local-macos-${slot}`,
  artifact_id: null,
  artifact_name: artifact,
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE
  if ! wait_for_port; then
    printf '42000 is occupied before %s\n' "$slot" >"$diagnostics/preflight-error.log"
    printf '69\n' >"$slot_root/runner.exit"
    return 69
  fi
  (
    cd "$venue_root" || exit 1
    env R25_TARGET_OS=macos R25_SLOT_ID="$slot" R25_LAUNCHD_TARGET="$launchd_target" \
      R25_TUPLE_JSON="$tuple" R25_OUTPUT="$output" R25_DIAGNOSTICS="$diagnostics" \
      PYTHON="$python_bin" \
      node .github/venue/r25-snapshot-runner.cjs \
        --local-origin "$origin" --agent-root "$agent_root" --pinokiod "$pinokiod_root" \
        --pterm "$pterm_root" --output "$output"
  ) >"$slot_root/runner.stdout.log" 2>"$slot_root/runner.stderr.log"
  result=$?
  printf '%s\n' "$result" >"$slot_root/runner.exit"
  return "$result"
}

set +e
run_slot pinokio-backend-macos 1
backend_exit=$?
run_slot pinokio-fully-local-macos 2
local_exit=$?
set -e

node - "$run_root/results/summary.json" "$venue_head" "$uid" "$backend_exit" "$local_exit" <<'NODE'
const fs = require('node:fs');
const [file, head, uid, backendExit, localExit] = process.argv.slice(2);
const value = {
  schema: 'astrid.r25.local-macos-option-b-summary.v1',
  generated_at: new Date().toISOString(),
  venue_head: head,
  local_uid: Number(uid),
  qualification_claimed: false,
  slots: {
    'pinokio-backend-macos': { runner_exit: Number(backendExit) },
    'pinokio-fully-local-macos': { runner_exit: Number(localExit) },
  },
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
NODE

"$python_bin" - "$run_root/results" <<'PY'
import hashlib
import os
import pathlib
import sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
manifest = root / "SHA256SUMS"
rows = []
for path in sorted(root.rglob("*")):
    if path.is_file() and not path.is_symlink() and path != manifest:
        rows.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}")
manifest.write_text("\n".join(rows) + "\n", encoding="ascii")
os.chmod(manifest, 0o600)
PY

printf 'R-25 results: %s/results\n' "$run_root"
[ "$backend_exit" -eq 0 ] && [ "$local_exit" -eq 0 ]
