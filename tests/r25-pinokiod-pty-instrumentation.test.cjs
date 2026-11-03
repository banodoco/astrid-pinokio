'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  PTY_MARKERS,
  RUNTIME,
  applyPinokiodPtyInstrumentation,
  createBoundedMarkerWriter,
  patchSource,
  sha256,
  PRESERVED_MARKERS,
} = require('../.github/venue/r25-pinokiod-pty-instrumentation.cjs');

function sourceFixture() {
  return [
    'const path = require("path")',
    'const pty = globalThis.__pty',
    'const Terminal = globalThis.__Terminal',
    'const SerializeAddon = globalThis.__SerializeAddon',
    'const fastq = globalThis.__fastq',
    'class Harness {',
    '  prompt(cwd) {',
    '    return new Promise((resolve, reject) => {',
    '      const config = {}',
    '      let re = /(.+)(\\1)/gs',
    '      let term = pty.spawn(this.shell, this.args, config)',
    '      let vt = new Terminal({ allowProposedApi: true, fontSize: 12 })',
    '      let vts = new SerializeAddon()',
    '      vt.loadAddon(vts)',
    '      let queue = fastq((data, cb) => {',
    '        if (this.prompt_ready) {',
    '          vt.write(data, () => {',
    '            let buf = vts.serialize()',
    '            let re = /(.+)echo pinokio[\\r\\n]+pinokio[\\r\\n]+(\\1)/gs',
    '            const match = re.exec(buf)',
    '            if (match && match.length > 0) {',
    '              this.prompt_ready = false',
    '              this.prompt_done = true',
    '              let stripped = this.stripAnsi(match[1])',
    '              const p = stripped',
    '                .replaceAll(/[\\r\\n]/g, "")',
    '                .trim()',
    '                .replaceAll(/[.*+?^${}()|[\\]\\\\]/g, \'\\\\$&\');',
    '              term.kill()',
    '              vt.dispose()',
    '              queue.killAndDrain()',
    '              resolve(p)',
    '            }',
    '          })',
    '          cb()',
    '        }',
    '      }, 1)',
    '      term.onData((data) => {',
    '        if (!this.prompt_done) {',
    '          if (this.prompt_ready) {',
    '            queue.push(this.filterDecsync(data))',
    '          } else {',
    '            setTimeout(() => {',
    '              if (!this.prompt_ready) {',
    '                this.prompt_ready = true',
    '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)',
    '              }',
    '            }, 500)',
    '          }',
    '        }',
    '      });',
    '    })',
    '  }',
    '}',
    'function execDummy() {',
    '          this.ptyProcess = pty.spawn(this.shell, shellArgs, config)',
    '          this.ptyProcess.onData((data) => {',
    '            this.ready = true',
    '              this.ptyProcess.write(`${this.exec_cmd || this.cmd}${this.EOL}`)',
    '          })',
    '}',
    'module.exports = Harness',
  ].join('\n') + '\n';
}

