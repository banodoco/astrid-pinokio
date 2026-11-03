#!/usr/bin/env bash
set -euo pipefail

# Seed the same run-owned prefix that pinokiod resolves from PINOKIO_HOME.
# This runs only on the disposable macOS Actions runner, before pinokiod starts.
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${PINOKIO_HOME:?PINOKIO_HOME is required}"

runner_temp="$(cd -P "$RUNNER_TEMP" && pwd)"
expected_home="$runner_temp/pinokio-home"
if [ "$PINOKIO_HOME" != "$expected_home" ]; then
  printf 'refusing unexpected PINOKIO_HOME: %s\n' "$PINOKIO_HOME" >&2
  exit 64
fi
if [ "$(uname -s)" != Darwin ]; then
  printf 'macOS runner required\n' >&2
  exit 65
fi
if [ -e "$PINOKIO_HOME" ]; then
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
