import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { frozenTuple, frozenAppBranch, validateDiagnosticTuple, verifyDiagnosticAsset, setDiagnosticAppRef } from './smoke/diagnostic-fixture.mjs';

test('diagnostic source and product tuple are distinct and exact; drift is refused', () => {
  const source = '1'.repeat(40);
  const env = { APP_REF: frozenTuple.app, AGENT_REF: frozenTuple.agent, RUNTIME_REF: frozenTuple.runtime, PINOKIO_REF: source };
  assert.equal(validateDiagnosticTuple(env, source).qualification_eligible, false);
  assert.throws(() => validateDiagnosticTuple({ ...env, AGENT_REF: '2'.repeat(40) }, source), /AGENT_REF differs/);
  assert.throws(() => validateDiagnosticTuple(env, '3'.repeat(40)), /harness HEAD differs/);
  assert.throws(() => verifyDiagnosticAsset('install', Buffer.from('altered installer')), /differs from frozen App bytes/);
});

test('diagnostic fixture selects a frozen App branch and preserves CRLF and other settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keepgoing-fixture-'));
  try {
    const file = path.join(root, '_ENVIRONMENT');
    fs.writeFileSync(file, '# fixture\r\nASTRID_APP_REF=\r\nOTHER=present\r\n');
    setDiagnosticAppRef(root);
    assert.equal(fs.readFileSync(file, 'utf8'), `# fixture\r\nASTRID_APP_REF=${frozenAppBranch}\r\nOTHER=present\r\n`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
