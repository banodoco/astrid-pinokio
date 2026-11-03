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
        writes: [],
        killCount: 0,
        onData(callback) { this.dataCallback = callback; },
        onExit(callback) { this.exitCallback = callback; },
        write(data) { this.writes.push(data); },
        kill() { this.killCount += 1; },
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
    shell.shell = scenario.shell || 'stub';
    shell.args = [];
    shell.EOL = '\n';
    shell.filterDecsync = data => {
      if (scenario.filterThrows) throw scenario.filterThrows;
      if (scenario.filter) return scenario.filter(data);
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

test('cumulative exact command-line counters handle chunk splits, cap counts, and retain no payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-command-line-stream-'));
  try {
    const harness = promptHarness(root);
    const run = harness.start({ serialized: 'ordinary screen', shell: 'cmd.exe' });
    run.term.emit('C:\\private\\> ech');
    run.term.emit('o pin');
    run.term.emit('okio\r');
    run.term.emit('\nC:\\private\\> echo pinokio\r\n');
    let row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.input_command_line_count, 2);
    assert.equal(row.filtered_command_line_count, 2);
    assert.equal(row.probe_command_line_count, 0, 'existing shape field remains the serialized-buffer count');
    assert.doesNotMatch(fs.readFileSync(harness.file, 'utf8'), /private|echo pinokio|C:\\private/);

    const capped = harness.start({ serialized: 'ordinary screen' });
    capped.term.emit(`${'echo pinokio\n'.repeat(1100)}`);
    row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.input_command_line_count, 1000);
    assert.equal(row.filtered_command_line_count, 1000);
    assert.ok(Buffer.byteLength(fs.readFileSync(harness.file, 'utf8')) <= 4096);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded discriminator attributes command loss before filtering, in filtering, or in serialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-command-line-stages-'));
  try {
    const harness = promptHarness(root);
    const scenarios = [
      { name: 'before-filter', input: 'PS> ordinary text\r\n', filter: value => value, serialized: 'PS> ordinary text\r\n', expectedInput: 0, expectedFiltered: 0 },
      { name: 'filter', input: 'PS> echo pinokio\r\n', filter: value => value.replace('echo pinokio', '[removed]'), serialized: 'PS> [removed]\r\n', expectedInput: 1, expectedFiltered: 0 },
      { name: 'serialization', input: 'PS> echo pinokio\r\n', filter: value => value, serialized: 'PS> pinokio\r\n', expectedInput: 1, expectedFiltered: 1 },
    ];
    for (const scenario of scenarios) {
      const run = harness.start(scenario);
      run.term.emit(scenario.input);
      const row = harness.rows().find(item => item.kind === 'prompt-processing');
      assert.equal(row.stage, 'regex', `${scenario.name} reaches serialized shape evaluation`);
      assert.equal(row.input_command_line_count, scenario.expectedInput, `${scenario.name} callback count`);
      assert.equal(row.filtered_command_line_count, scenario.expectedFiltered, `${scenario.name} filter output count`);
      assert.equal(row.probe_command_line_count, 0, `${scenario.name} serialized shape count`);
      assert.equal(row.match, false, `${scenario.name} leaves the matcher unchanged`);
    }
    const output = fs.readFileSync(harness.file, 'utf8');
    assert.doesNotMatch(output, /PS>|echo pinokio|\[removed\]|ordinary text/);
    assert.ok(Buffer.byteLength(output) <= 4096);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('records when terminal SGR styling splits the literal matcher command without changing match logic', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-sgr-split-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const context = {
      Buffer, Date, JSON, Set, require,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
    };
    const screen = 'PS> \u001b[93mecho \u001b[0mpinokio\r\npinokio\r\nPS> \u001b[93mecho \u001b[0mpinokio\r\n>> \r\npinokio\r\nPS> ';
    const matcher = /(.+)echo pinokio[\r\n]+pinokio[\r\n]+(\1)/gs;
    assert.equal(matcher.test(screen), false);
    assert.equal(matcher.test(screen.replace(/\u001b\[[0-?]*[ -/]*m/g, '')), true,
      'the captured continuation marker alone does not prevent the first repeated-prompt match');
    vm.runInNewContext(`${RUNTIME}
      __r25PtyLatestPromptOrdinal = 1;
      const state = __r25PtyNewProcessing(1, 47);
      __r25PtyProcessing(state, 'regex', { match: false, regex_shape: __r25PtyRegexShape(${JSON.stringify(screen)}) });
      globalThis.result = state;
    `, context);
    const row = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).find(item => item.kind === 'prompt-processing');
    assert.equal(context.result.probe_command_count, 0);
    assert.equal(context.result.probe_command_output_sequence_count, 0);
    assert.equal(context.result.probe_command_sgr_split_count, 2);
    assert.equal(context.result.probe_output_line_count, 2);
    assert.equal(row.probe_command_sgr_split_count, 2);
    assert.equal(row.match, false);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PS>|echo pinokio|pinokio/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nonce predicates distinguish echoed command from output without retaining nonce text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-nonce-predicates-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const context = {
      Buffer, Date, JSON, Set, require,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
    };
    vm.runInNewContext(`${RUNTIME}
      __r25PtyLatestPromptOrdinal = 1;
      const make = (nonce) => {
        const state = __r25PtyNewProcessing(1, 44);
        state.nonce = nonce;
        __r25PtyProcessing(state, 'callback', { nonce_probe_attempted: true, nonce_probe_write_returned: true });
        return state;
      };
      const outputOnly = make('r25_positive');
      __r25PtyCountNonceLines(outputOnly, '\\nr25_positive\\r\\n');
      __r25PtyProcessing(outputOnly, 'callback');
      globalThis.positive = { command: outputOnly.nonce_command_line_count, output: outputOnly.nonce_output_line_count,
        observed: outputOnly.nonce_probe_executed, absent: outputOnly.nonce_output_absent_after_write };
      const commandOnly = make('r25_negative');
      __r25PtyCountNonceLines(commandOnly, 'PS> echo r25_negative\\r\\n');
      __r25PtyProcessing(commandOnly, 'callback');
      globalThis.negative = { command: commandOnly.nonce_command_line_count, output: commandOnly.nonce_output_line_count,
        observed: commandOnly.nonce_probe_executed, absent: commandOnly.nonce_output_absent_after_write };
      const none = make('r25_none');
      __r25PtyProcessing(none, 'callback');
      globalThis.noData = { command: none.nonce_command_line_count, output: none.nonce_output_line_count,
        observed: none.nonce_probe_executed, absent: none.nonce_output_absent_after_write };
    `, context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.positive)), { command: 0, output: 1, observed: true, absent: false });
    assert.deepEqual(JSON.parse(JSON.stringify(context.negative)), { command: 1, output: 0, observed: false, absent: true });
    assert.deepEqual(JSON.parse(JSON.stringify(context.noData)), { command: 0, output: 0, observed: false, absent: true });
    const output = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(output, /r25_positive|r25_negative|r25_none|echo /);
    assert.match(output, /"nonce_probe_executed":false/);
    assert.match(output, /"nonce_output_absent_after_write":true/);
    assert.ok(Buffer.byteLength(output) <= 4096);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nonce command and output counters handle split chunks and CR/LF line endings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-nonce-chunks-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const context = {
      Buffer, Date, JSON, Set, require,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
    };
    vm.runInNewContext(`${RUNTIME}
      __r25PtyLatestPromptOrdinal = 1;
      const state = __r25PtyNewProcessing(1, 45);
      state.nonce = 'r25_split';
      __r25PtyProcessing(state, 'callback', { nonce_probe_attempted: true, nonce_probe_write_returned: true });
      for (const chunk of ['PS> ech', 'o r25_s', 'plit\\r', '\\nr25_', 'split\\n']) {
        __r25PtyCountNonceLines(state, chunk);
        __r25PtyProcessing(state, 'callback');
      }
      globalThis.result = { command: state.nonce_command_line_count, output: state.nonce_output_line_count,
        observed: state.nonce_probe_executed, absent: state.nonce_output_absent_after_write };
    `, context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result)), { command: 1, output: 1, observed: true, absent: false });
    const output = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(output, /r25_split|echo /);
    assert.match(output, /"nonce_command_line_count":1/);
    assert.match(output, /"nonce_output_line_count":1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bare echo state is captured across native cmd output chunks without retaining terminal text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-cmd-echo-state-'));
  try {
    const file = path.join(root, 'markers.jsonl');
    const context = {
      Buffer, Date, JSON, Set, require,
      process: { env: { ASTRID_R25_SETUP_DIAGNOSTICS: '1', ASTRID_R25_PTY_CAPTURE_FILE: file } },
    };
    vm.runInNewContext(`${RUNTIME}
      __r25PtyLatestPromptOrdinal = 1;
      const state = __r25PtyNewProcessing(1, 46);
      __r25PtyProcessing(state, 'callback', { cmd_echo_state_probe_attempted: true });
      __r25PtyCountCmdEchoState(state, 'ECHO is o');
      __r25PtyCountCmdEchoState(state, 'ff.\\r');
      __r25PtyCountCmdEchoState(state, '\\n');
      __r25PtyProcessing(state, 'callback');
      globalThis.result = state.cmd_echo_state;
    `, context);
    assert.equal(context.result, 'off');
    const output = fs.readFileSync(file, 'utf8');
    assert.match(output, /"cmd_echo_state":"off"/);
    assert.doesNotMatch(output, /ECHO is off/);
    assert.ok(Buffer.byteLength(output) <= 4096);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('injected prompt adds a bare echo discriminator and keeps state or nonce output from settling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-pty-nonce-write-'));
  try {
    const harness = promptHarness(root);
    const run = harness.start({ serialized: 'ordinary screen', shell: 'cmd.exe' });
    run.shell.prompt_ready = false;
    run.term.emit('initial prompt output');
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(run.term.writes.length, 3);
    assert.equal(run.term.writes[0], 'echo pinokio\necho pinokio\n');
    assert.equal(run.term.writes[1], 'echo\n');
    assert.match(run.term.writes[2], /^echo r25_[a-f0-9]{24}\n$/);
    const row = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(row.nonce_probe_attempted, true);
    assert.equal(row.nonce_probe_write_returned, true);
    assert.equal(row.nonce_command_line_count, 0);
    assert.equal(row.nonce_output_line_count, 0);
    assert.equal(row.nonce_probe_executed, false);
    assert.equal(row.nonce_output_absent_after_write, true);
    assert.equal(row.cmd_echo_state_probe_attempted, true);
    assert.doesNotMatch(fs.readFileSync(harness.file, 'utf8'), /r25_[a-f0-9]{24}|echo /);
    const original = sourceFixture();
    const patched = patchSource(original, { expectedSha256: sha256(Buffer.from(original, 'utf8')) });
    assert.equal((patched.source.match(/let re = \/\(\.\+\)echo pinokio/g) || []).length, 1);

    run.shell.prompt_ready = true;
    run.shell.prompt_done = false;
    harness.sandbox.__scenario.serialized = 'ECHO is off.\r\nr25_probe_output\r\n';
    run.term.emit('ECHO is off.\r\nr25_probe_output\r\n');
    const processing = harness.rows().find(item => item.kind === 'prompt-processing');
    assert.equal(processing.cmd_echo_state, 'off');
    assert.equal(processing.match, false);
    assert.equal(processing.done, false);
    assert.equal(run.term.killCount, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('native cmd.exe bare echo emits its state line on Windows', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ECHO is on\.?\r?\n?$/i);
});

test('PowerShell diagnostics retain the nonce probe without invoking interactive bare Write-Output', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r25-powershell-echo-'));
 try {
  const harness=promptHarness(root);
  const run=harness.start({serialized:'ordinary screen',shell:'powershell.exe'});
  run.shell.prompt_ready=false;run.term.emit('initial prompt output');
  await new Promise(resolve=>setTimeout(resolve,550));
  assert.equal(run.term.writes.length,2);
  assert.equal(run.term.writes.includes('echo\n'),false);
  assert.match(run.term.writes[1],/^echo r25_[a-f0-9]{24}\n$/);
  const row=harness.rows().find(item=>item.kind==='prompt-processing');
  assert.equal(row.cmd_echo_state_probe_attempted,false);
  assert.equal(row.nonce_probe_write_returned,true);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
