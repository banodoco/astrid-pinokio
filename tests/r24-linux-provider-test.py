#!/usr/bin/env python3
"""Local synthetic repositories and protocol fixtures; no live evidence."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'pinokio/providers/r24-linux.py'
spec = importlib.util.spec_from_file_location('r24', SOURCE)
r24 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r24)


def cmd(root, *argv):
    return subprocess.check_output(['git', '-C', str(root), *argv], stderr=subprocess.DEVNULL).decode().strip()


def repo(path, files):
    path.mkdir()
    subprocess.run(['git', 'init', '-q', str(path)], check=True)
    cmd(path, 'config', 'user.email', 'fixture@example.invalid')
    cmd(path, 'config', 'user.name', 'Fixture')
    for name, contents in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
    cmd(path, 'add', '.')
    cmd(path, 'commit', '-qm', 'synthetic fixture')
    return cmd(path, 'rev-parse', 'HEAD')


class InstalledContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'pinokio-home'
        self.backend = self.home / 'api/astrid/app/astrid'
        self.version = self.backend / 'versions/release-1'
        self.version.mkdir(parents=True)
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.backend / 'install.json').write_text(json.dumps({
            'owner': 'haus.astrid.runtime', 'managed_by': 'pinokio',
            'data_root': str(self.data)}))
        (self.backend / 'current').write_text('release-1\n')
        self.profile = self.version / 'profile.json'
        self.profile.write_text('{}')
        self.manifest = json.dumps({
            'release': 1,
            'tools': {'python': {'version': '3.11.13'}},
        }).encode()
        (self.version / 'manifest.json').write_bytes(self.manifest)
        self.lifecycle = self.home / 'api/astrid/pinokio/lifecycle.mjs'
        self.lifecycle.parent.mkdir(parents=True)
        self.lifecycle.write_bytes(b'fixture lifecycle')
        self.bootstrap = self.root / 'xdg/astrid/bootstrap/python'
        self.bootstrap.mkdir(parents=True)
        self.binding = {'lifecycle_sha256': r24.sha(self.lifecycle.read_bytes())}

    def write_record(self, python, **updates):
        record = {'root': str(self.version), 'python': str(python),
                  'profile': str(self.profile), 'env': {},
                  'identity': {'release': 1, 'managed_by': 'pinokio'}}
        record.update(updates)
        (self.version / 'version.json').write_text(json.dumps(record))

    def installed(self):
        with patch.object(r24, 'BINDING', self.binding):
            return r24.installed_context(
                self.home, self.lifecycle, self.manifest, self.bootstrap)

    def test_genuine_pinned_bootstrap_symlink_is_accepted_lexically(self):
        target = (self.bootstrap / 'cpython-3.11.13-linux-x86_64-gnu'
                  / 'bin/python3.11')
        target.parent.mkdir(parents=True)
        target.write_bytes(b'pinned python')
        python = self.version / 'py/bin/python'
        python.parent.mkdir(parents=True)
        try:
            python.symlink_to(target)
        except OSError as exc:
            self.skipTest(f'symlinks unavailable: {exc}')
        self.write_record(python)
        installed = self.installed()
        self.assertEqual(installed['python'], python)
        self.assertEqual(installed['python_target'], target)
        self.assertEqual(installed['python_sha256'], r24.sha(target.read_bytes()))

    def test_normal_in_version_interpreter_is_accepted(self):
        python = self.version / 'py/bin/python'
        python.parent.mkdir(parents=True)
        python.write_bytes(b'venv python')
        self.write_record(python)
        installed = self.installed()
        self.assertEqual(installed['python'], python)
        self.assertEqual(installed['python_target'], python)

    def test_lexical_and_target_escapes_are_rejected(self):
        pinned = (self.bootstrap / 'cpython-3.11.13-linux-x86_64-gnu'
                  / 'bin/python3.11')
        pinned.parent.mkdir(parents=True)
        pinned.write_bytes(b'pinned python')
        self.write_record(pinned)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

        external = self.root / 'external/python'
        external.parent.mkdir()
        external.write_bytes(b'external')
        python = self.version / 'py/bin/python'
        python.parent.mkdir(parents=True)
        python.symlink_to(external)
        self.write_record(python)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

    def test_parent_symlink_and_forged_bootstrap_shape_are_rejected(self):
        real_py = self.version / 'real-py/bin'
        real_py.mkdir(parents=True)
        (real_py / 'python').write_bytes(b'in-version')
        (self.version / 'py').symlink_to(self.version / 'real-py')
        python = self.version / 'py/bin/python'
        self.write_record(python)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

        (self.version / 'py').unlink()
        shutil.rmtree(self.version / 'real-py')
        python.parent.mkdir(parents=True)
        wrong = self.bootstrap / 'cpython-3.11.12-linux-x86_64-gnu/bin/python3.11'
        wrong.parent.mkdir(parents=True)
        wrong.write_bytes(b'wrong pin')
        python.symlink_to(wrong)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

        python.unlink()
        malformed = self.bootstrap / 'cpython-3.11.13-forged/bin/python3.11'
        malformed.parent.mkdir(parents=True)
        malformed.write_bytes(b'forged shape')
        python.symlink_to(malformed)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

        python.unlink()
        external = self.root / 'two-hop-external'
        external.write_bytes(b'external')
        pinned = (self.bootstrap / 'cpython-3.11.13-linux-x86_64-gnu'
                  / 'bin/python3.11')
        pinned.parent.mkdir(parents=True, exist_ok=True)
        pinned.symlink_to(external)
        python.symlink_to(pinned)
        with self.assertRaisesRegex(ValueError, 'installed path mismatch'):
            self.installed()

    def test_installer_python_root_comes_from_canonical_engine_environment(self):
        engine_home = self.root / 'engine-home'
        user_home = engine_home / 'user-home'
        data_home = engine_home / 'xdg-data'
        bootstrap = data_home / 'astrid/bootstrap/python'
        user_home.mkdir(parents=True)
        bootstrap.mkdir(parents=True)
        environment = {b'HOME': os.fsencode(user_home),
                       b'XDG_DATA_HOME': os.fsencode(data_home)}
        self.assertEqual(r24.installer_python_root(environment, engine_home), bootstrap)
        linked = engine_home / 'linked-xdg'
        linked.symlink_to(data_home, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'invalid installer data home'):
            r24.installer_python_root({b'HOME': os.fsencode(user_home),
                                       b'XDG_DATA_HOME': os.fsencode(linked)}, engine_home)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        paths = {name: root / name for name in ('app', 'agent', 'runtime', 'pinokio')}
        refs = {}
        execution_source = b'fixture execution source'
        for name in ('agent', 'runtime'):
            refs[name] = repo(paths[name], {'file': execution_source})
        stop = b'synthetic stop fixture'
        lifecycle = b'synthetic lifecycle fixture'
        refs['pinokio'] = repo(paths['pinokio'], {'pinokio/stop.js': stop, 'pinokio/lifecycle.mjs': lifecycle})
        manifest = json.dumps({'release': 1, 'agent': {'sha': refs['agent']}, 'runtime': {'sha': refs['runtime']}}).encode()
        refs['app'] = repo(paths['app'], {'public/install-manifest.json': manifest})
        self.candidate = {**refs, 'manifest_sha256': r24.sha(manifest)}
        provider = root / 'provider'
        files = {name: ('fixture ' + name).encode() for name in r24.FILES}
        provider_ref = repo(provider, files)
        pterm = root / 'pterm'
        pterm_ref = repo(pterm, {'index.js': b'fixture pterm'})
        module = pterm / 'node_modules/unws/src/node.cjs'
        module.parent.mkdir(parents=True)
        module.write_bytes(b'fixture module')
        node = root / 'node'
        node.write_bytes(b'fixture node')
        daemon = root / 'daemon'
        daemon_files = {'server/socket.js': b'fixture socket', 'kernel/api/index.js': b'fixture api'}
        daemon_ref = repo(daemon, daemon_files)
        home = root / 'home'
        resource = home / 'api/astrid'
        (resource / 'pinokio/providers').mkdir(parents=True)
        (resource / 'pinokio/stop.js').write_bytes(stop)
        (resource / 'pinokio/lifecycle.mjs').write_bytes(lifecycle)
        for name in ('pinokio/providers/r24-action.cjs', 'pinokio/providers/r24-live-action.js'):
            (resource / name).write_bytes(files[name])
        scratch = root / 'scratch'
        scratch.mkdir(mode=0o700)
        self.binding = {'candidate': self.candidate, 'stop_sha256': r24.sha(stop),
                        'lifecycle_sha256': r24.sha(lifecycle), 'pterm_ref': pterm_ref,
                        'pinokiod_ref': daemon_ref,
                        'pinokiod_sources': {name: r24.sha(data) for name, data in daemon_files.items()},
                        'runtime_execution_sources': {
                            'agent': {'file': r24.sha(execution_source)},
                            'runtime': {'file': r24.sha(execution_source)}}}
        self.config = {'checkouts': {k: str(v) for k, v in paths.items()}, 'pterm': str(pterm),
                       'pinokiod': str(daemon), 'scratch_root': str(scratch),
                       'node': str(node), 'node_sha256': r24.sha(node.read_bytes()),
                       'pterm_entry_sha256': r24.sha((pterm / 'index.js').read_bytes()), 'unws_sha256': r24.sha(module.read_bytes()),
                       'engine': {'pid': 123, 'boot_id': 'a' * 36, 'start_ticks': '7',
                                  'pinokio_home': str(home), 'port': 42000}}
        self.request = {'schema': 'astrid.r24.provider-request.v1', 'candidate': self.candidate.copy(),
                        'provider': {'ref': provider_ref, 'sources': {k: r24.sha(v) for k, v in files.items()}},
                        'stop': {'ref': refs['pinokio'], 'path': 'pinokio/stop.js', 'sha256': r24.sha(stop)},
                        'config_sha256': r24.sha(r24.canonical(self.config)), 'run_id': 'a' * 32}
        installed = {'backend_root': resource / 'app/astrid', 'version_root': resource,
                     'python': node, 'python_target': node,
                     'python_sha256': r24.sha(node.read_bytes()), 'data_root': root}
        engine_identity = {'pid': 123, 'boot_id': 'a' * 36, 'start_ticks': '7',
                           'port': 42000, 'node_sha256': r24.sha(node.read_bytes())}
        self.patches = [patch.object(r24, 'BINDING', self.binding), patch.object(r24, 'BASE', provider),
                        patch.object(r24, 'proc_identity', return_value=(engine_identity, root / 'bootstrap')),
                        patch.object(r24, 'installed_context', return_value=installed)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_tuple_and_executable_binding(self):
        r24.validate(self.request, self.config)
        self.request['candidate']['agent'] = '0' * 40
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)
        self.request['candidate']['agent'] = self.candidate['agent']
        Path(self.config['node']).write_bytes(b'changed')
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)

    def test_request_fields_sources_and_dirty_checkout(self):
        self.request['extra'] = True
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)
        del self.request['extra']
        self.request['provider']['sources'][r24.FILES[0]] = '0' * 64
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)
        self.request['provider']['sources'][r24.FILES[0]] = r24.sha(('fixture ' + r24.FILES[0]).encode())
        (Path(self.config['checkouts']['agent']) / 'file').write_text('changed')
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)

    def test_no_injection_or_restoration_claim_and_redaction(self):
        with patch.object(r24, 'collect_authenticated', side_effect=ValueError('bearer secret')):
            result, diagnostic = r24.run(self.request, self.config)
        self.assertIsNone(result)
        self.assertEqual((diagnostic['busy'], diagnostic['unknown'], diagnostic['restoration']), ('not-run', 'not-run', 'unknown'))
        self.assertEqual(diagnostic['action']['settlement'], 'unknown')
        with patch.object(r24, 'collect_authenticated', side_effect=ValueError('bearer secret')):
            result, diagnostic = r24.run(self.request, self.config)
        self.assertIsNone(result)
        self.assertNotIn('secret', json.dumps(diagnostic))
        self.assertEqual(diagnostic['action']['end'], 'observer-error')

    def test_exact_inner_action_streams_exit_and_binding_are_preserved(self):
        session = 'b' * 32
        context = {'engine': {'pid': 123, 'boot_id': 'a' * 36, 'start_ticks': '7',
                              'port': 42000, 'node_sha256': 'c' * 64}}
        proc = subprocess.CompletedProcess(['node'], 7, b'{"raw":"result"}\n', b'actual action stderr\n')
        record = r24.action_invocation(proc, self.request, session, context)
        self.assertEqual(record['returncode'], 7)
        self.assertEqual(record['exit_code'], 7)
        self.assertIsNone(record['signal'])
        self.assertEqual(r24.base64.b64decode(record['raw_result']['base64']), proc.stdout)
        self.assertEqual(r24.base64.b64decode(record['stderr']['base64']), proc.stderr)
        self.assertEqual(record['request_sha256'], r24.sha(r24.canonical(self.request)))
        self.assertEqual(record['session'], session)
        self.assertFalse(record['raw_result_validated'])
        with patch.object(r24, 'collect_authenticated', side_effect=r24.ActionInvocationFailure(record)), \
             patch.object(r24.secrets, 'token_hex', return_value=session):
            result, diagnostic = r24.run(self.request, self.config)
        self.assertIsNone(result)
        self.assertEqual(diagnostic['action'], record)

    def test_live_collection_retains_validated_raw_result_and_runtime_source(self):
        session = 'b' * 32
        context = r24.validate(self.request, self.config)
        blocker = {'task_id': 'task-1', 'blocker_kind': 'running_task',
                   'kind': 'render', 'state': 'running'}
        fence = {'request_id': 'request', 'connect_observed': True,
                 'disconnect_observed': True, 'idle_observed': True}
        action = {'schema': 'astrid.r24.live-action-result.v1', 'session': session,
                  'request_sha256': r24.sha(r24.canonical(self.request)),
                  'binding': {'request_id': 'probe', 'results': 1,
                              'stop_observed': True, 'disconnect_observed': True},
                  'busy': {'task_count': 1, 'blockers': [blocker],
                           'headline_sha256': 'd' * 64, 'stop_refused': True, 'fence': fence},
                  'unknown': {'observer_lost': True,
                              'preflight': {'child_pid': 45, 'python_sha256': 'e' * 64,
                                            'armed': True, 'drained': True, 'signal': 'SIGKILL'},
                              'fence': fence},
                  'restoration': {'request_id': 'restore', 'results': 1,
                                  'stop_observed': True, 'disconnect_observed': True,
                                  'preflight': {'blockers': [blocker]}, 'observer_usable': True}}
        snapshot = {'runtime': {'pid': 321, 'runtime_session_id': 'runtime-session'},
                    'active_tasks': [{'task_id': 'task-1'}], 'files': {}}
        proc = subprocess.CompletedProcess(['node'], 0, r24.canonical(action), b'inner warning\n')
        with patch.object(r24, 'protected_snapshot', return_value=snapshot), \
             patch.object(r24, 'invoke_action', return_value=proc), \
             patch.object(r24.secrets, 'token_hex', return_value='1' * 16):
            observations = r24.collect_authenticated(self.request, session, context)
        self.assertIsInstance(observations, r24.CollectedObservations)
        self.assertTrue(observations.action['raw_result_validated'])
        self.assertEqual(r24.base64.b64decode(observations.action['stderr']['base64']), proc.stderr)
        busy = next(row for row in observations if row['kind'] == 'busy')
        evidence = json.loads(busy['evidence'])
        self.assertEqual(evidence['action_invocation'], observations.action)
        self.assertEqual(evidence['runtime'], snapshot['runtime'])
        self.assertEqual(evidence['runtime_execution_sources'], self.binding['runtime_execution_sources'])

    def test_protected_snapshot_binds_real_runtime_task_session_and_process(self):
        root = Path(self.tmp.name) / 'runtime-state'
        data, realm = root / 'data', root / 'realm'
        support, backend, version = data / 'runtime', root / 'program', root / 'version'
        resource = root / 'resource'
        for directory in (support, realm, backend, version, resource / 'pinokio'):
            directory.mkdir(parents=True, exist_ok=True)
        pid = os.getpid()
        stat = (Path('/proc') / str(pid) / 'stat').read_text()
        ticks = stat[stat.rfind(')') + 2:].split()[19]
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        birth = f'proc-start-ticks:{ticks};boot:{boot}'
        runtime_session = 'runtime-session-1'
        catalog = {'selected_realm_id': 'realm-1', 'realms': [{
            'realm_id': 'realm-1', 'data_root': str(realm), 'readiness': 'ready',
            'runtime_instance_id': 'instance-1', 'runtime_epoch': 4}]}
        discovery = {'endpoint': 'http://127.0.0.1:12345', 'pid': pid,
            'process_birth_id': birth, 'active_realm': 'realm-1', 'realm_root': str(realm),
            'runtime_instance_id': 'instance-1', 'protocol_version': 'workspace.v1'}
        instance = {'pid': pid, 'process_birth_id': birth, 'runtime_instance_id': 'instance-1',
                    'realm_id': 'realm-1', 'realm_root': str(realm)}
        for path, value in ((support / 'catalog.json', catalog),
                            (support / 'discovery.json', discovery),
                            (support / 'instance.lock', instance)):
            path.write_text(json.dumps(value))
        for path in (backend / 'current', backend / 'install.json', version / 'version.json',
                     resource / 'pinokio/stop.js', resource / 'pinokio/lifecycle.mjs'):
            path.write_text('fixture')
        database = realm / 'realm.sqlite3'
        connection = sqlite3.connect(database)
        connection.executescript('''
            CREATE TABLE runtime_lifecycle(id INTEGER PRIMARY KEY, boot_id TEXT, runtime_epoch INTEGER);
            CREATE TABLE tasks(id TEXT PRIMARY KEY, run_id TEXT, capability TEXT, status TEXT);
            CREATE TABLE execution_bindings(binding_id TEXT, task_id TEXT, session_id TEXT,
              runtime_epoch INTEGER, executor_id TEXT, target_kind TEXT, target_id TEXT, status TEXT);
            INSERT INTO runtime_lifecycle VALUES(1, 'runtime-session-1', 4);
            INSERT INTO tasks VALUES('task-1', 'run-1', 'rendering.render', 'running');
            INSERT INTO execution_bindings VALUES('binding-1', 'task-1', 'runtime-session-1', 4,
              'astrid-pack-host', 'profile', 'local-profile', 'claimed');
        ''')
        connection.commit()
        connection.close()
        context = {'installed': {'data_root': data, 'backend_root': backend, 'version_root': version,
                                 'python': Path('/lexical/venv/bin/python'),
                                 'python_target': (Path('/proc') / str(pid) / 'exe').resolve()},
                   'resource': resource}
        snapshot = r24.protected_snapshot(context)
        self.assertEqual(snapshot['runtime']['runtime_session_id'], runtime_session)
        self.assertEqual(snapshot['active_tasks'][0]['binding_id'], 'binding-1')
        self.assertEqual(snapshot['active_tasks'][0]['executor_id'], 'astrid-pack-host')
        connection = sqlite3.connect(database)
        connection.execute("UPDATE execution_bindings SET session_id='foreign'")
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(ValueError, 'active task execution binding unavailable'):
            r24.protected_snapshot(context)

    def observations(self):
        session = 'b' * 32
        source = r24.FILES[0]
        records = []
        for kind, outcome in (('busy', 'busy-observed'), ('unknown', 'unknown-safely-handled'), ('restoration', 'restored')):
            evidence = ('synthetic ' + kind + ' secret payload').encode()
            records.append({'kind': kind, 'outcome': outcome, 'safe': True,
                            'request_sha256': r24.sha(r24.canonical(self.request)), 'run_id': self.request['run_id'],
                            'session': session, 'source': source, 'source_sha256': self.request['provider']['sources'][source],
                            'evidence': evidence, 'evidence_sha256': r24.sha(evidence)})
        return session, records

    def test_success_serialization_and_bindings(self):
        session, records = self.observations()
        result = r24.serialize_success(self.request, session, records)
        self.assertEqual([r['kind'] for r in result['observations']], ['busy', 'restoration', 'unknown'])
        self.assertNotIn('secret payload', json.dumps(result))
        parser_path = os.environ.get('R24_CONSUMER_PARSER')
        self.assertTrue(parser_path, 'pinned parser required for this focused test')
        spec = importlib.util.spec_from_file_location('r24_consumer_success', parser_path)
        import sys
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        request = module.ProviderRequest.parse(r24.canonical(self.request))
        self.assertEqual(len(module.ProviderResult.parse(r24.canonical(result), request).observations), 3)

        variants = [records[:-1], records + [records[0]], [records[0], records[0], records[2]]]
        for index in range(3):
            for key, value in (('request_sha256', '0' * 64), ('run_id', '0' * 32), ('session', '0' * 32),
                               ('source', 'foreign'), ('source_sha256', '0' * 64), ('evidence_sha256', '0' * 64),
                               ('evidence', b''), ('safe', False), ('outcome', 'not-run')):
                changed = copy.deepcopy(records)
                changed[index][key] = value
                variants.append(changed)
            for key in records[index]:
                changed = copy.deepcopy(records)
                del changed[index][key]
                variants.append(changed)
        with patch.object(r24, 'validate', return_value={}), \
             patch.object(r24.secrets, 'token_hex', return_value=session):
            for variant in variants:
                with self.subTest(variant=repr(variant)):
                    with self.assertRaises(ValueError): r24.serialize_success(self.request, session, variant)
                    with patch.object(r24, 'collect_authenticated', return_value=variant):
                        result, diagnostic = r24.run(self.request, self.config)
                    self.assertIsNone(result)
                    self.assertEqual(diagnostic['schema'], 'astrid.r24.producer-diagnostic.v1')
        with self.assertRaises(ValueError): r24.serialize_success(self.request, '', records)

    def test_result_diagnostic_separation_and_failure(self):
        session, records = self.observations()
        with patch.object(r24.secrets, 'token_hex', return_value=session), \
             patch.object(r24, 'collect_authenticated', return_value=records):
            result, diagnostic = r24.run(self.request, self.config)
        self.assertIsNone(diagnostic)
        self.assertEqual(result['schema'], 'astrid.r24.provider-result.v1')
        for code, observations in ((1, records), (0, records[:-1]), (0, None)):
            with self.subTest(code=code, observations=observations), \
                 patch.object(r24.secrets, 'token_hex', return_value=session), \
                 patch.object(r24, 'collect_authenticated', side_effect=(ValueError('failed') if code or observations is None else None),
                              return_value=observations):
                result, diagnostic = r24.run(self.request, self.config)
            self.assertIsNone(result)
            self.assertEqual(diagnostic['schema'], 'astrid.r24.producer-diagnostic.v1')
            self.assertNotIn('secret payload', json.dumps(diagnostic))

    def test_cli_streams_and_redacted_errors(self):
        import sys
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'request'
            config = Path(directory) / 'config'
            request.write_bytes(r24.canonical(self.request))
            config.write_bytes(r24.canonical(self.config))
            stdout, stderr = io.StringIO(), io.StringIO()
            diagnostic = {'schema': 'astrid.r24.producer-diagnostic.v1'}
            with patch.object(sys, 'argv', ['r24-linux.py', str(request), str(config)]), \
                 patch.object(r24, 'run', return_value=(None, diagnostic)), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(r24.main(), 1)
            self.assertEqual(stdout.getvalue(), '')
            self.assertEqual(json.loads(stderr.getvalue()), diagnostic)
            stdout, stderr = io.StringIO(), io.StringIO()
            success = r24.serialize_success(self.request, *self.observations())
            with patch.object(sys, 'argv', ['r24-linux.py', str(request), str(config)]), \
                 patch.object(r24, 'run', return_value=(success, None)), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(r24.main(), 0)
            self.assertEqual(json.loads(stdout.getvalue()), success)
            self.assertEqual(stderr.getvalue(), '')
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(sys, 'argv', ['r24-linux.py', str(request), str(config)]), \
                 patch.object(r24, 'run', side_effect=ValueError('bearer secret')), \
                 contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(r24.main(), 1)
            self.assertEqual(stdout.getvalue(), '')
            self.assertNotIn('secret', stderr.getvalue())

    def test_duplicate_json_and_config_digest_rejected(self):
        with self.assertRaises(ValueError): r24.decode('{"x":1,"x":2}')
        self.config['node_sha256'] = '0' * 64
        with self.assertRaises(ValueError): r24.validate(self.request, self.config)

    def test_provisional_parser_request_and_incompatible_diagnostic(self):
        parser_path = os.environ.get('R24_CONSUMER_PARSER')
        if not parser_path:
            self.skipTest('set R24_CONSUMER_PARSER to the independently obtained pinned parser')
        spec = importlib.util.spec_from_file_location('r24_consumer', parser_path)
        import sys
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        request = module.ProviderRequest.parse(r24.canonical(self.request))
        self.assertEqual(request.sha256, r24.sha(r24.canonical(self.request)))
        diagnostic = {'schema': 'astrid.r24.producer-diagnostic.v1', 'request_sha256': request.sha256,
                      'action': {}, 'busy': 'not-run', 'unknown': 'not-run', 'restoration': 'unknown',
                      'runtime_identity': 'unknown', 'custody': 'unknown', 'protected_state': 'unknown'}
        with self.assertRaises(module.ProviderContractError): module.ProviderResult.parse(r24.canonical(diagnostic), request)
        # Even an otherwise result-shaped record cannot convey unknown: safe must be true.
        rows = [{'kind': kind, 'source': r24.FILES[0], 'evidence_sha256': '0' * 64, 'safe': False} for kind in ('busy', 'unknown', 'restoration')]
        with self.assertRaisesRegex(module.ProviderContractError, 'unsafe observation'):
            module.ProviderResult.parse(r24.canonical({'schema': module.RESULT_SCHEMA, 'request_sha256': request.sha256, 'observations': rows}), request)

if __name__ == '__main__': unittest.main()
