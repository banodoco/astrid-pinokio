import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('R-21 always uploads only the named bounded diagnostic evidence', () => {
  const workflow = fs.readFileSync('.github/workflows/r21-real-engine.yml', 'utf8').replace(/\r\n/g, '\n');
  const uploads = [...workflow.matchAll(/^      - name: Upload bounded R-21 diagnostic evidence\n(?:(?!      - ).*\n?)*/gm)];
  assert.equal(uploads.length, 1);
  assert.equal((workflow.match(/uses:\s*actions\/upload-artifact@/g) || []).length, 1);

  const expectedPaths = [
    'r21-request.json',
    'r21-watchdog/progress.json',
    'r21-watchdog/watchdog.json',
    'r21-watchdog/setup.exit',
    'r21-watchdog/journey.exit',
    'r21-evidence/r21-progress.json',
    'r21-evidence/r21-receipt.json',
    'r21-evidence/r21-verdict.json',
    'r21-evidence/r21-runner-failure.json',
    'r21-evidence/r21-observer-operation.json',
    'r21-evidence/r21-failure.json',
    'r21-evidence/r21-install-diagnostics.json',
    'r21-result/request.json',
    'r21-result/verdict.json',
    'r21-result/r21-receipt.json',
    'r21-result/runner-failure.json',
    'r21-result/observer-failure.json',
    'r21-result/install-diagnostics.json',
    'r21-result/SHA256SUMS',
  ];
  const expected = [
    '      - name: Upload bounded R-21 diagnostic evidence',
    '        if: always()',
    '        continue-on-error: true',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: r21-published-tuple-diagnostics-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    '          retention-days: 7',
    '          if-no-files-found: warn',
    '          path: |',
    ...expectedPaths.map(path => `            \${{ runner.temp }}/${path}`),
    '',
  ].join('\n');
  assert.equal(uploads[0][0], expected);
});
