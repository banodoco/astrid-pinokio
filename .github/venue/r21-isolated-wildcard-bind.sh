#!/usr/bin/env bash
# Standalone measurement of the pinned daemon on an ephemeral hosted VM.
set -u
umask 077
out="$RUNNER_TEMP/r21-bind-evidence"
mkdir -p "$out"
work=$(mktemp -d "$RUNNER_TEMP/r21-bind.XXXXXXXX")
export HOME="$work/home" PINOKIO_HOME="$work/pinokio-home" PINOKIO_HTTPS_ACTIVE=0 PINOKIO_NETWORK_ACTIVE=0
mkdir -p "$HOME" "$PINOKIO_HOME"
export CANDIDATE_SHA=13cb31104c8aae655d0ee04efdb9537aa111e340
export AGENT_SHA=a678ae168498bdc4795471b44446d34d58f7c5cd
export DAEMON_EXPECTED=add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
export PTERM_EXPECTED=5be43718701c448b43daf0ce51d8935f170065bb
export binding_exit=not_run outbound_exit=not_run daemon_clone_exit=not_run daemon_checkout_exit=not_run daemon_install_exit=not_run pterm_clone_exit=not_run pterm_checkout_exit=not_run pterm_install_exit=not_run setup_exit=not_run readiness_exit=not_run listener_capture_exit=not_run listener_owner_exit=not_run cleanup_exit=not_run daemon_exit=not_started final_exit=1
export daemon_sha=not_checked pterm_sha=not_checked daemon_pid=not_started http_status=not_checked
pid=''
finish() {
  trap - EXIT TERM INT
  local cleanup=0 i
  if [[ -n "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for i in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || cleanup=1; fi
    wait "$pid" 2>/dev/null; daemon_exit=$?
    kill -0 -- "-$pid" 2>/dev/null && cleanup=1
  fi
  rm -rf -- "$work" || cleanup=1
  [[ ! -e "$work" ]] || cleanup=1
  cleanup_exit=$cleanup
  if [[ "$binding_exit" == 0 && "$outbound_exit" == 0 && "$setup_exit" == 0 && "$readiness_exit" == 0 && "$listener_capture_exit" == 0 && "$listener_owner_exit" == 0 && "$cleanup_exit" == 0 ]]; then final_exit=0; fi
  export cleanup_exit daemon_exit final_exit
  python3 - "$out/receipt.json" <<'PY'
import json, os, platform, sys
keys = ['GITHUB_REPOSITORY','GITHUB_REF','GITHUB_SHA','GITHUB_WORKFLOW_REF','GITHUB_WORKFLOW_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','RUNNER_OS','RUNNER_ARCH','ImageOS','ImageVersion','CANDIDATE_SHA','AGENT_SHA','DAEMON_EXPECTED','PTERM_EXPECTED','daemon_sha','pterm_sha','daemon_pid','http_status','binding_exit','outbound_exit','daemon_clone_exit','daemon_checkout_exit','daemon_install_exit','pterm_clone_exit','pterm_checkout_exit','pterm_install_exit','setup_exit','readiness_exit','listener_capture_exit','listener_owner_exit','daemon_exit','cleanup_exit','final_exit']
data = {k: os.environ.get(k, 'unavailable') for k in keys}
data.update({'kernel': platform.release(), 'outbound_url': 'https://github.com/pinokiocomputer/pinokiod.git/info/refs?service=git-upload-pack', 'readiness_url': 'http://127.0.0.1:42000/pinokio/version', 'listener_file': 'listener.txt', 'cleanup': 'task-local source and homes removed; daemon process group terminated' if data['cleanup_exit'] == '0' else 'cleanup failed'})
with open(sys.argv[1], 'w') as f: json.dump(data, f, indent=2, sort_keys=True); f.write('\n')
PY
  exit "$final_exit"
}
trap finish EXIT
trap 'exit 1' TERM INT
# A single venue-only commit must descend directly from the requested candidate.
if [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" && "$(git rev-parse HEAD^)" == "$CANDIDATE_SHA" && "${GITHUB_WORKFLOW_SHA:-}" == "$GITHUB_SHA" ]]; then binding_exit=0; else binding_exit=1; fi
curl -fsS --max-time 20 -o /dev/null 'https://github.com/pinokiocomputer/pinokiod.git/info/refs?service=git-upload-pack'; outbound_exit=$?
if [[ "$binding_exit" != 0 || "$outbound_exit" != 0 ]]; then exit 1; fi
timeout 120 git clone -q --filter=blob:none https://github.com/pinokiocomputer/pinokiod.git "$work/daemon" >/dev/null 2>&1; daemon_clone_exit=$?
if [[ "$daemon_clone_exit" != 0 ]]; then exit 1; fi
git -C "$work/daemon" checkout -q --detach "$DAEMON_EXPECTED" >/dev/null 2>&1; daemon_checkout_exit=$?
daemon_sha=$(git -C "$work/daemon" rev-parse HEAD 2>/dev/null || true)
if [[ "$daemon_checkout_exit" != 0 || "$daemon_sha" != "$DAEMON_EXPECTED" ]]; then exit 1; fi
timeout 420 npm ci --omit=dev --prefix "$work/daemon" --silent >/dev/null 2>&1; daemon_install_exit=$?
if [[ "$daemon_install_exit" != 0 ]]; then exit 1; fi
timeout 120 git clone -q --filter=blob:none https://github.com/pinokiocomputer/pterm.git "$work/pterm" >/dev/null 2>&1; pterm_clone_exit=$?
if [[ "$pterm_clone_exit" != 0 ]]; then exit 1; fi
git -C "$work/pterm" checkout -q --detach "$PTERM_EXPECTED" >/dev/null 2>&1; pterm_checkout_exit=$?
pterm_sha=$(git -C "$work/pterm" rev-parse HEAD 2>/dev/null || true)
if [[ "$pterm_checkout_exit" != 0 || "$pterm_sha" != "$PTERM_EXPECTED" ]]; then exit 1; fi
timeout 180 npm ci --omit=dev --prefix "$work/pterm" --silent >/dev/null 2>&1; pterm_install_exit=$?
if [[ "$pterm_install_exit" != 0 ]]; then exit 1; fi
setup_exit=0
(cd "$work/daemon" && exec setsid node script/index.js) > /dev/null 2>&1 &
pid=$!; daemon_pid=$pid
readiness_exit=1
for i in {1..90}; do
  kill -0 "$pid" 2>/dev/null || break
  http_status=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:42000/pinokio/version 2>/dev/null || true)
  if [[ "$http_status" == 200 ]] && kill -0 "$pid" 2>/dev/null; then readiness_exit=0; break; fi
  sleep 1
done
ss -ltnp '( sport = :42000 )' > "$out/listener.txt" 2>&1; listener_capture_exit=$?
listener_owner_exit=1
if [[ "$listener_capture_exit" == 0 ]] && awk -v pid="$pid" '$4 == "0.0.0.0:42000" && index($0,"pid=" pid ",") { found=1 } END { exit !found }' "$out/listener.txt"; then listener_owner_exit=0; fi
exit 0
