import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const frozenTuple = JSON.parse(fs.readFileSync(new URL('../fixtures/keepgoing-tuple.json', import.meta.url), 'utf8'));
export const frozenAppBranch = 'lane/M-APP/PINOKIO-APP-BINDING';
const appRepository = 'https://github.com/banodoco/astrid-app';
const sha = /^[a-f0-9]{40}$/;

export function validateDiagnosticTuple(environment, sourceHead) {
  for (const [key, field] of [['APP_REF', 'app'], ['AGENT_REF', 'agent'], ['RUNTIME_REF', 'runtime']]) {
    assert.equal(environment[key], frozenTuple[field], `${key} differs from frozen diagnostic product tuple`);
  }
  assert.match(environment.PINOKIO_REF || '', sha, 'PINOKIO_REF must be an exact harness source SHA');
  assert.equal(sourceHead, environment.PINOKIO_REF, 'Pinokio diagnostic harness HEAD differs');
  return { product: frozenTuple, pinokio_harness: sourceHead, qualification_eligible: false };
}

export function verifyDiagnosticAsset(name, bytes) {
  const expected = name === 'install-manifest.json' ? frozenTuple.manifest_sha256 : frozenTuple.artifacts[`public/${name}`];
  assert.ok(expected, `unknown diagnostic asset ${name}`);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected, `${name} differs from frozen App bytes`);
  if (name === 'install-manifest.json') {
    const manifest = JSON.parse(bytes.toString('utf8'));
    assert.equal(manifest.agent.sha, frozenTuple.agent, 'manifest Agent differs');
    assert.equal(manifest.runtime.sha, frozenTuple.runtime, 'manifest Runtime differs');
  }
  return expected;
}

export function setDiagnosticAppRef(appDirectory) {
  const file = path.join(appDirectory, '_ENVIRONMENT');
  const contents = fs.readFileSync(file, 'utf8');
  const setting = /^[ \t]*ASTRID_APP_REF[ \t]*=[^\r\n]*/m;
  const replacement = `ASTRID_APP_REF=${frozenAppBranch}`;
  fs.writeFileSync(file, setting.test(contents) ? contents.replace(setting, replacement) : `${contents.trimEnd()}\n${replacement}\n`);
}

export function verifyAppBranch() {
  const line = execFileSync('git', ['ls-remote', '--exit-code', appRepository, `refs/heads/${frozenAppBranch}`],
    { encoding: 'utf8', timeout: 30000 }).trim();
  assert.equal(line.split(/\s+/)[0], frozenTuple.app, 'frozen App fixture branch moved; refuse tuple drift');
}

export async function prepareDiagnosticFixture(appDirectory, environment, sourceDirectory) {
  const sourceHead = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
  const selection = validateDiagnosticTuple(environment, sourceHead);
  verifyAppBranch();
  const assets = {};
  for (const name of ['install-manifest.json', 'install', 'install.sh', 'install.ps1']) {
    const response = await fetch(`https://raw.githubusercontent.com/banodoco/astrid-app/${frozenTuple.app}/public/${name}`,
      { signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, `cannot obtain frozen App ${name}: HTTP ${response.status}`);
    assets[name] = verifyDiagnosticAsset(name, Buffer.from(await response.arrayBuffer()));
  }
  setDiagnosticAppRef(appDirectory);
  return { ...selection, app_fixture_branch: frozenAppBranch, verified_assets: assets,
    fixture: 'disposable launcher checkout; genuine harness-created precondition',
    engine: 'launcher-array smoke; no native Pinokiod/PTerm execution', c5_u1: 'not-in-this-published-product-tuple' };
}

export function verifyInstalledEditor(app) {
  if (!fs.existsSync(path.join(app.EDITOR_DIR, '.git'))) return;
  const head = execFileSync('git', ['-C', app.EDITOR_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.equal(head, frozenTuple.app, 'installed editor checkout differs from frozen App tuple');
  verifyDiagnosticAsset('install-manifest.json', fs.readFileSync(path.join(app.EDITOR_DIR, 'public', 'install-manifest.json')));
}
