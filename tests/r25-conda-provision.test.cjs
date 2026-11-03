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
  return { temp, mocks, home: path.join(temp, 'pinokio-home'), log: path.join(temp, 'commands.log'),
    diagnostics: path.join(temp, 'diagnostics') };
}

test('macOS preprovisioning seeds only the runner-owned Pinokio prefix with the pinned engine package set', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.temp, { recursive: true, force: true }));
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: f.home,
      R25_CROSS_OS_DIAGNOSTIC: '1', R25_DIAGNOSTICS: f.diagnostics, NODE_BINARY: process.execPath, CONDA_TEST_LOG: f.log },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const calls = fs.readFileSync(f.log, 'utf8');
  assert.match(calls, /^clean -y --all$/m);
  assert.match(calls, /^install -y --prefix .*\/pinokio-home\/bin\/miniforge --override-channels -c conda-forge conda=26\.5\.3 python=3\.10\.20 conda-libmamba-solver>=25\.4\.0$/m);
  assert.match(calls, /^shell\.bash hook$/m);
  assert.match(calls, /^--version$/m);
  assert.ok(fs.existsSync(path.join(f.home, 'bin', 'miniforge', 'bin', 'conda')));
  const presence = JSON.parse(fs.readFileSync(path.join(f.diagnostics, 'pre-shell-conda-presence.json'), 'utf8'));
  assert.deepEqual(presence, {
    schema: 'astrid.r25.macos-conda-presence.v1', miniforge_root_exists: true,
    conda_path_exists: true, conda_executable: true, conda_directory_on_path: false,
    observed_before: 'pinokio-setup-shell.run',
  });
});

test('canonicalizes a symlinked runner temp before provisioning its exact child', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.temp, { recursive: true, force: true }));
  const realTemp = path.join(f.temp, 'real-temp');
  const tempAlias = path.join(f.temp, 'temp-alias');
  fs.mkdirSync(realTemp);
  fs.symlinkSync(realTemp, tempAlias, 'dir');
  const home = path.join(tempAlias, 'pinokio-home');
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: tempAlias, PINOKIO_HOME: home,
      R25_CROSS_OS_DIAGNOSTIC: '1', R25_DIAGNOSTICS: f.diagnostics, NODE_BINARY: process.execPath, CONDA_TEST_LOG: f.log },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(fs.existsSync(path.join(realTemp, 'pinokio-home', 'bin', 'miniforge', 'bin', 'conda')));
});

test('provisioning refuses an existing home and an unbound home path before download', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.temp, { recursive: true, force: true }));
  fs.mkdirSync(f.home);
  fs.writeFileSync(path.join(f.home, 'preserve-me'), 'existing');
  const existing = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: f.home,
      R25_CROSS_OS_DIAGNOSTIC: '1', R25_DIAGNOSTICS: f.diagnostics, NODE_BINARY: process.execPath, CONDA_TEST_LOG: f.log },
  });
  assert.equal(existing.status, 66);
  assert.equal(fs.readFileSync(path.join(f.home, 'preserve-me'), 'utf8'), 'existing');
  assert.equal(fs.existsSync(f.log), false);

  const escaped = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.mocks}:/usr/bin:/bin`, RUNNER_TEMP: f.temp, PINOKIO_HOME: path.join(f.temp, 'elsewhere'),
      R25_CROSS_OS_DIAGNOSTIC: '1', R25_DIAGNOSTICS: f.diagnostics, NODE_BINARY: process.execPath, CONDA_TEST_LOG: f.log },
  });
  assert.equal(escaped.status, 64);
  assert.equal(fs.existsSync(f.log), false);
});

test('R-25 invokes the preprovisioner before starting the real daemon action', () => {
  assert.match(workflow, /PINOKIO_HOME:\s*\$\{\{ runner\.temp \}\}\/pinokio-home/);
  assert.match(workflow, /bash \.github\/venue\/r25-provision-macos-conda\.sh[\s\S]*?node \.github\/venue\/r25-snapshot-runner\.cjs/);
});

test('push-triggered workflow_call keeps its requested backend slot', () => {
  const route = fs.readFileSync(path.join(root, '.github', 'workflows', 'r25-mac-conda-route.yml'), 'utf8');
  assert.match(route, /on:\s*push:[\s\S]*?lane\/M-PIN\/R-PIN-MAC-ROUTE-FIX[\s\S]*?uses: \.\/\.github\/workflows\/r25-snapshot-journey\.yml[\s\S]*?slot_id: pinokio-backend-macos/);
  assert.match(workflow, /SLOT_ID:\s*\$\{\{ inputs\.slot_id \|\| 'pinokio-fully-local-macos' \}\}/);
  assert.match(workflow, /R25_SLOT_ID:\s*\$\{\{ inputs\.slot_id \|\| 'pinokio-fully-local-macos' \}\}/);
  assert.match(workflow, /name: R-25 macOS \(\$\{\{ inputs\.slot_id \|\| 'pinokio-fully-local-macos' \}\}\) \/ macos-six-action/);
  assert.doesNotMatch(workflow, /github\.event_name\s*==\s*'push'[\s\S]{0,100}pinokio-fully-local-macos/);
});
