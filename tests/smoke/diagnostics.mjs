import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 64 * 1024;

function redact(text) {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/\b(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|[A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|AUTHORIZATION)[A-Z0-9_]*)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[REDACTED]');
}

export function writeSmokeFailureCapture({ directory, logPath, step, code, signal }) {
  fs.mkdirSync(directory, { recursive: true });
  let source = '';
  let logBytes = 0;
  let capturedSha256 = null;
  if (fs.existsSync(logPath)) {
    const descriptor = fs.openSync(logPath, 'r');
    try {
      logBytes = fs.fstatSync(descriptor).size;
      const length = Math.min(logBytes, MAX_LOG_BYTES);
      const bytes = Buffer.alloc(length);
      fs.readSync(descriptor, bytes, 0, length, logBytes - length);
      capturedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      source = bytes.toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  }

  const redacted = Buffer.from(redact(source));
  const capturedLog = redacted.subarray(Math.max(0, redacted.length - MAX_LOG_BYTES)).toString('utf8');
  fs.writeFileSync(path.join(directory, 'install.log'), capturedLog);
  fs.writeFileSync(path.join(directory, 'failure.json'), `${JSON.stringify({
    step,
    innerExit: { code, signal: signal || null },
    installLog: {
      present: logBytes > 0,
      originalBytes: logBytes,
      capturedBytes: Buffer.byteLength(capturedLog),
      truncatedToLastBytes: logBytes > MAX_LOG_BYTES ? MAX_LOG_BYTES : null,
      capturedSha256BeforeRedaction: capturedSha256,
      redacted: true,
    },
  }, null, 2)}\n`);
}
