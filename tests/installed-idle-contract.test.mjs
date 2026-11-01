import test from 'node:test';
import assert from 'node:assert/strict';
import { assess, EXPECTED } from './installed-idle-contract.mjs';

function complete() {
  return {
    pins: { ...EXPECTED },
    run: { cleanCompletion:true },
    isolation: Object.fromEntries(['freshUid','actualHome','uidScopedProcesses','noSecrets','noServiceRegistration','shellReady','actionBytes'].map(k => [k, true])),
    install: Object.fromEntries(['identity','shellSucceeded','noError','finalDisconnect','transportClosed','notRunning','filesValidated','manifestValidated','backendModePersisted'].map(k => [k, true])),
    start: Object.fromEntries(['identity','noError','readySentinel','runtimeHealthy','openTarget','controllerIdentity','runningReadback'].map(k => [k, true])),
    stop: Object.fromEntries(['identity','idlePreflight','controllerCompleted','runtimeDown','lockReleased','stopActionNoError','stopActionFinalDisconnect','stopActionTransportClosed','startFinalDisconnect','startTransportClosed','stoppedReadbacks','runtimeListenerAbsent'].map(k => [k, true])),
    cleanup: Object.fromEntries(['daemonStopped','uidProcessesAbsent','daemonListenerAbsent','runtimeListenerAbsent','noForcedTeardown'].map(k => [k, true])),
  };
}
test('all independently observed conditions required', () => {
  const full = complete();
  assert.deepEqual(assess(full), { status: 'PASS', missing: [] });
  for (const [group, entries] of Object.entries(full)) for (const key of Object.keys(entries)) {
    const candidate = structuredClone(full);
    delete candidate[group][key];
    assert.equal(assess(candidate).status, 'UNKNOWN', `${group}.${key}`);
  }
});
test('packet settlement alone cannot establish shell success or readiness', () => {
  const e = complete();
  e.install.shellSucceeded = false;
  e.start.readySentinel = false;
  assert.deepEqual(assess(e).missing, ['install.shellSucceeded', 'start.readySentinel']);
});
test('forced cleanup cannot qualify an otherwise healthy run', () => {
  const e = complete(); e.cleanup.noForcedTeardown = false;
  assert.equal(assess(e).status, 'UNKNOWN');
});
test('changed tuple fails closed', () => {
  const e = complete(); e.pins.app = 'main';
  assert.ok(assess(e).missing.includes('pin.app'));
});
