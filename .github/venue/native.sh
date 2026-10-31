#!/usr/bin/env bash
set -uo pipefail
out="$RUNNER_TEMP/r20-evidence"
mkdir -p "$out"
{
  printf 'runner=%s arch=%s\n' "$RUNNER_OS" "$RUNNER_ARCH"
  printf 'node=%s npm=%s git=%s\n' "$(node --version)" "$(npm --version)" "$(git --version)"
} > "$out/host.txt"
probe() {
  local name="$1" repo="$2" sha="$3"
  if git clone -q "$repo" "$RUNNER_TEMP/$name" && git -C "$RUNNER_TEMP/$name" checkout -q --detach "$sha"; then
    printf '%s source=ok sha=%s\n' "$name" "$(git -C "$RUNNER_TEMP/$name" rev-parse HEAD)" >> "$out/host.txt"
  else
    printf '%s source=failed\n' "$name" >> "$out/host.txt"
    return 1
  fi
  if npm ci --omit=dev --prefix "$RUNNER_TEMP/$name" --silent > "$RUNNER_TEMP/$name-install.log" 2>&1; then
    printf '%s npm-ci=ok\n' "$name" >> "$out/host.txt"
  else
    printf '%s npm-ci=failed (details withheld; inspect runner log locally)\n' "$name" >> "$out/host.txt"
    return 1
  fi
}
failed=0
probe pterm https://github.com/pinokiocomputer/pterm.git 5be43718701c448b43daf0ce51d8935f170065bb || failed=1
probe pinokiod https://github.com/pinokiocomputer/pinokiod.git add4a674ad1ba95bb62ec427fce519fe5bf0e9bf || failed=1
if [ "$failed" = 0 ]; then
  if node "$RUNNER_TEMP/pterm/index.js" version terminal >> "$out/host.txt"; then
    node .github/venue/native-probe.cjs || failed=1
  else
    printf 'pterm launch=failed\n' >> "$out/host.txt"
    failed=1
  fi
fi
exit "$failed"
