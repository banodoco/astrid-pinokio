// Report only a package name and fixed diagnostic labels; npm logs can contain
// local paths or credentials and must not be retained in the venue artifact.
const fs = require('node:fs');
const log = fs.readFileSync(process.argv[2], 'utf8');
const match = log.match(/npm (?:ERR!|error) path [^\r\n]*[\\/]node_modules[\\/](@[a-z0-9._-]+[\\/])?([a-z0-9._-]+)/i);
if (match) console.log(`npm package=${(match[1] || '').replace('\\', '/')}${match[2]}`);
for (const [label, pattern] of [
  ['prebuilt-unavailable', /no prebuilt binaries found|prebuild-install.*(?:warn|error)/i],
  ['node-gyp', /node-gyp|gyp ERR!/i],
  ['visual-studio', /find VS|visual studio/i],
  ['python', /find Python|could not find python/i],
  ['network', /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i],
  ['permission', /EACCES|EPERM/i],
  ['disk-space', /ENOSPC/i],
]) if (pattern.test(log)) console.log(`npm diagnostic=${label}`);
