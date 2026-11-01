#!/usr/bin/env bash
set -euo pipefail
mode="${R20_LINUX_MODE:-docker}"
case "$mode" in docker|native) ;; *) printf 'unsupported R20_LINUX_MODE\n' >&2; exit 2 ;; esac
out="$RUNNER_TEMP/r20-evidence"
venue_home="$RUNNER_TEMP/r20-home"
# Never mix evidence or action state with a previous attempt.
if [ -e "$out" ] || [ -e "$venue_home" ]; then
  printf 'venue directories already exist; use a fresh RUNNER_TEMP\n' >&2
  exit 1
fi
mkdir -p "$out" "$venue_home/api/astrid"
# Only tracked candidate files enter the disposable Pinokio home.
git archive HEAD | tar -x -C "$venue_home/api/astrid"
{
  printf 'candidate=%s\n' "$(git rev-parse HEAD)"
  printf 'daemon=%s\npterm=%s\n' "$(git -C "$RUNNER_TEMP/pinokiod" rev-parse HEAD)" "$(git -C "$RUNNER_TEMP/pterm" rev-parse HEAD)"
  printf 'mode=%s run=%s attempt=%s\n' "$mode" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"
  uname -a
} > "$out/identity.txt"
test ! -e "$venue_home/api/astrid/app"
# Refuse an occupied port: readiness must belong to the daemon we launch.
node -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(1));s.listen(42000,"0.0.0.0",()=>s.close());'
daemon_pid=''
cleanup() {
  if [ "$mode" = native ]; then
    if [ -n "$daemon_pid" ]; then
      kill "$daemon_pid" 2>/dev/null || true
      wait "$daemon_pid" 2>/dev/null || true
    fi
  else
    docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}} image={{.Image}}' r20-pinokiod > "$out/container-state.txt" 2>/dev/null || true
    docker rm -f r20-pinokiod >/dev/null 2>&1 || true
  fi
  (cd "$out" && rm -f SHA256SUMS && sha256sum ./* > SHA256SUMS) || true
}
trap cleanup EXIT
if [ "$mode" = native ]; then
  (cd "$RUNNER_TEMP/pinokiod" && exec env PINOKIO_HOME="$venue_home" PINOKIO_HTTPS_ACTIVE=0 PINOKIO_NETWORK_ACTIVE=0 node script/index.js) >/dev/null 2>&1 &
  daemon_pid=$!
  export R20_ACTION_URI="$venue_home/api/astrid/pinokio/reset.js"
  export R20_DAEMON_PID="$daemon_pid"
else
  docker run -d --name r20-pinokiod -p 127.0.0.1:42000:42000 \
    -e PINOKIO_HTTPS_ACTIVE=0 -e PINOKIO_NETWORK_ACTIVE=0 \
    -v "$venue_home:/data/pinokio" r20-pinokiod > "$out/container-id.txt"
  export R20_ACTION_URI=/data/pinokio/api/astrid/pinokio/reset.js
fi
ready=0
for i in $(seq 1 120); do
  if [ "$mode" = native ] && ! kill -0 "$daemon_pid" 2>/dev/null; then
    printf 'native daemon exited before readiness\n' >&2
    break
  fi
  if curl -fsS http://127.0.0.1:42000/pinokio/version > "$out/version.json" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1
if [ "$mode" = native ]; then
  node .github/venue/r24-linux-real-engine.mjs
else
  node .github/venue/observe.cjs
fi
# Reset's expected disposable outcome is that no program directory exists.
test ! -e "$venue_home/api/astrid/app"
printf 'program directory absent after Reset\n' > "$out/postcondition.txt"
