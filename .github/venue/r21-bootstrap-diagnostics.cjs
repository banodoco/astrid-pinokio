'use strict';

// Reduce a private Linux process trace to the three fixed historical
// bootstrap boundaries. The trace itself may contain command arguments, so it
// is deleted in a finally block and is never eligible for publication.
const fs = require('node:fs');
const path = require('node:path');

const STAGES = Object.freeze(['fetch_install', 'fetch_manifest', 'execute_installer']);
const FETCH_CLASSES = Object.freeze({
  1: 'unsupported_protocol', 2: 'invocation', 3: 'malformed_url',
  5: 'proxy_resolution', 6: 'name_resolution', 7: 'connection',
  22: 'http_response', 23: 'local_write', 26: 'local_read', 27: 'memory',
  28: 'timeout', 35: 'tls_connect', 47: 'redirect', 52: 'empty_response',
  56: 'receive', 60: 'tls_verification',
});
const SETTLEMENT_CLASSES = Object.freeze(['zero', 'nonzero', 'signal', 'not_observed']);

const boundedExit = value => Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const bool = value => value === true ? true : value === false ? false : null;
const iso = seconds => Number.isFinite(seconds) && seconds >= 0 ? new Date(seconds * 1000).toISOString() : null;

function decodeCString(value) {
  return value.replace(/\\x([0-9a-fA-F]{2})|\\([0-7]{1,3})|\\(.)/g, (_all, hex, octal, escaped) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
    return ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escaped] ?? escaped;
  });
}

function execRecord(body) {
  const match = body.match(/^execve\("((?:\\.|[^"\\])*)", \[((?:\\.|[^\]])*)\],/);
  if (!match) return null;
  const args = [];
  for (const item of match[2].matchAll(/"((?:\\.|[^"\\])*)"/g)) args.push(decodeCString(item[1]));
  return { executable: decodeCString(match[1]), args };
}

function stageForExec(record) {
  if (!record) return null;
  const executable = path.posix.basename(record.executable);
  if (executable === 'curl') {
    let destination = null;
    for (let index = 0; index < record.args.length - 1; index++) {
      if (record.args[index] === '-o' || record.args[index] === '--output') destination = record.args[index + 1];
    }
    const name = typeof destination === 'string' ? path.posix.basename(destination) : '';
    if (name === 'install') return 'fetch_install';
    if (name === 'install-manifest.json') return 'fetch_manifest';
    return null;
  }
  if (!['sh', 'dash'].includes(executable)) return null;
  const installer = record.args[1];
  const managed = record.args.some((value, index) => value === '--managed-by' && record.args[index + 1] === 'pinokio');
  return managed && typeof installer === 'string' && path.posix.basename(installer) === 'install'
    ? 'execute_installer' : null;
}

function safeClass(stage, code) {
  if (code === 0) return 'success';
  if (stage !== 'execute_installer') return FETCH_CLASSES[code] || 'fetch_nonzero';
  if (code === 2) return 'usage_or_shell';
  if (code === 126) return 'cannot_execute';
  if (code === 127) return 'command_not_found';
  if ([129, 130, 143].includes(code)) return 'interrupted';
  return 'installer_nonzero';
}

function reduceTrace(text) {
  const stages = Object.fromEntries(STAGES.map(stage => [stage, {
    observed: false, started_at: null, normalized_exit: null, safe_class: 'not_observed',
  }]));
  const processStages = new Map();
  for (const line of String(text).split('\n')) {
    const header = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!header) continue;
    const pid = header[1];
    const at = iso(Number(header[2]));
    const body = header[3];
    if (body.startsWith('execve(')) {
      const stage = stageForExec(execRecord(body));
      if (stage && !stages[stage].observed) {
        stages[stage] = { observed: true, started_at: at, normalized_exit: null, safe_class: 'exit_not_observed' };
        processStages.set(pid, stage);
      }
      continue;
    }
    const exited = body.match(/^exit_group\((-?\d+)\)/);
    const stage = processStages.get(pid);
    if (!exited || !stage || stages[stage].normalized_exit !== null) continue;
    const code = boundedExit(Number(exited[1]));
    if (code === null) continue;
    stages[stage].normalized_exit = code;
    stages[stage].safe_class = safeClass(stage, code);
  }
  const ordered = STAGES.map(stage => ({ stage, ...stages[stage] }));
  const first = ordered.find(value => value.observed && value.normalized_exit !== null
    && value.normalized_exit !== 0);
  const unresolved = ordered.find(value => value.safe_class !== 'success');
  return {
    stages,
    first_failure: first ? { stage: first.stage, normalized_exit: first.normalized_exit,
      safe_class: first.safe_class } : null,
    next_unresolved_stage: unresolved ? unresolved.stage : null,
  };
}

