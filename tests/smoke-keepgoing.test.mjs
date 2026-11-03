import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKeepGoingRecorder, diagnosticKeepGoingEnabled } from './smoke/keepgoing.mjs';

test('diagnostic keep-going is opt-in and preserves fail-fast by default', async () => {
  assert.equal(diagnosticKeepGoingEnabled({}), false);
  assert.equal(diagnosticKeepGoingEnabled({ PINOKIO_DIAGNOSTIC_KEEP_GOING: '0' }), false);
  assert.equal(diagnosticKeepGoingEnabled({ PINOKIO_DIAGNOSTIC_KEEP_GOING: '1' }), true);
  const recorder = createKeepGoingRecorder();
  await assert.rejects(recorder.run('fails fast', async () => { throw new Error('original failure'); }), /original failure/);
  assert.deepEqual(recorder.report().stages, []);
});

test('diagnostic stages record first errors, explicit continuation, dependency sources, and report metadata', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pinokio-keepgoing-test-'));
  try {
    const reportPath = path.join(root, 'keepgoing-report.json');
    const recorder = createKeepGoingRecorder({ enabled: true, reportPath });
    await recorder.run('fixture', async () => 'ready');
    await recorder.run('failed operation', async () => { throw new Error('fixture did not install'); });
    await recorder.run('downstream check', async () => { throw new Error('expected diagnostic continuation'); }, { needs: ['failed operation'] });
    await recorder.run('continued check', async () => 'continued', { needs: ['failed operation'] });
    recorder.skip('not runnable', ['fixture missing']);
    const written = recorder.write();
    assert.equal(written, reportPath);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.proof_mode, 'keep-going-diagnostic');
    assert.equal(report.qualification, 'non-qualifying');
    assert.deepEqual(report.first_error, { stage: 'failed operation', message: 'Error: fixture did not install' });
    assert.equal(report.stages[1].forced, 'continue-after:failed operation');
    assert.equal(report.stages[1].class, 'real');
    assert.equal(report.stages[2].class, 'suspect:failed operation');
    assert.equal(report.stages[2].forced, 'continue-after:downstream check');
    assert.equal(report.stages[3].class, 'suspect');
    assert.equal(report.stages[3].forced, 'continue-after:failed operation');
    assert.equal(report.stages[4].result, 'skipped');
    assert.deepEqual(report.failures.map(({ stage }) => stage), ['failed operation', 'downstream check']);
    assert.match(report.mermaid, /flowchart TD/);
    assert.match(report.mermaid, /-\.->/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
