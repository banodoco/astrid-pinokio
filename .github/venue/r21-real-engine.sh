#!/usr/bin/env bash
# Dedicated R-21 venue entrypoint.  This is intentionally not sourced by the
# R-20 Reset runner: it builds a retained historical launcher and drives the
# old Update -> Pinokio Stop -> fresh Update journey through native pinokiod.
set -euo pipefail

# The deadline covers all setup and the journey, including cleanup. A separate
# process group lets the supervisor terminate descendants even if its leader
# exits on TERM. The job has 90 minutes; 70 minutes leaves publication headroom.
if [[ "${1:-}" == --execute || "${1:-}" == --watchdog ]]; then
  mode=$1; shift
  deadline=4200
  if [[ "$mode" == --watchdog ]]; then deadline=${1:?deadline required}; shift; fi
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || exit 2
  request=${1:?request required}
  : "${RUNNER_TEMP:?RUNNER_TEMP is required}"
  export R21_PROGRESS_DIR="$RUNNER_TEMP/r21-watchdog"
  mkdir "$R21_PROGRESS_DIR"
  export R21_STARTED_MS
  R21_STARTED_MS=$(node -p 'Date.now()')
  setsid bash "$0" --work "$request" &
  worker=$!
  sleep "$deadline" &
  timer=$!
  set +e
  finished=''
  wait -n -p finished "$worker" "$timer"
  status=$?
  if [[ "$finished" == "$timer" ]]; then
    # Always escalate, even if the leader exits on TERM: descendants may not.
    kill -TERM -- "-$worker" 2>/dev/null || true
    sleep 5
    kill -KILL -- "-$worker" 2>/dev/null || true
    # Do not let a task stuck in uninterruptible kernel sleep block publication.
    for _ in 1 2; do
      kill -0 "$worker" 2>/dev/null || break
      sleep 1
    done
    if ! kill -0 "$worker" 2>/dev/null; then wait "$worker" 2>/dev/null; fi
    status=124
    timed_out=true
  else
    kill "$timer" 2>/dev/null || true
    wait "$timer" 2>/dev/null || true
    # A completed leader can still have live clients in its process group.
    if kill -0 -- "-$worker" 2>/dev/null; then
      kill -TERM -- "-$worker" 2>/dev/null || true
      sleep 5
      kill -KILL -- "-$worker" 2>/dev/null || true
    fi
    timed_out=false
  fi
  node -e 'const fs=require("node:fs");const [dir,start,timed,code]=process.argv.slice(1);fs.writeFileSync(`${dir}/watchdog.json`,JSON.stringify({timed_out:timed==="true",elapsed_ms:Math.max(0,Date.now()-Number(start)),exit_code:Number(code)}));' "$R21_PROGRESS_DIR" "$R21_STARTED_MS" "$timed_out" "$status"
  for phase in setup journey; do
    value=not-run
    if [[ -f "$R21_PROGRESS_DIR/$phase.exit" ]]; then value=$(cat "$R21_PROGRESS_DIR/$phase.exit"); fi
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf '%s_exit=%s\n' "$phase" "$value" >> "$GITHUB_OUTPUT"; fi
  done
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'watchdog_exit=%s\n' "$status" >> "$GITHUB_OUTPUT"; fi
  exit "$status"
fi

