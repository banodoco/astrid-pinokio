// Candidate preparation only. Do not wire this into Update until promotion and
// interrupted-update recovery can preserve checkout artifacts.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const oid = /^[0-9a-f]{40}$/;

async function command(command, args, options) {
  return exec(command, args, { ...options, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

async function buildWithSession(options) {
  const { runSession } = await import('./session.mjs');
  await runSession(options);
}

// Fetch into a separate clone, leaving the installed checkout and its refs alone.
// The normal build session owns Runtime startup, build subprocesses and shutdown;
// plain `npm run build` does not provide the Runtime discovery the app requires.
export async function prepareCandidate({ editor, ref, remote, stagingRoot, root, installed,
  run = command, build = buildWithSession }) {
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
  let old;
  // Append-only, synced evidence stays with the fence after abrupt process loss.
  // A partial last line is evidence of interruption, not permission to recover.
  const journal = path.join(lock, 'journal.jsonl');
  const record = async (phase, fields = {}) => {
    const file = await open(journal, 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ schema: 1, phase, ...fields })}\n`);
      await file.sync();
    } finally { await file.close(); }
  };
  try {
    await record('acquired', { editor, ref, remote, pid: process.pid });
    old = await snapshot();
    if (!oid.test(old.sha) || old.branch !== ref || old.status) {
      throw new Error('Editor checkout is dirty or on a different branch; preserve changes and retry.');
    }
    await record('snapshot', old);
    parent = await mkdtemp(path.join(stagingRoot, 'astrid-update-'));
    await record('staging', { parent });
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
    await record('building', { target });
    await build({ action: 'build', mode: 'local', root, editor: candidate, installed: { ...installed, env } });
    // Build scripts are arbitrary code. A matching build.json alone does not
    // prove that the checkout or installer manifest still matches the target.
    if (await git(candidate, 'rev-parse', '--verify', 'HEAD^{commit}') !== target
      || await git(candidate, 'status', '--porcelain=v1', '--untracked-files=no')) {
      throw new Error('Candidate checkout changed during its build; refusing promotion.');
    }
    const identity = JSON.parse(await readFile(path.join(candidate, 'dist', 'build.json'), 'utf8'));
    if (identity.app !== target || identity.release !== release) throw new Error('Candidate build identity does not match its checkout and manifest.');
    const current = await snapshot();
    if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('Editor checkout changed during staging; preserving it.');
    await record('prepared', { target, release });
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
    let uncertainCheckout = false;
    // Do not describe a failed build as a clean recovery if another actor
    // changed the original checkout while staging was in progress.
    if (old) {
      try {
        const current = await snapshot();
        if (JSON.stringify(current) !== JSON.stringify(old)) {
          uncertainCheckout = true;
          error = new AggregateError([error], `Editor checkout changed during staging; preserve it. Original failure: ${error.message}`);
        }
      } catch (verification) {
        uncertainCheckout = true;
        error = new AggregateError([error, verification], `Cannot verify the original editor checkout after staging; inspect it before retrying. Original failure: ${error.message}`);
      }
    }
    if (uncertainCheckout) {
      // Preserve the candidate and fence as evidence, and forbid another
      // staging attempt until an operator has inspected the checkout.
      try { await record('checkout-uncertain', { message: error.message }); }
      catch (journalError) {
        throw new AggregateError([error, journalError], `Checkout and staging evidence need inspection at ${lock}.`);
      }
      throw new Error(`${error.message} Staging evidence and lock retained at ${lock}.`, { cause: error });
    }
    try {
      if (parent) await rm(parent, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `Candidate staging failed and cleanup failed; inspect ${parent || lock}.`);
    }
    throw error;
  }
}
