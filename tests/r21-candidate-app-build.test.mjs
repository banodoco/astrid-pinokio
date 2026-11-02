import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
  assert.match(runner, /git -C "\$RUNNER_TEMP\/r21-candidate-app-source" fetch .*933c53a6fb1a11e5f8a01335d6252016d703beec/s);
  assert.match(runner, /npm run --prefix "\$RUNNER_TEMP\/r21-candidate-app-source" build:hosted --silent/);
  assert.match(runner, /cmp "\$candidate_app_dist\/build\.json" "\$RUNNER_TEMP\/r21-served-build\.json"/);
  assert.match(runner, /R21_CANDIDATE_APP_HOST_RULES='MAP astrid\.haus 127\.0\.0\.1'/);
  assert.match(browser, /--host-resolver-rules=\$\{hostResolverRules\}/);
  assert.match(server, /https\.createServer/);
  assert.match(server, /host: '127\.0\.0\.1', port: 0/);
  assert.match(server, /astrid\\\.haus/);
});

test('R-21 local TLS server serves the generated build identity only to the production host', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'r21-candidate-app-server-'));
  const dist = path.join(root, 'dist');
  const key = path.join(root, 'key.pem');
  const cert = path.join(root, 'cert.pem');
  const ready = path.join(root, 'ready.json');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>candidate</title>');
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ app: TUPLE.app, release: 1 }));
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=astrid.haus', '-addext', 'subjectAltName=DNS:astrid.haus', '-keyout', key, '-out', cert], { encoding: 'utf8' });
  assert.equal(certificate.status, 0, certificate.stderr);
  const child = spawn(process.execPath, ['.github/venue/r21-candidate-app-server.cjs', '--root', dist, '--key', key, '--cert', cert, '--ready', ready]);
  const readReady = async () => {
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('candidate App TLS server did not start');
  };
  const request = (host) => new Promise((resolve, reject) => {
    const started = https.request({ host: '127.0.0.1', port: server.port, path: '/build.json',
      headers: { Host: host }, rejectUnauthorized: false }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', part => { body += part; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    started.once('error', reject); started.end();
  });
  let server;
  try {
    server = await readReady();
    assert.deepEqual(await request('astrid.haus'), { status: 200, body: JSON.stringify({ app: TUPLE.app, release: 1 }) });
    assert.deepEqual(await request('wrong.invalid'), { status: 421, body: '' });
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('close', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
