#!/usr/bin/env node
// Read-only diagnostic. A computed launch specification is not an exec or settlement observation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pin = '3a6a98ae251ca126505245286e2d3e760f4348e9';
const output = {
  diagnostic: 'm46-u2-read-only-v1', uid: process.getuid?.() ?? null,
  source_ref: pin, selected_app: null, descriptor_hashes: null,
  runtime_spec_computed: null, runtime_argv_observed: null,
  request_id: null, inner_exit: null, terminal_status: 'unknown',
  independent_selection: false, complete_helper_closure: false,
  protected_observation: false, first_failed_predicate: null,
};
function fail(message) { output.first_failed_predicate = message; console.log(JSON.stringify(output, null, 2)); process.exitCode = 2; }
function git(...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function main() {
  if (process.platform !== 'linux' || output.uid === null || output.uid === 0) return fail('real non-root Linux principal required');
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) return fail('absolute disposable installed app path required');
  try {
    if (git('rev-parse', `${pin}^{commit}`) !== pin || git('diff', '--name-only', pin, '--', 'pinokio') || git('ls-files', '--others', '--exclude-standard', '--', 'pinokio')) return fail('resolver source differs from published pin');
    const selected = fs.realpathSync(process.argv[2]);
    if (selected !== path.resolve(process.argv[2])) return fail('installed app path must be canonical');
    output.selected_app = selected;
    const descriptors = {};
    for (const name of ['start', 'stop', 'update', 'uninstall']) {
      const rel = `pinokio/${name}.js`;
      const file = path.join(selected, rel);
      if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) return fail(`descriptor not canonical regular file: ${rel}`);
      const installed = fs.readFileSync(file);
      const expected = execFileSync('git', ['-C', root, 'show', `${pin}:${rel}`]);
      descriptors[name] = { path: file, sha256: hash(installed), matches_published_source: hash(installed) === hash(expected) };
      if (!descriptors[name].matches_published_source) { output.descriptor_hashes = descriptors; return fail(`installed descriptor differs: ${rel}`); }
    }
    output.descriptor_hashes = descriptors;
    const mode = JSON.parse(fs.readFileSync(path.join(selected, 'app', 'install-mode.json'), 'utf8'));
    if (mode.schema_version !== 1 || !['backend', 'local'].includes(mode.mode)) return fail('valid installed mode required');
    const runtimeRoot = path.join(selected, 'app', 'astrid');
    const editorRoot = path.join(selected, 'app', 'editor');
    const session = await import(pathToFileURL(path.join(root, 'pinokio', 'session.mjs')).href);
    const installed = session.installation(runtimeRoot, { appDirectory: selected });
    const runtime = session.commands(runtimeRoot, editorRoot, mode.mode, installed).runtime;
    output.runtime_spec_computed = { persisted_mode: mode.mode, command: runtime.command, args: runtime.args, cwd: runtimeRoot };
    return fail('independent selected-app mapping, complete installed closure and request-bound child exec/exit observation unavailable');
  } catch (error) { return fail(`resolution unavailable: ${error.code || error.message}`); }
}
await main();
