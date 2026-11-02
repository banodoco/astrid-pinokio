"""Synthetic unit evidence; not hosted qualification observations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'pinokio/providers/r24-linux.py'
spec = importlib.util.spec_from_file_location('r24_linux', SOURCE)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.roots, refs, files = {}, {}, {}
        for name in ('agent', 'runtime', 'app', 'pinokio'):
            root = base / name
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'config', 'user.email', 'test@example.invalid'], check=True)
            subprocess.run(['git', '-C', str(root), 'config', 'user.name', 'Unit Test'], check=True)
            content = (name + '\n').encode()
            (root / 'source').write_bytes(content)
            if name == 'app':
                (root / 'public').mkdir()
                (root / 'public/install-manifest.json').write_text(json.dumps({'release': 1, 'agent': {'sha': refs['agent']}, 'runtime': {'sha': refs['runtime']}}))
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), 'commit', '-qm', 'fixture'], check=True)
            refs[name] = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            files[name] = {'source': sha(content)}
            self.roots[name] = str(root)
        data = json.dumps({'tuple': refs, 'files': files, 'manifest_sha256': sha((base/'app/public/install-manifest.json').read_bytes()), 'interface_sha256': 'fixture'}).encode()
        binding = base/'binding.json'
        binding.write_bytes(data)
        self.stack = patch.multiple(provider, BINDING=binding, BINDING_SHA256=sha(data))
        self.stack.start()
        self.addCleanup(self.stack.stop)
        self.request = {'checkouts': self.roots.copy(), 'source_override_test_mode': False}

    def test_materialization_reports_unknown_and_not_run(self):
        result = provider.materialize(self.request)
        self.assertEqual(result['checkouts'], self.roots)
        self.assertEqual(result['admission'], 'closed')
        self.assertEqual(result['action'], {'status': 'not-run', 'settlement': 'unknown'})
        self.assertEqual(result['busy'], {'status': 'not-run', 'refusal': 'unknown'})
        self.assertEqual(result['restoration'], {'status': 'not-run', 'fencing': 'unknown'})
        self.assertEqual(result['engine']['identity'], 'unknown')

    def test_missing_foreign_dirty_override_and_tampering_fail(self):
        for request in ({}, {**self.request, 'source_override_test_mode': True},
                        {**self.request, 'checkouts': {**self.roots, 'app': self.roots['agent']}},
                        {**self.request, 'checkouts': {**self.roots, 'app': 'relative'}}):
            with self.subTest(request=request), self.assertRaises((ValueError, TypeError)):
                provider.materialize(request)
        (Path(self.roots['agent'])/'source').write_text('modified')
        with self.assertRaisesRegex(ValueError, 'dirty checkout'):
            provider.materialize(self.request)
        subprocess.run(['git', '-C', self.roots['agent'], 'checkout', '--', 'source'], check=True)
        provider.BINDING.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'binding bytes changed'):
            provider.materialize(self.request)

    def test_foreign_commit_fails_even_with_matching_sources(self):
        root = self.roots['pinokio']
        subprocess.run(['git', '-C', root, 'commit', '--allow-empty', '-qm', 'foreign'], check=True)
        with self.assertRaisesRegex(ValueError, 'foreign checkout'):
            provider.materialize(self.request)

    def test_missing_source_fails_closed(self):
        (Path(self.roots['runtime'])/'source').unlink()
        with self.assertRaises(ValueError):
            provider.materialize(self.request)


if __name__ == '__main__':
    unittest.main()
