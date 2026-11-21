'use strict';

const path = require('node:path').posix;
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

function bootstrap({ root, installerUrl, installerFile, manifest, manifestUrl, action = 'install', deleteData = false, yes = false }) {
  const args = ['--root', root, '--managed-by', 'pinokio'];
  if (yes) args.push('--yes');
  if (action !== 'install') args.push(`--${action}`);
  if (deleteData) args.push('--delete-data');
  if (manifest) args.push('--manifest', manifest);
  if (installerFile) return [
    'set -eu',
    // The POSIX bootstrap currently puts its disposable venv beside --manifest.
    // Do not let Vite copy that installer cache out of public/ into dist/.
    `trap ${quote(`rm -rf -- ${quote(path.join(path.dirname(installerFile), 'bootstrap-venv'))}`)} EXIT`,
    `sh ${quote(installerFile)} ${args.map(quote).join(' ')}`,
  ].join('\n');
  // Download before execution so a failed curl cannot look like an empty,
  // successful installer. Ref scripts and manifests share one private temp dir.
  return [
    'set -eu',
    'tmp=$(mktemp -d)',
    `trap 'rm -rf "$tmp"' EXIT`,
    `trap 'exit 129' HUP`,
    `trap 'exit 130' INT`,
    `trap 'exit 143' TERM`,
    `curl -fsSL ${quote(installerUrl)} -o "$tmp/install"`,
    ...(manifestUrl ? [`curl -fsSL ${quote(manifestUrl)} -o "$tmp/install-manifest.json"`] : []),
    `sh "$tmp/install" ${args.map(quote).join(' ')}${manifestUrl ? ' --manifest "$tmp/install-manifest.json"' : ''}`,
  ].join('\n');
}

function run(root, args = []) {
  return [quote(path.join(root, 'run')), ...args.map(quote)].join(' ');
}

module.exports = { quote, bootstrap, run };