function settlement(install) {
  const deadline = timestamp(install?.timer?.deadline_at);
  const terminal = timestamp(install?.last_terminal?.timestamp);
  const childAt = timestamp(install?.child?.exited_at);
  const code = boundedExit(install?.child?.code);
  const signal = typeof install?.child?.signal === 'string' ? install.child.signal : null;
  const timerFired = timestamp(install?.timer?.fired_at) ? true
    : deadline && (terminal || childAt) ? false : null;
  const terminalBefore = deadline && terminal ? Date.parse(terminal) <= Date.parse(deadline)
    : deadline && timerFired === true ? false : null;
  const childBefore = deadline && childAt ? Date.parse(childAt) <= Date.parse(deadline)
    : deadline && timerFired === true ? false : null;
  return {
    terminal_before_deadline: terminalBefore,
    child_exit_before_deadline: childBefore,
    timer_fired: timerFired,
    pterm_exit: { normalized_exit: code, safe_class: signal ? 'signal' : code === 0 ? 'zero'
      : code !== null ? 'nonzero' : 'not_observed' },
  };
}

function createBootstrapEvidence(trace, request, install) {
  const reduced = reduceTrace(trace);
  return {
    schema: 1,
    binding: {
      request_id: request?.request_id ?? null,
      runner_ref: request?.runner_ref ?? null,
      run_id: request?.workflow?.run_id ?? null,
      run_attempt: request?.workflow?.run_attempt ?? null,
    },
    instrumentation: { kind: 'linux_ptrace_process_exit', historical_launcher_modified: false,
      installer_bytes_modified: false },
    ...reduced,
    settlement: settlement(install),
  };
}

function projectBootstrapEvidence(raw, binding) {
  const stages = {};
  for (const stage of STAGES) {
    const value = raw?.stages?.[stage] || {};
    const observed = value.observed === true;
    const code = observed ? boundedExit(value.normalized_exit) : null;
    stages[stage] = {
      observed,
      started_at: observed ? timestamp(value.started_at) : null,
      normalized_exit: code,
      safe_class: !observed ? 'not_observed' : code === null ? 'exit_not_observed' : safeClass(stage, code),
    };
  }
  const firstStage = STAGES.find(stage => stages[stage].observed
    && stages[stage].normalized_exit !== null && stages[stage].normalized_exit !== 0);
  const unresolvedStage = STAGES.find(stage => stages[stage].safe_class !== 'success');
  const pterm = raw?.settlement?.pterm_exit || {};
  return {
    schema: 1,
    binding,
    instrumentation: { kind: raw?.instrumentation?.kind === 'linux_ptrace_process_exit'
      ? 'linux_ptrace_process_exit' : null,
    historical_launcher_modified: bool(raw?.instrumentation?.historical_launcher_modified),
    installer_bytes_modified: bool(raw?.instrumentation?.installer_bytes_modified) },
    stages,
    first_failure: firstStage ? {
      stage: firstStage, normalized_exit: stages[firstStage].normalized_exit,
      safe_class: stages[firstStage].safe_class,
    } : null,
    next_unresolved_stage: unresolvedStage || null,
    settlement: {
      terminal_before_deadline: bool(raw?.settlement?.terminal_before_deadline),
      child_exit_before_deadline: bool(raw?.settlement?.child_exit_before_deadline),
      timer_fired: bool(raw?.settlement?.timer_fired),
      pterm_exit: { normalized_exit: boundedExit(pterm.normalized_exit),
        safe_class: SETTLEMENT_CLASSES.includes(pterm.safe_class) ? pterm.safe_class : 'not_observed' },
    },
  };
}

function writeBootstrapEvidence({ tracePath, requestPath, installPath, outputPath }) {
  let trace = '';
  try {
    trace = fs.readFileSync(tracePath, 'utf8');
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    let install = null;
    try { install = JSON.parse(fs.readFileSync(installPath, 'utf8')); } catch {}
    const raw = createBootstrapEvidence(trace, request, install);
    const projected = projectBootstrapEvidence(raw, raw.binding);
    fs.writeFileSync(outputPath, `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o600 });
    return projected;
  } finally {
    trace = '';
    try { fs.rmSync(tracePath, { force: true }); } catch {}
  }
}

module.exports = { STAGES, createBootstrapEvidence, projectBootstrapEvidence, reduceTrace,
  writeBootstrapEvidence };

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
  const tracePath = option('--trace');
  const requestPath = option('--request');
  const installPath = option('--install');
  const outputPath = option('--output');
  if (![tracePath, requestPath, installPath, outputPath].every(value => value && path.isAbsolute(value))) {
    throw new Error('absolute --trace, --request, --install, and --output paths are required');
  }
  writeBootstrapEvidence({ tracePath, requestPath, installPath, outputPath });
}
