// Invoked by the diagnostic venue while its own pinokiod process is alive.
// This is a checkpoint, not an R-30 export or qualification receipt.
import fs from 'node:fs/promises';
import { captureActionSources, captureProcess } from '../pinokio/providers/linux-observations.mjs';

const [pidText, launcher, output] = process.argv.slice(2);
if (!/^\d+$/.test(pidText || '') || !launcher || !output) throw new Error('expected PID, launcher directory and output');
const processRecord = await captureProcess(Number(pidText));
const sourceRecord = await captureActionSources(launcher);
const serializable = {
  kind: 'r24-diagnostic-checkpoint', version: 1,
  process: { ...processRecord, raw: Object.fromEntries(Object.entries(processRecord.raw).map(([key, value]) => [key, value.toString('base64')])) },
  actionSources: { ...sourceRecord, files: sourceRecord.files.map(({ bytes, ...file }) => ({ ...file, bytesBase64: bytes.toString('base64') })) },
};
await fs.writeFile(output, JSON.stringify(serializable), { flag: 'wx', mode: 0o600 });
