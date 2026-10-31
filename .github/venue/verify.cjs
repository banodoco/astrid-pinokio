'use strict';
module.exports = function verify(packets, running) {
  if (packets.some(p => p.type === 'error')) throw new Error('daemon reported action error');
  const results = packets.filter(p => p.type === 'result');
  if (!results.some(p => p.index === 0 && p.total === 2 && p.data?.stopped === false && p.data?.lockFree === true) ||
      !results.some(p => p.index === 1 && p.total === 2 && p.data?.reset === true && p.data?.dataKept === true)) throw new Error('missing Reset step results');
  if (!packets.some(p => p.type === 'event' && p.data === 'stop') || !packets.some(p => p.type === 'disconnect')) throw new Error('missing normal completion event');
  if (running !== false) throw new Error('action remains running or status is indeterminate');
};