if [[ "${1:-}" == --work ]]; then
  shift
  request=${1:?request required}
  progress() {
    node -e 'const fs=require("node:fs");const [dir,start,stage,substage]=process.argv.slice(1);const p=`${dir}/progress.json`;fs.writeFileSync(`${p}.tmp`,JSON.stringify({stage,substage:substage||null,elapsed_ms:Math.max(0,Date.now()-Number(start))}));fs.renameSync(`${p}.tmp`,p);' "$R21_PROGRESS_DIR" "$R21_STARTED_MS" "$1" "${2:-}"
  }
  set +e
  (
    set -euo pipefail
    progress setup clone-pinokiod
    git clone --filter=blob:none https://github.com/pinokiocomputer/pinokiod.git "$RUNNER_TEMP/pinokiod"
    progress setup checkout-pinokiod
    git -C "$RUNNER_TEMP/pinokiod" checkout --detach add4a674ad1ba95bb62ec427fce519fe5bf0e9bf
    progress setup install-pinokiod
    npm ci --omit=dev --prefix "$RUNNER_TEMP/pinokiod" --silent
    progress setup clone-pterm
    git clone --filter=blob:none https://github.com/pinokiocomputer/pterm.git "$RUNNER_TEMP/pterm"
    progress setup checkout-pterm
    git -C "$RUNNER_TEMP/pterm" checkout --detach 5be43718701c448b43daf0ce51d8935f170065bb
    progress setup install-pterm
    npm ci --omit=dev --prefix "$RUNNER_TEMP/pterm" --silent
    progress setup clone-candidate-app
    git init --quiet "$RUNNER_TEMP/r21-candidate-app-source"
    git -C "$RUNNER_TEMP/r21-candidate-app-source" remote add origin https://github.com/banodoco/astrid-app.git
    git -C "$RUNNER_TEMP/r21-candidate-app-source" fetch --quiet --depth=1 --filter=blob:none origin \
      ce1502e94b935fe6ef1e2f363fc6b55aade4a204
    git -C "$RUNNER_TEMP/r21-candidate-app-source" checkout --quiet --detach FETCH_HEAD
    test "$(git -C "$RUNNER_TEMP/r21-candidate-app-source" rev-parse HEAD)" = 'ce1502e94b935fe6ef1e2f363fc6b55aade4a204'
    progress setup install-candidate-app
    npm ci --prefix "$RUNNER_TEMP/r21-candidate-app-source" --silent
    progress setup build-candidate-app
    env RAILWAY_GIT_COMMIT_SHA=ce1502e94b935fe6ef1e2f363fc6b55aade4a204 \
      VITE_APP_BUILD=ce1502e94b935fe6ef1e2f363fc6b55aade4a204 NODE_OPTIONS=--max-old-space-size=4096 \
      npm run --prefix "$RUNNER_TEMP/r21-candidate-app-source" build:hosted --silent
    node .github/venue/r21-candidate-app-build.cjs \
      --source "$RUNNER_TEMP/r21-candidate-app-source" \
      --app ce1502e94b935fe6ef1e2f363fc6b55aade4a204 \
      --manifest 920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87 \
      --output "$RUNNER_TEMP/r21-candidate-app-build.json"
  )
  status=$?
  printf '%s\n' "$status" > "$R21_PROGRESS_DIR/setup.exit"
  if [[ "$status" -eq 0 ]]; then
    bash "$0" "$request"
    status=$?
    printf '%s\n' "$status" > "$R21_PROGRESS_DIR/journey.exit"
  fi
  exit "$status"
fi

request="${1:?usage: r21-real-engine.sh <r21-request.json>}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${R21_REQUEST_ID:?R21_REQUEST_ID is required}"
: "${R21_RUNNER_REF:?R21_RUNNER_REF is required}"
: "${R21_CONFIRMATION:?R21_CONFIRMATION is required}"

out="$RUNNER_TEMP/r21-evidence"
venue_home="$RUNNER_TEMP/r21-pinokio-home"
source_root="$RUNNER_TEMP/r21-old-launcher-source"
agent_source="$RUNNER_TEMP/r21-published-agent-source"
app_root="$venue_home/api/astrid"
candidate_app_source="$RUNNER_TEMP/r21-candidate-app-source"
candidate_app_dist="$candidate_app_source/dist"
candidate_app_provenance="$RUNNER_TEMP/r21-candidate-app-build.json"
candidate_app_key="$RUNNER_TEMP/r21-candidate-app.key"
candidate_app_cert="$RUNNER_TEMP/r21-candidate-app.crt"
candidate_app_ready="$RUNNER_TEMP/r21-candidate-app-server.json"
candidate_app_pid=''
candidate_app_port=''
candidate_app_nat=false
stage='preflight'
daemon_pid=''
progress() {
  if [[ -n "${R21_PROGRESS_DIR:-}" ]]; then
    node -e 'const fs=require("node:fs");const [dir,start,stage]=process.argv.slice(1);const p=`${dir}/progress.json`;fs.writeFileSync(`${p}.tmp`,JSON.stringify({stage,substage:null,elapsed_ms:Math.max(0,Date.now()-Number(start))}));fs.renameSync(`${p}.tmp`,p);' "$R21_PROGRESS_DIR" "$R21_STARTED_MS" "$stage"
  fi
}
progress "$stage"

if [ -e "$out" ] || [ -e "$venue_home" ] || [ -e "$source_root" ] || [ -e "$agent_source" ] \
    || [ ! -d "$candidate_app_source" ] || [ ! -d "$candidate_app_dist" ] || [ ! -f "$candidate_app_provenance" ]; then
  printf 'R-21 venue paths already exist; a fresh RUNNER_TEMP is required\n' >&2
  exit 1
