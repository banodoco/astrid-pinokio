#!/usr/bin/env bash
# Dedicated R-21 venue entrypoint.  This is intentionally not sourced by the
# R-20 Reset runner: it builds a retained historical launcher and drives the
# old Update -> Pinokio Stop -> fresh Update journey through native pinokiod.
set -euo pipefail

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
stage='preflight'
daemon_pid=''

if [ -e "$out" ] || [ -e "$venue_home" ] || [ -e "$source_root" ] || [ -e "$agent_source" ]; then
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
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [ -d "$out" ]; then
    (cd "$out" && rm -f SHA256SUMS && sha256sum ./* > SHA256SUMS) || true
  fi
  exit "$status"
}
trap failure_receipt EXIT

stage='verify-native-inputs'
test "$(git rev-parse HEAD)" = "$R21_RUNNER_REF"
git merge-base --is-ancestor 89ed7aacae72bb48eb97ff9ff95c222bdd7e71e4 HEAD
test "$(git -C "$RUNNER_TEMP/pinokiod" rev-parse HEAD)" = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf'
test "$(git -C "$RUNNER_TEMP/pterm" rev-parse HEAD)" = '5be43718701c448b43daf0ce51d8935f170065bb'
node .github/venue/r21-inputs.cjs --output "$request"
git init --quiet "$agent_source"
git -C "$agent_source" remote add origin https://github.com/banodoco/astrid-agent.git
git -C "$agent_source" fetch --quiet --filter=blob:none origin \
  af5ae8afdb9829beb2bba4f811dbe97765bd72b2 \
  c722bc77020add08405e700300efb533011ffc2b
test "$(git -C "$agent_source" rev-parse af5ae8afdb9829beb2bba4f811dbe97765bd72b2^{commit})" = 'af5ae8afdb9829beb2bba4f811dbe97765bd72b2'
git -C "$agent_source" merge-base --is-ancestor \
  c722bc77020add08405e700300efb533011ffc2b \
  af5ae8afdb9829beb2bba4f811dbe97765bd72b2

stage='retain-historical-launcher'
# Create a private, immutable local origin at the old launcher revision.  The
# historical Update action still performs its real `git pull --ff-only`, but
# it cannot drift to an unreviewed remote head between the first and retry
# clicks.  No installer behavior is changed.
git clone --quiet --filter=blob:none --no-checkout https://github.com/banodoco/astrid-pinokio.git "$source_root"
git -C "$source_root" fetch --quiet origin bbba620e3d89eeff8021417f365e6ea584203105
git -C "$source_root" branch -f r21-old bbba620e3d89eeff8021417f365e6ea584203105
git clone --quiet --branch r21-old --single-branch --no-local "$source_root" "$app_root"
test "$(git -C "$app_root" rev-parse HEAD)" = 'bbba620e3d89eeff8021417f365e6ea584203105'
# The retained launcher normally reads this supported setting from its tracked
# environment file.  The immutable app SHA makes both fetched bootstrap and
# manifest resolve to the published RC-0 App input.
sed -i 's/^ASTRID_APP_REF=.*/ASTRID_APP_REF=a55bec9ff384b5bbfee5535962880084ab2adb1b/' "$app_root/_ENVIRONMENT"

stage='verify-published-app-manifest'
# This is the same immutable raw URL the historical launcher will execute.
# Validate its pins before any action, while retaining neither its contents nor
# setup output as R-21 evidence.
manifest="$RUNNER_TEMP/r21-published-install-manifest.json"
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/banodoco/astrid-app/a55bec9ff384b5bbfee5535962880084ab2adb1b/public/install-manifest.json \
  --output "$manifest"
node - "$manifest" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = {
  agent: 'af5ae8afdb9829beb2bba4f811dbe97765bd72b2',
  runtime: '47e5949465cb6f3afdfd1cb8a0e90009fd9d4020',
};
for (const [name, sha] of Object.entries(expected)) {
  if (manifest?.[name]?.sha !== sha) process.exit(1);
}
NODE
rm -f "$manifest"

stage='start-native-engine'
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
env HOME="$venue_home/user-home" XDG_DATA_HOME="$venue_home/data" PINOKIO_HOME="$venue_home" \
  R21_APP_ROOT="$app_root" R21_PTERM_ROOT="$RUNNER_TEMP/pterm" R21_VENUE_HOME="$venue_home" \
  node .github/venue/r21-observe.cjs "$request" "$out"

stage='complete'
