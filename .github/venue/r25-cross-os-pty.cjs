'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./r25-pinokiod-pty-instrumentation.cjs');

// Layered only onto the verified, disposable diagnostic daemon. The production
// prompt predicate and every resolve/kill operation remain byte-for-byte intact.
function patchCrossOsSource(source, macHelper) {
  function replace(needle, addition) {
    if (source.split(needle).length !== 2) throw new Error('cross-OS diagnostic anchor is not unique');
    source = source.replace(needle, addition);
  }
  const runtime = String.raw`
const __r25CrossFs = require('fs');
const __r25CrossPath = require('path');
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
  replace("const __r25PtyFs = require('fs');", runtime + "\nconst __r25PtyFs = require('fs');");
  replace('    this.prompt_pattern = await this.prompt(params.path)',
    '    __r25CrossBeforeShell(this.kernel.homedir, this.env)\n    this.prompt_pattern = await this.prompt(params.path)');
  replace('      term.onData((data) => {', '      term.onData((data) => {\n        __r25CrossMacPrompt(__r25PromptOrdinal)?.onData(data)\n        __r25CrossWrite()');
  const probe = "                __r25PtyCapture('prompt-probe-write-return', { prompt_ordinal: __r25PromptOrdinal, prompt_pid: term?.pid })";
  replace(probe, probe + "\n                __r25CrossProbe(__r25PromptOrdinal, 'written_at')" + '\n                __r25CrossMacPrompt(__r25PromptOrdinal)?.probeWritten()\n                __r25CrossWrite()');
  const resolved = "              __r25PtyProcessing(__r25PromptState, 'resolve')";
  replace(resolved, resolved + "\n              __r25CrossProbe(__r25PromptOrdinal, 'resolved_at')" + '\n              __r25CrossMacPrompt(__r25PromptOrdinal)?.promptResolved()\n              __r25CrossWrite()');
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
