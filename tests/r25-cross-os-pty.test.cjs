'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { patchCrossOsSource } = require('../.github/venue/r25-cross-os-pty.cjs');
const { patchWindowsSource } = require('../.github/venue/r25-windows-pty-diagnostics.cjs');
const { PINOKIOD_SHELL_SHA256, patchSource: patchSgrSource, sha256 } = require('../.github/venue/r25-pinokiod-pty-instrumentation.cjs');
function fixture() { return ["const __r25PtyFs = require('fs');", '    this.prompt_pattern = await this.prompt(params.path)',
  '      term.onData((data) => {', "                __r25PtyCapture('prompt-probe-write-return', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })",
  "              __r25PtyProcessing(__r25PromptState, 'resolve')",
  "                const __r25CmdEchoProbe = /^cmd(?:\\.exe)?$/i.test(__r25PtyPath.win32.basename(String(this.shell || '')))\n                  __r25PtyProcessing(__r25PromptState, 'callback', { nonce_probe_attempted: true, cmd_echo_state_probe_attempted: __r25CmdEchoProbe })\n                    if (__r25CmdEchoProbe) term.write(`echo${this.EOL}`)\n                    term.write(`echo ${__r25PromptState.nonce}${this.EOL}`)",
  '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)'].join('\n'); }
