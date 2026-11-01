'use strict';
const fs = require('node:fs');
const errnoNames = new Set([...Object.keys(require('node:os').constants.errno),
  'EACCES', 'EAGAIN', 'EBUSY', 'ECONNREFUSED', 'ECONNRESET', 'EEXIST', 'EINVAL',
  'EIO', 'EISDIR', 'EMFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY',
  'EPERM', 'EPIPE', 'ETIMEDOUT', 'E404', 'E401', 'E403', 'E500', 'E502', 'E503',
  'EAUTH', 'EBADENGINE', 'EBADPLATFORM', 'ECOMPROMISED', 'EINTEGRITY', 'EINVALIDPACKAGENAME',
  'EJSONPARSE', 'ELOCKVERIFY', 'ENOVERSIONS', 'ERESOLVE', 'ETARGET', 'EUSAGE']);

const safeTools = [
  ['node-gyp', /(?:^|[^a-z0-9_-])node-gyp(?:\.cmd|\.js)?(?:\s|$)/i],
  ['node-pre-gyp', /(?:^|[^a-z0-9_-])node-pre-gyp(?:\.cmd|\.js)?(?:\s|$)/i],
  ['prebuild-install', /(?:^|[^a-z0-9_-])prebuild-install(?:\.cmd|\.js)?(?:\s|$)/i],
  ['cmake-js', /(?:^|[^a-z0-9_-])cmake-js(?:\.cmd|\.js)?(?:\s|$)/i],
  ['cmake', /(?:^|[^a-z0-9_-])cmake(?:\.exe)?(?:\s|$)/i],
  ['msbuild', /(?:^|[^a-z0-9_-])(?:MSBuild|msbuild)(?:\.exe)?(?:\s|$)/i],
  ['python', /(?:^|[^a-z0-9_-])python(?:3(?:\.\d+)?)?(?:\.exe)?(?:\s|$)/i],
];
const safeReasons = [
  ['python-missing', /could not find (?:any )?python|python (?:is not set|not found|was not found)|can't find python/i],
  ['msbuild-missing', /(?:msbuild|visual studio).{0,80}(?:not found|not installed|could not be found)|(?:not found|not installed|could not be found).{0,80}(?:msbuild|visual studio)/i],
  ['compiler-missing', /(?:no suitable )?(?:c\+\+ )?compiler (?:found|available)|unable to find (?:a )?(?:c\+\+ )?compiler/i],
  ['unsupported-node', /unsupported (?:runtime|node(?:\.js)?)(?: version)?|node(?:\.js)? version .* not supported/i],
  ['prebuild-unavailable', /no prebuilt binaries found|pre-built binaries? (?:not found|unavailable)/i],
  ['network-failure', /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/i],
];

// Only emit lockfile-verified package identities and bounded npm error tokens.
function diagnose(log, lock) {
  const codes = new Set();
  const packages = new Set();
  const phases = new Set();
  const tools = new Set();
  const reasons = new Set();
  const entries = Object.entries(lock.packages || {}).filter(([key, value]) =>
    /^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/)*node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(key) &&
    typeof value.version === 'string' && /^[0-9][a-zA-Z0-9.+_-]{0,63}$/.test(value.version));
  for (const line of log.split(/\r?\n/)) {
    const code = /^npm (?:ERR!|error) (code|errno) (-?[A-Z0-9_]{1,32})\s*$/.exec(line);
    if (code && (errnoNames.has(code[2]) ||
      (/^-?[0-9]{1,5}$/.test(code[2]) && Math.abs(Number(code[2])) <= 65535))) {
      codes.add(`${code[1]}=${code[2]}`);
    }
    const match = /^npm (?:ERR!|error) path (.+)$/.exec(line);
    if (match) {
      const path = match[1].replace(/\\/g, '/');
      const found = entries.filter(([key]) => path.endsWith('/' + key) || path.includes('/' + key + '/'))
        .sort((a, b) => b[0].length - a[0].length)[0];
      if (found) {
        const name = found[0].slice(found[0].lastIndexOf('node_modules/') + 'node_modules/'.length);
        packages.add(`${name}@${found[1].version}`);
      }
    }
    const lifecycle = /^npm (?:ERR!|error) lifecycle [^\r\n]*~(preinstall|install|postinstall): failed\s*$/i.exec(line);
    if (lifecycle) phases.add(lifecycle[1].toLowerCase());
    if (/^npm (?:ERR!|error) command\s+/i.test(line)) {
      for (const [name, pattern] of safeTools) if (pattern.test(line)) tools.add(name);
    }
    for (const [name, pattern] of safeReasons) if (pattern.test(line)) reasons.add(name);
  }
  return [...[...packages].sort().slice(0, 10).map(p => `package=${p}`),
    ...[...phases].sort().slice(0, 3).map(p => `phase=${p}`),
    ...[...tools].sort().slice(0, 5).map(t => `tool=${t}`),
    ...[...reasons].sort().slice(0, 5).map(r => `reason=${r}`),
    ...[...codes].sort().slice(0, 10)].join('\n');
}
if (require.main === module) {
  try {
    const result = diagnose(fs.readFileSync(process.argv[2], 'utf8'), JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
    console.log(result || 'diagnostic=unavailable');
  } catch {
    console.log('diagnostic=unavailable');
  }
}
module.exports = { diagnose };
