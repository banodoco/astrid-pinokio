#!/bin/bash
# Self-contained setup and two-row execution for Hannah's Mac.
set -euo pipefail
umask 077

test "$(uname -s)" = Darwin
test "$(id -un)" = astrid-runner
command -v git >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v python3.12 >/dev/null
test "$(node --version)" = v20.19.4
test "$(python3.12 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')" = 3.12

venue_ref=327d0fc29f0b63d58e6c6c3449c81af5912ac85c
agent_ref=a6b68d5b5478326a4db1971966d33a2cfe61d091
pinokiod_ref=add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
pterm_ref=5be43718701c448b43daf0ce51d8935f170065bb
run_parent="$HOME/r25-option-b-runs"
mkdir -p -m 700 "$run_parent"
run_root="$(mktemp -d "$run_parent/run.XXXXXXXX")"
sources="$run_root/sources"
mkdir -m 700 "$sources"
exec > >(tee -a "$run_root/setup.stdout.log") 2> >(tee -a "$run_root/setup.stderr.log" >&2)
printf 'R25_RUN_ROOT=%s\n' "$run_root"

checkout() {
  name="$1"
  url="$2"
  ref="$3"
  root="$sources/$name"
  git init -q "$root"
  git -C "$root" config core.autocrlf false
  git -C "$root" config core.eol lf
  git -C "$root" remote add origin "$url"
  git -C "$root" fetch --quiet --filter=blob:none --no-tags --depth=1 origin "$ref"
  git -C "$root" checkout --quiet --detach FETCH_HEAD
  test "$(git -C "$root" rev-parse HEAD)" = "$ref"
}

checkout astrid-pinokio https://github.com/banodoco/astrid-pinokio.git "$venue_ref"
checkout astrid-agent https://github.com/banodoco/astrid-agent.git "$agent_ref"
checkout pinokiod https://github.com/pinokiocomputer/pinokiod.git "$pinokiod_ref"
checkout pterm https://github.com/pinokiocomputer/pterm.git "$pterm_ref"

npm ci --omit=dev --prefix "$sources/pinokiod" --silent
npm ci --omit=dev --prefix "$sources/pterm" --silent

(
  cd "$sources/astrid-pinokio"
  node pinokio/providers/r25-native-collector-binding.cjs \
    --validate-source-only true --agent-ref "$agent_ref" \
    --agent-root "$sources/astrid-agent" --pinokio-root "$sources/astrid-pinokio"
  node --test tests/r25-native-collector-binding.test.cjs tests/r25-snapshot-macos.test.cjs
  python3.12 -m py_compile \
    "$sources/astrid-agent/scripts/pinokio_snapshot_collector.py" \
    "$sources/astrid-agent/scripts/pinokio_snapshot_macos.py" \
    .github/venue/r25-snapshot-worker.py
  node --check .github/venue/r25-snapshot-runner.cjs
  bash -n .github/venue/r25-local-macos-option-b.sh
)

set +e
bash "$sources/astrid-pinokio/.github/venue/r25-local-macos-option-b.sh" \
  "$run_root" "$sources/astrid-agent" "$sources/pinokiod" "$sources/pterm"
route_exit=$?
set -e
printf '%s\n' "$route_exit" >"$run_root/route.exit"
printf 'R25_RESULTS=%s/results\nR25_ROUTE_EXIT=%s\n' "$run_root" "$route_exit"
exit "$route_exit"
