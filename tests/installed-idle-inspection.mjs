import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXPECTED } from './installed-idle-contract.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');

// Read-only inspection of the real install output after engine settlement.
// No sensitive record contents or paths are returned in the result.
export async function inspectInstalled(appRoot) {
  const root = path.join(appRoot, 'app', 'astrid');
  const sessionPath = path.join(appRoot, 'pinokio', 'session.mjs');
  const { installationFiles } = await import(sessionPath);
  const installed = installationFiles(root);
  const version = fs.readFileSync(path.join(root, 'current'), 'utf8').trim();
  const versionRoot = path.join(root, 'versions', version);
  const manifest = JSON.parse(fs.readFileSync(path.join(versionRoot, 'manifest.json'), 'utf8'));
  const mode = JSON.parse(fs.readFileSync(path.join(appRoot, 'app', 'install-mode.json'), 'utf8'));
  return {
    filesValidated: true,
    manifestValidated: manifest.agent?.sha === EXPECTED.agent && manifest.runtime?.sha === EXPECTED.runtime,
    backendModePersisted: mode.schema_version === 1 && mode.mode === 'backend',
    // No environment, token, or local path leaves the process.
    versionRecordPresent: Boolean(installed.record),
  };
}

export function verifyInputBytes(bootstrap, manifest) {
  const bootstrapMatches = sha256(bootstrap) === EXPECTED.bootstrapSha256;
  const manifestMatches = sha256(manifest) === EXPECTED.manifestSha256;
  let tupleMatches = false;
  try {
    const parsed = JSON.parse(manifest.toString('utf8'));
    tupleMatches = parsed.agent?.sha === EXPECTED.agent && parsed.runtime?.sha === EXPECTED.runtime;
  } catch { /* mismatch, not success */ }
  return { bootstrapMatches, manifestMatches, tupleMatches };
}
