#!/usr/bin/env bash
set -euo pipefail
out="$RUNNER_TEMP/r20-evidence"
home="$RUNNER_TEMP/r20-home"
mkdir -p "$out" "$home/api/astrid"
# Only tracked candidate files enter the disposable Pinokio home.
git archive HEAD | tar -x -C "$home/api/astrid"
{
  printf 'candidate=%s\n' "$(git rev-parse HEAD)"
  printf 'daemon=%s\npterm=%s\n' "$(git -C "$RUNNER_TEMP/pinokiod" rev-parse HEAD)" "$(git -C "$RUNNER_TEMP/pterm" rev-parse HEAD)"
  printf 'run=%s attempt=%s\n' "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
  uname -a
} > "$out/identity.txt"
test ! -e "$home/api/astrid/app"
docker run -d --name r20-pinokiod -p 127.0.0.1:42000:42000 \
  -e PINOKIO_HTTPS_ACTIVE=0 -e PINOKIO_NETWORK_ACTIVE=0 \
  -v "$home:/data/pinokio" r20-pinokiod > "$out/container-id.txt"
cleanup() {
  docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} image={{.Image}}' r20-pinokiod > "$out/container-state.txt" 2>/dev/null || true
  docker rm -f r20-pinokiod >/dev/null 2>&1 || true
  (cd "$out" && sha256sum ./* > SHA256SUMS) || true
}
trap cleanup EXIT
ready=0
for i in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:42000/pinokio/version > "$out/version.json"; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1
node .github/venue/observe.cjs
# Reset's expected disposable outcome is that no program directory exists.
test ! -e "$home/api/astrid/app"
printf 'program directory absent after Reset\n' > "$out/postcondition.txt"
