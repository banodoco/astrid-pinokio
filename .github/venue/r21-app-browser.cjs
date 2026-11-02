'use strict';

// Observe the served candidate App itself—not an observer-authored HTTP
// imitation—connecting to the candidate Runtime. Chrome is driven through its
// native DevTools pipe so the venue needs no mutable browser package install.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const exactStrings = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
  && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);

function validateCandidateAppInteraction(observed, { appRuntime, appSha, expectedRuntimeInstanceId, expectedRealmId }) {
  if (observed?.page?.origin !== appRuntime.origin || observed.page.build_status !== 200
      || observed.page.build_app !== appSha || observed.page.build_release !== 1) {
    throw new Error('served candidate App identity was not observed in the browser');
  }
  const health = observed.requests?.health;
  if (health?.initiated_by_app !== true || health.status !== 200 || health.body?.status !== 'ok'
      || health.body?.protocol !== appRuntime.protocol || health.body?.schema_digest !== appRuntime.schema_digest
      || health.body?.runtime_instance_id !== expectedRuntimeInstanceId) {
    throw new Error('served candidate App did not observe this Runtime health identity');
  }
  const realm = observed.requests?.realm;
  if (realm?.initiated_by_app !== true || realm.status !== 200 || realm.body?.realm_id !== expectedRealmId) {
    throw new Error('served candidate App did not observe this Runtime realm');
  }
  const handshake = observed.requests?.handshake;
  const request = handshake?.request;
  const response = handshake?.body;
  const forbidden = ['owner', 'astrid-pack-host', 'admin', 'worker'];
  if (handshake?.initiated_by_app !== true || handshake.status !== 200
      || request?.protocol !== appRuntime.protocol || request?.client_name !== appRuntime.client_name
      || request?.client_version !== appRuntime.client_version
      || !exactStrings(request?.requested_scopes, appRuntime.requested_scopes)
      || response?.protocol !== appRuntime.protocol || response?.schema_digest !== appRuntime.schema_digest
      || response?.realm_id !== expectedRealmId || typeof response?.session_id !== 'string' || !response.session_id
      || typeof response?.actor_id !== 'string' || !response.actor_id || forbidden.includes(response.actor_id)
      || !exactStrings(response?.scopes, appRuntime.requested_scopes)
      || !Array.isArray(response?.capabilities) || !response.capabilities.includes(appRuntime.capability)) {
    throw new Error('served candidate App did not complete its Runtime handshake');
  }
  return {
    app: appSha,
    origin: appRuntime.origin,
    app_release: 1,
    health: true,
    realm: true,
    handshake: true,
    runtime_instance_digest: sha256(expectedRuntimeInstanceId),
    realm_digest: sha256(expectedRealmId),
  };
}

function createCdp(child) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (!input || !output) throw new Error('Chrome DevTools pipe was not created');
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const rejectPending = error => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.once('error', () => rejectPending(new Error('candidate App browser could not start')));
  child.once('close', () => rejectPending(new Error('candidate App browser closed')));
  output.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const boundary = buffer.indexOf(0);
      if (boundary === -1) break;
      const frame = buffer.subarray(0, boundary).toString('utf8');
      buffer = buffer.subarray(boundary + 1);
      if (!frame) continue;
      let message;
      try { message = JSON.parse(frame); }
      catch { rejectPending(new Error('candidate App browser emitted malformed DevTools data')); continue; }
      if (Number.isInteger(message.id) && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id);
        if (message.error) entry.reject(new Error(`candidate App browser command failed: ${entry.method}`));
        else entry.resolve(message.result || {});
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });
  return {
    command(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('candidate App browser is closed'));
      const id = ++sequence;
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        input.write(`${JSON.stringify(payload)}\0`, error => {
          if (error && pending.delete(id)) reject(new Error('candidate App browser command write failed'));
        });
      });
    },
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

