'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const PINOKIOD_REF = 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const ARIA2_PATH = path.join('kernel', 'bin', 'aria2.js');
const SOURCE_SHA256 = '43ccf5bdf6952700a94461f216b0c38f3ab45f3a92f446245f7855210748848c';
const BEFORE = '  env() {\n    if (this.kernel.platform === \'win32\') {';
const AFTER = '  env(kernel) {\n    if (kernel.platform === \'win32\') {';

function sha256(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function patchSource(source) {
  if (typeof source !== 'string' || sha256(source) !== SOURCE_SHA256) {
    throw new Error('pinned Aria2 source hash mismatch; refusing seed patch');
  }
  if (source.split(BEFORE).length !== 2) {
    throw new Error('pinned Aria2 seed patch anchor mismatch');
  }
  return source.replace(BEFORE, AFTER);
}

function applyLinuxSeedFix(pinokiodRoot) {
  const head = execFileSync('git', ['-C', pinokiodRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== PINOKIOD_REF) throw new Error('pinokiod checkout is not the pinned seed source');
  const file = path.join(pinokiodRoot, ARIA2_PATH);
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchSource(source);
  fs.writeFileSync(file, patched, 'utf8');
  return { pinokiod_ref: head, path: ARIA2_PATH, source_sha256: SOURCE_SHA256, patched_sha256: sha256(patched) };
}

if (require.main === module) {
  const pinokiodRoot = process.argv[2];
  if (!pinokiodRoot) throw new Error('usage: node r20-linux-seed-fix.cjs <pinned-pinokiod-root>');
  process.stdout.write(`${JSON.stringify(applyLinuxSeedFix(pinokiodRoot))}\n`);
}

module.exports = { AFTER, ARIA2_PATH, BEFORE, PINOKIOD_REF, SOURCE_SHA256, applyLinuxSeedFix, patchSource, sha256 };
