import fs from 'node:fs';
import { assess, EXPECTED } from './installed-idle-contract.mjs';

// Construct a bounded allowlisted export; never pass through raw data/errors.
export function finalize(collector = {}, cleanup = {}) {
  const fields = {
    isolation:['freshUid','actualHome','uidScopedProcesses','noSecrets','noServiceRegistration','shellReady','actionBytes'],
    install:['identity','shellSucceeded','noError','finalDisconnect','transportClosed','notRunning','filesValidated','manifestValidated','backendModePersisted'],
    start:['identity','noError','readySentinel','runtimeHealthy','openTarget','controllerIdentity','runningReadback'],
    stop:['identity','idlePreflight','controllerCompleted','runtimeDown','lockReleased','stopActionNoError','stopActionFinalDisconnect','stopActionTransportClosed','startFinalDisconnect','startTransportClosed','stoppedReadbacks','runtimeListenerAbsent'],
    cleanup:['daemonStopped','uidProcessesAbsent','daemonListenerAbsent','runtimeListenerAbsent','noForcedTeardown'],
  };
  const safe = {schema:1,pins:{}};
  for (const [key,value] of Object.entries(EXPECTED)) if (collector.pins?.[key] === value) safe.pins[key] = value;
  for (const [group,names] of Object.entries(fields)) {
    safe[group] = {};
    for (const name of names) {
      let value = collector[group]?.[name] === true;
      if (['uidProcessesAbsent','daemonListenerAbsent','runtimeListenerAbsent'].includes(name) && group === 'cleanup') value = cleanup[name] === true;
      if (name === 'noForcedTeardown' && group === 'cleanup') value = value && cleanup.forcedTeardown === false && cleanup.accountRemoved === true;
      safe[group][name] = value;
    }
  }
  const phases = ['initial','daemon','shell','install','start','stop','daemon-shutdown','collector-finished'];
  safe.phase = phases.includes(collector.finishedPhase) ? collector.finishedPhase : (phases.includes(collector.phase) ? collector.phase : 'unavailable');
  const failures = ['deadline','http','node version','uid','root','home','passwd','environment','settings','reference root','reference custody','engine pins','engine changed','preexisting listener','archive','archive extract','tracked actions','launcher bytes','input HTTP','input bytes','native shell','daemon health','control identity','home state missing','app scripts missing','install settlement','install records','start engine','start ready','start evidence','stop settlement','stop readback','unclassified'];
  safe.failure = failures.includes(collector.failure) ? collector.failure : null;
  safe.packetObservations = {};
  const packetNames = ['observed','identity','error','failureMarker','finalDisconnect','stopEvent','transportClosed','shellReady','readySentinel','openTarget','daemonReady','stopResult','installSaveResult'];
  for (const action of ['install','start','stop']) {
    safe.packetObservations[action] = {};
    for (const name of packetNames) safe.packetObservations[action][name] = collector.packets?.[action]?.[name] === true;
  }
  safe.run = {cleanCompletion: collector.failure === null && collector.phase === 'collector-finished' && collector.finishedPhase === 'daemon-shutdown'};
  const verdict = assess(safe);
  return {...safe,...verdict};
}
if (process.argv[1]?.endsWith('installed-idle-finalize.mjs')) {
  const read = file => { try { const stat = fs.statSync(file); if (stat.size > 200000) return {}; return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return {}; } };
  const result = finalize(read(process.argv[2]),read(process.argv[3]));
  fs.writeFileSync(process.argv[4],JSON.stringify(result,null,2)+'\n');
  console.log(`installed idle diagnostic: ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
