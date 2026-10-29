import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The smoke's Update action needs a pullable branch. Create it in a disposable
// bare copy, never in the source checkout, including when source is detached.
export function prepareCheckout(source, appDirectory) {
  const remote = path.join(path.dirname(appDirectory), 'smoke-origin.git');
  execFileSync('git', ['clone', '--bare', '--no-local', source, remote], { stdio: 'inherit' });
  execFileSync('git', ['-C', remote, 'update-ref', 'refs/heads/ci-smoke', 'HEAD'], { stdio: 'inherit' });
  execFileSync('git', ['clone', '--branch', 'ci-smoke', '--single-branch', remote, appDirectory], { stdio: 'inherit' });
}

export function assertRunEnvironment(environment, platform, containerExists) {
  if (environment.GITHUB_ACTIONS === 'true') return;
  if (platform !== 'linux' || environment.ASTRID_DISPOSABLE_CONTAINER !== 'yes' || !containerExists) {
    throw new Error('Local smoke requires a disposable Linux container and ASTRID_DISPOSABLE_CONTAINER=yes.');
  }
}
