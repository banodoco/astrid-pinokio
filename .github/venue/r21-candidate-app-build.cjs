'use strict';

// The R-21 venue never treats a public-page response as App identity.  It
// builds this exact App checkout and carries only non-secret provenance from
// its generated build.json into the sanitized receipt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_ORIGIN = 'https://astrid.haus';

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = message => { throw new Error(`candidate App build rejected: ${message}`); };
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function verifyCandidateAppProvenance(value, { appSha, manifestSha256, release = 1 }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provenance is required');
  if (value.source_commit !== appSha || !SHA40.test(value.source_commit)) fail('source commit is not the candidate App');
  if (value.manifest_sha256 !== manifestSha256 || !SHA256.test(value.manifest_sha256)) fail('manifest digest is not the published manifest');
  if (value.build_json_app !== appSha || value.build_json_release !== release) fail('generated build.json does not name the candidate App and release');
  if (!SHA256.test(value.build_json_sha256 || '')) fail('generated build.json digest is missing');
  if (value.origin !== EXPECTED_ORIGIN || value.local_loopback !== true) fail('served App provenance is not the local exact-origin route');
  return {
    source_commit: value.source_commit,
    manifest_sha256: value.manifest_sha256,
    build_json_app: value.build_json_app,
    build_json_release: value.build_json_release,
    build_json_sha256: value.build_json_sha256,
    origin: value.origin,
    local_loopback: true,
  };
}

function verifyCandidateAppBuild({ sourceRoot, appSha, manifestSha256, release = 1 }) {
  if (!path.isAbsolute(sourceRoot) || !fs.existsSync(sourceRoot)) fail('source root is unavailable');
  if (!SHA40.test(appSha || '') || !SHA256.test(manifestSha256 || '')) fail('expected source identities are malformed');
  if (git(sourceRoot, ['rev-parse', 'HEAD']) !== appSha) fail('checkout HEAD is not the candidate App');
  if (git(sourceRoot, ['status', '--porcelain', '--untracked-files=no'])) fail('candidate App tracked source is dirty');
  const manifest = path.join(sourceRoot, 'public', 'install-manifest.json');
  const build = path.join(sourceRoot, 'dist', 'build.json');
  if (!fs.existsSync(manifest) || sha256File(manifest) !== manifestSha256) fail('candidate App manifest bytes differ from the published manifest');
  let value;
  try { value = JSON.parse(fs.readFileSync(build, 'utf8')); } catch { fail('generated dist/build.json is unreadable'); }
  return verifyCandidateAppProvenance({
    source_commit: appSha,
    manifest_sha256: manifestSha256,
    build_json_app: value?.app,
    build_json_release: value?.release,
    build_json_sha256: sha256File(build),
    origin: EXPECTED_ORIGIN,
    local_loopback: true,
  }, { appSha, manifestSha256, release });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

if (require.main === module) {
  const sourceRoot = option('--source');
  const appSha = option('--app');
  const manifestSha256 = option('--manifest');
  const output = option('--output');
  if (!sourceRoot || !appSha || !manifestSha256 || !output || !path.isAbsolute(output)) {
    throw new Error('usage: r21-candidate-app-build.cjs --source <absolute-path> --app <sha> --manifest <sha256> --output <absolute-path>');
  }
  const provenance = verifyCandidateAppBuild({ sourceRoot, appSha, manifestSha256 });
  fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { EXPECTED_ORIGIN, verifyCandidateAppBuild, verifyCandidateAppProvenance };
