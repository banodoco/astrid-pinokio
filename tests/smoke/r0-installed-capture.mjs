import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const R0 = Object.freeze({
  commit: '6d53a19070faf63fc15ae1f81417722edc2c8a5f',
  bootstrapSha256: '2308de857ea58022c589ac44de988572faf3445ed348a01fd8ab7964c306f0eb',
  lifecycleSha256: '8395ffc23d2664f08dcf212d35e97787e7228b44f6610509713bbfde0fdf73ed',
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function inside(candidate, parent, paths = path) {
  const relative = paths.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

function findFiles(directory, basename) {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === basename) matches.push(file);
    }
  };
  visit(directory);
  return matches;
}

function containsCommit(value) {
  if (typeof value === 'string') return value.toLowerCase().includes(R0.commit);
  if (Array.isArray(value)) return value.some(containsCommit);
  if (value && typeof value === 'object') return Object.values(value).some(containsCommit);
  return false;
}

function commitClaims(value, prefix = '$') {
  if (typeof value === 'string') return value.toLowerCase().includes(R0.commit) ? [{ field: prefix, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => commitClaims(item, `${prefix}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => commitClaims(item, `${prefix}.${key}`));
  return [];
}

export function captureInstalledR0(root, { platform = process.platform, tempDirectory = os.tmpdir() } = {}) {
  if (platform !== 'win32') throw new Error('Native R0 artifact capture requires Windows.');
  const absoluteRoot = path.win32.resolve(root);
  const tempRoot = path.win32.resolve(tempDirectory);
  const relativeToTemp = path.win32.relative(tempRoot, absoluteRoot);
  const homeName = relativeToTemp.split(path.win32.sep)[0];
  const disposableRoot = path.win32.join(tempRoot, homeName);
  if (!inside(absoluteRoot, tempRoot, path.win32) || !/^astrid-pinokio-r0-disposable-[A-Za-z0-9-]+$/i.test(homeName)
    || !inside(absoluteRoot, disposableRoot, path.win32)) {
    throw new Error('Refusing capture: the Runtime root is outside a named disposable Pinokio temp home.');
  }
  const markerPath = path.win32.join(disposableRoot, '.astrid-r0-disposable.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (path.win32.resolve(marker.programRoot) !== absoluteRoot || marker.runtimeCommit !== R0.commit) {
    throw new Error('Refusing capture: disposable marker does not bind this exact R0 program root.');
  }

  const version = fs.readFileSync(path.win32.join(absoluteRoot, 'current'), 'utf8').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new Error('Invalid installed Runtime version pointer.');
  const versionRoot = path.win32.join(absoluteRoot, 'versions', version);
  const versionRecord = JSON.parse(fs.readFileSync(path.win32.join(versionRoot, 'version.json'), 'utf8'));
  const installRecord = JSON.parse(fs.readFileSync(path.win32.join(absoluteRoot, 'install.json'), 'utf8'));
  if (installRecord.owner !== 'haus.astrid.runtime' || installRecord.managed_by !== 'pinokio') {
    throw new Error('Refusing capture: program root is not recorded as Pinokio-managed Runtime.');
  }
  if (!containsCommit(versionRecord) && !containsCommit(installRecord)) {
    throw new Error('Installed version records do not identify the requested R0 commit.');
  }
  if (!inside(path.win32.resolve(installRecord.data_root), disposableRoot, path.win32)) {
    throw new Error('Refusing capture: Runtime data root is outside the disposable Pinokio home.');
  }
  if (!inside(path.win32.resolve(versionRecord.python), versionRoot, path.win32)) {
    throw new Error('Refusing capture: recorded Python is outside the installed version directory.');
  }
  const pythonRoot = path.win32.join(path.win32.dirname(versionRecord.python), 'Lib', 'site-packages');
  const bootstrapFiles = findFiles(pythonRoot, 'bootstrap.py').filter((file) => file.toLowerCase().endsWith('astrid_runtime\\bootstrap.py'));
  const lifecycleFiles = findFiles(pythonRoot, 'lifecycle.py').filter((file) => file.toLowerCase().endsWith('runtime_protocol\\lifecycle.py'));
  if (bootstrapFiles.length !== 1 || lifecycleFiles.length !== 1) throw new Error('Expected exactly one installed R0 bootstrap and lifecycle module.');
  const source = {
    bootstrap: { path: bootstrapFiles[0], sha256: sha256(bootstrapFiles[0]) },
    lifecycle: { path: lifecycleFiles[0], sha256: sha256(lifecycleFiles[0]) },
  };
  source.matchesAuthenticatedR0 = source.bootstrap.sha256 === R0.bootstrapSha256 && source.lifecycle.sha256 === R0.lifecycleSha256;
  return {
    schema: 'astrid-pinokio-r0-installed-capture.v1',
    host: { platform, elevated: null },
    tuple: { pinokio: '7979e023874c98057f441ee8e525e0cb6c562e90', runtime: R0.commit,
      actionsRun: '41600499394', actionsJob: '125797843152' },
    installed: {
      programRoot: absoluteRoot,
      version,
      versionRecordSha256: sha256(path.win32.join(versionRoot, 'version.json')),
      installRecordSha256: sha256(path.win32.join(absoluteRoot, 'install.json')),
      sourceIdentityClaims: [...commitClaims(versionRecord), ...commitClaims(installRecord)],
      source,
    },
    predicates: {
      artifactIdentity: source.matchesAuthenticatedR0 ? 'verified-by-byte-hash' : 'mismatch',
      clearStop: 'not-run', blockedRefusal: 'not-run', retryAfterReconciliation: 'not-run',
      processAndLockSurvival: 'not-observed',
    },
    limitation: 'This read-only capture does not invoke Pinokio Stop or Runtime down; it cannot establish clear, blocked, or retry behavior.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('Native R0 artifact capture requires Windows.');
    if (!process.argv[2]) throw new Error('Usage: node tests/smoke/r0-installed-capture.mjs <disposable-program-root> [report.json]');
    const report = captureInstalledR0(process.argv[2]);
    const output = process.argv[3] ? path.resolve(process.argv[3]) : null;
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) fs.writeFileSync(output, json, { flag: 'wx' });
    process.stdout.write(json);
    if (!report.installed.source.matchesAuthenticatedR0) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
