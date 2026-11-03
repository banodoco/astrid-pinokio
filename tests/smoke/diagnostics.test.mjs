import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSmokeFailureCapture } from './diagnostics.mjs';

test('smoke failure capture is bounded, redacted, and preserves the inner shell exit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'astrid-smoke-diagnostics-'));
  try {
    const logPath = path.join(directory, 'source-install.log');
    const outputDirectory = path.join(directory, 'capture');
    const source = `earlier diagnostic\n${'x'.repeat(70 * 1024)}\nPASSWORD=hunter2\nlast real installer error\n`;
    fs.writeFileSync(logPath, source);

    writeSmokeFailureCapture({ directory: outputDirectory, logPath, step: 'install', code: 23, signal: null });

    const log = fs.readFileSync(path.join(outputDirectory, 'install.log'), 'utf8');
    const metadata = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'failure.json'), 'utf8'));
    assert.ok(Buffer.byteLength(log) <= 64 * 1024);
    assert.match(log, /last real installer error/);
    assert.doesNotMatch(log, /hunter2/);
    assert.equal(metadata.innerExit.code, 23);
    assert.equal(metadata.innerExit.signal, null);
    assert.equal(metadata.installLog.originalBytes, Buffer.byteLength(source));
    assert.equal(metadata.installLog.redacted, true);
    assert.match(metadata.installLog.capturedSha256AfterRedaction, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