const withTimeout = (promise, timeoutMs, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

function initiatedByApp(initiator, origin) {
  const stacks = [];
  for (let stack = initiator?.stack; stack; stack = stack.parent) stacks.push(...(stack.callFrames || []));
  return initiator?.type === 'script' && stacks.some(frame => typeof frame.url === 'string' && frame.url.startsWith(`${origin}/`));
}

async function observeCandidateAppInteraction({
  spawn, chromePath, profileDir, appRuntime, appSha, expectedRuntimeInstanceId, expectedRealmId,
  timeoutMs = 45000,
}) {
  if (typeof chromePath !== 'string' || !path.isAbsolute(chromePath) || !fs.existsSync(chromePath)) {
    throw new Error('candidate App browser executable is unavailable');
  }
  await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-pipe', `--user-data-dir=${profileDir}`, 'about:blank',
  ], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const cdp = createCdp(child);
  try {
    await withTimeout(cdp.command('Browser.getVersion'), timeoutMs, 'candidate App browser startup');
    // Chrome exposes the Local Network Access family through the DevTools
    // PermissionType enum, while setPermission's web PermissionDescriptor does
    // not accept those names. The enum-typed command is therefore required.
    await cdp.command('Browser.grantPermissions', {
      permissions: ['localNetworkAccess', 'localNetwork', 'loopbackNetwork'], origin: appRuntime.origin,
    });
    const { targetId } = await cdp.command('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.command('Target.attachToTarget', { targetId, flatten: true });
    const session = attached.sessionId;
    await Promise.all([
      cdp.command('Page.enable', {}, session),
      cdp.command('Runtime.enable', {}, session),
      cdp.command('Network.enable', {}, session),
    ]);

    const requested = new Map();
    const observations = {};
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const complete = () => {
      if (observations.health?.body && observations.realm?.body && observations.handshake?.body) readyResolve();
    };
    const unlisten = cdp.listen(message => {
      if (message.sessionId !== session) return;
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params?.request;
        let url;
        try { url = new URL(request?.url); } catch { return; }
        if (url.origin !== 'http://127.0.0.1:17340' || !url.pathname.startsWith('/api/runtime/v1/')) return;
        const route = url.pathname.split('/').at(-1);
        if (!['health', 'realm', 'handshake'].includes(route)) return;
        let body = null;
        try { body = request.postData ? JSON.parse(request.postData) : null; } catch {}
        requested.set(message.params.requestId, {
          route, request: body, initiated_by_app: initiatedByApp(message.params.initiator, appRuntime.origin),
        });
      }
      if (message.method === 'Network.responseReceived') {
        const fact = requested.get(message.params?.requestId);
        if (!fact || message.params?.response?.status !== 200) return;
        void cdp.command('Network.getResponseBody', { requestId: message.params.requestId }, session).then(result => {
          let body;
          try { body = JSON.parse(result.body); } catch { return; }
          observations[fact.route] = { ...fact, status: message.params.response.status, body };
          complete();
        }).catch(() => {});
      }
    });
    try {
      const loaded = new Promise(resolve => {
        const stop = cdp.listen(message => {
          if (message.sessionId === session && message.method === 'Page.loadEventFired') { stop(); resolve(); }
        });
      });
      await cdp.command('Page.navigate', { url: `${appRuntime.origin}/?connect=1&r21-proof=1` }, session);
      await withTimeout(loaded, timeoutMs, 'served candidate App navigation');
      const evaluated = await withTimeout(cdp.command('Runtime.evaluate', {
        expression: `(async()=>{const r=await fetch('/build.json',{cache:'no-store'});const b=await r.json();return {origin:location.origin,build_status:r.status,build_app:b.app,build_release:b.release};})()`,
        awaitPromise: true, returnByValue: true,
      }, session), timeoutMs, 'served candidate App identity');
      if (evaluated.exceptionDetails || !evaluated.result?.value) throw new Error('served candidate App identity could not be read');
      await withTimeout(ready, timeoutMs, 'served candidate App Runtime interaction');
      return validateCandidateAppInteraction({ page: evaluated.result.value, requests: observations }, {
        appRuntime, appSha, expectedRuntimeInstanceId, expectedRealmId,
      });
    } finally { unlisten(); }
  } finally {
    try { await cdp.command('Browser.close'); } catch {}
    if (!child.killed) { try { child.kill('SIGTERM'); } catch {} }
    await Promise.race([
      new Promise(resolve => child.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }
}

module.exports = { observeCandidateAppInteraction, validateCandidateAppInteraction };
