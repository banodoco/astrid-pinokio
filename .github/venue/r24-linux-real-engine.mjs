#!/usr/bin/env node
// Native venue entry point. It runs pinned PTerm once and writes a deliberately
// small diagnostic projection. The protected M4 rows remain not-run.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runNativeResetDiagnostic } from '../../pinokio/providers/linux-native-evidence-harness.mjs';

const require = createRequire(import.meta.url);
const root = process.env.RUNNER_TEMP;
const out = path.join(root, 'r20-evidence');
const venueHome = path.join(root, 'r20-home');
const ptermRoot = path.join(root, 'pterm');
const pinokioDirectory = path.join(venueHome, 'api', 'astrid', 'pinokio');
const uri = process.env.R20_ACTION_URI || path.join(pinokioDirectory, 'reset.js');
const ref = 'pinokio://127.0.0.1:42000/api/astrid';

function runPterm() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ptermRoot, 'index.js'), 'start', 'pinokio/reset.js', '--ref', ref],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`pterm exit ${code} signal ${signal}`)));
  });
}

function projection(result) {
  return {
    kind: result.kind,
    state: result.state,
    qualification: result.qualification,
    dispatched: result.dispatched,
    issues: result.issues || result.settlement?.issues || [],
    settlement: result.settlement,
    custody: result.custody,
    fullyLocalRestoration: result.fullyLocalRestoration,
    fault: result.fault,
    journeys: result.journeys,
    externalAwait: result.externalAwait,
    note: 'Diagnostic output only; it is not an authenticated custody, settlement, readiness, restoration, or M4 claim.',
  };
}

async function main() {
  if (!root || !Number.isSafeInteger(Number(process.env.R20_DAEMON_PID))) {
    throw new Error('RUNNER_TEMP and R20_DAEMON_PID are required');
  }
  const { WebSocket } = require(path.join(ptermRoot, 'node_modules', 'unws'));
  const result = await runNativeResetDiagnostic({
    WebSocket,
    endpoint: 'ws://127.0.0.1:42000',
    uri,
    daemonPid: Number(process.env.R20_DAEMON_PID),
    pinokioDirectory,
    startAction: runPterm,
  });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'r24-native-diagnostic.json'), JSON.stringify(projection(result), null, 2) + '\n');
  // The diagnostic must not upgrade a missing terminal/idle observation into
  // success. A bad native Reset is an infrastructure failure, never an M4 pass.
  // These four issues are deliberately permanent until protected bindings are
  // supplied; every other observation defect fails this bounded venue run.
  const expectedUnknowns = new Set([
    'engine-execution-id-unavailable', 'subscription-and-source-continuity-unverified',
    'profile-and-provenance-unbound', 'installer-journal-and-readiness-unobserved',
  ]);
  if (!result.dispatched || result.settlement?.issues?.some((issue) => !expectedUnknowns.has(issue))) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'r24-native-diagnostic.json'), JSON.stringify({
    state: 'unknown', qualification: 'closed', dispatched: false,
    issues: ['native-diagnostic-failed'],
    error: error instanceof Error ? error.message : 'unknown-error',
    note: 'Diagnostic output only; it is not an M4 claim.',
  }, null, 2) + '\n');
  process.exitCode = 1;
});
