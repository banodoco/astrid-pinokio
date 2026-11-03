import assert from 'node:assert/strict';
export function createNativeObservation(script, safe = value => String(value).slice(-8192)) {
  const observation = { script, pterm_exit: null, installer_exit: null, engine_error: null,
    terminal: [], qualification_eligible: false };
  let rawTail = '';
  function packet(packet) {
    const raw = typeof packet.data?.raw === 'string' ? packet.data.raw : '';
    rawTail = safe(rawTail + raw);
    if (packet.type === 'error' || rawTail.includes('ASTRID_PINOKIO_FAILURE') || rawTail.includes('Terminated Shell')) {
      observation.engine_error ??= { type: packet.type,
        first_error: safe(typeof packet.data === 'string' ? packet.data : rawTail || 'engine error') };
    }
    if (packet.type === 'event' && ['stop', 'disconnect'].includes(packet.data)) observation.terminal.push(packet.data);
  }
  function validate() {
    if (observation.engine_error) throw new Error(observation.engine_error.first_error);
    assert.ok(observation.terminal.length, 'PTerm exit without an observed engine terminal event; installer exit remains unknown');
    assert.equal(observation.pterm_exit?.code, 0, 'PTerm exit is nonzero or unknown');
    return observation;
  }
  return { observation, packet, validate };
}
