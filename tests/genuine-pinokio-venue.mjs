import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const PINOKIO_PORT = 42000;
const EXPECTED_PINOKIO_COMMIT = process.env.PINOKIO_COMMIT || process.env.GITHUB_SHA || 'c5b42701641889ecb916c60cde09a717f83d62ff';
const EXPECTED_BASE_COMMIT = process.env.PINOKIO_BASE_COMMIT || 'c5b42701641889ecb916c60cde09a717f83d62ff';
const EXPECTED_PINOKIOD_REF = process.env.PINOKIOD_REF || 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf';
const EXPECTED_PTERM_REF = process.env.PTERM_REF || '5be43718701c448b43daf0ce51d8935f170065bb';
const candidateRoot = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const pinokiodRoot = path.resolve(process.env.PINOKIOD_ROOT || path.join(os.tmpdir(), 'pinokiod'));
const ptermRoot = path.resolve(process.env.PTERM_ROOT || path.join(os.tmpdir(), 'pterm'));
const pinokioHome = path.resolve(process.env.PINOKIO_HOME || path.join(os.tmpdir(), 'pinokio-home'));
const evidenceDir = path.resolve(process.env.VENUE_EVIDENCE_DIR || path.join(os.tmpdir(), 'pinokio-venue-evidence'));
const appId = 'astrid-pinokio-venue-candidate';
const baseUrl = `http://127.0.0.1:${PINOKIO_PORT}`;
const selectedAppRoot = path.join(pinokioHome, 'api', appId);
const selectedStart = path.join(selectedAppRoot, 'pinokio', 'start.js');
const selectedRef = `pinokio://127.0.0.1:${PINOKIO_PORT}/api/${appId}`;
const actionFiles = ['pinokio/start.js', 'pinokio/stop.js', 'pinokio/update.js'];
const daemonLog = path.join(evidenceDir, 'pinokiod.log');
const daemonPidFile = path.join(evidenceDir, 'pinokiod.pid');
const actionPacketFile = path.join(evidenceDir, 'engine-packets.jsonl');

fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(path.dirname(pinokioHome), { recursive: true });

const evidence = {
  status: 'UNKNOWN',
  immutable: {
    candidate_commit_expected: EXPECTED_PINOKIO_COMMIT,
    candidate_commit_observed: null,
    pinokiod_ref: EXPECTED_PINOKIOD_REF,
    pterm_ref: EXPECTED_PTERM_REF,
    actions: {},
  },
  venue: {
    platform: process.platform,
    node: process.version,
    pinokio_home: pinokioHome,
    port: PINOKIO_PORT,
    selected_app_id: appId,
    selected_ref: selectedRef,
    selected_root: null,
  },
  daemon: { pid: null, version: null, home: null, health: null },
  engine: { task_id: null, packets: [], settlement: 'not-attempted', boundary: null },
  independent: { process: null, listener: null, post_readback: null },
};

