'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { patchCrossOsSource } = require('../.github/venue/r25-cross-os-pty.cjs');
function fixture() { return ["const __r25PtyFs = require('fs');", '    this.prompt_pattern = await this.prompt(params.path)',
  '      term.onData((data) => {', "                __r25PtyCapture('prompt-probe-write-return', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })",
  "              __r25PtyProcessing(__r25PromptState, 'resolve')"].join('\n'); }
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
