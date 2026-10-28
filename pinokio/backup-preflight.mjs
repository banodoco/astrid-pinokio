// Run the installed backup policy before any maintenance stop or Git operation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installation } from './session.mjs';
import { runCommand } from './lifecycle.mjs';

export const PREFLIGHT_MS = 30_000;

export async function preflightBackup(root, { platform = process.platform, filesystem = fs,
  environment = process.env, run = runCommand, timeoutMs = PREFLIGHT_MS } = {}) {
  try {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const unlinked = (file) => {
      if (filesystem.lstatSync(file).isSymbolicLink()) throw new Error(`Installed path is linked: ${file}`);
    };
    unlinked(root);
    unlinked(p.join(root, 'current'));
    unlinked(p.join(root, 'install.json'));
    const installed = installation(root, { platform, filesystem, environment });
    const version = filesystem.readFileSync(p.join(root, 'current'), 'utf8').trim();
    const versionRoot = p.join(root, 'versions', version);
    const py = p.join(versionRoot, 'py');
    const bin = p.join(py, platform === 'win32' ? 'Scripts' : 'bin');
    for (const file of [p.join(root, 'versions'), versionRoot, p.join(versionRoot, 'version.json'), py, bin]) unlinked(file);
    const expectedPython = p.join(bin, platform === 'win32' ? 'python.exe' : 'python');
    if (p.resolve(installed.python) !== p.resolve(expectedPython)) {
      throw new Error('Pinned Python is outside the installed version.');
    }
    const helper = fileURLToPath(new URL('./backup-preflight.py', import.meta.url));
    await run({ command: installed.python, args: ['-I', '-B', helper, root] },
      { env: installed.env, cwd: root, timeoutMs });
    return { eligible: true };
  } catch (error) {
    throw new Error(`Astrid cannot safely check its support backup. ${error.message} Current mode is unchanged. Resolve the reported path or install record, then retry.`);
  }
}

