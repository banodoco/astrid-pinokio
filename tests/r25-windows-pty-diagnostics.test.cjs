'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { MAX_CAPTURE_BYTES, RAW_BYTES, patchWindowsSource } = require('../.github/venue/r25-windows-pty-diagnostics.cjs');
function fixture() {
  return ["const __r25PtyFs = require('fs');", "      __r25PtySetPromptPid(term?.pid)",
    "        if (!__r25PromptFirstOutput) { __r25PromptFirstOutput = true;",
    "          __r25PtyCapture('exec-pty-spawn', { pid: this.ptyProcess?.pid, ppid: process.pid })",
    "          this.ptyProcess.onData((data) => {", ''].join('\n');
}
test('Windows callback overlay records the actual registry args, prompt ordinal and raw boundary', () => {
  const result = patchWindowsSource(fixture());
  assert.match(result.source, /args: shellArgs, cwd: config.cwd, env: config.env/);
  assert.match(result.source, /role: __r25PromptOrdinal === 2 \? 'prompt-2'/);
  assert.match(result.source, /shell: __r25PromptShell, args: __r25PromptArgs/);
  assert.match(result.source, /this.exec_cmd \|\| this.cmd/);
  assert.equal(result.replacements.length, 5);
  assert.equal(MAX_CAPTURE_BYTES, 16384);
});
test('native-callback simulation retains both spawn identities, computes their diff, bounds raw bytes and handles split echo state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-win-raw-'));
  const file = path.join(root, 'capture.jsonl');
  const source = patchWindowsSource(fixture()).source;
  const helper = source.slice(source.indexOf('const __r25WinFs'), source.indexOf('const __r25PtyFs'));
  try {
    vm.runInNewContext(helper + `
      __r25WinCapture('spawn', {role:'registry-check',pid:1,shell:'cmd.exe',args:['/D','/Q'],cwd:'one',env:{PATH:'one'}});
      __r25WinCapture('raw-ondata', {role:'registry-check',data:'echo pinokio\\r\\n' + 'x'.repeat(100000)});
      __r25WinCapture('spawn', {role:'prompt-2',pid:2,shell:'cmd.exe',args:['/D'],cwd:'two',env:{PATH:'two'}});
      __r25WinCapture('raw-ondata', {role:'prompt-2',data:'token=private\\r\\nECHO is o'});
      __r25WinCapture('raw-ondata', {role:'prompt-2',data:'n.\\r\\n'});
    `, { require, Buffer, Date, Map, JSON, process: {platform:'win32',env:{ASTRID_R25_SETUP_DIAGNOSTICS:'1',ASTRID_R25_WINDOWS_PTY_CAPTURE_FILE:file}} });
    const text = fs.readFileSync(file,'utf8');
    const rows = text.trim().split('\n').map(JSON.parse);
    const diff = rows.find(row => row.kind==='spawn' && row.role==='prompt-2').diff;
    const actualArgv = rows.find(row => row.kind==='spawn' && row.role==='prompt-2').actual_argv;
    assert.deepEqual(actualArgv, ['cmd.exe', '/D']);
    assert.equal(diff.args_equal,false);
    assert.equal(diff.cwd_equal,false);
    assert.deepEqual(diff.env_changed,['PATH']);
    const raw = rows.find(row=>row.kind==='raw-ondata' && row.role==='prompt-2');
    assert.equal(raw.cmd_echo_state,'on');
    assert.doesNotMatch(text,/private/);
    assert.ok(Buffer.byteLength(text)<=MAX_CAPTURE_BYTES);
    const control = rows.find(row=>row.kind==='raw-ondata'&&row.role==='registry-check');
    assert.ok(control.raw_bytes<=RAW_BYTES);
    assert.equal(control.echo_probe_observed,true);
    assert.equal(control.truncated,true);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
