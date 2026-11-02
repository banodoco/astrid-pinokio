'use strict';

// Minimal TLS static server for the already-built candidate App.  It is not a
// browser mock: the runner supplies the exact checkout's dist directory and
// Chrome reaches it at the product's real origin through a loopback-only map.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp',
});
const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
};
const rootArg = option('--root');
const key = option('--key');
const cert = option('--cert');
const ready = option('--ready');
if (!rootArg || !key || !cert || !ready || ![rootArg, key, cert, ready].every(path.isAbsolute)) {
  throw new Error('usage: r21-candidate-app-server.cjs --root <absolute-dist> --key <absolute-key> --cert <absolute-cert> --ready <absolute-json>');
}
const root = fs.realpathSync(rootArg);
if (!fs.statSync(root).isDirectory()) throw new Error('candidate App dist root is not a directory');

function targetFor(requestUrl) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestUrl || '/', 'https://astrid.haus').pathname); }
  catch { return null; }
  if (pathname.includes('\0')) return null;
  const candidate = path.resolve(root, `.${path.posix.normalize(`/${pathname}`)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  // Vite's client-side routes must receive the real generated entrypoint; a
  // missing asset remains a 404 instead of silently becoming index.html.
  return path.extname(pathname) ? null : path.join(root, 'index.html');
}

const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), minVersion: 'TLSv1.2' }, (request, response) => {
  if (!/^astrid\.haus(?::443)?$/i.test(request.headers.host || '')) {
    response.writeHead(421, { 'Cache-Control': 'no-store' }); response.end(); return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); response.end(); return;
  }
  const target = targetFor(request.url);
  if (!target || !fs.existsSync(target)) { response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(); return; }
  const extension = path.extname(target).toLowerCase();
  response.writeHead(200, {
    'Content-Type': MIME[extension] || 'application/octet-stream',
    'Cache-Control': path.basename(target) === 'build.json' ? 'no-store' : 'private, max-age=0',
    'Content-Length': fs.statSync(target).size,
  });
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(target).pipe(response);
});

const close = () => server.close(() => process.exit(0));
process.once('SIGTERM', close); process.once('SIGINT', close);
server.listen({ host: '127.0.0.1', port: 0 }, () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('candidate App server did not receive a TCP port');
  fs.writeFileSync(ready, `${JSON.stringify({ schema: 1, host: '127.0.0.1', port: address.port, origin: 'https://astrid.haus' })}\n`, { mode: 0o600 });
});
