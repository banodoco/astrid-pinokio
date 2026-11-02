#!/usr/bin/env python3
"""Linux Stop-action observation producer; no qualification authority."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys

HERE = Path(__file__).resolve().parent
BASE = HERE.parent.parent
BINDING = json.loads((HERE / 'r24-linux-binding.json').read_bytes())
FILES = ('pinokio/providers/r24-linux.py', 'pinokio/providers/r24-action.cjs',
         'pinokio/providers/r24-live-action.js',
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


def proc_identity(pid, node, daemon, engine):
    if type(pid) is not int or pid < 1:
        raise ValueError('invalid engine pid')
    proc = Path('/proc') / str(pid)
    boot_id = regular(Path('/proc/sys/kernel/random/boot_id')).decode().strip()
    if engine['boot_id'] != boot_id or not re.fullmatch(r'[0-9a-f-]{36}', boot_id):
        raise ValueError('engine boot mismatch')
    stat = regular(proc / 'stat').decode()
    tail = stat[stat.rfind(')') + 2:].split()
    if len(tail) < 20 or engine['start_ticks'] != tail[19]:
        raise ValueError('engine birth mismatch')
    if (proc / 'cwd').resolve() != daemon or (proc / 'exe').resolve() != node.resolve():
        raise ValueError('engine executable mismatch')
    argv = regular(proc / 'cmdline').split(b'\0')
    if not argv or not any(value.endswith(b'script/index.js') for value in argv):
        raise ValueError('engine command mismatch')
    environment = {}
    for row in regular(proc / 'environ').split(b'\0'):
        if b'=' in row:
            key, value = row.split(b'=', 1)
            if key == b'PINOKIO_HOME':
                environment[key] = value
    if environment.get(b'PINOKIO_HOME') != os.fsencode(engine['pinokio_home']):
        raise ValueError('engine home mismatch')
    port_hex = f"{engine['port']:04X}"
    inodes = set()
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text(encoding='ascii').splitlines()[1:]:
            fields = line.split()
            if len(fields) > 9 and fields[1].split(':')[-1] == port_hex and fields[3] == '0A':
                inodes.add(fields[9])
    owned = {target[8:-1] for fd in (proc / 'fd').iterdir()
             if (target := os.readlink(fd)).startswith('socket:[')}
    if not inodes or not inodes.intersection(owned):
        raise ValueError('engine listener ownership mismatch')
    return {'pid': pid, 'boot_id': boot_id, 'start_ticks': engine['start_ticks'],
            'port': engine['port'], 'node_sha256': sha(regular(node))}


def installed_context(home, lifecycle):
    backend = home / 'api/astrid/app/astrid'
    install = decode(regular(backend / 'install.json'))
    if install.get('owner') != 'haus.astrid.runtime' or install.get('managed_by') != 'pinokio':
        raise ValueError('installed owner mismatch')
    version = regular(backend / 'current').decode().strip()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', version):
        raise ValueError('invalid installed version')
    version_root = (backend / 'versions' / version).resolve(strict=True)
    record = decode(regular(version_root / 'version.json'))
    python = Path(record['python']).resolve(strict=True)
    data = Path(install['data_root']).resolve(strict=True)
    if version_root not in python.parents or not data.is_dir() or data.is_symlink():
        raise ValueError('installed path mismatch')
    if sha(regular(lifecycle)) != BINDING['lifecycle_sha256']:
        raise ValueError('lifecycle source mismatch')
    return {'backend_root': backend, 'version_root': version_root, 'python': python,
            'python_sha256': sha(regular(python)), 'data_root': data}


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
    exact(config, ('checkouts', 'pterm', 'pinokiod', 'node', 'node_sha256', 'pterm_entry_sha256',
                   'unws_sha256', 'engine', 'scratch_root'))
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
    daemon = checkout(config['pinokiod'], BINDING['pinokiod_ref'])
    for rel, digest in BINDING['pinokiod_sources'].items():
        if sha(regular(daemon / rel)) != digest or sha(git_blob(daemon, BINDING['pinokiod_ref'], rel)) != digest:
            raise ValueError('daemon source mismatch')
    exact(config['engine'], ('pid', 'boot_id', 'start_ticks', 'pinokio_home', 'port'))
    engine = config['engine']
    if engine['port'] != 42000 or not isinstance(engine['pinokio_home'], str) or not os.path.isabs(engine['pinokio_home']):
        raise ValueError('invalid engine binding')
    home = Path(engine['pinokio_home']).resolve(strict=True)
    if home.is_symlink() or not home.is_dir():
        raise ValueError('invalid engine home')
    resource = home / 'api/astrid'
    for rel, expected in (('pinokio/stop.js', BINDING['stop_sha256']),
                          ('pinokio/lifecycle.mjs', BINDING['lifecycle_sha256'])):
        if sha(regular(resource / rel)) != expected:
            raise ValueError('engine resource tuple mismatch')
    for rel in ('pinokio/providers/r24-action.cjs', 'pinokio/providers/r24-live-action.js'):
        if sha(regular(resource / rel)) != sources[rel]:
            raise ValueError('engine provider source mismatch')
    scratch = Path(config['scratch_root']).resolve(strict=True) if isinstance(config['scratch_root'], str) else Path('.')
    if not scratch.is_absolute() or scratch.is_symlink() or not scratch.is_dir() or scratch.stat().st_uid != os.getuid():
        raise ValueError('invalid scratch root')
    identity = proc_identity(engine['pid'], node, daemon, engine)
    installed = installed_context(home, resource / 'pinokio/lifecycle.mjs')
    return {'roots': roots, 'pterm': pterm, 'node': node, 'daemon': daemon, 'home': home,
            'resource': resource, 'scratch': scratch, 'engine': identity, 'installed': installed}


def git_blob(root, ref, rel):
    return subprocess.check_output(['git', '-C', str(root), 'show', ref + ':' + rel], stderr=subprocess.DEVNULL, timeout=30)


def invoke_action(node, control):
    return subprocess.run([str(node), str(HERE / 'r24-action.cjs'), str(control)],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120, check=False)


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
    for observation in observations:
        payloads[f"observation-{observation['kind']}.json"] = observation['evidence']
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


def protected_snapshot(context):
    installed = context['installed']
    data = installed['data_root']
    support = data / 'runtime'
    catalog = decode(regular(support / 'catalog.json'))
    selected = catalog.get('selected_realm_id')
    realms = [row for row in catalog.get('realms', []) if isinstance(row, dict) and row.get('realm_id') == selected]
    if len(realms) != 1:
        raise ValueError('selected realm unavailable')
    realm = Path(realms[0]['data_root']).resolve(strict=True)
    database = realm / 'realm.sqlite3'
    if database.is_symlink() or not database.is_file():
        raise ValueError('realm database unavailable')
    connection = sqlite3.connect(f'file:{database}?mode=ro', uri=True, timeout=5)
    try:
        rows = [dict(zip(('task_id', 'capability', 'status'), row)) for row in connection.execute(
            "SELECT id, capability, status FROM tasks WHERE lower(status) IN ('running','cancel_requested') ORDER BY id")]
    finally:
        connection.close()
    watched = [installed['backend_root'] / 'current', installed['backend_root'] / 'install.json',
               installed['version_root'] / 'version.json', support / 'catalog.json', support / 'discovery.json',
               support / 'instance.lock', context['resource'] / 'pinokio/stop.js',
               context['resource'] / 'pinokio/lifecycle.mjs']
    files = {}
    for index, item in enumerate(watched):
        files[str(index)] = sha(regular(item)) if item.exists() else None
    stat = database.stat()
    return {'files': files, 'selected_realm_id_sha256': sha(str(selected).encode()),
            'realm_root_sha256': sha(os.fsencode(realm)), 'database_device': stat.st_dev,
            'database_inode': stat.st_ino, 'active_tasks': rows}


def validate_live_result(value, request, session):
    exact(value, ('schema', 'session', 'request_sha256', 'binding', 'busy', 'unknown', 'restoration'))
    if value['schema'] != 'astrid.r24.live-action-result.v1' or value['session'] != session or \
            value['request_sha256'] != sha(canonical(request)):
        raise ValueError('live action binding mismatch')
    exact(value['binding'], ('request_id', 'results', 'stop_observed', 'disconnect_observed'))
    if value['binding']['results'] != 1 or value['binding']['stop_observed'] is not True or \
            value['binding']['disconnect_observed'] is not True:
        raise ValueError('engine settlement unavailable')
    busy = value['busy']
    exact(busy, ('task_count', 'blockers', 'headline_sha256', 'stop_refused', 'fence'))
    if type(busy['task_count']) is not int or busy['task_count'] < 1 or busy['stop_refused'] is not True or not busy['blockers']:
        raise ValueError('busy not established')
    for blocker in busy['blockers']:
        exact(blocker, ('task_id', 'blocker_kind', 'kind', 'state'))
        if not all(isinstance(blocker[key], str) and blocker[key] for key in ('task_id', 'blocker_kind', 'state')):
            raise ValueError('busy identity unavailable')
    match(busy['headline_sha256'], HEX64)
    exact(value['unknown'], ('observer_lost', 'preflight', 'fence'))
    preflight = value['unknown']['preflight']
    exact(preflight, ('child_pid', 'python_sha256', 'armed', 'drained', 'signal'))
    if value['unknown']['observer_lost'] is not True or preflight['armed'] is not True or preflight['drained'] is not True \
            or preflight['signal'] != 'SIGKILL' or type(preflight['child_pid']) is not int:
        raise ValueError('unknown was not safely drained')
    match(preflight['python_sha256'], HEX64)
    restoration = value['restoration']
    exact(restoration, ('request_id', 'results', 'stop_observed', 'disconnect_observed', 'preflight', 'observer_usable'))
    if restoration['results'] != 1 or restoration['stop_observed'] is not True or \
            restoration['disconnect_observed'] is not True or restoration['observer_usable'] is not True:
        raise ValueError('restoration unavailable')
    for fence in (busy['fence'], value['unknown']['fence']):
        exact(fence, ('request_id', 'connect_observed', 'disconnect_observed', 'idle_observed'))
        if any(fence[key] is not True for key in ('connect_observed', 'disconnect_observed', 'idle_observed')):
            raise ValueError('request fence unavailable')
    return value


def remove_control(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in ('arm', 'ready.json', 'drained.json', 'control.json'):
            try:
                os.unlink(name, dir_fd=descriptor)
            except FileNotFoundError:
                pass
    finally:
        os.close(descriptor)
    directory.rmdir()


def collect_authenticated(request, session, context):
    """Collect live engine facts; external hosted custody is still M-CI-owned."""
    before = protected_snapshot(context)
    token = secrets.token_hex(8)
    control_dir = context['scratch'] / f'r24-{session}-{token}'
    control_dir.mkdir(mode=0o700)
    installed = context['installed']
    control = {'schema': 'astrid.r24.live-control.v1', 'pterm': str(context['pterm']),
        'session': session, 'request_sha256': sha(canonical(request)),
        'live_uri': str(context['resource'] / 'pinokio/providers/r24-live-action.js'),
        'stop_uri': str(context['resource'] / 'pinokio/stop.js'),
        'lifecycle': str(context['resource'] / 'pinokio/lifecycle.mjs'),
        'lifecycle_sha256': BINDING['lifecycle_sha256'], 'backend_root': str(installed['backend_root']),
        'python': str(installed['python']), 'python_sha256': installed['python_sha256'],
        'data_root': str(installed['data_root']), 'control_dir': str(control_dir)}
    control_path = control_dir / 'control.json'
    fd = os.open(control_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(canonical(control))
    proc = invoke_action(context['node'], control_path)
    if proc.returncode != 0:
        raise ValueError('live action collection failed')
    action = validate_live_result(decode(proc.stdout), request, session)
    after = protected_snapshot(context)
    if before != after:
        raise ValueError('protected state changed')
    if {row['task_id'] for row in before['active_tasks']} != {row['task_id'] for row in action['busy']['blockers']}:
        raise ValueError('busy task census mismatch')
    remove_control(control_dir)
    common = {'schema': 'astrid.r24.live-observation.v1', 'request_sha256': sha(canonical(request)),
              'run_id': request['run_id'], 'session': session, 'engine': context['engine'],
              'provider_ref': request['provider']['ref']}
    payloads = {
        'busy': {**common, 'kind': 'busy', 'engine_binding': action['binding'], 'busy': action['busy'],
                 'protected_before': before, 'protected_after': after},
        'unknown': {**common, 'kind': 'unknown', 'unknown': action['unknown'],
                    'protected_before': before, 'protected_after': after},
        'restoration': {**common, 'kind': 'restoration', 'restoration': action['restoration'],
                        'protected_before': before, 'protected_after': after, 'control_removed': not control_dir.exists()},
    }
    source = 'pinokio/providers/r24-action.cjs'
    outcomes = {'busy': 'busy-observed', 'unknown': 'unknown-safely-handled', 'restoration': 'restored'}
    observations = []
    for kind in ('busy', 'unknown', 'restoration'):
        evidence = canonical(payloads[kind])
        observations.append({'kind': kind, 'outcome': outcomes[kind], 'safe': True,
            'request_sha256': common['request_sha256'], 'run_id': request['run_id'], 'session': session,
            'source': source, 'source_sha256': request['provider']['sources'][source],
            'evidence': evidence, 'evidence_sha256': sha(evidence)})
    return observations


def run(request, config, export_destination=None):
    context = validate(request, config)
    session = secrets.token_hex(16)
    try:
        observations = collect_authenticated(request, session, context)
        result = serialize_success(request, session, observations)
        if export_destination is not None:
            seal_observations(request, session, observations, export_destination)
        return result, None
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        action = {'end': 'observer-error', 'settlement': 'unknown'}
    # A failed live control, drain, state comparison, or export never becomes a
    # success result. External Actions/broker custody is evaluated separately.
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
