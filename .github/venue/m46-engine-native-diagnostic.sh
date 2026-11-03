#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${RUNNER_TEMP:?RUNNER_TEMP must be set}/m46-engine-evidence"
home="${RUNNER_TEMP}/m46-engine-home"
daemon="${RUNNER_TEMP}/pinokiod"
pterm="${RUNNER_TEMP}/pterm"
daemon_pid=''

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || fail 'refusing root: diagnostic requires native non-root execution'
[ ! -e "$out" ] && [ ! -e "$home" ] || fail 'evidence or disposable Pinokio home already exists'
[ "$(git -C "$daemon" rev-parse HEAD)" = add4a674ad1ba95bb62ec427fce519fe5bf0e9bf ] || fail 'pinokiod ref mismatch'
[ "$(git -C "$pterm" rev-parse HEAD)" = 5be43718701c448b43daf0ce51d8935f170065bb ] || fail 'PTerm ref mismatch'
[ "$(sha256sum "$daemon/kernel/api/index.js" | cut -d' ' -f1)" = acdd39ce8c058d42e7555b029c8798aa3173062e33c3249773a25b239dfc58a7 ] || fail 'pinokiod API source hash mismatch'

mkdir -p "$out" "$home/api/astrid"
git -C "$repo" archive HEAD | tar -x -C "$home/api/astrid"
test ! -e "$home/api/astrid/app"
node - "$repo" "$daemon" > "$out/overlay.json" <<'NODE'
const path = require('node:path');
const { applyPinokiodEngineOverlay } = require(path.join(process.argv[2], '.github/venue/m46-engine-overlay.cjs'));
process.stdout.write(JSON.stringify(applyPinokiodEngineOverlay(process.argv[3])) + '\n');
NODE
{
  printf 'uid=%s user=%s\n' "$(id -u)" "$(id -un)"
  printf 'candidate=%s\n' "$(git -C "$repo" rev-parse HEAD)"
  printf 'pinokiod=%s\npterm=%s\n' "$(git -C "$daemon" rev-parse HEAD)" "$(git -C "$pterm" rev-parse HEAD)"
  printf 'node=%s\n' "$(node --version)"
  printf 'platform=%s\n' "$(uname -a)"
} > "$out/identity.txt"

node -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(1));s.listen(42000,"127.0.0.1",()=>s.close())' || fail 'port 42000 is occupied'
cleanup() {
  if [ -n "$daemon_pid" ]; then
    kill "$daemon_pid" 2>/dev/null || true
    if wait "$daemon_pid" 2>/dev/null; then daemon_exit=0; else daemon_exit=$?; fi
    printf '{"pid":%s,"uid":%s,"sent_signal":"SIGTERM","wait_exit":%s}\n' "$daemon_pid" "$(id -u)" "$daemon_exit" > "$out/daemon-exit.json"
  fi
  if [ -e "$out" ]; then (cd "$out" && sha256sum ./* > SHA256SUMS) 2>/dev/null || true; fi
}
trap cleanup EXIT

export ASTRID_M46_ENGINE_CAPTURE_FILE="$out/engine-observations.jsonl"
export R20_ACTION_URI="$home/api/astrid/pinokio/reset.js"
(cd "$daemon" && exec env PINOKIO_HOME="$home" PINOKIO_HTTPS_ACTIVE=0 PINOKIO_NETWORK_ACTIVE=0 node script/index.js) > "$out/daemon.log" 2>&1 &
daemon_pid=$!
{
  printf 'daemon_pid=%s daemon_uid=%s\n' "$daemon_pid" "$(id -u)"
  printf 'daemon_exe_sha256=%s\n' "$(sha256sum "/proc/$daemon_pid/exe" | cut -d' ' -f1)"
  printf 'daemon_cmdline=%s\n' "$(tr '\0' ' ' < "/proc/$daemon_pid/cmdline")"
} >> "$out/identity.txt"
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then break; fi
  if curl -fsS http://127.0.0.1:42000/pinokio/version > "$out/version.json" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  printf '{"stage":"readiness","failure":"pinned daemon did not expose /pinokio/version within 60 seconds"}\n' > "$out/first-failure.json"
  fail 'bounded first failure: daemon readiness'
fi

if ! node "$repo/.github/venue/m46-engine-native-observe.cjs"; then
  fail 'bounded first failure: safe Reset request / PTerm observer; see evidence'
fi
node - "$out/engine-observations.jsonl" "$out/engine-summary.json" <<'NODE'
const fs = require('node:fs');
const [file, target] = process.argv.slice(2);
let rows = [];
try { rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch {}
const kinds = Object.fromEntries(['action-resolved', 'rpc-dispatch', 'rpc-return'].map(kind => [kind, rows.filter(row => row.kind === kind).length]));
const requestIds = [...new Set(rows.map(row => row.request_id).filter(Boolean))];
const firstFailure = kinds['action-resolved'] && kinds['rpc-dispatch'] ? null : 'expected request or RPC step rows absent from bounded daemon-writable capture';
const summary = { schema: 'astrid.pinokio.engine-diagnostic-summary.v1', rows: rows.length, kinds, request_ids: requestIds, first_failure: firstFailure, capture_protected: false, terminal_status: 'unknown' };
fs.writeFileSync(target, JSON.stringify(summary, null, 2) + '\n');
if (firstFailure) process.exit(1);
NODE
printf 'diagnostic observation complete; terminal settlement remains unknown\n' > "$out/disposition.txt"
