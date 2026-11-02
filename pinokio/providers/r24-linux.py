#!/usr/bin/env python3
"""Linux Stop-action observation producer; no qualification authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

HERE = Path(__file__).resolve().parent
BASE = HERE.parent.parent
BINDING = json.loads((HERE / 'r24-linux-binding.json').read_bytes())
FILES = ('pinokio/providers/r24-linux.py', 'pinokio/providers/r24-action.cjs',
         'pinokio/providers/r24-linux-binding.json', 'pinokio/providers/r24-schema.json')
HEX40 = re.compile(r'[0-9a-f]{40}\Z')
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
HEX32 = re.compile(r'[0-9a-f]{32}\Z')
MAX_EVIDENCE_BYTES = 65536
MAX_REQUEST_BYTES = 65536
JUNIT = b'<testsuite name="r24-producer-export" tests="1" skipped="1"><testcase name="qualification"><skipped message="not a qualification result"/></testcase></testsuite>\n'


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('ascii')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def decode(data):
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid constant')))


def exact(obj, keys):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise ValueError('invalid fields')


def match(value, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError('invalid identity')


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL, timeout=30).strip()


def checkout(value, ref, clean=True):
    if not isinstance(value, str) or not os.path.isabs(value) or Path(value).is_symlink():
        raise ValueError('invalid checkout')
    root = Path(value).resolve(strict=True)
    if Path(os.fsdecode(git(root, 'rev-parse', '--show-toplevel'))).resolve() != root or git(root, 'rev-parse', 'HEAD').decode() != ref:
        raise ValueError('checkout identity mismatch')
    if clean and git(root, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('dirty checkout')
    return root


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('missing regular file')
    return path.read_bytes()


def validate(request, config):
    if sys.platform != 'linux':
        raise ValueError('Linux required')
    exact(request, ('schema', 'candidate', 'provider', 'stop', 'config_sha256', 'run_id'))
    if request['schema'] != 'astrid.r24.provider-request.v1' or request['candidate'] != BINDING['candidate']:
        raise ValueError('request tuple mismatch')
    match(request['run_id'], HEX32)
    match(request['config_sha256'], HEX64)
    if sha(canonical(config)) != request['config_sha256']:
        raise ValueError('config digest mismatch')
    exact(request['provider'], ('ref', 'sources'))
    match(request['provider']['ref'], HEX40)
    sources = request['provider']['sources']
    exact(sources, FILES)
    # Producer code is on its own immutable lane, separate from the product tuple.
    provider_root = checkout(str(BASE), request['provider']['ref'])
    for rel in FILES:
        match(sources[rel], HEX64)
        if sha(regular(provider_root / rel)) != sources[rel] or sha(git_blob(provider_root, request['provider']['ref'], rel)) != sources[rel]:
            raise ValueError('provider source mismatch')
    exact(request['stop'], ('ref', 'path', 'sha256'))
    if request['stop'] != {'ref': BINDING['candidate']['pinokio'], 'path': 'pinokio/stop.js', 'sha256': BINDING['stop_sha256']}:
        raise ValueError('stop identity mismatch')
    exact(config, ('checkouts', 'pterm', 'node', 'node_sha256', 'pterm_entry_sha256', 'unws_sha256'))
    exact(config['checkouts'], ('app', 'agent', 'runtime', 'pinokio'))
    roots = {name: checkout(value, BINDING['candidate'][name]) for name, value in config['checkouts'].items()}
    if len(set(roots.values())) != 4 or provider_root in roots.values():
        raise ValueError('distinct roots required')
    manifest = regular(roots['app'] / 'public/install-manifest.json')
    if sha(manifest) != BINDING['candidate']['manifest_sha256']:
        raise ValueError('manifest mismatch')
    parsed_manifest = decode(manifest)
    if parsed_manifest.get('release') != 1 or any(parsed_manifest[k]['sha'] != BINDING['candidate'][k] for k in ('agent', 'runtime')):
        raise ValueError('manifest tuple mismatch')
    stop = regular(roots['pinokio'] / 'pinokio/stop.js')
    if sha(stop) != BINDING['stop_sha256'] or sha(git_blob(roots['pinokio'], BINDING['candidate']['pinokio'], 'pinokio/stop.js')) != BINDING['stop_sha256']:
        raise ValueError('stop bytes mismatch')
    # Installed modules are not tracked by Git; their bytes are config-bound, not approved provenance.
    pterm = checkout(config['pterm'], BINDING['pterm_ref'], clean=False)
    if git(pterm, 'status', '--porcelain=v1', '--untracked-files=no'):
        raise ValueError('dirty pterm source')
    node = Path(config['node']) if isinstance(config['node'], str) else Path('.')
    if not node.is_absolute():
        raise ValueError('node path must be absolute')
    for path, key in ((node, 'node_sha256'), (pterm / 'index.js', 'pterm_entry_sha256'), (pterm / 'node_modules/unws/src/node.cjs', 'unws_sha256')):
        match(config[key], HEX64)
        if sha(regular(path)) != config[key]:
            raise ValueError('executable dependency mismatch')
    return roots, pterm, node


def git_blob(root, ref, rel):
    return subprocess.check_output(['git', '-C', str(root), 'show', ref + ':' + rel], stderr=subprocess.DEVNULL, timeout=30)


def sanitize_action(action):
    fields = ('dispatched', 'client_exit', 'client_signal', 'messages', 'disconnects', 'errors', 'post_terminal', 'end', 'settlement')
    exact(action, fields)
    if type(action['dispatched']) is not bool or type(action['post_terminal']) is not bool:
        raise ValueError('invalid observer flags')
    if action['client_exit'] is not None and (type(action['client_exit']) is not int or not -255 <= action['client_exit'] <= 255):
        raise ValueError('invalid client exit')
    if action['client_signal'] not in (None, 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'):
        raise ValueError('invalid signal')
    if any(type(action[k]) is not int or not 0 <= action[k] <= 1000000 for k in ('messages', 'disconnects', 'errors')):
        raise ValueError('invalid counters')
    if action['end'] not in ('timeout', 'subscription-error', 'client-error', 'malformed-event', 'socket-error', 'socket-closed', 'premature-disconnect', 'duplicate-open', 'daemon-error') or action['settlement'] != 'unknown':
        raise ValueError('invalid observer status')
    return {key: action[key] for key in fields}


def invoke_action(node, pterm, uri):
    return subprocess.run([str(node), str(HERE / 'r24-action.cjs'), str(pterm), uri], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=130, check=False)


def serialize_success(request, session, observations):
    """Serialize already authenticated observations; never authenticates them.

    This is an internal boundary, not an input API. The collector must establish
    invocation, source and custody authenticity before returning these records.
    """
    match(session, HEX32)
    request_sha = sha(canonical(request))
    match(request['run_id'], HEX32)
    sources = request['provider']['sources']
    if not isinstance(observations, list) or len(observations) != 3:
        raise ValueError('incomplete observations')
    outcomes = {'busy': 'busy-observed', 'unknown': 'unknown-safely-handled', 'restoration': 'restored'}
    rows = []
    seen = set()
    for obs in observations:
        exact(obs, ('kind', 'outcome', 'safe', 'request_sha256', 'run_id', 'session',
                    'source', 'source_sha256', 'evidence', 'evidence_sha256'))
        kind = obs['kind']
        if not isinstance(kind, str) or kind not in outcomes or kind in seen:
            raise ValueError('invalid observation kind')
        seen.add(kind)
        if obs['outcome'] != outcomes[kind] or obs['safe'] is not True:
            raise ValueError('observation not safely completed')
        if obs['request_sha256'] != request_sha or obs['run_id'] != request['run_id'] or obs['session'] != session:
            raise ValueError('observation binding mismatch')
        source = obs['source']
        if not isinstance(source, str) or source not in sources or obs['source_sha256'] != sources[source]:
            raise ValueError('observation source mismatch')
        match(obs['source_sha256'], HEX64)
        match(obs['evidence_sha256'], HEX64)
        if not isinstance(obs['evidence'], bytes) or not 0 < len(obs['evidence']) <= MAX_EVIDENCE_BYTES or sha(obs['evidence']) != obs['evidence_sha256']:
            raise ValueError('evidence mismatch')
        rows.append({'kind': kind, 'source': source, 'evidence_sha256': obs['evidence_sha256'], 'safe': True})
    return {'schema': 'astrid.r24.provider-result.v1', 'request_sha256': request_sha,
            'observations': sorted(rows, key=lambda row: row['kind'])}


def seal_observations(request, session, observations, destination):
    """Export internal collector records, without asserting identity or custody.

    The caller must have validated the request and authenticated the source. This
    function is not a file/JSON input API and does not authenticate observations.
    """
    if len(canonical(request)) > MAX_REQUEST_BYTES:
        raise ValueError('request too large')
    exact(request, ('schema', 'candidate', 'provider', 'stop', 'config_sha256', 'run_id'))
    if request['schema'] != 'astrid.r24.provider-request.v1' or request['candidate'] != BINDING['candidate']:
        raise ValueError('invalid export binding')
    exact(request['provider'], ('ref', 'sources'))
    exact(request['provider']['sources'], FILES)
    match(request['provider']['ref'], HEX40)
    match(request['config_sha256'], HEX64)
    for digest in request['provider']['sources'].values():
        match(digest, HEX64)
    if request['stop'] != {'ref': BINDING['candidate']['pinokio'], 'path': 'pinokio/stop.js', 'sha256': BINDING['stop_sha256']}:
        raise ValueError('invalid stop binding')
    result = canonical(serialize_success(request, session, observations)) + b'\n'
    payloads = {'junit.xml': JUNIT, 'observation-result.json': result}
    entries = [{'path': name, 'bytes': len(data), 'sha256': sha(data)}
               for name, data in sorted(payloads.items())]
    payloads['manifest.json'] = canonical({'schema': 'astrid.r24.producer-export.v1',
        'qualification': 'not-evaluated', 'files': entries}) + b'\n'
    inventory = [{'path': name, 'bytes': len(data), 'sha256': sha(data)}
                 for name, data in sorted(payloads.items())]

    # Resolve each existing directory without following symlinks; create only a
    # new final directory. All exported member names are fixed, not caller paths.
    if not isinstance(destination, (str, Path)):
        raise ValueError('invalid destination')
    raw = os.fspath(destination)
    if not isinstance(raw, str) or not raw.startswith('/') or any(p in ('', '.', '..') for p in raw.split('/')[1:]):
        raise ValueError('invalid destination')
    parts = raw.split('/')[1:]
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    target = None
    created = False
    written = []
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        os.mkdir(parts[-1], 0o700, dir_fd=parent)
        created = True
        target = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        for name, data in sorted(payloads.items()):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
            written.append(name)
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
        return inventory
    except BaseException:
        if target is not None:
            for name in written:
                os.unlink(name, dir_fd=target)
        if created:
            os.rmdir(parts[-1], dir_fd=parent)
        raise
    finally:
        if target is not None:
            os.close(target)
        os.close(parent)


def collect_authenticated(request, session, action):
    # No current collector can authenticate the invocation, bind this session,
    # or establish the required controls and restoration. Never accept records
    # from request/config, environment, action stdout, or caller-provided files.
    return None


def run(request, config, export_destination=None):
    roots, pterm, node = validate(request, config)
    uri = str(roots['pinokio'] / 'pinokio/stop.js')
    session = secrets.token_hex(16)
    try:
        proc = invoke_action(node, pterm, uri)
        if proc.returncode != 0:
            raise ValueError('action failed')
        action = sanitize_action(decode(proc.stdout))
        observations = collect_authenticated(request, session, action)
        if observations is not None:
            result = serialize_success(request, session, observations)
            if export_destination is not None:
                seal_observations(request, session, observations, export_destination)
            return result, None
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        action = {'end': 'observer-error', 'settlement': 'unknown'}
    # No busy/unknown injection or restoration source is bound. Never translate
    # a process exit or socket disconnect into settlement, safety or restoration.
    return None, {'schema': 'astrid.r24.producer-diagnostic.v1', 'request_sha256': sha(canonical(request)),
            'action': action, 'busy': 'not-run', 'unknown': 'not-run', 'restoration': 'unknown',
            'runtime_identity': 'unknown', 'custody': 'unknown', 'protected_state': 'unknown'}


def main():
    if len(sys.argv) not in (3, 4):
        print(json.dumps({'schema': 'astrid.r24.producer-error.v1', 'status': 'unknown'}), file=sys.stderr)
        return 2
    try:
        request = decode(Path(sys.argv[1]).read_bytes())
        config = decode(Path(sys.argv[2]).read_bytes())
        result, diagnostic = run(request, config, sys.argv[3] if len(sys.argv) == 4 else None)
    except (OSError, ValueError, KeyError, TypeError, RecursionError, subprocess.SubprocessError):
        print(json.dumps({'schema': 'astrid.r24.producer-error.v1', 'status': 'unknown'}), file=sys.stderr)
        return 1
    if result is None:
        print(json.dumps(diagnostic, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
