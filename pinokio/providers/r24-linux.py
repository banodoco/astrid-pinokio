#!/usr/bin/env python3
"""Fail-closed Linux R-24 runner binding and diagnostic provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

BINDING = Path(__file__).with_name('r24-linux-binding.json')
BINDING_SHA256 = '8168dd23683c0785a8a71faf8389c688c5116c1d8fd0df9524114148e910bf2a'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE,
                                   timeout=30)


def materialize(request):
    if sys.platform != 'linux':
        raise ValueError('Linux required')
    if set(request) != {'checkouts', 'source_override_test_mode'}:
        raise ValueError('unexpected or missing request fields')
    if request['source_override_test_mode'] is not False:
        raise ValueError('source override must be false')
    raw = BINDING.read_bytes()
    if digest(raw) != BINDING_SHA256:
        raise ValueError('binding bytes changed')
    binding = json.loads(raw)
    roots = request['checkouts']
    if not isinstance(roots, dict) or set(roots) != set(binding['tuple']):
        raise ValueError('four checkout paths required')
    observed = {}
    for name, expected in binding['tuple'].items():
        value = roots[name]
        if not isinstance(value, str) or not os.path.isabs(value):
            raise ValueError('checkout path must be absolute')
        root = Path(value).resolve(strict=True)
        top = Path(os.fsdecode(git(root, 'rev-parse', '--show-toplevel').strip())).resolve(strict=True)
        if root != top or root in observed.values():
            raise ValueError('checkout must be a distinct repository root')
        if git(root, 'rev-parse', 'HEAD').decode().strip() != expected:
            raise ValueError('foreign checkout: ' + name)
        if git(root, 'status', '--porcelain=v1', '--untracked-files=all').strip():
            raise ValueError('dirty checkout: ' + name)
        for rel, expected_hash in binding['files'][name].items():
            source = (root / rel).resolve(strict=True)
            if not source.is_relative_to(root) or not source.is_file():
                raise ValueError('unsafe source path: ' + name + '/' + rel)
            if digest(git(root, 'show', expected + ':' + rel)) != expected_hash:
                raise ValueError('foreign source blob: ' + name + '/' + rel)
            if digest(source.read_bytes()) != expected_hash:
                raise ValueError('foreign source bytes: ' + name + '/' + rel)
        observed[name] = root
    manifest = json.loads((observed['app'] / 'public/install-manifest.json').read_bytes())
    if manifest.get('release') != 1 or any(manifest[k]['sha'] != binding['tuple'][k] for k in ('agent', 'runtime')):
        raise ValueError('manifest members differ')
    return {
        'kind': 'r24-linux-binding-diagnostic', 'version': 1,
        'source_override_test_mode': False,
        'tuple': binding['tuple'], 'manifest_sha256': binding['manifest_sha256'],
        'interface_sha256': binding['interface_sha256'],
        'checkouts': {k: str(v) for k, v in observed.items()},
        'admission': 'closed',
        'action': {'status': 'not-run', 'settlement': 'unknown'},
        'busy': {'status': 'not-run', 'refusal': 'unknown'},
        'uncertainty': {'status': 'not-run'},
        'restoration': {'status': 'not-run', 'fencing': 'unknown'},
        'engine': {'identity': 'unknown', 'session': 'unknown'},
        'reason': 'independent terminal, busy, fault and fencing sources are not bound',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', help='JSON file with checkout roots and source_override_test_mode')
    args = parser.parse_args()
    try:
        with open(args.request, encoding='utf-8') as f:
            request = json.load(f)
        result = materialize(request)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as exc:
        print(json.dumps({'kind': 'r24-linux-binding-error', 'version': 1,
                          'admission': 'closed', 'status': 'unknown', 'error': str(exc)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
