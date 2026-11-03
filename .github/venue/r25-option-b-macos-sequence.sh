#!/bin/bash
# Self-contained setup and two-row execution for Hannah's Mac.
# The run directory is retained; only run-owned installed roots are removed.
set -euo pipefail
umask 077

private_mode() {
  stat -f '%Lp' "$1"
}

require_private_directory() {
  test "$(private_mode "$1")" = 700
}

# The focused regression invokes only this preflight helper with a portable
# stat fixture; the production route never takes this branch.
if [ "${R25_PREFLIGHT_ONLY:-0}" = 1 ]; then
  test "$#" -eq 1
  require_private_directory "$1"
  exit 0
fi

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
require_private_directory "$run_parent"
run_root="$(mktemp -d "$run_parent/run.XXXXXXXX")"
test "$(stat -f '%u' "$run_root")" = "$run_uid"
require_private_directory "$run_root"

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

# Bind the disposable inner venue to the immutable observability input. Keep
# this distinct from the outer sequence commit so the binding cannot become
# self-referential when this candidate is committed.
venue_ref=4e4d95543ac1a9f54caf477badf25061cdd612c5
inner_snapshot_runner_sha256=a95eabe4f14ed204fef485dc7faca9c776047e55537d0faa38966c01b84e029b
inner_snapshot_runner_blob=982a622ef4b8cd85391cb73ffb173ac34a7d38cb
inner_observer_diagnostics_sha256=b3eb6d0943efaf8aaae268f6ffd94ab8826a7053aff4df142238cc74b73fc94f
inner_observer_diagnostics_blob=d7eb13d3716528d95f8c24bd4b02033adb03faaa
wrapper_ref=37e2337271cffe275374fe9a2eda73e8948ef17a
wrapper_sha256=c9abcd60a839de2001195f207e63133632d457bc2c4fa921f3ba4c09efdd0570
wrapper_url="https://raw.githubusercontent.com/banodoco/astrid-pinokio/$wrapper_ref/.github/venue/r25-local-macos-option-b.sh"
install_ps1_digest=bba3f2edc41c047cb51475ceeac4489a04610af73a3af44bdc05287964d28258
stale_install_ps1_digest="${install_ps1_digest}f"
corrected_wrapper_sha256=2f208fdf12154769f4ff524144cc83bf177ac341f7f2c4771f6bdd4b7b891ea1
agent_ref=a6b68d5b5478326a4db1971966d33a2cfe61d091
pinokiod_ref=add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
pterm_ref=5be43718701c448b43daf0ce51d8935f170065bb
pinokio_product_ref=3a6a98ae251ca126505245286e2d3e760f4348e9
outer_pinokio_head="$(git rev-parse HEAD)"

printf '%s\n' \
  "bundle_os=macOS 15.4 arm64" \
  "runner_user=$(id -un)" \
  "runner_uid=$run_uid" \
  "node=$(node --version)" \
  "python_command=$python_bin" \
  "python_actual_executable=$python_actual_executable" \
  "python_actual_version=$python_actual_version" \
  "python_version_guard=explicitly-supported-3.11" \
  "outer_pinokio_head=$outer_pinokio_head" \
  "pinokio_source_ref=$venue_ref" \
  "inner_snapshot_runner_sha256=$inner_snapshot_runner_sha256" \
  "inner_snapshot_runner_blob=$inner_snapshot_runner_blob" \
  "inner_observer_diagnostics_sha256=$inner_observer_diagnostics_sha256" \
  "inner_observer_diagnostics_blob=$inner_observer_diagnostics_blob" \
  "executed_wrapper_ref=$wrapper_ref" \
  "wrapper_source_sha256=$wrapper_sha256" \
  "wrapper_normalization=public/install.ps1:$stale_install_ps1_digest->$install_ps1_digest" \
  "executed_wrapper_sha256=$corrected_wrapper_sha256" \
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

verify_inner_source() {
  local relative_path="$1" expected_sha256="$2" expected_blob="$3" path actual blob
  path="$sources/astrid-pinokio/$relative_path"
  test ! -L "$path"
  actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  test "$actual" = "$expected_sha256"
  blob="$(git -C "$sources/astrid-pinokio" rev-parse "$inner_pinokio_head:$relative_path")"
  test "$blob" = "$expected_blob"
}

mkdir -m 700 "$sources"
clone_pinned astrid-pinokio https://github.com/banodoco/astrid-pinokio.git "$venue_ref"
inner_pinokio_head="$(git -C "$sources/astrid-pinokio" rev-parse HEAD)"
test "$inner_pinokio_head" = "$venue_ref"
printf '%s\n' \
  "inner_pinokio_head=$inner_pinokio_head" >>"$run_root/sequence.env"
verify_inner_source .github/venue/r25-snapshot-runner.cjs "$inner_snapshot_runner_sha256" "$inner_snapshot_runner_blob"
verify_inner_source .github/venue/r21-observer-diagnostics.cjs "$inner_observer_diagnostics_sha256" "$inner_observer_diagnostics_blob"
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

# The pinned wrapper contains one stale 65-character install.ps1 digest. The
# pinned app bytes establish the authoritative 64-character value below. Keep
# the wrapper's source hash check above, then admit only this exact correction
# and hash the corrected wrapper before execution.
test "$(grep -F -c "$stale_install_ps1_digest" "$wrapper_path")" = 1
wrapper_corrected="$run_root/r25-local-macos-option-b.sh.corrected"
sed "s/$stale_install_ps1_digest/$install_ps1_digest/" "$wrapper_path" >"$wrapper_corrected"
printf '%s  %s\n' "$corrected_wrapper_sha256" "$wrapper_corrected" | shasum -a 256 --check
chmod 700 "$wrapper_corrected"
mv -f "$wrapper_corrected" "$wrapper_path"

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
