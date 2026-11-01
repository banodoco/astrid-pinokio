// Development-only seam for the read-only preflight runner. It is not a
// collector, a stop authority, or evidence that a remote request is fenced.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const PREFLIGHT_CODE_SHA256 = '28eb075c4225b72ed883cfa53b86461e7febd2f043866393f056e8156739e03b';
const occupiedSlots = new WeakSet();
const FAULT_EXTERNAL_AWAIT = Object.freeze(['R-15', 'R-21', 'R-36']);

export function installPreflightOutputFault(slot, { timeoutMs = 5000 } = {}) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid Linux fault configuration.');
  const descriptor = Object.getOwnPropertyDescriptor(slot, 'run');
  if (!descriptor || !('value' in descriptor) || !descriptor.writable || typeof descriptor.value !== 'function') {
    throw new Error('A writable, own preflight runner is required.');
  }
  if (occupiedSlots.has(slot)) throw new Error('Fault slot is already in use or invalid.');
  const prior = descriptor.value;
  let active = true;
  let used = false;
  let pending;
  let finalization;
  // This runner is only for preflightStop's read-only command, never /stop.
  const fault = (spec, options) => {
    if (!active || used) return Promise.reject(new Error('Fault seam is closed.'));
    used = true;
    if (typeof spec?.command !== 'string' || !path.isAbsolute(spec.command) || !Array.isArray(spec.args) || spec.args.length !== 4 ||
        spec.args[0] !== '-I' || spec.args[1] !== '-c' || typeof spec.args[2] !== 'string' ||
        createHash('sha256').update(spec.args[2]).digest('hex') !== PREFLIGHT_CODE_SHA256 ||
        typeof spec.args[3] !== 'string' || !path.isAbsolute(spec.args[3]) || options?.cwd !== spec.args[3] ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      return Promise.reject(new Error('Unexpected preflight command; not dispatched.'));
    }
    let child;
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    pending = { closed, child: undefined };
    return new Promise((resolve, reject) => {
      try {
        child = execFile(spec.command, spec.args, { env: options.env, cwd: options.cwd,
          timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true },
        () => {
          close();
          // A completed callback can never turn a dropped response into safety.
          reject(new Error('Runtime stop preflight response unavailable.'));
        });
        pending.child = child;
        // Disconnect the actual output pipe, rather than producing a forged
        // refusal or reporting success based on a timeout.
        child.stdout.once('data', () => child.stdout.destroy());
        child.stderr.once('data', () => child.stderr.destroy());
      } catch (error) {
        close();
        reject(error);
      }
    });
  };
  Object.defineProperty(slot, 'run', { ...descriptor, value: fault });
  occupiedSlots.add(slot);
  return {
    async finalize() {
      if (finalization) return finalization;
      active = false;
      finalization = (async () => {
        const issues = [];
        const current = Object.getOwnPropertyDescriptor(slot, 'run');
        if (!current || current.value !== fault || current.writable !== descriptor.writable ||
            current.enumerable !== descriptor.enumerable || current.configurable !== descriptor.configurable) {
          issues.push('seam-identity-changed');
        }
        if (pending) {
          // No signal to the Runtime or a process group: only our exact child.
          if (pending.child && pending.child.exitCode === null && pending.child.signalCode === null) {
            try { if (!pending.child.kill('SIGKILL')) issues.push('child-cancel-failed'); }
            catch { issues.push('child-cancel-failed'); }
          }
          let timer;
          const closed = await Promise.race([pending.closed.then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
          clearTimeout(timer);
          if (!closed) issues.push('child-not-reaped');
        }
        // Keep the closed wrapper installed until the child callback barrier.
        // Never replace a third party's intervening runner.
        const afterDrain = Object.getOwnPropertyDescriptor(slot, 'run');
        if (!issues.includes('child-not-reaped') && afterDrain && afterDrain.value === fault && afterDrain.writable === descriptor.writable &&
            afterDrain.enumerable === descriptor.enumerable && afterDrain.configurable === descriptor.configurable) {
          try { Object.defineProperty(slot, 'run', descriptor); }
          catch { issues.push('seam-removal-failed'); }
        } else if ((!afterDrain || afterDrain.value !== fault || afterDrain.writable !== descriptor.writable ||
                    afterDrain.enumerable !== descriptor.enumerable || afterDrain.configurable !== descriptor.configurable) &&
                   !issues.includes('seam-identity-changed')) {
          issues.push('seam-identity-changed');
        }
        const restored = Object.getOwnPropertyDescriptor(slot, 'run');
        if (!restored || restored.value !== prior || restored.writable !== descriptor.writable ||
            restored.enumerable !== descriptor.enumerable || restored.configurable !== descriptor.configurable) issues.push('runner-not-restored');
        if (!issues.length) occupiedSlots.delete(slot);
        return { state: issues.length ? 'fail' : 'unknown', issues };
      })();
      return finalization;
    },
  };
}

// Scope the seam to one attempted action; cleanup failure overrides any product
// refusal. The caller must invalidate its larger session on either failure.
export async function withPreflightOutputFault(slot, action, options) {
  const seam = installPreflightOutputFault(slot, options);
  try {
    await action();
    throw new Error('Faulted action did not refuse; session invalid.');
  } finally {
    const finalization = await seam.finalize();
    if (finalization.state === 'fail') {
      throw new Error(`Fault finalization failed: ${finalization.issues.join(', ')}; session invalid.`);
    }
  }
}

/**
 * Exercise the bounded preflight-output seam and return producer facts for a
 * future R-36 collector. This is deliberately not an R-30 export: the local
 * runner cannot bind the Runtime/controller, approved profiles, or protected
 * collection session, so the diagnostic stays unknown/closed.
 */
export async function observePreflightOutputFault(slot, action, options) {
  if (typeof action !== 'function') throw new TypeError('A faulted action callback is required.');
  const observations = [];
  const record = (kind, result, details = {}) => {
    observations.push(Object.freeze({
      id: `fault-${String(observations.length + 1).padStart(6, '0')}`,
      kind, result, ...details,
    }));
  };

  record('fault-before', 'unknown', { reason: 'R-36 collector and approved Runtime binding are absent' });
  let seam;
  let observedResult = 'not-run';
  let finalization = { state: 'not-run', issues: ['fault-not-installed'] };
  try {
    seam = installPreflightOutputFault(slot, options);
    record('fault-installed', 'unknown', { reason: 'local seam installed; identity is not authenticated' });
    try {
      await action();
      // A successful action means this diagnostic did not observe the
      // expected refusal/uncertainty. Keep the top-level result unknown: this
      // local contradiction is not a qualification verdict.
      observedResult = 'fail';
      record('fault-observed', observedResult, { reason: 'action completed without refusal or uncertainty' });
    } catch {
      // The callback's error may be a product refusal or an unavailable
      // response; without the upstream binding they are intentionally not
      // distinguished here.
      observedResult = 'unknown';
      record('fault-observed', observedResult, { reason: 'action returned refusal or unavailable response' });
    }
  } catch {
    record('fault-installed', 'not-run', { reason: 'seam installation failed' });
  } finally {
    if (seam) {
      finalization = await seam.finalize();
      record('fault-after', finalization.state === 'fail' ? 'fail' : 'unknown', {
        issues: Object.freeze([...finalization.issues]),
        reason: finalization.state === 'fail' ? 'seam cleanup failed' : 'local seam restored; external cleanup is unobserved',
      });
    } else {
      record('fault-after', 'not-run', { reason: 'seam was not installed' });
    }
  }

  return Object.freeze({
    kind: 'pinokio-linux-fault-diagnostic',
    state: 'unknown',
    qualification: 'closed',
    externalAwait: Object.freeze([...FAULT_EXTERNAL_AWAIT]),
    observed: observedResult,
    finalization: Object.freeze({ state: finalization.state, issues: Object.freeze([...finalization.issues]) }),
    observations: Object.freeze(observations),
  });
}

export { FAULT_EXTERNAL_AWAIT };
