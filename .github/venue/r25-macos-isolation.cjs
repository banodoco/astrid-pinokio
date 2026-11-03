'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

async function hostedRunIdentity(env = process.env, platform = process.platform) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const user = execFileSync('id', ['-un'], { encoding: 'utf8', timeout: 5000 }).trim();
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('hosted-run-api-token-unavailable');
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=latest&per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`hosted-run-job-api-failed:${response.status}`);
  const jobs = await response.json();
  const matches = (jobs.jobs || []).filter(job => job.runner_name === env.RUNNER_NAME
    && /backend-start-diagnostic/.test(job.name || '') && job.status === 'in_progress');
  if (matches.length !== 1) throw new Error('hosted-run-job-identity-ambiguous');
  const job = matches[0];
  const identity = {
    schema: 'astrid.r25.hosted-run-identity.v1',
    repository: env.GITHUB_REPOSITORY || null,
    run_id: env.GITHUB_RUN_ID || null,
    run_attempt: env.GITHUB_RUN_ATTEMPT || null,
    workflow: env.GITHUB_WORKFLOW || null,
    workflow_ref: env.GITHUB_WORKFLOW_REF || null,
    workflow_sha: env.GITHUB_WORKFLOW_SHA || null,
    head_sha: env.GITHUB_SHA || null,
    job: env.GITHUB_JOB || null,
    job_id: job.id,
    job_name: job.name,
    job_status: job.status,
    job_started_at: job.started_at,
    runner_name: env.RUNNER_NAME || null,
    runner_id: job.runner_id,
    runner_arch: env.RUNNER_ARCH || null,
    runner_os: env.RUNNER_OS || null,
    hostname: os.hostname(),
    platform,
    uid,
    user,
    home: env.HOME || os.homedir(),
    pinokio_home: env.PINOKIO_HOME || null,
    isolated_user_home: env.R25_ISOLATED_USER_HOME || null,
    runner_temp: env.RUNNER_TEMP || null,
  };
  if (!identity.repository || !identity.run_id || !identity.run_attempt || !identity.job
    || !identity.runner_name || !identity.runner_arch || !identity.runner_os
    || !Number.isSafeInteger(uid) || uid < 1 || !identity.pinokio_home || !identity.isolated_user_home || !identity.runner_temp) {
    throw new Error('hosted-run-identity-incomplete');
  }
  return identity;
}

function captureServiceDefinition(userHome, { uid, session, label = 'haus.astrid.runtime', plutil = 'plutil' } = {}) {
  if (!Number.isSafeInteger(uid) || uid < 1 || session !== `gui/${uid}` || !userHome || !path.isAbsolute(userHome)) {
    throw new Error('launchd-service-context-invalid');
  }
  const plistPath = path.join(userHome, 'Library', 'LaunchAgents', `${label}.plist`);
  const bytes = fs.readFileSync(plistPath);
  const plist = JSON.parse(execFileSync(plutil, ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000,
  }));
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments
    : typeof plist.Program === 'string' ? [plist.Program] : null;
  const program = typeof plist.Program === 'string' ? plist.Program : args?.[0];
  if (plist.Label !== label || !program || !path.isAbsolute(program) || !args?.length || args[0] !== program) {
    throw new Error('launchd-service-definition-incomplete-or-mismatched');
  }
  return {
    schema: 'astrid.r25.launchd-service-definition.v1',
    label,
    program,
    arguments: args,
    user: plist.UserName || { uid },
    session,
    plist_path: plistPath,
    plist_sha256: sha256(bytes),
  };
}

function launchdRow(census, target) {
  const rows = census?.launchd;
  if (!Array.isArray(rows)) return null;
  const matching = rows.filter(row => row?.target === target);
  return matching.length === 1 ? matching[0] : null;
}

function ownerPid(rawPrint) {
  const matches = [...String(rawPrint || '').matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gm)];
  if (matches.length !== 1) return null;
  const pid = Number(matches[0][1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function validateStopOwner({ census, target, definition, uid }) {
  if (!definition?.plist_sha256 || !definition?.program || !Array.isArray(definition.arguments)) {
    return { allowed: false, reason: 'service-definition-unavailable', owner_pid: null };
  }
  const row = launchdRow(census, target);
  if (!row) return { allowed: false, reason: 'launchd-census-target-ambiguous', owner_pid: null };
  if (row.state === 'absent') {
    const matching = (census.processes || []).filter(item => item?.executable_path === definition.program && item.collection_state === 'present');
    return matching.length === 0
      ? { allowed: false, reason: 'no-live-owner', owner_pid: null, no_owner_verified: true }
      : { allowed: false, reason: 'service-absent-but-program-live', owner_pid: null };
  }
  if (row.state !== 'present') return { allowed: false, reason: 'launchd-service-state-unknown', owner_pid: null };
  const pid = ownerPid(row.raw_print);
  const processes = (census.processes || []).filter(item => item?.pid === pid);
  if (!pid || processes.length !== 1) return { allowed: false, reason: 'launchd-owner-not-in-fresh-process-census', owner_pid: pid };
  const process = processes[0];
  if (process.executable_path !== definition.program || process.collection_state !== 'present'
    || process.command_line !== definition.arguments.join(' ')) {
    return { allowed: false, reason: 'launchd-owner-identity-mismatch', owner_pid: pid };
  }
  return { allowed: true, reason: null, owner_pid: pid, owner_identity: process };
}

function verifyStopped({ census, target, definition, ownerPid: expectedPid = null }) {
  const row = launchdRow(census, target);
  const ownerProcess = expectedPid ? (census?.processes || []).filter(item => item?.pid === expectedPid) : [];
  return { verified: row?.state === 'absent' && ownerProcess.length === 0,
    launchd_state: row?.state || 'unknown', validated_owner_pid: expectedPid, owner_process_after_stop: ownerProcess,
    service_definition_sha256: definition?.plist_sha256 || null };
}

module.exports = { hostedRunIdentity, captureServiceDefinition, ownerPid, validateStopOwner, verifyStopped };
