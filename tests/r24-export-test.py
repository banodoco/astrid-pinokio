#!/usr/bin/env python3
"""Synthetic tests for the internal export boundary; no hosted evidence."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('producer', ROOT / 'pinokio/providers/r24-linux.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.request = {'schema': 'astrid.r24.provider-request.v1', 'candidate': p.BINDING['candidate'],
            'run_id': 'a' * 32, 'config_sha256': 'e' * 64,
            'provider': {'ref': 'f' * 40, 'sources': {name: 'b' * 64 for name in p.FILES}},
            'stop': {'ref': p.BINDING['candidate']['pinokio'], 'path': 'pinokio/stop.js',
                     'sha256': p.BINDING['stop_sha256']}}
        self.session = 'c' * 32
        self.records = []
        for kind, outcome in [('busy', 'busy-observed'), ('unknown', 'unknown-safely-handled'), ('restoration', 'restored')]:
            evidence = ('synthetic ' + kind).encode()
            self.records.append({'kind': kind, 'outcome': outcome, 'safe': True,
                'request_sha256': p.sha(p.canonical(self.request)), 'run_id': self.request['run_id'],
                'session': self.session, 'source': p.FILES[0], 'source_sha256': 'b' * 64,
                'evidence': evidence, 'evidence_sha256': p.sha(evidence)})

    def seal(self, dest, records=None, request=None):
        return p.seal_observations(request or self.request, self.session,
                                   self.records if records is None else records, dest)

    def test_deterministic_allowlist_inventory_and_retained_raw_evidence(self):
        first, second = self.root / 'one', self.root / 'two'
        inventory = self.seal(first)
        self.assertEqual(inventory, self.seal(second, list(reversed(self.records))))
        self.assertEqual([x['path'] for x in inventory], ['junit.xml', 'manifest.json', 'observation-busy.json',
            'observation-restoration.json', 'observation-result.json', 'observation-unknown.json'])
        for row in inventory:
            data = (first / row['path']).read_bytes()
            self.assertEqual(data, (second / row['path']).read_bytes())
            self.assertEqual((len(data), p.sha(data)), (row['bytes'], row['sha256']))
            if row['path'].startswith('observation-') and row['path'] != 'observation-result.json':
                self.assertIn(b'synthetic', data)
            else:
                self.assertNotIn(b'synthetic', data)
        manifest = json.loads((first / 'manifest.json').read_bytes())
        self.assertEqual(manifest['qualification'], 'not-evaluated')
        self.assertEqual(manifest['files'], [row for row in inventory if row['path'] != 'manifest.json'])
        self.assertIn(b'<skipped ', (first / 'junit.xml').read_bytes())

    def test_invalid_observations_never_create_directory(self):
        variants = [[], self.records[:-1], self.records + [self.records[0]],
                    [self.records[0], self.records[0], self.records[2]]]
        for key, value in [('safe', False), ('outcome', 'not-run'), ('run_id', 'd' * 32),
                           ('session', 'd' * 32), ('request_sha256', 'd' * 64),
                           ('source', '../escape'), ('source_sha256', 'd' * 64),
                           ('evidence', b'x' * (p.MAX_EVIDENCE_BYTES + 1)), ('extra', True)]:
            changed = copy.deepcopy(self.records)
            changed[0][key] = value
            if key == 'evidence': changed[0]['evidence_sha256'] = p.sha(value)
            variants.append(changed)
        for key in self.records[0]:
            changed = copy.deepcopy(self.records)
            del changed[0][key]
            variants.append(changed)
        for index, records in enumerate(variants):
            dest = self.root / str(index)
            with self.subTest(index=index), self.assertRaises((ValueError, KeyError)):
                self.seal(dest, records)
            self.assertFalse(dest.exists())
        with self.assertRaises(ValueError): p.decode('{"x":1,"x":2}')
        big = dict(self.request, extra='x' * p.MAX_REQUEST_BYTES)
        with self.assertRaises(ValueError): self.seal(self.root / 'big', request=big)
        for key in self.request:
            request = dict(self.request)
            del request[key]
            with self.subTest(missing=key), self.assertRaises((ValueError, KeyError)):
                self.seal(self.root / 'missing', request=request)
        with self.assertRaises(ValueError): self.seal(self.root / 'extra', request=dict(self.request, extra=True))

    def test_destination_traversal_symlinks_and_existing(self):
        (self.root / 'link').symlink_to(self.root, target_is_directory=True)
        for dest in [str(self.root / 'link' / 'out'), str(self.root) + '/../escape',
                     str(self.root) + '/./escape', str(self.root) + '//escape', 'relative', str(self.root)]:
            with self.subTest(dest=dest), self.assertRaises((ValueError, OSError)):
                self.seal(dest)
        self.assertFalse((self.root / 'out').exists())

    def test_write_failure_removes_partial_export(self):
        original = os.open
        def fail(name, *args, **kwargs):
            if name == 'manifest.json': raise OSError('synthetic failure')
            return original(name, *args, **kwargs)
        with patch.object(p.os, 'open', side_effect=fail), self.assertRaises(OSError):
            self.seal(self.root / 'out')
        self.assertFalse((self.root / 'out').exists())

    def test_run_never_exports_without_internal_collector(self):
        action = {'dispatched': True, 'client_exit': 0, 'client_signal': None, 'messages': 1,
                  'disconnects': 1, 'errors': 0, 'post_terminal': False,
                  'end': 'socket-closed', 'settlement': 'unknown'}
        dest = self.root / 'out'
        with patch.object(p, 'validate', return_value=({'pinokio': self.root}, self.root, self.root)), \
             patch.object(p, 'collect_authenticated', side_effect=ValueError('collector unavailable')):
            result, diagnostic = p.run(self.request, {}, dest)
        self.assertIsNone(result)
        self.assertEqual(diagnostic['custody'], 'unknown')
        self.assertFalse(dest.exists())

    def test_run_seals_only_internal_complete_records_and_fails_on_existing_destination(self):
        action = {'dispatched': True, 'client_exit': 0, 'client_signal': None, 'messages': 1,
                  'disconnects': 1, 'errors': 0, 'post_terminal': False,
                  'end': 'socket-closed', 'settlement': 'unknown'}
        dest = self.root / 'out'
        with patch.object(p, 'validate', return_value=({'pinokio': self.root}, self.root, self.root)), \
             patch.object(p, 'invoke_action', return_value=subprocess.CompletedProcess([], 0, json.dumps(action).encode())), \
             patch.object(p.secrets, 'token_hex', return_value=self.session), \
             patch.object(p, 'collect_authenticated', return_value=self.records):
            result, diagnostic = p.run(self.request, {}, dest)
            self.assertIsNone(diagnostic)
            self.assertEqual(result, json.loads((dest / 'observation-result.json').read_bytes()))
            result, diagnostic = p.run(self.request, {}, dest)
            self.assertIsNone(result)
            self.assertEqual(diagnostic['custody'], 'unknown')

    def test_exact_collector_round_trip_with_synthetic_api(self):
        collector_path = os.environ['R24_COLLECTOR']
        self.assertEqual(hashlib.sha256(Path(collector_path).read_bytes()).hexdigest(),
                         '8f8fb1abd327d12fdd68fc53737198425b7f6a415c31b391dc6144444031de6b')
        spec = importlib.util.spec_from_file_location('collector', collector_path)
        collector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(collector)
        source_dir = self.root / 'source'
        inventory = self.seal(source_dir)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as z:
            for row in inventory: z.writestr(row['path'], (source_dir / row['path']).read_bytes())
        data = archive.getvalue()
        url = 'https://github.com/banodoco/astrid-pinokio'
        binding = {'kind': 'hosted', 'repo': 'pinokio', 'workflow_path': '.github/workflows/test.yml',
                   'workflow_revision': 'a' * 40, 'run_id': 1, 'run_attempt': 1, 'job_id': 2,
                   'artifact_id': 3, 'artifact_name': 'fixture', 'head_sha': 'b' * 40}
        run = {'id': 1, 'run_attempt': 1, 'head_sha': 'b' * 40, 'status': 'completed', 'conclusion': 'success',
               'path': binding['workflow_path'], 'repository': {'html_url': url}}
        job = {'id': 2, 'run_id': 1, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success'}
        artifact = {'id': 3, 'name': 'fixture', 'expired': False, 'workflow_run': {'id': 1}, 'digest': 'sha256:' + p.sha(data)}
        def fetch(path, binary=False):
            if binary: return data
            if path.endswith('/jobs?per_page=100'): return {'total_count': 1, 'jobs': [job]}
            if path.endswith('/artifacts?per_page=100'): return {'total_count': 1, 'artifacts': [artifact]}
            return run
        result = collector.download(binding, {'pinokio': {'sha': 'b' * 40, 'url': url}}, self.root / 'download', fetch)
        self.assertEqual(result['files'], inventory)
        self.assertEqual(result['run']['job_id'], 2)
        self.assertEqual(result['archive_sha256'], p.sha(data))


if __name__ == '__main__': unittest.main()
