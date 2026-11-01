// Candidate preparation only. This is deliberately not wired into Update until
// promotion and interrupted-update recovery can preserve checkout artifacts.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const oid = /^[0-9a-f]{40}$/;

async function command(command, args, options) {
  return exec(command, args, { ...options, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

// Fetch into a separate clone, leaving the installed checkout and its refs alone.
export async function prepareCandidate({ editor, ref, remote, stagingRoot, installed, run = command }) {
  const git = async (cwd, ...args) => (await run('git', args, { cwd })).stdout.trim();
  const snapshot = async () => ({
    sha: await git(editor, 'rev-parse', '--verify', 'HEAD^{commit}'),
    branch: await git(editor, 'branch', '--show-current'),
    status: await git(editor, 'status', '--porcelain=v1', '--untracked-files=all'),
  });
  // This is a cooperative fence for preparations sharing this staging root.
  // A surviving lock is intentionally not stolen: ownership after a crash is
  // unknown, and a future recovery protocol must inspect it before removal.
  const lock = path.join(stagingRoot, 'astrid-update.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`An editor update is already in progress or needs inspection: ${lock}`);
    throw error;
  }
  let parent;
  try {
    const old = await snapshot();
    if (!oid.test(old.sha) || old.branch !== ref || old.status) {
      throw new Error('Editor checkout is dirty or on a different branch; preserve changes and retry.');
    }
    parent = await mkdtemp(path.join(stagingRoot, 'astrid-update-'));
    const candidate = path.join(parent, 'checkout');
    await run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', editor, candidate], { cwd: parent });
    await git(candidate, 'fetch', '--no-tags', '--', remote, `refs/heads/${ref}`);
    const target = await git(candidate, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    if (!oid.test(target)) throw new Error('Candidate commit is invalid.');
    await git(candidate, 'merge-base', '--is-ancestor', old.sha, target);
    await git(candidate, 'checkout', '--detach', target);
    const manifest = JSON.parse(await readFile(path.join(candidate, 'public', 'install-manifest.json'), 'utf8'));
    const release = manifest.release === undefined ? 0 : manifest.release;
    if (!Number.isSafeInteger(release) || release < 0) throw new Error('Candidate release is invalid.');
    const env = { ...installed.env, VITE_APP_BUILD: target, RAILWAY_GIT_COMMIT_SHA: target };
    await run(installed.node, [installed.npx, '-y', 'npm@11', 'ci', '--no-audit', '--no-fund'], { cwd: candidate, env });
    await run(installed.node, [installed.npm, 'run', 'build'], { cwd: candidate, env });
    const build = JSON.parse(await readFile(path.join(candidate, 'dist', 'build.json'), 'utf8'));
    if (build.app !== target || build.release !== release) throw new Error('Candidate build identity does not match its checkout and manifest.');
    const current = await snapshot();
    if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('Editor checkout changed during staging; preserving it.');
    let cleanupPromise;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        await rm(parent, { recursive: true, force: true });
        await rm(lock, { recursive: true, force: true });
      })().catch((error) => { cleanupPromise = undefined; throw error; });
      return cleanupPromise;
    };
    return { parent, candidate, oldSha: old.sha, targetSha: target, ref, release, cleanup };
  } catch (error) {
    try {
      if (parent) await rm(parent, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `Candidate staging failed and cleanup failed; inspect ${parent || lock}.`);
    }
    throw error;
  }
}