fi
mkdir -p "$out" "$venue_home/api" "$venue_home/user-home" "$venue_home/data"
chmod 700 "$out" "$venue_home" "$venue_home/user-home" "$venue_home/data"

failure_receipt() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # Artifacts are deliberately limited to this stable stage label; raw
    # installer, daemon, command, and hosted logs remain only in the venue.
    node -e 'const fs=require("node:fs"); const p=process.argv[1]; const stage=process.argv[2]; if (!fs.existsSync(`${p}/r21-receipt.json`)) fs.writeFileSync(`${p}/r21-runner-failure.json`, JSON.stringify({schema:1,status:"blocked",stage},null,2)+"\n",{mode:0o600});' "$out" "$stage" || true
  fi
  if [ -n "$daemon_pid" ]; then
    kill "$daemon_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$daemon_pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [ "$candidate_app_nat" = true ] && [ -n "$candidate_app_port" ]; then
    sudo -n iptables -w -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports "$candidate_app_port" 2>/dev/null || true
  fi
  if [ -n "$candidate_app_pid" ]; then
    kill "$candidate_app_pid" 2>/dev/null || true
    wait "$candidate_app_pid" 2>/dev/null || true
  fi
  if [ -d "$out" ]; then
    (cd "$out" && rm -f SHA256SUMS && sha256sum ./* > SHA256SUMS) || true
  fi
  exit "$status"
}
trap failure_receipt EXIT

stage='verify-native-inputs'
progress "$stage"
test "$(git rev-parse HEAD)" = "$R21_RUNNER_REF"
git merge-base --is-ancestor 3a6a98ae251ca126505245286e2d3e760f4348e9 HEAD
chrome_path=$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser)
test -x "$chrome_path"
test "$(git -C "$RUNNER_TEMP/pinokiod" rev-parse HEAD)" = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf'
test "$(git -C "$RUNNER_TEMP/pterm" rev-parse HEAD)" = '5be43718701c448b43daf0ce51d8935f170065bb'
node .github/venue/r21-candidate-app-build.cjs \
  --source "$candidate_app_source" \
  --app ce1502e94b935fe6ef1e2f363fc6b55aade4a204 \
  --manifest 920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87 \
  --output "$candidate_app_provenance"
node .github/venue/r21-inputs.cjs --output "$request"
git init --quiet "$agent_source"
git -C "$agent_source" remote add origin https://github.com/banodoco/astrid-agent.git
git -C "$agent_source" fetch --quiet --filter=blob:none origin \
  2de0726d1eaea7f7bd141251e088aa9fdf224525 \
  cb71f548caf6f06051eaeb161cce45e44401e145
test "$(git -C "$agent_source" rev-parse 2de0726d1eaea7f7bd141251e088aa9fdf224525^{commit})" = '2de0726d1eaea7f7bd141251e088aa9fdf224525'
git -C "$agent_source" merge-base --is-ancestor \
  cb71f548caf6f06051eaeb161cce45e44401e145 \
  2de0726d1eaea7f7bd141251e088aa9fdf224525

stage='retain-historical-launcher'
progress "$stage"
# Create a private, immutable local origin at the old launcher revision.  The
# historical Update action still performs its real `git pull --ff-only`, but
# it cannot drift to an unreviewed remote head between the first and retry
# clicks.  No installer behavior is changed.
git init --quiet "$source_root"
git -C "$source_root" remote add origin https://github.com/banodoco/astrid-pinokio.git
# A complete shallow tree avoids lazy object fetches during local upload-pack.
git -C "$source_root" fetch --quiet --depth=1 origin bbba620e3d89eeff8021417f365e6ea584203105
git -C "$source_root" branch -f r21-old FETCH_HEAD
git clone --quiet --branch r21-old --single-branch --no-local "$source_root" "$app_root"
test "$(git -C "$app_root" rev-parse HEAD)" = 'bbba620e3d89eeff8021417f365e6ea584203105'
# The retained launcher normally reads this supported setting from its tracked
# environment file.  The immutable app SHA makes both fetched bootstrap and
# manifest resolve to the current published R-21 App input.
sed -i 's/^ASTRID_APP_REF=.*/ASTRID_APP_REF=ce1502e94b935fe6ef1e2f363fc6b55aade4a204/' "$app_root/_ENVIRONMENT"

stage='verify-published-app-manifest'
progress "$stage"
# This is the same immutable raw URL the historical launcher will execute.
# Validate its pins before any action, while retaining neither its contents nor
# setup output as R-21 evidence.
manifest="$RUNNER_TEMP/r21-published-install-manifest.json"
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/banodoco/astrid-app/ce1502e94b935fe6ef1e2f363fc6b55aade4a204/public/install-manifest.json \
  --output "$manifest"
printf '%s  %s\n' '920477210d01615a6698cda30f248552f13c712734e86ea56f283300cb1a9c87' "$manifest" | sha256sum --check --status
node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = {
  agent: '2de0726d1eaea7f7bd141251e088aa9fdf224525',
  runtime: '5453366458f7b4ee874c94d15ae7952e3e82d3c3',
};
for (const [name, sha] of Object.entries(expected)) {
  if (manifest?.[name]?.sha !== sha) process.exit(1);
}
if (manifest?.runtime?.schema_digest !== 'sha256:9628bb5fd6e1dbbec392dd39f2e01031622dcf52d7ccff7cd1f0ad10743dcb1c') process.exit(1);
NODE
rm -f "$manifest"

stage='serve-candidate-app-build'
progress "$stage"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj '/CN=astrid.haus' -addext 'subjectAltName=DNS:astrid.haus,IP:127.0.0.1' \
  -keyout "$candidate_app_key" -out "$candidate_app_cert" >/dev/null 2>&1
chmod 600 "$candidate_app_key"
node .github/venue/r21-candidate-app-server.cjs --root "$candidate_app_dist" \
  --key "$candidate_app_key" --cert "$candidate_app_cert" --ready "$candidate_app_ready" >/dev/null 2>&1 &
candidate_app_pid=$!
for _ in $(seq 1 50); do
  if [ -f "$candidate_app_ready" ]; then break; fi
  kill -0 "$candidate_app_pid" 2>/dev/null || exit 1
  sleep 0.1
done
test -f "$candidate_app_ready"
candidate_app_port=$(node - "$candidate_app_ready" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value?.schema !== 1 || value?.host !== '127.0.0.1' || value?.origin !== 'https://astrid.haus'
    || !Number.isInteger(value?.port) || value.port < 1024 || value.port > 65535) process.exit(1);
process.stdout.write(String(value.port));
NODE
)
command -v sudo >/dev/null
sudo -n true
sudo -n iptables -w -t nat -I OUTPUT 1 -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports "$candidate_app_port"
candidate_app_nat=true
curl --noproxy '*' --fail --silent --show-error --resolve astrid.haus:443:127.0.0.1 \
  --cacert "$candidate_app_cert" https://astrid.haus/build.json --output "$RUNNER_TEMP/r21-served-build.json"
