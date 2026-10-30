// Authenticated control of this launcher's supervisor; no ambient Runtime down.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import policy from './environment.js';

export const STOP_FIRST = 'Astrid is still running. Stop it in Pinokio, then try again.';
export const CONTROL_FILE = 'pinokio-control.json';
export const GRACE_MS = 45_000;
export const DOWN_MS = 25_000;
export const LOCK_MS = 10_000;
function isC1Report(report) {
  return report !== null && typeof report === 'object' && !Array.isArray(report)
    && Object.keys(report).length === 1 && report.c1 === 'stopped';
}
export function bounded(promise, ms, label, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer;
  const expired = new Promise((_, reject) => { timer = schedule(() => reject(new Error(`${label} timed out.`)), ms); });
  return Promise.race([promise, expired]).finally(() => cancel(timer));
}
export function runCommand(spec, { env, cwd, timeoutMs = DOWN_MS, execute = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execute(spec.command, spec.args, { env, cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const raw = (stderr || stdout || error.message).trim();
          if (!error.killed) {
            for (const candidate of [stdout, stderr]) {
              try {
                const response = JSON.parse(candidate);
                if (response?.ok !== false) continue;
                const structured = response.error;
                const message = typeof structured === 'string' ? structured : structured?.message;
                if (typeof message !== 'string') continue;
                const failure = new Error(message);
                const details = structured?.details ?? response.details;
                if (details !== undefined) failure.details = details;
                reject(failure); return;
              } catch { /* Non-JSON command errors retain their original text. */ }
            }
          }
          reject(new Error(`${error.killed ? 'Command timed out' : 'Command failed'}: ${raw}`));
        } else resolve(stdout);
      });
  });
}
export async function preflightStop(rootOrInstalled, { timeoutMs = DOWN_MS, run = runCommand,
  filesystem = fs, platform = process.platform, environment = process.env, appDirectory } = {}) {
  const installed = typeof rootOrInstalled === 'string'
    ? (await import('./session.mjs')).installation(rootOrInstalled, { filesystem, platform, environment, appDirectory })
    : rootOrInstalled;
  if (!installed?.python || !installed.data) throw new Error('Installed Runtime paths are unavailable for a safe stop check.');
  const code = [
    'import json,sys',
    'from pathlib import Path',
    'from astrid_runtime.paths import RuntimePaths',
    'from astrid_runtime.bootstrap import BootstrapError,preflight_stop',
    'try:',
    ' report=preflight_stop(RuntimePaths.current(data_root=Path(sys.argv[1])))',
    ' print(json.dumps(report))',
    'except BootstrapError as error:',
    ' print(json.dumps({"message":str(error),"details":error.details}))',
    ' raise SystemExit(2)',
    'except Exception as error:',
    ' print(json.dumps({"message":str(error)}))',
    ' raise SystemExit(2)',
  ].join('\n');
  let output;
  try {
    output = await run({ command: installed.python, args: ['-I', '-c', code, installed.data] },
      { env: installed.env, cwd: installed.data, timeoutMs });
  } catch (error) {
    const raw = String(error.message || error).replace(/^Command failed:\s*/, '');
    try {
      const refusal = JSON.parse(raw);
      const preserved = new Error(refusal.message || 'Runtime stop preflight refused.');
      if (refusal.details !== undefined) preserved.details = refusal.details;
      throw preserved;
    } catch (parseError) {
      if (parseError instanceof SyntaxError) throw error;
      throw parseError;
    }
  }
  let report;
  try { report = JSON.parse(output); }
  catch { throw new Error('Runtime stop preflight returned an unreadable report.'); }
  if (report?.safe !== true) {
    const error = new Error(report?.message || report?.headline || 'Runtime stop preflight refused.');
    error.details = report;
    throw error;
  }
  return report;
}
export async function createController(root, stop, { filesystem = fs, pid = process.pid, killProcess = process.kill.bind(process) } = {}) {
  const file = path.join(root, CONTROL_FILE);
  try {
    const prior = JSON.parse(filesystem.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw new Error('Invalid Astrid controller record. Reset this install.');
    try { killProcess(prior.pid, 0); throw new Error(STOP_FIRST); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    filesystem.unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/stop' || req.headers.authorization !== `Bearer ${token}`
      || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      req.resume();
      res.writeHead(403); res.end(); return;
    }
    // C1's completed stop is a narrowly shaped report, never a stop command.
    let report;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size <= 4096) chunks.push(chunk);
      }
      if (size && size <= 4096) report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { report = undefined; }
    try {
      const result = await stop({ c1Stopped: isC1Report(report) });
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, errors: [error.message], ...(error.details !== undefined ? { details: error.details } : {}) }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    filesystem.writeFileSync(file, JSON.stringify({ schema: 1, pid, port: server.address().port, token }), { flag: 'wx', mode: 0o600 });
  } catch (error) { server.close(); throw error; }
  return { close: async () => {
    try { if (JSON.parse(filesystem.readFileSync(file, 'utf8')).token === token) filesystem.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await bounded(new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); }), 2000, 'Controller close')
      .catch(() => server.closeAllConnections());
  } };
}
export async function requestGracefulStop(root, { filesystem = fs, request = fetch, timeoutMs = GRACE_MS, platform = process.platform, killProcess = process.kill.bind(process) } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let record;
  try { record = JSON.parse(filesystem.readFileSync(p.join(root, CONTROL_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { ok: true, absent: true }; throw error; }
  if (record.schema !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new Error('Invalid Astrid controller record.');
  }
  try { killProcess(record.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return { ok: true, absent: true }; throw error; }
  const response = await request(`http://127.0.0.1:${record.port}/stop`, { method: 'POST',
    headers: { Authorization: `Bearer ${record.token}` }, signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    const error = new Error((result.errors || ['Graceful stop failed.']).join(' '));
    if (result.details !== undefined) error.details = result.details;
    throw error;
  }
  return result;
}
export async function waitForInstallerLock(root, { filesystem = fs, platform = process.platform, environment = process.env,
  appDirectory, installed, run = runCommand, timeoutMs = LOCK_MS } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // No program files means there is no mutation to protect. A partial app with
  // files but no usable installed Python fails closed instead of deleting them.
  if (!filesystem.existsSync(p.dirname(root))) return;
  if (!installed) {
    installed = (await import('./session.mjs')).installationFiles(root, { filesystem, platform });
    // Older records may name Pinokio cache/tool paths. They cannot start a
    // session, but must still be able to verify the lock and Reset/reinstall.
    installed.env = policy.buildEnvironment({ appDirectory: appDirectory || p.resolve(root, '..', '..'),
      platform, environment, recordEnv: installed.env });
  }
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'installer-lock.py');
  await run({ command: installed.python, args: ['-I', helper, String(timeoutMs / 1000)] },
    { env: installed.env, cwd: root, timeoutMs: timeoutMs + 2000 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, root] = process.argv.slice(2);
  if (action !== 'stop') throw new Error('Expected lifecycle.mjs stop <program-root>.');
  requestGracefulStop(root).catch((error) => { console.error(`${STOP_FIRST} ${error.message}`); process.exitCode = 1; });
}
