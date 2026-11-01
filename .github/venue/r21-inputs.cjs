'use strict';

const fs = require('node:fs');
const { validateDispatch } = require('./r21-verify.cjs');

const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error('usage: node r21-inputs.cjs --output <request.json>');
}
const request = validateDispatch({
  request_id: process.env.R21_REQUEST_ID,
  confirmation: process.env.R21_CONFIRMATION,
  runner_ref: process.env.R21_RUNNER_REF,
});
fs.writeFileSync(process.argv[outputIndex + 1], `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