function writeEvidence() {
  fs.writeFileSync(path.join(evidenceDir, 'venue-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function fail(message) {
  evidence.status = 'UNKNOWN';
  evidence.engine.boundary ||= message;
  writeEvidence();
  throw new Error(message);
}

function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  for (const [needle, replacement] of [
    [candidateRoot, '$GITHUB_WORKSPACE'],
    [pinokiodRoot, '$PINOKIOD_ROOT'],
    [ptermRoot, '$PTERM_ROOT'],
    [pinokioHome, '$PINOKIO_HOME'],
    [selectedAppRoot, '$SELECTED_APP_ROOT'],
  ]) text = text.split(needle).join(replacement);
  return text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(args, options = {}) {
  return execFileSync('git', ['-C', candidateRoot, ...args], { encoding: 'utf8', ...options }).trim();
}

function fileDescriptor(relative) {
  const sourcePath = path.join(candidateRoot, relative);
  const sourceBytes = fs.readFileSync(sourcePath);
  const refBytes = execFileSync('git', ['-C', candidateRoot, 'cat-file', 'blob', `${EXPECTED_PINOKIO_COMMIT}:${relative}`]);
  const blob = git(['rev-parse', `${EXPECTED_PINOKIO_COMMIT}:${relative}`]);
  const selectedPath = path.join(selectedAppRoot, relative);
  const descriptor = {
    relative,
    source_sha256: sha256(sourceBytes),
    ref_sha256: sha256(refBytes),
    git_blob: blob,
    selected_sha256: null,
    selected_ref_match: sourceBytes.equals(refBytes),
    deployed_match: false,
  };
  evidence.immutable.actions[relative] = descriptor;
  if (!descriptor.selected_ref_match) fail(`candidate worktree bytes differ from immutable ref for ${relative}`);
  return { sourcePath, selectedPath, descriptor };
}

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, { headers: { 'x-pinokio-client': 'm4-6-genuine-venue' } });
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: redact(body) }; }
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}: ${redact(parsed)}`);
  return parsed;
}

async function waitForDaemon() {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const version = await getJson('/pinokio/version');
      const home = await getJson('/pinokio/home');
      const health = await getJson('/check');
      evidence.daemon.version = version;
      evidence.daemon.home = home;
      evidence.daemon.health = health;
      const expectedHome = fs.realpathSync(pinokioHome);
      if (path.resolve(home.path || '') !== path.resolve(expectedHome)) fail(`daemon home readback was not isolated: ${redact(home)}`);
      if (!version.pinokiod) fail('daemon version response did not report pinokiod');
      return;
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`real pinokiod did not become healthy: ${redact(lastError)}`);
}

function copyCandidateApp() {
  fs.rmSync(selectedAppRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(selectedAppRoot), { recursive: true });
  fs.cpSync(candidateRoot, selectedAppRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(candidateRoot, source);
      return relative !== '.git' && !relative.startsWith(`.git${path.sep}`) &&
        relative !== 'node_modules' && !relative.startsWith(`node_modules${path.sep}`);
    },
  });
}

async function registerAndReadBack() {
  const resource = await getJson(`/pinokio/resource/status?ref=${encodeURIComponent(selectedRef)}`);
  const status = await getJson(`/apps/status/${encodeURIComponent(appId)}`);
  evidence.venue.selected_root = resource.path || status.path || null;
  evidence.venue.resource_readback = resource;
  evidence.venue.app_readback = status;
  if (resource.app_id !== appId || status.app_id !== appId) fail(`control-plane identity readback mismatch: ${redact({ resource, status })}`);
  if (path.resolve(resource.path || '') !== path.resolve(selectedAppRoot)) fail(`resource root readback mismatch: ${redact(resource)}`);
  if (path.resolve(status.path || '') !== path.resolve(selectedAppRoot)) fail(`app root readback mismatch: ${redact(status)}`);
}

function verifyDeployedActionBytes() {
  for (const relative of actionFiles) {
    const descriptor = evidence.immutable.actions[relative];
    const deployedBytes = fs.readFileSync(path.join(selectedAppRoot, relative));
    descriptor.selected_sha256 = sha256(deployedBytes);
    descriptor.deployed_match = descriptor.selected_sha256 === descriptor.ref_sha256;
    if (!descriptor.deployed_match) fail(`deployed action bytes differ from immutable ref for ${relative}`);
  }
}

function independentObservation() {
  const pid = evidence.daemon.pid;
  try {
    evidence.independent.process = redact(execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' }));
  } catch (error) { evidence.independent.process = `ps unavailable: ${redact(error.message)}`; }
  try {
    evidence.independent.listener = redact(execFileSync('ss', ['-ltnp', `sport = :${PINOKIO_PORT}`], { encoding: 'utf8' }));
  } catch (error) { evidence.independent.listener = `ss unavailable: ${redact(error.message)}`; }
}

async function invokeThroughPterm() {
  const rpcModule = await import(path.join(ptermRoot, 'rpc.js'));
  const RPC = rpcModule.default || rpcModule;
  const rpc = new RPC(`ws://127.0.0.1:${PINOKIO_PORT}`);
  const packets = [];
  fs.writeFileSync(actionPacketFile, '');
  const request = {
    uri: selectedStart,
    source: 'pterm',
    client: { source: 'pterm', venue: 'm4-6-genuine-pinokio-venue' },
  };
  evidence.engine.task_id = selectedStart;
  await new Promise((resolve) => {
    let finished = false;
    let stopRequested = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      evidence.engine.settlement = 'unknown-timeout';
      evidence.engine.boundary = 'engine did not emit a terminal packet within 15 seconds';
      rpc.close();
      resolve();
    }, 15_000);
    const finish = (settlement, boundary) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      evidence.engine.settlement = settlement;
      evidence.engine.boundary = boundary || null;
      rpc.close();
      resolve();
    };
    rpc.run(request, (packet) => {
      const safePacket = { type: packet?.type || null, id: packet?.id || null, data: redact(packet?.data) };
      packets.push(safePacket);
      fs.appendFileSync(actionPacketFile, `${JSON.stringify(safePacket)}\n`);
      if (packet?.id && !evidence.engine.task_id) evidence.engine.task_id = packet.id;
      if (packet?.type === 'error') {
        const text = String(packet.data || '');
        const refusal = /fully installed|choose reset|not installed|refus/i.test(text);
        finish(refusal ? 'explicit-refusal' : 'engine-error', refusal ? redact(text) : redact(text));
      } else if (packet?.type === 'start' && !stopRequested) {
        stopRequested = true;
        rpc.stop({ uri: selectedStart });
      } else if (packet?.type === 'disconnect' || (packet?.type === 'event' && packet.data === 'stop')) {
        finish('terminal-stop', null);
      }
    });
  });
  evidence.engine.packets = packets;
  if (!['explicit-refusal', 'terminal-stop'].includes(evidence.engine.settlement)) {
    fail(`real engine task did not settle: ${evidence.engine.settlement}`);
  }
}

