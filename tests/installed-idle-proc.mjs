import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
// Match an exact process-owned socket inode to an IPv4 loopback listener.
// A port that merely answers on the host cannot establish controller identity.
export function controllerSocketOwned(pid, port, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const fds = path.join(procRoot,String(pid),'fd');
    const sockets = new Set(fs.readdirSync(fds).flatMap(name => {
      try { const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(path.join(fds,name))); return match ? [match[1]] : []; }
      catch { return []; }
    }));
    const address = `0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`;
    return fs.readFileSync(path.join(procRoot,'net','tcp'),'utf8').split('\n').slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      return fields.length >= 10 && fields[1] === address && fields[3] === '0A' && sockets.has(fields[9]);
    });
  } catch { return false; }
}

export function daemonHealthMatches(version, home, health, expectedHome) {
  return typeof version?.pinokiod === 'string' && version.pinokiod.length > 0 &&
    typeof home?.path === 'string' && path.resolve(home.path) === expectedHome && health?.success === true;
}

export const shellProbeMessage = [
  'test "${CONDA_DEFAULT_ENV:-}" = base',
  'test -n "${CONDA_PREFIX:-}"',
  'test -x "${CONDA_PREFIX}/bin/conda"',
  'conda --version >/dev/null 2>&1',
  'test "$(node --version)" = v20.19.4',
  "printf 'ASTRID_SHELL_%s\\n' READY",
].join(' && ');

// Check a root-owned tree is not writable or replaceable by the diagnostic UID.
// Symlinks may exist in npm .bin, but their targets must stay inside the tree.
export function protectedTree(root, ownerUid = 0, writableFile = null, writableUid = null) {
  try {
    const resolved = fs.realpathSync(root);
    if (resolved !== root) return false;
    const pending = [root];
    while (pending.length) {
      const item = pending.pop();
      const info = fs.lstatSync(item);
      if (info.isSymbolicLink()) {
        const target = fs.realpathSync(item);
        if (target !== root && !target.startsWith(root + path.sep)) return false;
        continue;
      }
      if (item === writableFile) {
        if (!info.isFile() || info.uid !== writableUid || (info.mode & 0o077) !== 0) return false;
      } else if (info.uid !== ownerUid || (info.mode & 0o022) !== 0) return false;
      if (info.isDirectory()) for (const name of fs.readdirSync(item)) pending.push(path.join(item,name));
      else if (!info.isFile()) return false;
    }
    return true;
  } catch { return false; }
}

export function cleanTrackedGitTree(directory, ref, except = null) {
  const args = ['-c', `safe.directory=${directory}`, '-C', directory, 'diff', '--quiet', '--no-ext-diff'];
  const paths = except ? ['--', '.', `:(exclude)${except}`] : ['--'];
  const staged = spawnSync('git', [...args, '--cached', ref, ...paths], {stdio:'ignore', timeout:30000});
  const worktree = spawnSync('git', [...args, ...paths], {stdio:'ignore', timeout:30000});
  return staged.status === 0 && worktree.status === 0;
}