cmp "$candidate_app_dist/build.json" "$RUNNER_TEMP/r21-served-build.json"
rm -f "$RUNNER_TEMP/r21-served-build.json"
candidate_app_spki=$(openssl x509 -in "$candidate_app_cert" -pubkey -noout \
  | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 -w0)
test "$candidate_app_spki" != ''

stage='start-native-engine'
progress "$stage"
# A free port is required so all actions and statuses belong to this daemon.
node -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(1));s.listen(42000,"127.0.0.1",()=>s.close());'
(
  cd "$RUNNER_TEMP/pinokiod"
  exec env HOME="$venue_home/user-home" XDG_DATA_HOME="$venue_home/data" \
    PINOKIO_HOME="$venue_home" PINOKIO_HTTPS_ACTIVE=0 PINOKIO_NETWORK_ACTIVE=0 \
    node script/index.js
) >/dev/null 2>&1 &
daemon_pid=$!
ready=0
for _ in $(seq 1 120); do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    printf 'native daemon exited before readiness\n' >&2
    break
  fi
  if curl -fsS http://127.0.0.1:42000/pinokio/version >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1

stage='run-r21-journey'
progress "$stage"
env HOME="$venue_home/user-home" XDG_DATA_HOME="$venue_home/data" PINOKIO_HOME="$venue_home" \
  R21_APP_ROOT="$app_root" R21_PTERM_ROOT="$RUNNER_TEMP/pterm" R21_VENUE_HOME="$venue_home" \
  R21_CHROME_PATH="$chrome_path" R21_CANDIDATE_APP_PROVENANCE="$candidate_app_provenance" \
  R21_CANDIDATE_APP_HOST_RULES='MAP astrid.haus 127.0.0.1' \
  R21_CANDIDATE_APP_CERTIFICATE_SPKI="$candidate_app_spki" \
  node .github/venue/r21-observe.cjs "$request" "$out"

stage='complete'
progress "$stage"
