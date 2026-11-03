import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Capability is the actual ChildProcess returned by this task's spawn call.
// It never authorizes a PID lookup, process group, or descendants.
const owned = new WeakMap();
export function trackDisposableChild(child, { cwd, root }) {
  assert.ok(child instanceof ChildProcess && child.pid > 0, 'only a spawned ChildProcess can be owned');
  const actualRoot = fs.realpathSync.native(root);
  const actualCwd = fs.realpathSync.native(cwd);
  const relative = path.relative(actualRoot, actualCwd);
  assert.ok(relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)),
    'owned process cwd must be inside the task disposable root');
  const identity = { pid: child.pid, spawnfile: child.spawnfile, spawnargs: [...child.spawnargs], root: actualRoot, exited: false };
  child.once('exit', () => { identity.exited = true; });
  child.once('error', () => { identity.exited = true; });
  owned.set(child, identity);
  return child;
}

export async function terminateDisposableChild(child, { graceMs = 1000 } = {}) {
  const identity = owned.get(child);
  assert.ok(identity, 'refused process termination: unknown task ownership');
  assert.ok(Number.isInteger(graceMs) && graceMs > 0 && graceMs <= 5000, 'termination grace must be bounded');
  assert.equal(child.pid, identity.pid, 'owned process identity changed');
  assert.equal(child.spawnfile, identity.spawnfile, 'owned process executable changed');
  assert.deepEqual(child.spawnargs, identity.spawnargs, 'owned process argv changed');
  const result = { pid: identity.pid, scope: 'spawned-child-handle-only', descendants: 'unknown; no tree termination attempted',
    forced: true, signals: [], exited: identity.exited || child.exitCode !== null || child.signalCode !== null };
  if (result.exited) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); return result; }
  async function wait(signal) {
    if (identity.exited) return true;
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(true); };
      const timer = setTimeout(() => { child.off('exit', finish); resolve(false); }, graceMs);
      child.once('exit', finish);
      result.signals.push(signal);
      child.kill(signal);
    });
  }
  result.exited = await wait('SIGTERM') || await wait('SIGKILL');
  // Descendants can hold pipes after their parent exits. Detach only this
  // task's read handles; leave the fixture to hosted runner disposal.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  if (!result.exited) throw Object.assign(new Error('owned child did not exit inside bounded termination window'), { cleanup: result });
  return result;
}

export function boundOwnedOperation(child, operation, timeoutMs, onCleanup = () => {}) {
  assert.ok(owned.has(child), 'refused bounded operation: unknown task ownership');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 600000, 'invalid diagnostic timeout');
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(async () => {
      expired = true;
      try {
        const cleanup = await terminateDisposableChild(child);
        onCleanup(cleanup);
        reject(Object.assign(new Error(`diagnostic owned-child timeout after ${timeoutMs}ms`), { cleanup }));
      } catch (error) { reject(error); }
    }, timeoutMs);
    Promise.resolve(operation).then(value => {
      if (!expired) { clearTimeout(timer); resolve(value); }
    }, error => {
      if (!expired) { clearTimeout(timer); reject(error); }
    });
  });
}
