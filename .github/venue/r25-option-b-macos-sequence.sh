#!/bin/bash
# Self-contained setup and two-row execution for Hannah's Mac.
# The run directory is retained; only run-owned installed roots are removed.
set -euo pipefail
umask 077

test "$(uname -s)" = Darwin
test "$(id -un)" = astrid-runner
command -v git >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v curl >/dev/null
command -v shasum >/dev/null
test "$(node --version)" = v20.19.4

run_parent="$HOME/r25-option-b-runs"
test ! -L "$run_parent"
mkdir -p "$run_parent"
run_uid="$(id -u)"
test "$(stat -f '%u' "$run_parent")" = "$run_uid"
run_root="$(mktemp -d "$run_parent/run.XXXXXXXX")"
test "$(stat -f '%u' "$run_root")" = "$run_uid"
test "$(stat -f '%Lp' "$run_root")" = 700

install_root="$run_root/installed"
sources="$install_root/sources"
mkdir -m 700 "$install_root"
route_exit_written=0

safe_remove() {
  local target="$1"
  case "$target" in
    "$run_root"/*) ;;
    *) printf 'REFUSED cleanup outside run root: %s\n' "$target" >>"$run_root/cleanup.log"; return 1 ;;
  esac
  if [ ! -e "$target" ]; then
    return 0
  fi
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    printf 'REFUSED cleanup non-directory or symlink: %s\n' "$target" >>"$run_root/cleanup.log"
    return 1
  fi
  if [ "$(stat -f '%u' "$target" 2>/dev/null || true)" != "$run_uid" ]; then
    printf 'REFUSED cleanup owner mismatch: %s\n' "$target" >>"$run_root/cleanup.log"
    return 1
  fi
  rm -rf -- "$target"
}

cleanup() {
  local original_exit=$? cleanup_exit=0 slot rel target
  set +e
  if [ -n "${run_root:-}" ] && [ -d "$run_root" ] && [ ! -L "$run_root" ]; then
    : >"$run_root/cleanup.log"
    for slot in pinokio-backend-macos pinokio-fully-local-macos; do
      for rel in pinokio-product pinokio-home user-home data-home; do
        target="$run_root/results/$slot/$rel"
        safe_remove "$target" || cleanup_exit=70
      done
    done
    safe_remove "$install_root" || cleanup_exit=70
    if [ "$route_exit_written" -eq 0 ]; then
      printf '%s\n' "$original_exit" >"$run_root/route.exit"
    fi
    printf '%s\n' "$cleanup_exit" >"$run_root/cleanup.exit"
    printf '%s\n' "$original_exit" >"$run_root/sequence.exit"
    printf 'original_exit=%s cleanup_exit=%s\n' "$original_exit" "$cleanup_exit" >>"$run_root/cleanup.log"
  fi
  if [ "$original_exit" -eq 0 ] && [ "$cleanup_exit" -ne 0 ]; then
    original_exit="$cleanup_exit"
  fi
  trap - EXIT HUP INT TERM
  exit "$original_exit"
}
trap cleanup EXIT HUP INT TERM

exec > >(tee -a "$run_root/setup.stdout.log") 2> >(tee -a "$run_root/setup.stderr.log" >&2)
printf 'R25_RUN_ROOT=%s\n' "$run_root"

python_bin="${PYTHON_BIN:-${PYTHON311:-}}"
if [ -z "$python_bin" ]; then
  python_bin="$(command -v python3.11 2>/dev/null || true)"
fi
if [ -z "$python_bin" ] && command -v brew >/dev/null 2>&1; then
  python_bin="$(brew --prefix python@3.11 2>/dev/null || true)/bin/python3.11"
fi
test -x "$python_bin"
python_actual_version="$("$python_bin" -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')"
test "$python_actual_version" = 3.11
python_actual_executable="$("$python_bin" -c 'import os, sys; print(os.path.realpath(sys.executable))')"
test -x "$python_actual_executable"

# The local wrapper accepts this real, explicitly supported Python 3.11
# interpreter. No alternate executable is installed.

venue_ref=5ad7ef974f5f11643ba19da95c20fbaeb9fca442
wrapper_ref=5ad7ef974f5f11643ba19da95c20fbaeb9fca442
wrapper_sha256=2f208fdf12154769f4ff524144cc83bf177ac341f7f2c4771f6bdd4b7b891ea1
wrapper_url="https://raw.githubusercontent.com/banodoco/astrid-pinokio/$wrapper_ref/.github/venue/r25-local-macos-option-b.sh"
agent_ref=a6b68d5b5478326a4db1971966d33a2cfe61d091
pinokiod_ref=add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
pterm_ref=5be43718701c448b43daf0ce51d8935f170065bb
pinokio_product_ref=3a6a98ae251ca126505245286e2d3e760f4348e9

printf '%s\n' \
  "bundle_os=macOS 15.4 arm64" \
  "runner_user=$(id -un)" \
  "runner_uid=$run_uid" \
  "node=$(node --version)" \
  "python_command=$python_bin" \
  "python_actual_executable=$python_actual_executable" \
  "python_actual_version=$python_actual_version" \
  "python_version_guard=explicitly-supported-3.11" \
  "pinokio_source_ref=$venue_ref" \
  "executed_wrapper_ref=$wrapper_ref" \
  "executed_wrapper_sha256=$wrapper_sha256" \
  "pinokio_product_ref=$pinokio_product_ref" \
  "agent_ref=$agent_ref" \
  "pinokiod_ref=$pinokiod_ref" \
  "pterm_ref=$pterm_ref" \
  "install_root=$install_root" \
  "evidence_root=$run_root" >"$run_root/sequence.env"

clone_pinned() {
  local name="$1" url="$2" ref="$3" root="$sources/$1"
  git clone --filter=blob:none --no-checkout "$url" "$root"
  git -C "$root" fetch --no-tags --depth=1 origin "$ref"
  git -C "$root" config core.autocrlf false
  git -C "$root" config core.eol lf
  git -C "$root" checkout --detach FETCH_HEAD
  test "$(git -C "$root" rev-parse HEAD)" = "$ref"
}

mkdir -m 700 "$sources"
clone_pinned astrid-pinokio https://github.com/banodoco/astrid-pinokio.git "$venue_ref"
clone_pinned astrid-agent https://github.com/banodoco/astrid-agent.git "$agent_ref"
clone_pinned pinokiod https://github.com/pinokiocomputer/pinokiod.git "$pinokiod_ref"
clone_pinned pterm https://github.com/pinokiocomputer/pterm.git "$pterm_ref"

wrapper_path="$sources/astrid-pinokio/.github/venue/r25-local-macos-option-b.sh"
wrapper_download="$run_root/r25-local-macos-option-b.sh.download"
test ! -L "$wrapper_path"
curl --fail --silent --show-error --location "$wrapper_url" --output "$wrapper_download"
printf '%s  %s\n' "$wrapper_sha256" "$wrapper_download" | shasum -a 256 --check
chmod 700 "$wrapper_download"
mv -f "$wrapper_download" "$wrapper_path"
printf '%s  %s\n' "$wrapper_sha256" "$wrapper_path" | shasum -a 256 --check

npm ci --omit=dev --prefix "$sources/pinokiod" --silent
npm ci --omit=dev --prefix "$sources/pterm" --silent

(
  cd "$sources/astrid-pinokio"
  node pinokio/providers/r25-native-collector-binding.cjs \
    --validate-source-only true --agent-ref "$agent_ref" \
    --agent-root "$sources/astrid-agent" --pinokio-root "$sources/astrid-pinokio"
  node --test tests/r25-native-collector-binding.test.cjs tests/r25-snapshot-macos.test.cjs
  "$python_bin" -m py_compile \
    "$sources/astrid-agent/scripts/pinokio_snapshot_collector.py" \
    "$sources/astrid-agent/scripts/pinokio_snapshot_macos.py" \
    .github/venue/r25-snapshot-worker.py
  node --check .github/venue/r25-snapshot-runner.cjs
  bash -n "$wrapper_path"
)

set +e
bash "$wrapper_path" \
  "$run_root" "$sources/astrid-agent" "$sources/pinokiod" "$sources/pterm"
route_exit=$?
set -e

verify_product_pins() {
  local slot product
  for slot in pinokio-backend-macos pinokio-fully-local-macos; do
    product="$run_root/results/$slot/pinokio-product"
    if [ -d "$product/.git" ]; then
      test "$(git -C "$product" rev-parse HEAD)" = "$pinokio_product_ref" || return 1
    fi
  done
}
if [ "$route_exit" -eq 0 ] && ! verify_product_pins; then
  printf 'Pinokio product checkout verification failed\n' >&2
  route_exit=65
fi

printf '%s\n' "$route_exit" >"$run_root/route.exit"
route_exit_written=1
printf 'R25_RESULTS=%s/results\nR25_ROUTE_EXIT=%s\nR25_CLEANUP=%s\n' \
  "$run_root" "$route_exit" 'run-owned installed roots only; evidence retained'
exit "$route_exit"
