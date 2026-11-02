import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function boundedFileDiagnostic(filename, maxBytes = 64 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'r');
    const { size } = fs.fstatSync(descriptor);
    const retained = Buffer.alloc(Math.min(size, maxBytes));
    const offset = Math.max(0, size - retained.length);
    const bytesRead = retained.length ? fs.readSync(descriptor, retained, 0, retained.length, offset) : 0;
    const bytes = retained.subarray(0, bytesRead);
    return {
      status: 'present',
      bytes: bytes.toString('utf8'),
      sourceBytes: size,
      retainedOffset: offset,
      retainedBytes: bytesRead,
      truncated: size > bytesRead,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: `${error.code || error.name}: ${error.message}` };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Start's output pipes must keep draining while render/HTTP commands wait for
// it. A synchronous subprocess blocks that drain and can deadlock the server.
export async function runTool(command, args, environment) {
  const pending = execute(command, args, {
    encoding: 'utf8', env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  pending.child.stdin.end();
  const { stdout } = await pending;
  return stdout;
}

export async function timedStep(name, action, log) {
  const started = performance.now();
  log(`START ${name}`);
  let result = 'failed';
  try {
    const value = await action();
    result = 'passed';
    return value;
  } finally {
    log(`END ${name}: ${result} (${((performance.now() - started) / 1000).toFixed(2)}s)`);
  }
}
