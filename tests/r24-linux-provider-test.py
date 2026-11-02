#!/usr/bin/env python3
"""Local synthetic repositories and protocol fixtures; no live evidence."""
import importlib.util
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
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


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        paths = {name: root / name for name in ('app', 'agent', 'runtime', 'pinokio')}
        refs = {}
        for name in ('agent', 'runtime'):
            refs[name] = repo(paths[name], {'file': b'fixture'})
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
                        'pinokiod_sources': {name: r24.sha(data) for name, data in daemon_files.items()}}
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
                     'python': node, 'python_sha256': r24.sha(node.read_bytes()), 'data_root': root}
        self.patches = [patch.object(r24, 'BINDING', self.binding), patch.object(r24, 'BASE', provider),
                        patch.object(r24, 'proc_identity', return_value={'pid': 123}),
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