test('daemon-bound hooks capture pre-shell Conda and macOS raw callback bytes under explicit diagnostics only', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r25-cross-'));
 const capture=path.join(root,'cross.json');
 const bin=path.join(root,'bin','miniforge','bin');fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,'conda'),'fixture',{mode:0o700});
 const modulePath=path.resolve(__dirname,'../.github/venue/r25-macos-diagnostic.cjs');
 const source=patchCrossOsSource(fixture(),modulePath);
 const runtime=source.slice(0,source.indexOf("const __r25PtyFs"));
 try {
  const context={require,Buffer,Date,Map,JSON,process:{platform:'darwin',env:{ASTRID_R25_CROSS_OS_DIAGNOSTIC:'1',ASTRID_R25_CROSS_CAPTURE_FILE:capture}}};
  vm.runInNewContext(runtime+`
   __r25CrossBeforeShell(${JSON.stringify(root)}, {PATH:${JSON.stringify(bin)}});
   const item=__r25CrossMacPrompt(2); item.probeWritten(); item.onData('echo pinokio\\r\\npinokio\\r\\n'); item.promptResolved(); __r25CrossWrite();
  `,context);
  const data=JSON.parse(fs.readFileSync(capture));
  assert.equal(data.pre_shell[0].conda.conda_executable,true);
  assert.equal(data.pre_shell[0].conda.conda_directory_on_path,true);
  assert.equal(data.macos_prompts[0].echo,'observed');
  assert.match(Buffer.from(data.macos_prompts[0].raw_on_data.data,'base64').toString(),/echo pinokio/);
  fs.rmSync(capture);
  context.process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC='0';
  vm.runInNewContext(`__r25CrossBeforeShell(${JSON.stringify(root)}, {});`,context);
  assert.equal(fs.existsSync(capture),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('changed-input overlay keeps matcher pair and nonce, records guard/write metadata, and omits bare echo', () => {
 const source=patchCrossOsSource(fixture(),path.resolve(__dirname,'../.github/venue/r25-macos-diagnostic.cjs'));
 assert.match(source,/term\.write\(__r25MatcherPairInput\)/);
 assert.match(source,/term\.write\(__r25NonceInput\)/);
 assert.match(source,/__r25CrossWriteAudit\(__r25PromptOrdinal, __r25PtyPath\.win32\.basename\(String\(this\.shell \|\| ''\)\), __r25CmdEchoProbe\)/);
 assert.match(source,/no_argument_echo_write = false/);
 assert.doesNotMatch(source,/if \(__r25CmdEchoProbe\) term\.write\(`echo\$\{this\.EOL\}`\)/);
 const runtime=source.slice(0,source.indexOf("const __r25PtyFs"));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r25-cross-audit-'));
 const capture=path.join(root,'cross.json');
 try {
  vm.runInNewContext(runtime+`__r25CrossWriteAudit(2,'powershell.exe',false);
   __r25CrossProbeWrite(2,'matcher-pair','echo pinokio\\r\\necho pinokio\\r\\n');
   __r25CrossProbeWrite(2,'matcher-pair','echo pinokio\\r\\necho pinokio\\r\\n',true);
   __r25CrossProbeWrite(2,'nonce','echo probe-nonce\\r\\n');
   __r25CrossProbeWrite(2,'nonce','echo probe-nonce\\r\\n',true);`,
   {require,Buffer,Date,Map,JSON,process:{platform:'win32',env:{ASTRID_R25_CROSS_OS_DIAGNOSTIC:'1',ASTRID_R25_CROSS_CAPTURE_FILE:capture}}});
  const data=JSON.parse(fs.readFileSync(capture,'utf8'));
  const probe=data.prompt_probes[0];
  assert.equal(probe.shell_basename,'powershell.exe');
  assert.equal(probe.no_argument_echo_guard,false);
  assert.equal(probe.no_argument_echo_write,false);
  assert.deepEqual(probe.writes.map(write=>write.role),['matcher-pair','nonce']);
  assert.ok(probe.writes.every(write=>write.returned_at && /^[a-f0-9]{64}$/.test(write.sha256)));
  assert.doesNotMatch(fs.readFileSync(capture,'utf8'),/probe-nonce|echo pinokio/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('SGR then cross-OS overlays compose on authentic pinned pinokiod source', () => {
 const pinnedPath=path.join(__dirname,'fixtures','pinokiod-shell-add4a674ad1ba95bb62ec427fce519fe5bf0e9bf.js');
 const pinned=fs.readFileSync(pinnedPath,'utf8');
 assert.equal(sha256(Buffer.from(pinned,'utf8')),PINOKIOD_SHELL_SHA256);
 const sgr=patchSgrSource(pinned).source;
 const windows=patchWindowsSource(sgr).source;
 const combined=patchCrossOsSource(windows,path.resolve(__dirname,'../.github/venue/r25-macos-diagnostic.cjs'));
 assert.doesNotThrow(()=>new vm.Script(combined));

 // The SGR pass intentionally changes only the prompt input branch. The
 // cross-OS pass must bind to that combined form and preserve both input
 // payloads and pinokiod's literal matcher predicate.
 assert.ok(combined.includes("if (process.env.ASTRID_R25_WINDOWS_SGR_DIAGNOSTIC === '1') { term.write(`Remove-Module PSReadLine -ErrorAction SilentlyContinue; if (-not (Get-Module -Name PSReadLine)) { Write-Output 'R25_SGR_COLOR_DISABLED' } else { Write-Output 'R25_SGR_COLOR_SETTING_FAILED' }${this.EOL}echo pinokio${this.EOL}echo pinokio${this.EOL}`) }"));
 assert.ok(combined.includes("const __r25MatcherPairInput = `echo pinokio${this.EOL}echo pinokio${this.EOL}`"));
 assert.ok(combined.includes("const __r25NonceInput = `echo ${__r25PromptState.nonce}${this.EOL}`"));
 const matcher="let re = /(.+)echo pinokio[\\r\\n]+pinokio[\\r\\n]+(\\1)/gs";
 assert.equal(pinned.split(matcher).length-1,1);
 assert.equal(combined.split(matcher).length-1,1);
 assert.equal(combined.split('if (match && match.length > 0) {').length-1,1);
 for(const predicate of [
  'probe_command_sgr_split_count',
  'sgr_color_setting_proven',
  'sgr_color_setting_failed',
  'no_argument_echo_guard',
  'no_argument_echo_write',
  'matcher-pair',
  "'nonce'",
  "'resolved_at'",
 ]) assert.ok(combined.includes(predicate),`missing retained predicate/observation ${predicate}`);

 // Every pass is bound: a source drift is rejected by the pinned SGR hash
 // check, the Windows anchors are unique, and every cross-OS anchor is exact.
 assert.throws(()=>patchSgrSource(pinned.replace('const { Terminal }','const {Terminal }')),/source hash differs/);
 assert.throws(()=>patchCrossOsSource(windows.replace('this.prompt_pattern = await this.prompt(params.path)','this.prompt_pattern = await this.prompt(params.other)'),'/tmp/helper'),/pre-shell matched 0 times/);
});
