'use strict';

// A runner-local, read-only action used by the R-24 collector. It executes
// inside pinokiod, so its result and terminal packets are engine facts.  It
// never calls the Runtime controller and has no mutation/retry authority.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PREFLIGHT_CODE_SHA256 = '28eb075c4225b72ed883cfa53b86461e7febd2f043866393f056e8156739e03b';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('Invalid R-24 live action input.');
  }
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('R-24 source is not a regular file.');
  return fs.readFileSync(file);
}

function installedPython(file, target) {
  const stat = fs.lstatSync(file);
  if ((!stat.isFile() && !stat.isSymbolicLink()) || fs.realpathSync(file) !== target) {
    throw new Error('R-24 installed Python target mismatch.');
  }
  return regular(target);
}

function writeExclusive(directory, name, value) {
  const file = path.join(directory, name);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); } finally { fs.closeSync(fd); }
}

function waitForArm(directory, session, timeoutMs, onReady) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        const raw = regular(path.join(directory, 'arm')).toString('utf8');
        if (raw !== session + '\n') throw new Error('R-24 fault arm mismatch.');
        resolve();
      } catch (error) {
        if (error && error.code !== 'ENOENT') { reject(error); return; }
        if (Date.now() >= deadline) { reject(new Error('R-24 fault was not armed.')); return; }
        setTimeout(poll, 10);
      }
    };
    onReady();
    poll();
  });
}

function controlledUnknownRunner(input) {
  let used = false;
  return (spec, options) => {
    if (used) return Promise.reject(new Error('R-24 fault runner is single-use.'));
    used = true;
    if (!spec || spec.command !== input.python || !Array.isArray(spec.args) || spec.args.length !== 4 ||
        spec.args[0] !== '-I' || spec.args[1] !== '-c' || digest(spec.args[2]) !== PREFLIGHT_CODE_SHA256 ||
        spec.args[3] !== input.data_root || !options || options.cwd !== input.data_root) {
      return Promise.reject(new Error('Unexpected Runtime preflight command; not dispatched.'));
    }
    return new Promise((resolve, reject) => {
      let child;
      let armed = false;
      let completed = false;
      const finish = (error, stdout, stderr) => {
        if (completed) return;
        completed = true;
        try {
          writeExclusive(input.control_dir, 'drained.json', {
            schema: 'astrid.r24.fault-drained.v1', session: input.session,
            pid: child && Number.isSafeInteger(child.pid) ? child.pid : null,
            armed, killed: Boolean(error && error.killed), signal: error && error.signal || null,
            stdout_bytes: Buffer.byteLength(stdout || ''), stderr_bytes: Buffer.byteLength(stderr || '')
          });
        } catch (_) { reject(new Error('R-24 fault drain record unavailable.')); return; }
        reject(new Error('Runtime stop preflight response unavailable.'));
      };
      try {
        child = execFile(spec.command, spec.args, {
          env: options.env, cwd: options.cwd, timeout: options.timeoutMs,
          killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true
        }, finish);
        if (!Number.isSafeInteger(child.pid) || child.pid < 1 || !child.kill('SIGSTOP')) {
          child.kill('SIGKILL');
          reject(new Error('R-24 preflight child could not be held.'));
          return;
        }
        waitForArm(input.control_dir, input.session, 10_000, () => {
          writeExclusive(input.control_dir, 'ready.json', {
            schema: 'astrid.r24.fault-ready.v1', session: input.session, pid: child.pid,
            python_sha256: digest(installedPython(input.python, input.python_target))
          });
        }).then(() => {
          armed = true;
          if (child.stdout) child.stdout.destroy();
          if (child.stderr) child.stderr.destroy();
          if (!child.kill('SIGKILL')) reject(new Error('R-24 preflight child could not be fenced.'));
        }, error => {
          child.kill('SIGKILL');
          reject(error);
        });
      } catch (error) { reject(error); }
    });
  };
}

function projectRefusal(error) {
  const details = error && error.details && typeof error.details === 'object' ? error.details : {};
  const blockers = Array.isArray(details.blockers) ? details.blockers.map(row => ({
    task_id: String(row.task_id || ''), blocker_kind: String(row.blocker_kind || ''),
    kind: String(row.kind || ''), state: String(row.state || '')
  })) : [];
  return {
    safe: false,
    headline: String(details.headline || error && error.message || 'Runtime stop preflight refused.'),
    task_count: Number.isSafeInteger(details.task_count) ? details.task_count : blockers.length,
    blockers
  };
}

async function execute(request) {
  const input = request && request.input;
  exact(input, ['schema', 'mode', 'session', 'request_sha256', 'lifecycle', 'lifecycle_sha256',
    'backend_root', 'python', 'python_target', 'python_sha256', 'data_root', 'control_dir']);
  if (input.schema !== 'astrid.r24.live-action-input.v1' || !HEX32.test(input.session) ||
      !HEX64.test(input.request_sha256) || !HEX64.test(input.lifecycle_sha256) ||
      !HEX64.test(input.python_sha256) || !['probe', 'busy', 'unknown', 'restoration'].includes(input.mode)) {
    throw new Error('Invalid R-24 live action binding.');
  }
  for (const key of ['lifecycle', 'backend_root', 'python', 'python_target', 'data_root', 'control_dir']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) throw new Error('R-24 paths must be absolute.');
  }
  if (digest(regular(input.lifecycle)) !== input.lifecycle_sha256 ||
      digest(installedPython(input.python, input.python_target)) !== input.python_sha256) {
    throw new Error('R-24 live source identity mismatch.');
  }
  if (input.mode === 'probe') {
    return { schema: 'astrid.r24.engine-binding.v1', session: input.session,
      request_sha256: input.request_sha256, mode: 'probe' };
  }
  const lifecycle = await import(pathToFileURL(input.lifecycle).href);
  const options = input.mode === 'unknown' ? { run: controlledUnknownRunner(input) } : {};
  try {
    const report = await lifecycle.preflightStop(input.backend_root, options);
    return { schema: 'astrid.r24.preflight.v1', session: input.session,
      request_sha256: input.request_sha256, mode: input.mode, safe: true,
      task_count: Number.isSafeInteger(report && report.task_count) ? report.task_count : 0, blockers: [] };
  } catch (error) {
    if (input.mode === 'unknown') throw error;
    return { schema: 'astrid.r24.preflight.v1', session: input.session,
      request_sha256: input.request_sha256, mode: input.mode, ...projectRefusal(error) };
  }
}

module.exports = { run: [{ method: execute }], execute, PREFLIGHT_CODE_SHA256 };
