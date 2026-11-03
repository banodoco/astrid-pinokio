#!/usr/bin/env bash
set -euo pipefail

# Seed the same run-owned prefix that pinokiod resolves from PINOKIO_HOME.
# This runs only on the disposable macOS Actions runner, before pinokiod starts.
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${PINOKIO_HOME:?PINOKIO_HOME is required}"

runner_temp="$(cd -P "$RUNNER_TEMP" && pwd)"
expected_home="$runner_temp/pinokio-home"
home_parent_input="${PINOKIO_HOME%/*}"
home_name="${PINOKIO_HOME##*/}"
if [ "$home_parent_input" = "$PINOKIO_HOME" ] || ! home_parent="$(cd -P "$home_parent_input" 2>/dev/null && pwd)"; then
  printf 'refusing unexpected PINOKIO_HOME: %s\n' "$PINOKIO_HOME" >&2
  exit 64
fi
canonical_home="$home_parent/$home_name"
if [ "$canonical_home" != "$expected_home" ]; then
  printf 'refusing unexpected PINOKIO_HOME: %s\n' "$PINOKIO_HOME" >&2
  exit 64
fi
if [ "$(uname -s)" != Darwin ]; then
  printf 'macOS runner required\n' >&2
  exit 65
fi
if [ -e "$PINOKIO_HOME" ] || [ -L "$PINOKIO_HOME" ]; then
  printf 'refusing existing run home: %s\n' "$PINOKIO_HOME" >&2
  exit 66
fi

case "$(uname -m)" in
  arm64) asset=Miniforge3-MacOSX-arm64.sh ;;
  x86_64) asset=Miniforge3-MacOSX-x86_64.sh ;;
  *) printf 'unsupported macOS architecture: %s\n' "$(uname -m)" >&2; exit 67 ;;
esac

release=26.3.2-3
conda_pin=26.5.3
python_pin=3.10.20
miniforge_root="$PINOKIO_HOME/bin/miniforge"
installer="$RUNNER_TEMP/$asset"
mkdir -p "$PINOKIO_HOME/bin"
curl -fsSL "https://github.com/conda-forge/miniforge/releases/download/$release/$asset" -o "$installer"
bash "$installer" -b -p "$miniforge_root"

# Match the package set installed by pinokiod/kernel/bin/conda.js at the
# pinned engine revision. Conda.init() writes condarc and the pin file when
# the daemon starts; it does not install Miniforge.
conda="$miniforge_root/bin/conda"
test -x "$conda"
export CONDA_PREFIX="$miniforge_root"
export PIP_REQUIRE_VIRTUALENV=false
"$conda" clean -y --all
"$conda" install -y --prefix "$miniforge_root" --override-channels -c conda-forge \
  "conda=$conda_pin" "python=$python_pin" 'conda-libmamba-solver>=25.4.0'

# Fail before the engine action if its exact shell hook or base executable is
# still unavailable. The daemon later supplies this prefix through its normal
# managed PATH and runs the same `conda shell.bash hook` startup command.
"$conda" shell.bash hook >/dev/null
"$conda" --version

# Retain the run-owned Conda state immediately before pinokio-setup's
# shell.run. This records presence without adding a global Conda path.
: "${R25_DIAGNOSTICS:?R25_DIAGNOSTICS is required}"
node_bin="${NODE_BINARY:-node}"
"$node_bin" -e 'require("./.github/venue/r25-macos-diagnostic.cjs").writeCondaPresence(process.env.PINOKIO_HOME, process.env.R25_DIAGNOSTICS)'
