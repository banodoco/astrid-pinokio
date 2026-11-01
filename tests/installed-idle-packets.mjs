// Packet observations contain no raw logs or paths. The caller retains the
// exact task URI privately and exports only these bounded predicates.
export function actionTracker(uri, kind) {
  const state = { observed: false, identity: true, error: false, failureMarker: false,
    finalDisconnect: false, stopEvent: false, transportClosed: false,
    shellReady: false, readySentinel: false, openTarget: false, daemonReady: false,
    stopResult: false, installSaveResult: false };
  let tail = '';
  let localSetIndex = null;
  function accept(packet) {
    if (packet?.id !== uri) { state.identity = false; return; }
    state.observed = true;
    if (packet.type === 'error') state.error = true;
    if (packet.type === 'event' && packet.data === 'stop') state.stopEvent = true;
    if (packet.type === 'disconnect') state.finalDisconnect = true;
    if (packet.type === 'start' && packet.data?.method === 'local.set') localSetIndex = packet.index ?? packet.data.current;
    if (packet.type === 'start' && packet.data?.title === 'Started' && packet.data?.description === 'All scripts finished running. Running in daemon mode...') state.daemonReady = true;
    if (packet.type === 'result' && kind === 'install' && packet.data?.mode === 'backend') state.installSaveResult = true;
    if (packet.type === 'result' && kind === 'stop' && packet.data?.stopped === true && packet.data?.lockFree === true) state.stopResult = true;
    if (packet.type === 'stream' && typeof packet.data?.raw === 'string') {
      const raw = packet.data.raw;
      tail = (tail + raw).slice(-8192);
      if (tail.includes('ASTRID_PINOKIO_FAILURE')) state.failureMarker = true;
      if (/(?:^|[\r\n])ASTRID_SHELL_READY(?:[\r\n]|$)/.test(tail)) state.shellReady = true;
      if (/(?:^|[\r\n])ASTRID_PINOKIO_READY(?:[\r\n]|$)/.test(tail)) state.readySentinel = true;
      // The pinned engine's local.set emits the serialized installed memory as
      // a stream at the index established by its preceding local.set start.
      // The socket server strips packet.rpc; the value never enters evidence.
      if (kind === 'start' && localSetIndex !== null && packet.index === localSetIndex) {
        try {
          const data = JSON.parse(raw);
          if (data.url === 'https://astrid.haus/?connect=1' && data.mode === 'backend') state.openTarget = true;
        } catch { /* non-JSON stream segments do not establish a target */ }
      }
    }
  }
  function result() { return { ...state, identity: state.identity && state.observed }; }
  return { accept, result, markTransportClosed() { state.transportClosed = true; } };
}
