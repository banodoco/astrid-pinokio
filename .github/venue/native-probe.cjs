'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const root = process.env.RUNNER_TEMP;
const out = path.join(root, 'r20-evidence', 'native-launch.json');
const home = path.join(root, 'r20-native-home');
fs.mkdirSync(home, { recursive: true });
const daemon = spawn(process.execPath, [path.join(root, 'pinokiod/script/index.js')], {
  cwd: path.join(root, 'pinokiod'), stdio: 'ignore',
  env: { ...process.env, PINOKIO_HOME: home, PINOKIO_HTTPS_ACTIVE: '0', PINOKIO_NETWORK_ACTIVE: '0' },
});
let done = false;
let exit;
daemon.on('error', error => finish(false, `spawn: ${error.code || 'error'}`));
daemon.on('exit', (code, signal) => { exit = { code, signal }; if (!done) finish(false, 'daemon exited before readiness'); });
const started = Date.now();
function finish(ready, reason) {
  if (done) return;
  done = true;
  clearInterval(poll);
  fs.writeFileSync(out, JSON.stringify({ ready, reason, elapsed_ms: Date.now() - started, exit: exit || null, note: 'No Astrid action was run.' }, null, 2) + '\n');
  daemon.kill();
  if (!ready) process.exitCode = 1;
}
const poll = setInterval(() => {
  if (Date.now() - started > 90000) return finish(false, 'readiness timeout');
  const req = http.get('http://127.0.0.1:42000/pinokio/version', res => { res.resume(); if (res.statusCode === 200) finish(true, 'version endpoint reachable'); });
  req.on('error', () => {});
  req.setTimeout(1000, () => req.destroy());
}, 1000);
