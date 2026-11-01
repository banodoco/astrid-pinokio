import test from 'node:test';
import assert from 'node:assert/strict';
import { finalize } from './installed-idle-finalize.mjs';
import { EXPECTED } from './installed-idle-contract.mjs';
test('missing collector or cleanup is UNKNOWN and exports no untrusted text', () => {
  const result = finalize({phase:'secret-value', raw:'token=private', pins:{app:'main'}},{uidProcessesAbsent:true});
  assert.equal(result.status,'UNKNOWN'); assert.equal(result.phase,'unavailable');
  assert.equal(JSON.stringify(result).includes('private'),false);
  assert.equal(JSON.stringify(result).includes('main'),false);
});
test('cleanup requires explicit absence and a removed account', () => {
  const result = finalize({cleanup:{noForcedTeardown:true,daemonStopped:true}}, {uidProcessesAbsent:true,daemonListenerAbsent:true,runtimeListenerAbsent:true,forcedTeardown:false});
  assert.equal(result.cleanup.noForcedTeardown,false);
});

test('complete observations survive finalization and can pass', () => {
  const keys = {
    isolation:['freshUid','actualHome','uidScopedProcesses','noSecrets','noServiceRegistration','shellReady','actionBytes'],
    install:['identity','shellSucceeded','noError','finalDisconnect','transportClosed','notRunning','filesValidated','manifestValidated','backendModePersisted'],
    start:['identity','noError','readySentinel','runtimeHealthy','openTarget','controllerIdentity','runningReadback'],
    stop:['identity','idlePreflight','controllerCompleted','runtimeDown','lockReleased','stopActionNoError','stopActionFinalDisconnect','stopActionTransportClosed','startFinalDisconnect','startTransportClosed','stoppedReadbacks','runtimeListenerAbsent'],
    cleanup:['daemonStopped','noForcedTeardown'],
  };
  const collector = {pins:{...EXPECTED},failure:null,phase:'collector-finished',finishedPhase:'daemon-shutdown'};
  for (const [group,names] of Object.entries(keys)) collector[group] = Object.fromEntries(names.map(name => [name,true]));
  const cleanup = {uidProcessesAbsent:true,daemonListenerAbsent:true,runtimeListenerAbsent:true,forcedTeardown:false,accountRemoved:true};
  assert.equal(finalize(collector,cleanup).status,'PASS');
  collector.failure = 'unclassified';
  assert.equal(finalize(collector,cleanup).status,'UNKNOWN');
  collector.failure = null;
  collector.finishedPhase = 'stop';
  assert.equal(finalize(collector,cleanup).status,'UNKNOWN');
  collector.finishedPhase = 'daemon-shutdown';
  cleanup.forcedTeardown = true;
  assert.equal(finalize(collector,cleanup).status,'UNKNOWN');
});
