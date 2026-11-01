import test from 'node:test';
import assert from 'node:assert/strict';
import { actionTracker } from './installed-idle-packets.mjs';
const id = '/app/pinokio/start.js';
test('binds final disconnect, sentinel and local-set observation to exact task', () => {
  const t = actionTracker(id, 'start');
  t.accept({id,type:'start',data:{method:'local.set',current:2}});
  t.accept({id,type:'stream',index:2,data:{raw:'{"url":"https://astrid.haus/?connect=1","mode":"backend"}'}});
  t.accept({id,type:'stream',data:{raw:'\r\nASTRID_PINOKIO_READY\r\n'}});
  t.accept({id,type:'disconnect'}); t.markTransportClosed();
  assert.equal(t.result().openTarget, true); assert.equal(t.result().readySentinel, true);
  assert.equal(t.result().finalDisconnect, true); assert.equal(t.result().transportClosed, true);
});
test('wrong identity cannot establish success, even if subsequent packets match', () => {
  const t = actionTracker(id, 'stop');
  t.accept({id:'/other',type:'result',data:{stopped:true,lockFree:true}});
  t.accept({id,type:'disconnect'});
  assert.equal(t.result().identity, false); assert.equal(t.result().stopResult, false);
});
test('command echo is not a readiness sentinel, split real marker is accepted', () => {
  const t = actionTracker(id, 'shell');
  t.accept({id,type:'stream',data:{raw:"printf 'ASTRID_SHELL_%s\\n' READY\r\n"}});
  assert.equal(t.result().shellReady, false);
  t.accept({id,type:'stream',data:{raw:'ASTRID_SHELL_'}});
  t.accept({id,type:'stream',data:{raw:'READY\r\n'}});
  assert.equal(t.result().shellReady, true);
});
test('failure markers, engine errors and no final packet remain visible', () => {
  const t = actionTracker(id, 'install');
  t.accept({id,type:'stream',data:{raw:'ASTRID_PINOKIO_FAILURE'}});
  t.accept({id,type:'error'}); t.markTransportClosed();
  assert.equal(t.result().error, true); assert.equal(t.result().failureMarker, true);
  assert.equal(t.result().finalDisconnect, false);
});