test('patches the exact source anchors and exposes every bounded PTY boundary marker', () => {
  const source = sourceFixture();
  const result = patchSource(source, { expectedSha256: sha256(Buffer.from(source, 'utf8')) });
  assert.equal(result.replacements.length, 14);
  for (const marker of PTY_MARKERS) assert.match(result.source, new RegExp(marker));
  assert.match(result.source, /__r25PromptFirstOutput = true; __r25PtyCapture\('prompt-first-output'[\s\S]*else if \(!__r25PromptFollowupOutput\)[\s\S]*prompt-followup-output/);
  const preProbe = result.source.indexOf("__r25PtyCapture('prompt-probe-write'");
  const write = result.source.indexOf('term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)', preProbe);
  const returned = result.source.indexOf('__r25PromptProbeWriteReturned = true', write);
  const returnMarker = result.source.indexOf("__r25PtyCapture('prompt-probe-write-return'", returned);
  const postCallback = result.source.indexOf("if (__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput)");
  const postMarker = result.source.indexOf("__r25PtyCapture('prompt-post-probe-output'", postCallback);
  assert.ok(preProbe >= 0 && preProbe < write && write < returned && returned < returnMarker);
  assert.ok(postCallback >= 0 && postMarker > postCallback);
  assert.match(result.source, /if \(__r25PromptProbeWriteReturned && !__r25PromptPostProbeOutput\) \{ __r25PromptPostProbeOutput = true; __r25PtyCapture\('prompt-post-probe-output',/);
  assert.deepEqual(PRESERVED_MARKERS, ['prompt-probe-write-return', 'prompt-post-probe-output']);
  assert.notEqual(result.patchedSha256, result.sourceSha256);
});

test('fails closed on a source mismatch without modifying the checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-patch-mismatch-'));
  try {
    const source = sourceFixture();
    const file = path.join(root, 'kernel', 'shell.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    assert.throws(() => applyPinokiodPtyInstrumentation(root, {
      diagnosticFile: path.join(root, 'markers.jsonl'), verifyGit: false, expectedSha256: '0'.repeat(64),
    }), /source hash differs/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('redacts arbitrary fields and keeps marker output bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-marker-bounds-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const writer = createBoundedMarkerWriter(file, { maxRows: 16, maxBytes: 512 });
    writer.write('exec-input-write', { command: 'do-not-retain', token: 'secret-value' });
    for (let index = 0; index < 30; index += 1) writer.write('prompt-pty-spawn', { pid: index + 1, ppid: 99 });
    const output = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 512);
    assert.ok(output.split('\n').filter(Boolean).length <= 16);
    assert.doesNotMatch(output, /do-not-retain|secret-value|command|token/);
    assert.match(output, /prompt-pty-spawn/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the two probe boundary markers survive ring overflow without duplication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-marker-preservation-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const writer = createBoundedMarkerWriter(file, { maxRows: 16, maxBytes: 512 });
    writer.write('prompt-probe-write-return');
    writer.write('prompt-post-probe-output');
    for (let index = 0; index < 40; index += 1) writer.write('exec-pty-spawn', { pid: index + 1, ppid: 99 });
    writer.write('prompt-probe-write-return');
    const output = fs.readFileSync(file, 'utf8');
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(Buffer.byteLength(output, 'utf8') <= 512);
    assert.ok(rows.length <= 16);
    for (const marker of PRESERVED_MARKERS) assert.equal(rows.filter(row => row.kind === marker).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup return is not attributed to setup and setup return/output keep their prompt ordinal and PID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-latest-prompt-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    vm.runInNewContext(`${RUNTIME}
      __r25PtyBeginPrompt(); __r25PtySetPromptPid(101); __r25PtyCapture('prompt-pty-spawn', { pid: 101, ppid: 99 });
      __r25PtyCapture('prompt-probe-write'); __r25PromptProbeWriteReturned = true; __r25PtyCapture('prompt-probe-write-return');
      __r25PtyBeginPrompt(); __r25PtySetPromptPid(202); __r25PtyCapture('prompt-pty-spawn', { pid: 202, ppid: 99 });
      __r25PtyCapture('prompt-probe-write');
      for (let i = 0; i < 40; i += 1) __r25PtyCapture('exec-pty-spawn', { pid: i + 1, ppid: 99 });
      __r25PromptProbeWriteReturned = true; __r25PtyCapture('prompt-probe-write-return'); __r25PtyCapture('prompt-post-probe-output');`, {
      Buffer, Date, JSON, Set,
      process: { pid: 99, env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
      require,
    });
    const output = fs.readFileSync(file, 'utf8');
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(Buffer.byteLength(output, 'utf8') <= 4096);
    assert.ok(rows.length <= 16);
    assert.equal(rows.some(row => row.kind === 'prompt-probe-write-return' && row.prompt_ordinal === 1), false);
    assert.equal(rows.find(row => row.kind === 'prompt-probe-write' && row.prompt_ordinal === 2).prompt_pid, 202);
    assert.equal(rows.find(row => row.kind === 'prompt-probe-write-return').prompt_ordinal, 2);
    assert.equal(rows.find(row => row.kind === 'prompt-post-probe-output').prompt_pid, 202);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('setup call remains attributed when its return is absent and overflow follows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-setup-no-return-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    vm.runInNewContext(`${RUNTIME}
      __r25PtyBeginPrompt(); __r25PtySetPromptPid(101); __r25PtyCapture('prompt-pty-spawn', { pid: 101, ppid: 99 });
      __r25PtyCapture('prompt-probe-write'); __r25PromptProbeWriteReturned = true; __r25PtyCapture('prompt-probe-write-return');
      __r25PtyBeginPrompt(); __r25PtySetPromptPid(202); __r25PtyCapture('prompt-pty-spawn', { pid: 202, ppid: 99 });
      __r25PtyCapture('prompt-probe-write');
      for (let i = 0; i < 40; i += 1) __r25PtyCapture('exec-pty-spawn', { pid: i + 1, ppid: 99 });`, {
      Buffer, Date, JSON, Set,
      process: { pid: 99, env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
      require,
    });
    const output = fs.readFileSync(file, 'utf8');
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(Buffer.byteLength(output, 'utf8') <= 4096);
    assert.ok(rows.length <= 16);
    assert.equal(rows.some(row => row.kind === 'prompt-probe-write-return' && row.prompt_ordinal === 1), false);
    for (const kind of ['prompt-pty-spawn-start', 'prompt-pty-spawn', 'prompt-probe-write']) {
      const row = rows.find(item => item.kind === kind);
      assert.equal(row.prompt_ordinal, 2);
      if (kind !== 'prompt-pty-spawn-start') assert.equal(row.prompt_pid, 202);
    }
    assert.equal(rows.some(row => row.kind === 'prompt-probe-write-return' && row.prompt_ordinal === 2), false);
    assert.equal(rows.some(row => row.kind === 'prompt-post-probe-output' && row.prompt_ordinal === 2), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected runtime keeps the actual marker file bounded and command-free', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-runtime-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    vm.runInNewContext(`${RUNTIME}\n__r25PtyCapture('prompt-probe-write-return');\n__r25PtyCapture('prompt-post-probe-output');\n__r25PtyCapture('exec-input-write', { command: 'do-not-retain', token: 'secret-value' });\nfor (let i = 0; i < 30; i += 1) __r25PtyCapture('prompt-pty-spawn', { pid: i + 1, ppid: 99 });`, {
      Buffer, Date, JSON, Set,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
      require,
    });
    const output = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(output, 'utf8') <= 4096);
    assert.ok(output.split('\n').filter(Boolean).length <= 16);
    assert.doesNotMatch(output, /do-not-retain|secret-value|command|token/);
    const rows = output.split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const marker of PRESERVED_MARKERS) assert.equal(rows.filter(row => row.kind === marker).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function promptHarness(root, scenarios = []) {
  let pid = 3000;
  const terms = [];
  const source = sourceFixture();
  const patched = patchSource(source, { expectedSha256: sha256(Buffer.from(source, 'utf8')) });
  const sandbox = {
    Buffer, Date, JSON, Set, Promise, Math, Number, Boolean, Object,
    process: { pid: 2999, env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: path.join(root, 'markers.jsonl') } },
    require,
    module: { exports: {} }, exports: {},
    __scenario: null,
    __pty: { spawn: () => {
      const term = {
        pid: ++pid,
        onData(callback) { this.dataCallback = callback; },
        onExit(callback) { this.exitCallback = callback; },
        write() {},
        kill() {},
        emit(data) { return this.dataCallback(data); },
        exit(event) { return this.exitCallback(event); },
      };
      terms.push(term);
      return term;
    } },
    __Terminal: class {
      constructor() { this.scenario = sandbox.__scenario; }
      loadAddon(addon) { this.addon = addon; }
      write(data, callback) {
        if (this.scenario.writeThrows) throw this.scenario.writeThrows;
        if (this.scenario.invokeWriteCallback !== false) callback();
      }
      dispose() {}
    },
    __SerializeAddon: class {
      constructor() { this.scenario = sandbox.__scenario; }
      serialize() {
        if (this.scenario.serializeThrows) throw this.scenario.serializeThrows;
        return this.scenario.serialized;
      }
    },
    __fastq: worker => {
      const queue = data => worker(data, () => {});
      queue.push = data => worker(data, () => {});
      queue.killAndDrain = () => {};
      return queue;
    },
    setTimeout,
  };
  vm.runInNewContext(patched.source, sandbox, { filename: 'patched-prompt-fixture.js' });
  function start(scenario) {
    sandbox.__scenario = scenario;
    const shell = new sandbox.module.exports();
    shell.prompt_ready = true;
    shell.prompt_done = false;
    shell.shell = 'stub';
    shell.args = [];
    shell.EOL = '\n';
    shell.filterDecsync = data => {
      if (scenario.filterThrows) throw scenario.filterThrows;
      return data;
    };
    shell.stripAnsi = value => {
      if (scenario.normalizeThrows) throw scenario.normalizeThrows;
      return value;
    };
    const promise = shell.prompt('/stub');
    return { promise, term: terms.at(-1), shell };
  }
  function rows() {
    const file = path.join(root, 'markers.jsonl');
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  return { start, terms, rows, file: path.join(root, 'markers.jsonl'), sandbox };
}

test('actual injected prompt path distinguishes no terminal callback, false match, and successful resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-prompt-path-'));
  try {
    const harness = promptHarness(root);
    const missing = harness.start({ invokeWriteCallback: false, serialized: '' });
    missing.term.emit(`secret input without probe text${'x'.repeat(1_000_005)}`);
    let row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.stage, 'vt-write');
    assert.equal(row.write_return_count, 1);
    assert.equal(row.write_callback_count, 0);
    assert.equal(row.input_length, 1_000_000);
    assert.equal(row.output_length, 1_000_000);

    const falseMatch = harness.start({ serialized: 'ordinary prompt output' });
    falseMatch.term.emit('secret payload one');
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.stage, 'regex');
    assert.equal(row.match, false);
    assert.equal(row.regex_count, 1);

    const matched = harness.start({ serialized: 'PS> echo pinokio\r\npinokio\r\nPS> ' });
    matched.term.emit('private user data');
    assert.equal(await matched.promise, 'PS>');
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.stage, 'resolve');
    assert.equal(row.match, true);
    assert.equal(row.done, true);
    assert.equal(row.normalize_count, 1);
    const output = fs.readFileSync(harness.file, 'utf8');
    assert.doesNotMatch(output, /secret input|secret payload|private user data|PS>|echo pinokio/);
    assert.ok(Buffer.byteLength(output) <= 4096);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual injected prompt path records fixed exception classes and rethrows the original error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-prompt-errors-'));
  try {
    const harness = promptHarness(root);
    const original = new TypeError('private exception detail must not be retained');
    const scenario = { serialized: '', serializeThrows: original };
    const run = harness.start(scenario);
    assert.throws(() => run.term.emit('private payload'), error => error === original);
    let row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.error_stage, 'serialize');
    assert.equal(row.error_class, 'TypeError');
    const output = fs.readFileSync(harness.file, 'utf8');
    assert.doesNotMatch(output, /private exception detail|private payload/);

    const filterError = new Error('filter private detail');
    const filterRun = harness.start({ serialized: '', filterThrows: filterError });
    assert.throws(() => filterRun.term.emit('another private payload'), error => error === filterError);
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.error_stage, 'filter');
    assert.equal(row.error_class, 'Error');

    const normalizeError = new TypeError('normalization private detail');
    const normalizeRun = harness.start({ serialized: 'PS> echo pinokio\r\npinokio\r\nPS> ', normalizeThrows: normalizeError });
    assert.throws(() => normalizeRun.term.emit('third private payload'), error => error === normalizeError);
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.error_stage, 'normalize');
    assert.equal(row.error_class, 'TypeError');
    const allOutput = fs.readFileSync(harness.file, 'utf8');
    assert.doesNotMatch(allOutput, /filter private detail|normalization private detail|another private payload|third private payload/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('interleaved prompt callbacks stay bound to their prompt and stage summaries remain bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-prompt-interleave-'));
  try {
    const harness = promptHarness(root);
    const first = harness.start({ serialized: 'old prompt' });
    const second = harness.start({ serialized: 'new prompt' });
    first.term.emit('old secret');
    first.term.exit({ exitCode: 7, signal: null });
    let row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.prompt_ordinal, 2);
    assert.equal(row.callback_count, 0);
    const oldExit = harness.rows().find(item => item.kind === 'prompt-native-exit');
    assert.equal(oldExit.prompt_ordinal, 1);
    assert.equal(oldExit.prompt_pid, first.term.pid);
    second.term.emit('new secret');
    for (let i = 0; i < 40; i += 1) vm.runInNewContext(`__r25PtyCapture('exec-pty-spawn', { pid: ${4000 + i}, ppid: 2999 })`, harness.sandbox);
    const output = fs.readFileSync(harness.file, 'utf8');
    assert.ok(Buffer.byteLength(output) <= 4096);
    assert.ok(output.split('\n').filter(Boolean).length <= 16);
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.prompt_ordinal, 2);
    assert.doesNotMatch(output, /old secret|new secret|old prompt|new prompt/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
