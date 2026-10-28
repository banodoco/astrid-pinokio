// Authenticated session stop; controllerless maintenance uses the installed Runtime down.
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
// The only report: a plain object whose sole key is c1, with value 'stopped'.
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
// Maintenance without a live session still needs C1's actual fenced down.
// The installer lock alone cannot establish that durable work is idle.
export async function stopRuntime(root, { filesystem = fs, platform = process.platform,
  environment = process.env, appDirectory, installed, run = runCommand, timeoutMs = DOWN_MS } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!filesystem.existsSync(p.dirname(root))) return;
  const session = await import('./session.mjs');
  if (!installed) {
    installed = session.installationFiles(root, { filesystem, platform });
    installed.env = policy.buildEnvironment({ appDirectory: appDirectory || p.resolve(root, '..', '..'),
      platform, environment, recordEnv: installed.env });
  }
  await run(session.commands(root, '', 'backend', installed, platform).down,
    { env: installed.env, cwd: root, timeoutMs });
}
export async function createController(root, stop, { filesystem = fs, pid = process.pid,
  killProcess = process.kill.bind(process), localUpdate = {} } = {}) {
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
    const send = (status, body = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`
      || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      req.resume();
      res.writeHead(403); res.end(); return;
    }
    const route = req.url;
    if (route === '/stop') {
      // The body is data, never a command: the updater may report that
      // Backend C1 completed the Runtime stop as exactly { c1: 'stopped' }.
      // Any other, malformed or oversized body is no report: today's stop.
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
      if (localUpdate.isUpdating?.()) return send(409, { ok: false, errors: ['Astrid is updating. Try again when it finishes.'] });
      try {
        const result = await stop({ c1Stopped: isC1Report(report) });
        send(result.ok ? 200 : 500, result);
      } catch (error) {
        send(500, { ok: false, errors: [error.message], ...(error.details !== undefined ? { details: error.details } : {}) });
      }
      return;
    }
    const action = ({ '/local-update-begin': 'begin', '/local-update-runtime': 'runtime', '/local-update-end': 'end' })[route];
    if (!action || typeof localUpdate[action] !== 'function') {
      req.resume(); send(404, { ok: false, errors: ['Unknown Pinokio controller request.'] }); return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { req.destroy(); throw new Error('Pinokio controller request is too large.'); }
        chunks.push(chunk);
      }
      let payload = {};
      if (size) {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Pinokio controller request.');
      }
      const result = await localUpdate[action](payload);
      send(200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (error) {
      send(500, { ok: false, error: error.message, errors: [error.message], ...(error.details !== undefined ? { details: error.details } : {}) });
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
    headers: { Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}` }, signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    const error = new Error((result.errors || ['Graceful stop failed.']).join(' '));
    if (result.details !== undefined) error.details = result.details;
    throw error;
  }
  return result;
}

export async function requestLocalUpdate(root, action, payload = {}, { filesystem = fs, request = fetch,
  platform = process.platform, timeoutMs = 240_000 } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!['begin', 'runtime', 'end'].includes(action)) throw new Error('Invalid Pinokio update action.');
  const record = JSON.parse(filesystem.readFileSync(p.join(root, CONTROL_FILE), 'utf8'));
  if (record.schema !== 1 || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Invalid Astrid controller record.');
  const route = { begin: 'local-update-begin', runtime: 'local-update-runtime', end: 'local-update-end' }[action];
  const response = await request(`http://127.0.0.1:${record.port}/${route}`, { method: 'POST',
    headers: { Authorization: `Bearer ${record.token}`, Host: `127.0.0.1:${record.port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok || result.ok !== true) {
    const error = new Error((result.errors || ['Pinokio update request failed.']).join(' '));
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
