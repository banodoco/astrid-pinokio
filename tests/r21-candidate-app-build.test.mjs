import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { verifyCandidateAppProvenance } = require('../.github/venue/r21-candidate-app-build.cjs');
const { APP_RUNTIME, MANIFEST_SHA256, TUPLE } = require('../.github/venue/r21-verify.cjs');

function provenance() {
  return {
    source_commit: TUPLE.app, manifest_sha256: MANIFEST_SHA256,
    build_json_app: TUPLE.app, build_json_release: 1, build_json_sha256: 'a'.repeat(64),
    origin: APP_RUNTIME.origin, local_loopback: true,
  };
}

test('R-21 candidate App provenance requires the exact checkout, generated identity, and loopback exact-origin serve', () => {
  assert.deepEqual(verifyCandidateAppProvenance(provenance(), {
    appSha: TUPLE.app, manifestSha256: MANIFEST_SHA256,
  }), provenance());
  for (const mutate of [
    value => { value.source_commit = '0'.repeat(40); },
    value => { value.manifest_sha256 = '0'.repeat(64); },
    value => { value.build_json_app = '0'.repeat(40); },
    value => { value.build_json_release = 2; },
    value => { value.local_loopback = false; },
    value => { value.origin = 'https://wrong.invalid'; },
  ]) {
    const value = provenance(); mutate(value);
    assert.throws(() => verifyCandidateAppProvenance(value, {
      appSha: TUPLE.app, manifestSha256: MANIFEST_SHA256,
    }), /candidate App build rejected/);
  }
});

test('R-21 runner serves only the built exact candidate App at the product origin', () => {
  const runner = fs.readFileSync('.github/venue/r21-real-engine.sh', 'utf8');
  const server = fs.readFileSync('.github/venue/r21-candidate-app-server.cjs', 'utf8');
  const browser = fs.readFileSync('.github/venue/r21-app-browser.cjs', 'utf8');
  assert.match(runner, /git -C "\$RUNNER_TEMP\/r21-candidate-app-source" fetch .*ce1502e94b935fe6ef1e2f363fc6b55aade4a204/s);
  assert.match(runner, /npm run --prefix "\$RUNNER_TEMP\/r21-candidate-app-source" build:hosted --silent/);
  assert.match(runner, /cmp "\$candidate_app_dist\/build\.json" "\$RUNNER_TEMP\/r21-served-build\.json"/);
  assert.match(runner, /R21_CANDIDATE_APP_HOST_RULES='MAP astrid\.haus 127\.0\.0\.1'/);
  assert.match(browser, /--host-resolver-rules=\$\{hostResolverRules\}/);
  assert.match(server, /https\.createServer/);
  assert.match(server, /host: '127\.0\.0\.1', port: 0/);
  assert.match(server, /astrid\\\.haus/);
});
