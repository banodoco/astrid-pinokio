import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { EXPECTED } from './installed-idle-contract.mjs';
import { inspectInstalled, verifyInputBytes } from './installed-idle-inspection.mjs';
import { actionTracker } from './installed-idle-packets.mjs';
import { controllerSocketOwned, daemonHealthMatches, shellProbeMessage, protectedTree, cleanTrackedGitTree } from './installed-idle-proc.mjs';

// Runs only as the workflow-created, unprivileged OS account. Raw packets,
// daemon logs, control tokens, HTTP bodies and local paths never enter evidence.
const home = process.env.HOME;
const root = process.env.DIAG_ROOT;
const source = process.env.DIAG_SOURCE;
const refRoot = path.dirname(source);
const daemonRoot = path.join(refRoot, 'engines', 'pinokiod');
const ptermRoot = path.join(refRoot, 'engines', 'pterm');
const pinHome = path.join(home, 'pinokio');
const appId = 'astrid-installed-idle';
const appRoot = path.join(pinHome, 'api', appId);
const backend = path.join(appRoot, 'app', 'astrid');
const evidenceFile = path.join(root, 'collector.json');
const origin = 'http://127.0.0.1:42000';
const appRef = `pinokio://127.0.0.1:42000/api/${appId}`;
const facts = { schema: 1, status: 'UNKNOWN', failure: null, phase: 'initial', pins: {}, isolation: {}, install: {}, start: {}, stop: {}, cleanup: {}, packets: {} };
let daemon, daemonExited = false, startAction, stopProven = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = b => createHash('sha256').update(b).digest('hex');
const write = () => fs.writeFileSync(evidenceFile, JSON.stringify(facts, null, 2) + '\n', {mode:0o600});
const phase = value => { facts.phase = value; write(); };
function check(value, label) { if (!value) throw new Error(label); }
function git(dir, ...args) { return execFileSync('git', ['-c', `safe.directory=${dir}`, '-C', dir, ...args], { encoding:'utf8', timeout:30000, stdio:['ignore','pipe','ignore'] }).trim(); }
async function timed(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function poll(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await delay(250); }
  return false;
}
async function json(url, options = {}) {
  const headers = { ...(url.startsWith(origin) ? {'x-pinokio-client':'pterm'} : {}), ...(options.headers || {}) };
  const response = await fetch(url, {...options, headers, signal:AbortSignal.timeout(3000)});
  check(response.ok, 'http');
  return response.json();
}
async function control() {
  const [resource, app, homeStatus] = await Promise.all([
    json(`${origin}/pinokio/resource/status?ref=${encodeURIComponent(appRef)}`),
    json(`${origin}/apps/status/${encodeURIComponent(appId)}`), json(`${origin}/pinokio/home_status`),
  ]);
  check(resource.app_id === appId && app.app_id === appId && path.resolve(resource.path || '') === appRoot && path.resolve(app.path || '') === appRoot, 'control identity');
  return {resource, app, homeStatus};
}
function taskRunning(c, uri) {
  const scripts = c.homeStatus.running_scripts;
  check(Array.isArray(scripts) && Array.isArray(c.homeStatus.running_apps), 'home state missing');
  check(Array.isArray(c.resource.running_scripts) && Array.isArray(c.app.running_scripts), 'app scripts missing');
  return scripts.some(x => x?.id === uri) || [c.resource, c.app].some(s => s.running_scripts.some(x => typeof x === 'string' && path.resolve(appRoot, x) === uri));
}
function portOpen(port) {
  return new Promise(resolve => { const s = net.createConnection({host:'127.0.0.1',port}); s.setTimeout(600);
    s.once('connect', () => { s.destroy(); resolve(true); }); s.once('timeout', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(false)); });
}
function uidOf(pid) {
  const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const m = /^Uid:\s+(\d+)/m.exec(text); return m ? Number(m[1]) : -1;
}
function assertIsolated() {
  check(process.platform === 'linux' && process.getuid() > 1000, 'uid');
  check(/^\/tmp\/astrid-idle-[0-9]+-[0-9]+$/.test(root) && home === `${root}/home`, 'root');
  check(fs.realpathSync(home) === home && os.homedir() === home, 'home');
  const user = process.env.USER;
  check(/^astrid[0-9]+$/.test(user || ''), 'username');
  const record = fs.readFileSync('/etc/passwd','utf8').split('\n').map(line => line.split(':')).find(row => row[0] === user);
  check(record && Number(record[2]) === process.getuid() && record[5] === home, 'passwd');
  const allowed = new Set(['HOME','USER','LOGNAME','PATH','SHELL','LANG','PINOKIO_HOME','ASTRID_APP_REF','DIAG_ROOT','DIAG_SOURCE']);
  check(Object.keys(process.env).every(key => allowed.has(key)), 'environment');
  check(refRoot === root.replace('/tmp/astrid-idle-', '/tmp/astrid-idle-reference-') && source === path.join(refRoot,'repo'), 'reference root');
  check(process.env.ASTRID_APP_REF === EXPECTED.app && process.env.PINOKIO_HOME === pinHome, 'settings');
  facts.isolation = {freshUid:true, actualHome:true, uidScopedProcesses:true, noSecrets:true};
}
function extractLauncher() {
  fs.mkdirSync(appRoot, {recursive:true});
  const archive = spawnSync('git',['-c', `safe.directory=${source}`, '-C', source, 'archive', EXPECTED.launcher], {maxBuffer:64*1024*1024, timeout:30000});
  check(archive.status === 0, 'archive');
  const unpack = spawnSync('tar',['-x','-C',appRoot], {input:archive.stdout, timeout:30000, stdio:['pipe','ignore','ignore']});
  check(unpack.status === 0, 'archive extract');
  const files = git(source,'ls-tree','-r','--name-only',EXPECTED.launcher,'--','pinokio','pinokio.js').split('\n').filter(Boolean);
  check(files.includes('pinokio/install.js') && files.includes('pinokio/start.js') && files.includes('pinokio/stop.js'), 'tracked actions');
  for (const file of files) {
    const reference = execFileSync('git',['-c', `safe.directory=${source}`, '-C',source,'show',`${EXPECTED.launcher}:${file}`],{timeout:10000,stdio:['ignore','pipe','ignore']});
    check(digest(reference) === digest(fs.readFileSync(path.join(appRoot,file))), 'launcher bytes');
  }
  facts.pins.launcher = EXPECTED.launcher;
  facts.isolation.actionBytes = true;
}
async function inputProvenance() {
  const base = `https://raw.githubusercontent.com/banodoco/astrid-app/${EXPECTED.app}/public`;
  const fetchBytes = async name => { const response = await fetch(`${base}/${name}`, {signal:AbortSignal.timeout(15000)}); check(response.ok, 'input HTTP'); return Buffer.from(await response.arrayBuffer()); };
  const verified = verifyInputBytes(await fetchBytes('install'), await fetchBytes('install-manifest.json'));
  check(verified.bootstrapMatches && verified.manifestMatches && verified.tupleMatches, 'input bytes');
  facts.pins.app = EXPECTED.app; facts.pins.bootstrapSha256 = EXPECTED.bootstrapSha256; facts.pins.manifestSha256 = EXPECTED.manifestSha256;
}
async function action(uri, kind) {
  const mod = await import(path.join(ptermRoot,'rpc.js'));
  const RPC = mod.default || mod;
  const rpc = new RPC('ws://127.0.0.1:42000');
  const tracker = actionTracker(uri, kind);
  const done = rpc.run({uri, source:'pterm', client:{source:'pterm', venue:'installed-idle-diagnostic'}}, packet => {
    tracker.accept(packet);
    if (packet?.type === 'disconnect' && packet.id === uri) rpc.close();
  }).then(() => tracker.markTransportClosed());
  // Keep a rejection handled even when another phase is polling.
  done.catch(() => {});
  return {tracker, done, close:() => rpc.close()};
}
function successfulTerminal(t) {
  return t.identity && !t.error && !t.failureMarker && t.stopEvent && t.finalDisconnect && t.transportClosed;
}
async function waitTerminal(a, ms) { await timed(a.done,ms); return a.tracker.result(); }
async function runShellProbe() {
  const dir = path.join(pinHome,'api','astrid-shell-prerequisite'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'check.js'), `module.exports={run:[{method:'shell.run',params:{shell:'bash',message:${JSON.stringify(shellProbeMessage)},input:false}}]};\n`);
  const a = await action(path.join(dir,'check.js'),'shell');
  let t;
  try { t = await waitTerminal(a,60000); } finally { a.close(); }
  check(successfulTerminal(t) && t.shellReady, 'native shell');
  facts.isolation.shellReady = true;
}
async function startDaemon() {
  daemon = spawn(process.execPath,[path.join(daemonRoot,'script','index.js')],{cwd:daemonRoot,env:process.env,detached:true,stdio:'ignore'});
  daemon.on('error',() => {}); daemon.on('exit',() => { daemonExited = true; });
  check(await poll(async () => {
    const [version, homeInfo, health] = await Promise.all([json(`${origin}/pinokio/version`),json(`${origin}/pinokio/home`),json(`${origin}/check`)]);
    return daemonHealthMatches(version,homeInfo,health,pinHome);
  },60000), 'daemon health');
}
async function main() {
  assertIsolated();
  check(process.version === 'v20.19.4', 'node version');
  const refInfo = fs.lstatSync(refRoot);
  check(refInfo.isDirectory() && refInfo.uid === 0 && (refInfo.mode & 0o022) === 0 &&
    protectedTree(source) && protectedTree(ptermRoot) && protectedTree(daemonRoot,0,path.join(daemonRoot,'script','pinokio.json'),process.getuid()), 'reference custody');
  check(git(daemonRoot,'rev-parse','HEAD') === EXPECTED.daemon && git(ptermRoot,'rev-parse','HEAD') === EXPECTED.pterm &&
    cleanTrackedGitTree(daemonRoot,EXPECTED.daemon) && cleanTrackedGitTree(ptermRoot,EXPECTED.pterm), 'engine pins');
  facts.pins.daemon = EXPECTED.daemon; facts.pins.pterm = EXPECTED.pterm;
  check(!await portOpen(42000) && !await portOpen(17340), 'preexisting listener');
  extractLauncher(); await inputProvenance();
  phase('daemon'); await startDaemon();
  phase('shell'); await runShellProbe();
  phase('install');
  const installUri = path.join(appRoot,'pinokio','install.js');
  const install = await action(installUri,'install');
  let it;
  try { it = await waitTerminal(install,25*60*1000); } finally { facts.packets.install = install.tracker.result(); install.close(); }
  facts.packets.install = it;
  check(successfulTerminal(it) && it.installSaveResult, 'install settlement');
  const ic = await control();
  const installed = await inspectInstalled(appRoot);
  facts.install = {identity:it.identity, shellSucceeded:it.installSaveResult && !it.failureMarker,
    noError:!it.error && !it.failureMarker, finalDisconnect:it.finalDisconnect, transportClosed:it.transportClosed,
    notRunning:!taskRunning(ic,installUri), ...installed};
  facts.isolation.noServiceRegistration = !fs.existsSync(path.join(home,'.config/systemd/user/astrid.service'));
  check(Object.values(facts.install).every(x => x === true) && facts.isolation.noServiceRegistration, 'install records');
  facts.pins.agent = EXPECTED.agent; facts.pins.runtime = EXPECTED.runtime;
  phase('start');
  const startUri = path.join(appRoot,'pinokio','start.js');
  startAction = await action(startUri,'start');
  check(await poll(async () => {
    const s = startAction.tracker.result();
    check(!s.error && !s.failureMarker && s.identity, 'start engine');
    return s.readySentinel && s.openTarget && s.daemonReady;
  },190000), 'start ready');
  const sc = await control();
  const health = await json('http://127.0.0.1:17340/api/runtime/v1/health',{headers:{Origin:'https://astrid.haus'}});
  const session = await import(path.join(appRoot,'pinokio','session.mjs'));
  const runtimeHealthy = await session.backendSessionReady({root:backend,editor:path.join(appRoot,'app','editor'),doorHealth:health});
  const controller = JSON.parse(fs.readFileSync(path.join(backend,'pinokio-control.json'),'utf8'));
  const controllerIdentity = controller.schema === 1 && Number.isInteger(controller.pid) && uidOf(controller.pid) === process.getuid() &&
    Number.isInteger(controller.port) && controller.port > 0 && controller.port <= 65535 && /^[a-f0-9]{64}$/.test(controller.token) && controllerSocketOwned(controller.pid,controller.port) && await portOpen(controller.port);
  const st = startAction.tracker.result();
  facts.start = {identity:st.identity,noError:!st.error && !st.failureMarker,readySentinel:st.readySentinel,
    runtimeHealthy,openTarget:st.openTarget,controllerIdentity,runningReadback:taskRunning(sc,startUri)};
  check(Object.values(facts.start).every(x => x === true), 'start evidence');
  phase('stop');
  // The unmodified Stop action performs preflight and authenticated controller
  // shutdown before reporting {stopped:true,lockFree:true}; no direct RPC stop.
  const stop = await action(path.join(appRoot,'pinokio','stop.js'),'stop');
  let sto, startFinal;
  try { [sto,startFinal] = await Promise.all([waitTerminal(stop,120000),waitTerminal(startAction,120000)]); }
  finally { stop.close(); startAction.close(); }
  facts.packets.stop = sto; facts.packets.start = startFinal;
  check(successfulTerminal(sto) && sto.stopResult && startFinal.identity && !startFinal.error && !startFinal.failureMarker && startFinal.finalDisconnect && startFinal.transportClosed, 'stop settlement');
  const lifecycle = await import(path.join(appRoot,'pinokio','lifecycle.mjs'));
  await lifecycle.waitForInstallerLock(backend,{appDirectory:appRoot});
  const stopped = await control();
  const runtimeListenerAbsent = !await portOpen(17340);
  facts.stop = {identity:sto.identity,idlePreflight:sto.stopResult,controllerCompleted:sto.stopResult,
    runtimeDown:sto.stopResult && runtimeListenerAbsent && !fs.existsSync(path.join(backend,'pinokio-control.json')),
    lockReleased:true, stopActionNoError:!sto.error && !sto.failureMarker, stopActionFinalDisconnect:sto.finalDisconnect,
    stopActionTransportClosed:sto.transportClosed, startFinalDisconnect:startFinal.finalDisconnect,startTransportClosed:startFinal.transportClosed,
    stoppedReadbacks:!taskRunning(stopped,startUri) && !taskRunning(stopped,path.join(appRoot,'pinokio','stop.js')) && stopped.resource.running === false && stopped.app.running === false && !stopped.homeStatus.running_apps.includes(appId),runtimeListenerAbsent};
  check(Object.values(facts.stop).every(x => x === true), 'stop readback');
  check(cleanTrackedGitTree(daemonRoot,EXPECTED.daemon,'script/pinokio.json') && cleanTrackedGitTree(ptermRoot,EXPECTED.pterm), 'engine changed');
  stopProven = true;
  phase('daemon-shutdown');
}
try { await main(); }
catch (error) { facts.failure = ['deadline','http','node version','uid','root','home','passwd','environment','settings','reference root','reference custody','engine pins','engine changed','preexisting listener','archive','archive extract','tracked actions','launcher bytes','input HTTP','input bytes','native shell','daemon health','control identity','home state missing','app scripts missing','install settlement','install records','start engine','start ready','start evidence','stop settlement','stop readback'].includes(error.message) ? error.message : 'unclassified'; }
finally {
  if (startAction) { facts.packets.start ||= startAction.tracker.result(); startAction.close(); }
  if (daemon?.pid && !daemonExited) { try { process.kill(-daemon.pid,'SIGTERM'); } catch {} }
  facts.cleanup.daemonStopped = Boolean(daemon?.pid) && await poll(() => daemonExited,8000);
  facts.cleanup.noForcedTeardown = stopProven;
  facts.finishedPhase = facts.phase;
  facts.phase = 'collector-finished';
  write();
}