async function main() {
  evidence.immutable.candidate_commit_observed = git(['rev-parse', 'HEAD']);
  if (evidence.immutable.candidate_commit_observed !== EXPECTED_PINOKIO_COMMIT) fail('workflow checkout is not the expected clean Pinokio candidate');
  try {
    execFileSync('git', ['-C', candidateRoot, 'merge-base', '--is-ancestor', EXPECTED_BASE_COMMIT, 'HEAD'], { stdio: 'ignore' });
  } catch {
    fail('workflow checkout is not based on the clean Pinokio candidate');
  }
  if (git(['status', '--porcelain'])) fail('workflow checkout is dirty before venue probe');

  for (const relative of actionFiles) fileDescriptor(relative);
  copyCandidateApp();
  verifyDeployedActionBytes();
  writeEvidence();

  const daemon = spawn('npm', ['start'], {
    cwd: pinokiodRoot,
    env: { ...process.env, HOME: process.env.HOME || os.homedir(), PINOKIO_HOME: pinokioHome },
    stdio: ['ignore', fs.openSync(daemonLog, 'w'), fs.openSync(daemonLog, 'a')],
  });
  evidence.daemon.pid = daemon.pid;
  fs.writeFileSync(daemonPidFile, `${daemon.pid}\n`);
  daemon.once('exit', (code, signal) => {
    if (!evidence.daemon.health) evidence.daemon.exit = { code, signal };
  });
  try {
    await waitForDaemon();
    await registerAndReadBack();
    verifyDeployedActionBytes();
    writeEvidence();
    await invokeThroughPterm();
    evidence.independent.post_readback = {
      home_status: await getJson('/pinokio/home_status'),
      resource_status: await getJson(`/pinokio/resource/status?ref=${encodeURIComponent(selectedRef)}`),
    };
    independentObservation();
    evidence.status = evidence.engine.settlement === 'explicit-refusal' ? 'UNKNOWN' : 'PASS';
    writeEvidence();
    console.log(JSON.stringify({ status: evidence.status, task_id: evidence.engine.task_id, settlement: evidence.engine.settlement }));
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((resolve) => daemon.once('exit', resolve));
    }
    independentObservation();
    writeEvidence();
  }
}

main().catch((error) => {
  console.error(`genuine Pinokio venue: ${redact(error.stack || error.message)}`);
  process.exitCode = 1;
});
