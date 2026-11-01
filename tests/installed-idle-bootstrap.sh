#!/usr/bin/env bash
set -euo pipefail
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
cd "$HOME"
git clone --quiet --no-checkout https://github.com/pinokiocomputer/pinokiod.git pinokiod
git -C pinokiod checkout --quiet --detach add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
[[ $(git -C pinokiod rev-parse HEAD) == add4a674ad1ba95bb62ec427fce519fe5bf0e9bf ]]
npm ci --no-audit --no-fund --prefix pinokiod
git clone --quiet --no-checkout https://github.com/pinokiocomputer/pterm.git pterm
git -C pterm checkout --quiet --detach 5be43718701c448b43daf0ce51d8935f170065bb
[[ $(git -C pterm rev-parse HEAD) == 5be43718701c448b43daf0ce51d8935f170065bb ]]
npm ci --no-audit --no-fund --prefix pterm
