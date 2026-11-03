const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const script = path.join(root, '.github', 'venue', 'r25-provision-macos-conda.sh');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'r25-snapshot-journey.yml'), 'utf8');

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r25-conda-provision-'));
  const mocks = path.join(temp, 'mocks');
  fs.mkdirSync(mocks);
  fs.writeFileSync(path.join(mocks, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac\n');
  fs.writeFileSync(path.join(mocks, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; : > "$1"; fi; shift; done\n');
  fs.writeFileSync(path.join(mocks, 'bash'), '#!/bin/sh\nshift\nshift\nshift\nprefix="$1"\nmkdir -p "$prefix/bin"\ncat > "$prefix/bin/conda" <<\'CONDASH\'\n#!/bin/sh\nprintf "%s\\n" "$*" >> "$CONDA_TEST_LOG"\ncase "$1" in shell.bash) echo hook ;; --version) echo conda 26.5.3 ;; esac\nCONDASH\nchmod +x "$prefix/bin/conda"\n');
  for (const name of ['uname', 'curl', 'bash']) fs.chmodSync(path.join(mocks, name), 0o755);
  return { temp, mocks, home: path.join(temp, 'pinokio-home'), log: path.join(temp, 'commands.log') };
}

test('macOS preprovisioning seeds only the runner-owned Pinokio prefix with the pinned engine package set', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.temp, { recursive: true, force: true }));
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: f.home, CONDA_TEST_LOG: f.log },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const calls = fs.readFileSync(f.log, 'utf8');
  assert.match(calls, /^clean -y --all$/m);
  assert.match(calls, /^install -y --prefix .*\/pinokio-home\/bin\/miniforge --override-channels -c conda-forge conda=26\.5\.3 python=3\.10\.20 conda-libmamba-solver>=25\.4\.0$/m);
  assert.match(calls, /^shell\.bash hook$/m);
  assert.match(calls, /^--version$/m);
  assert.ok(fs.existsSync(path.join(f.home, 'bin', 'miniforge', 'bin', 'conda')));
});

test('provisioning refuses an existing home and an unbound home path before download', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.temp, { recursive: true, force: true }));
  fs.mkdirSync(f.home);
  fs.writeFileSync(path.join(f.home, 'preserve-me'), 'existing');
  const existing = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: f.home, CONDA_TEST_LOG: f.log },
  });
  assert.equal(existing.status, 66);
  assert.equal(fs.readFileSync(path.join(f.home, 'preserve-me'), 'utf8'), 'existing');
  assert.equal(fs.existsSync(f.log), false);

  const escaped = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: path.join(f.temp, 'elsewhere'), CONDA_TEST_LOG: f.log },
  });
  assert.equal(escaped.status, 64);
  assert.equal(fs.existsSync(f.log), false);
});

test('R-25 invokes the preprovisioner before starting the real daemon action', () => {
  assert.match(workflow, /PINOKIO_HOME:\s*\$\{\{ runner\.temp \}\}\/pinokio-home/);
  assert.match(workflow, /bash \.github\/venue\/r25-provision-macos-conda\.sh[\s\S]*?node \.github\/venue\/r25-snapshot-runner\.cjs/);
});
