'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./r25-pinokiod-pty-instrumentation.cjs');

// Layered only onto the verified, disposable diagnostic daemon. The production
// prompt predicate and every resolve/kill operation remain byte-for-byte intact.
function patchCrossOsSource(source, macHelper) {
  function replace(needle, addition, label) {
    const matches = source.split(needle).length - 1;
    if (matches !== 1) throw new Error(`cross-OS diagnostic anchor ${label} matched ${matches} times; refusing patch`);
    source = source.replace(needle, addition);
  }
  function replaceOneOf(anchors, label) {
    const matches = anchors.filter(item => source.includes(item.needle));
    if (matches.length !== 1) throw new Error(`cross-OS diagnostic anchor ${label} matched ${matches.length} variants; refusing patch`);
    replace(matches[0].needle, matches[0].addition, label);
  }
  const runtime = String.raw`
const __r25CrossFs = require('fs');
const __r25CrossPath = require('path');
const __r25CrossCrypto = require('crypto');
const __r25CrossMacHelper = require(${JSON.stringify(macHelper)});
const __r25CrossMac = new Map();
const __r25CrossPreShell = [];
const __r25CrossProbes = [];
function __r25CrossWrite() {
  const file = process.env.ASTRID_R25_CROSS_CAPTURE_FILE;
  if (!file || process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return;
  const value = { schema: 'astrid.r25.cross-os-pty.v1', pre_shell: __r25CrossPreShell, prompt_probes: __r25CrossProbes,
    macos_prompts: [...__r25CrossMac.entries()].map(([ordinal, item]) => ({ ordinal, ...item.snapshot() })) };
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data, 'utf8') > 131072) return;
  try { __r25CrossFs.mkdirSync(__r25CrossPath.dirname(file), { recursive: true }); __r25CrossFs.writeFileSync(file, data, { mode: 0o600 }); } catch {}
}
function __r25CrossBeforeShell(home, env) {
  if (process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return;
  const root = __r25CrossPath.join(home, 'bin', 'miniforge');
  const exists = relative => { try { return __r25CrossFs.statSync(__r25CrossPath.join(root, relative)).isFile(); } catch { return false; } };
  const state = { at: new Date().toISOString(), platform: process.platform,
    conda: __r25CrossMacHelper.condaPresence(home, env),
    windows_conda_exe_exists: exists('Scripts/conda.exe'), windows_conda_bat_exists: exists('condabin/conda.bat') };
  __r25CrossPreShell.push(state);
  if (__r25CrossPreShell.length > 8) __r25CrossPreShell.shift();
  __r25CrossWrite();
}
function __r25CrossProbe(ordinal, field) {
  if (process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return;
  let probe = __r25CrossProbes.find(item => item.prompt_ordinal === ordinal);
  if (!probe) { if (__r25CrossProbes.length >= 32) return; probe = {prompt_ordinal: ordinal}; __r25CrossProbes.push(probe); }
  probe[field] = new Date().toISOString();
}
function __r25CrossProbeWrite(ordinal, role, input, returned = false) {
  if (process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return;
  let probe = __r25CrossProbes.find(item => item.prompt_ordinal === ordinal);
  if (!probe) { if (__r25CrossProbes.length >= 32) return; probe = {prompt_ordinal: ordinal}; __r25CrossProbes.push(probe); }
  if (!Array.isArray(probe.writes)) probe.writes = [];
  let write = probe.writes.find(item => item.role === role);
  if (!write) {
    if (probe.writes.length >= 4 || typeof input !== 'string') return;
    const bytes = Buffer.from(input, 'utf8');
    write = {role, bytes: bytes.length, sha256: __r25CrossCrypto.createHash('sha256').update(bytes).digest('hex'), attempted_at: new Date().toISOString()};
    probe.writes.push(write);
  }
  if (returned) write.returned_at = new Date().toISOString();
  __r25CrossWrite();
}
function __r25CrossSgrMatcherPair(state, ordinal, term, eol) {
  if (process.env.ASTRID_R25_WINDOWS_SGR_DIAGNOSTIC !== '1' || !state ||
      state.sgr_color_setting_proven !== true || state.sgr_color_setting_failed === true ||
      state.sgr_matcher_pair_write_attempted === true) return;
  state.sgr_matcher_pair_write_attempted = true;
  const input = `echo pinokio${eol}echo pinokio${eol}`;
  __r25CrossProbeWrite(ordinal, 'matcher-pair', input);
  try {
    term.write(input);
    state.sgr_matcher_pair_write_returned = true;
    __r25CrossProbeWrite(ordinal, 'matcher-pair', input, true);
  } catch (error) {
    state.sgr_matcher_pair_write_error = error?.name || 'Error';
  }
  __r25CrossWrite();
}
function __r25CrossWriteAudit(ordinal, shell, guard) {
  if (process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return;
  let probe = __r25CrossProbes.find(item => item.prompt_ordinal === ordinal);
  if (!probe) { if (__r25CrossProbes.length >= 32) return; probe = {prompt_ordinal: ordinal}; __r25CrossProbes.push(probe); }
  probe.shell_basename = typeof shell === 'string' ? shell.slice(0, 80) : null;
  probe.no_argument_echo_guard = guard === true;
  probe.no_argument_echo_write = false;
  __r25CrossWrite();
}
function __r25CrossMacPrompt(ordinal) {
  if (process.platform !== 'darwin' || process.env.ASTRID_R25_CROSS_OS_DIAGNOSTIC !== '1') return null;
  if (!__r25CrossMac.has(ordinal)) {
    if (__r25CrossMac.size >= 2) { const first = __r25CrossMac.keys().next().value; __r25CrossMac.get(first).dispose(); __r25CrossMac.delete(first); }
    const item = __r25CrossMacHelper.createMacPtyDiagnostics({ probe: 'echo pinokio', onFailure: () => __r25CrossWrite() });
    item.terminalWait('PTerm packet.type=stop|disconnect; observer child.exit');
    __r25CrossMac.set(ordinal, item);
  }
  return __r25CrossMac.get(ordinal);
}
`;
  replace("const __r25PtyFs = require('fs');", runtime + "\nconst __r25PtyFs = require('fs');", 'runtime-helper');
  replace('    this.prompt_pattern = await this.prompt(params.path)',
    '    __r25CrossBeforeShell(this.kernel.homedir, this.env)\n    this.prompt_pattern = await this.prompt(params.path)', 'pre-shell');
  replace('      term.onData((data) => {', '      term.onData((data) => {\n        __r25CrossMacPrompt(__r25PromptOrdinal)?.onData(data)\n        __r25CrossWrite()', 'prompt-on-data');
  const sgrProofCallback = "        __r25PtyProcessing(__r25PromptState, 'callback', { ready: this.prompt_ready, done: this.prompt_done, input_length: typeof data === 'string' ? data.length : 0, input_probe_count: __r25PtyProbeCount(data), input_command_line_count: __r25InputCommandLines })";
  replace(sgrProofCallback, sgrProofCallback + "\n        __r25CrossSgrMatcherPair(__r25PromptState, __r25PromptOrdinal, term, this.EOL)", 'sgr-proof-pair-boundary');
  const probe = "                __r25PtyCapture('prompt-probe-write-return', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })";
  replace(probe, probe + "\n                __r25CrossProbe(__r25PromptOrdinal, 'written_at')" + '\n                __r25CrossMacPrompt(__r25PromptOrdinal)?.probeWritten()\n                __r25CrossWrite()', 'probe-write-return');
  replace("                const __r25CmdEchoProbe = /^cmd(?:\\.exe)?$/i.test(__r25PtyPath.win32.basename(String(this.shell || '')))\n",
    "                const __r25CmdEchoProbe = /^cmd(?:\\.exe)?$/i.test(__r25PtyPath.win32.basename(String(this.shell || '')))\n" +
    "                __r25PtyProcessing(__r25PromptState, 'callback', { nonce_probe_attempted: true, cmd_echo_state_probe_attempted: false })\n" +
    "                __r25CrossWriteAudit(__r25PromptOrdinal, __r25PtyPath.win32.basename(String(this.shell || '')), __r25CmdEchoProbe)\n", 'nonce-probe-audit');
  // Keep the ordinary matcher-pair write in its normal-input branch. The
  // changed-input branch writes removal alone; its echo pair follows the
  // callback that has already proven the removal marker.
  const matcherPairAudit =
    "                const __r25MatcherPairInput = `echo pinokio${this.EOL}echo pinokio${this.EOL}`\n" +
    "                __r25CrossProbeWrite(__r25PromptOrdinal, 'matcher-pair', __r25MatcherPairInput)\n" +
    "                term.write(__r25MatcherPairInput)\n" +
    "                __r25CrossProbeWrite(__r25PromptOrdinal, 'matcher-pair', __r25MatcherPairInput, true)";
  const changedSgrInput = "if (process.env.ASTRID_R25_WINDOWS_SGR_DIAGNOSTIC === '1') term.write(`Remove-Module PSReadLine -ErrorAction SilentlyContinue; if (-not (Get-Module -Name PSReadLine)) { Write-Output 'R25_SGR_COLOR_DISABLED' } else { Write-Output 'R25_SGR_COLOR_SETTING_FAILED' }${this.EOL}echo pinokio${this.EOL}echo pinokio${this.EOL}`); else term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)";
  replaceOneOf([
    { needle: changedSgrInput, addition: "if (process.env.ASTRID_R25_WINDOWS_SGR_DIAGNOSTIC === '1') {\n" +
        "                  const __r25SgrRemovalInput = `Remove-Module PSReadLine -ErrorAction SilentlyContinue; if (-not (Get-Module -Name PSReadLine)) { Write-Output 'R25_SGR_COLOR_DISABLED' } else { Write-Output 'R25_SGR_COLOR_SETTING_FAILED' }${this.EOL}`\n" +
        "                  __r25CrossProbeWrite(__r25PromptOrdinal, 'sgr-removal', __r25SgrRemovalInput)\n" +
        "                  term.write(__r25SgrRemovalInput)\n" +
        "                  __r25CrossProbeWrite(__r25PromptOrdinal, 'sgr-removal', __r25SgrRemovalInput, true)\n" +
        "                } else {\n" + matcherPairAudit + "\n                }" },
    { needle: '                term.write(`echo pinokio${this.EOL}echo pinokio${this.EOL}`)', addition: matcherPairAudit },
  ], 'matcher-pair-write');
  replace('                    if (__r25CmdEchoProbe) term.write(`echo${this.EOL}`)',
    "                    // The cmd-only no-argument echo is omitted for this changed-input probe.", 'cmd-no-argument-echo');
  replace('                    term.write(`echo ${__r25PromptState.nonce}${this.EOL}`)',
    "                    const __r25NonceInput = `echo ${__r25PromptState.nonce}${this.EOL}`\n" +
    "                    __r25CrossProbeWrite(__r25PromptOrdinal, 'nonce', __r25NonceInput)\n" +
    "                    term.write(__r25NonceInput)\n" +
    "                    __r25CrossProbeWrite(__r25PromptOrdinal, 'nonce', __r25NonceInput, true)", 'nonce-write');
  const resolved = "              __r25PtyProcessing(__r25PromptState, 'resolve')";
  replace(resolved, resolved + "\n              __r25CrossProbe(__r25PromptOrdinal, 'resolved_at')" + '\n              __r25CrossMacPrompt(__r25PromptOrdinal)?.promptResolved()\n              __r25CrossWrite()', 'resolve');
  return source;
}

function applyCrossOsPtyDiagnostics(root) {
  const file = path.join(root, 'kernel', 'shell.js');
  const previous = fs.readFileSync(file, 'utf8');
  const source = patchCrossOsSource(previous, path.join(__dirname, 'r25-macos-diagnostic.cjs'));
  fs.writeFileSync(file, source);
  return { pinokiod_ref: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf', prior_sha256: sha256(previous), patched_sha256: sha256(source), adapter_sha256: sha256(fs.readFileSync(__filename)), mac_helper_sha256: sha256(fs.readFileSync(path.join(__dirname, 'r25-macos-diagnostic.cjs'))), max_capture_bytes: 131072 };
}

module.exports = { patchCrossOsSource, applyCrossOsPtyDiagnostics };
