#!/usr/bin/env python3
"""Bounded teardown of exactly the workflow-created disposable Linux UID."""
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path


def emit(file, value):
    Path(file).write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def process_uids(pid, proc_root=Path('/proc')):
    try:
        text = (proc_root / str(pid) / 'status').read_text(encoding='utf-8')
    except FileNotFoundError:
        return None
    match = re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$', text, re.MULTILINE)
    if not match:
        raise RuntimeError('unreadable process identity')
    return tuple(int(value) for value in match.groups())


def process_ids(uid, proc_root=Path('/proc')):
    found = []
    for entry in proc_root.iterdir():
        if not entry.name.isdecimal():
            continue
        uids = process_uids(int(entry.name), proc_root)
        if uids is not None and uid in uids:
            found.append(int(entry.name))
    return found


def owned(pid, uid):
    # Refuse to signal a process with any elevated or foreign UID. Its presence
    # still blocks cleanup proof and the disposable VM remains containment.
    return process_uids(pid) == (uid, uid, uid, uid)


def no_listener(port):
    out = subprocess.run(["ss", "-ltnH"], capture_output=True, text=True, check=True, timeout=5).stdout
    return not any(re.search(rf":{port}\s", line) for line in out.splitlines())


def copy_collector(user, uid, gid, root, target):
    # Drop all privileges before opening any account-owned content. Bind the
    # leaf to an O_NOFOLLOW directory fd and cap it before root writes a copy.
    script = """import os,stat,sys
root=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
fd=os.open('collector.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=root)
if not stat.S_ISREG(os.fstat(fd).st_mode): raise SystemExit(1)
sys.stdout.buffer.write(os.read(fd,200001))
"""
    def drop():
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    result = subprocess.run([sys.executable, '-I', '-c', script, root], preexec_fn=drop,
                            env={'HOME': root + '/home', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'},
                            capture_output=True, timeout=5)
    if result.returncode == 0:
        Path(target).write_bytes(result.stdout)


def cleanup(user, root, marker, collector_target, target):
    result = {"uidProcessesAbsent": False, "daemonListenerAbsent": False,
              "runtimeListenerAbsent": False, "forcedTeardown": True, "accountRemoved": False}
    try:
        if os.geteuid() != 0 or not re.fullmatch(r"astrid[0-9]+", user):
            raise ValueError("bad identity")
        if not re.fullmatch(r"/tmp/astrid-idle-[0-9]+-[0-9]+", root):
            raise ValueError("bad root")
        marker_path = Path(marker)
        marker_info = marker_path.lstat()
        if not stat.S_ISREG(marker_info.st_mode) or marker_info.st_uid != 0 or stat.S_IMODE(marker_info.st_mode) != 0o600:
            raise ValueError("untrusted custody marker")
        custody = json.loads(marker_path.read_text(encoding="utf-8"))
        account = pwd.getpwnam(user)
        uid = account.pw_uid
        if custody != {"user": user, "root": root, "uid": uid}:
            raise ValueError("custody mismatch")
        if uid <= 1000 or account.pw_dir != root + "/home" or uid == os.getuid():
            raise ValueError("uid/home mismatch")
        try:
            copy_collector(user, uid, account.pw_gid, root, collector_target)
        except Exception:
            pass  # Missing collector evidence must remain UNKNOWN.
        # Never kill a process by stale PID after it changes ownership.
        prior = process_ids(uid)
        result["forcedTeardown"] = bool(prior)
        for pid in prior:
            if owned(pid, uid):
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
        deadline = time.monotonic() + 8
        while process_ids(uid) and time.monotonic() < deadline:
            time.sleep(.2)
        for pid in process_ids(uid):
            if owned(pid, uid):
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        deadline = time.monotonic() + 4
        while process_ids(uid) and time.monotonic() < deadline:
            time.sleep(.2)
        result["uidProcessesAbsent"] = not process_ids(uid)
        result["daemonListenerAbsent"] = no_listener(42000)
        result["runtimeListenerAbsent"] = no_listener(17340)
        if result["uidProcessesAbsent"]:
            subprocess.run(["userdel", user], check=True, capture_output=True, timeout=10)
            result["accountRemoved"] = True
    except Exception:
        # No exception text, command line, token or process output is exported.
        pass
    emit(target, result)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == '--census':
        try:
            uid = int(sys.argv[2])
            if os.geteuid() != 0 or uid <= 1000 or process_ids(uid):
                raise SystemExit(1)
            raise SystemExit(0)
        except Exception:
            raise SystemExit(1)
    if len(sys.argv) != 6:
        raise SystemExit(2)
    cleanup(*sys.argv[1:])
