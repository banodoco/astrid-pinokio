// Fail-closed acceptance contract for the isolated hosted diagnostic.
// This module interprets observations; it never starts or stops any process.
export const EXPECTED = Object.freeze({
  app: 'ad43f06092e1cb7c4155bbb1a9138c847dd4b7ed',
  agent: 'b05ac03a5bcab278bccf99d85b49f4037b5dec10',
  runtime: 'f75517d86011140e737782f3f75206408ddc1cf9',
  launcher: 'c5b42701641889ecb916c60cde09a717f83d62ff',
  daemon: 'add4a674ad1ba95bb62ec427fce519fe5bf0e9bf',
  pterm: '5be43718701c448b43daf0ce51d8935f170065bb',
  bootstrapSha256: '100bab1deb15d620abd910c8fb0c9a6d77f4945428a3229dac6b506705e3fd0d',
  manifestSha256: 'ce9f4944f2e8c844a3246d0e1bf85c830839653d48935f4c734c3198f1e93dd7',
});

// Every fact is separately observed by its producing subsystem. In particular,
// an RPC packet, final disconnect, or prefilled identifier is not shell success.
export function assess(e = {}) {
  const missing = [];
  const requireTrue = (name, value) => { if (value !== true) missing.push(name); };
  for (const [name, expected] of Object.entries(EXPECTED)) {
    if (e.pins?.[name] !== expected) missing.push(`pin.${name}`);
  }
  requireTrue('run.cleanCompletion', e.run?.cleanCompletion);
  for (const name of ['freshUid', 'actualHome', 'uidScopedProcesses', 'noSecrets', 'noServiceRegistration', 'shellReady', 'actionBytes'])
    requireTrue(`isolation.${name}`, e.isolation?.[name]);
  for (const name of ['identity', 'shellSucceeded', 'noError', 'finalDisconnect', 'transportClosed', 'notRunning', 'filesValidated', 'manifestValidated', 'backendModePersisted'])
    requireTrue(`install.${name}`, e.install?.[name]);
  for (const name of ['identity', 'noError', 'readySentinel', 'runtimeHealthy', 'openTarget', 'controllerIdentity', 'runningReadback'])
    requireTrue(`start.${name}`, e.start?.[name]);
  for (const name of ['identity', 'idlePreflight', 'controllerCompleted', 'runtimeDown', 'lockReleased', 'stopActionNoError', 'stopActionFinalDisconnect', 'stopActionTransportClosed', 'startFinalDisconnect', 'startTransportClosed', 'stoppedReadbacks', 'runtimeListenerAbsent'])
    requireTrue(`stop.${name}`, e.stop?.[name]);
  for (const name of ['daemonStopped', 'uidProcessesAbsent', 'daemonListenerAbsent', 'runtimeListenerAbsent', 'noForcedTeardown'])
    requireTrue(`cleanup.${name}`, e.cleanup?.[name]);
  return { status: missing.length ? 'UNKNOWN' : 'PASS', missing };
}
