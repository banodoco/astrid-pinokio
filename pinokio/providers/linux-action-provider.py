#!/usr/bin/env python3
"""Read-only Linux action-provider v1; see the task receipt for its wire contract.

This diagnostic is not an R-30 export or an authenticated session. It never
calls Pinokio or dispatches an action: the required terminal and control sources
are not bound. All input paths are hints, not provenance or authority.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time

PINS = {
    "app": "ae95eb455408b8c0e185bfded67798e2b307a6f6",
    "agent": "dd6b48192c720c5346e6f140184e313b2cf84f31",
    "runtime": "1e6d899efa77a2d6ec247c38250f9748330bb587",
    "pinokio": "2f085c5fc0cde192ac4a022065883c85dcccd0de",
}
FILES = {
    ("app", "public/install-manifest.json"): "15ea3a2e0a4067773b727635e4eaa4b894eceb10f73aaa88cd29896a2364bd77",
    ("pinokio", "pinokio/update.js"): "1be13ca4d415d1693e0493a0d81d7aecf616f27ab3875a94ea5d9ebb69aba9e5",
    ("pinokio", "pinokio/start.js"): "442ff8fb73d65047bc4dd34de997bd36920efab16733aeb6ddd967afe291c037",
    ("pinokio", "pinokio/lib.js"): "59bb0a556b425dafb4d986aaab54f0dbd23a988814a0d64a6cb4437c52d3d998",
    ("pinokio", "pinokio/lifecycle.mjs"): "0ddc6a5596dc02a2f33afba799495c7834ebb193df33fe15c376c2b60859a3ad",
    ("pinokio", "pinokio/session.mjs"): "460ff77a8cda2b711c785a607e4a399f8c33ddc903496e4c769b717d010aad99",
}
MAX_INPUT = 16384
MAX_FILE = 1024 * 1024
GIT = "/usr/bin/git"


class Refusal(Exception):
    def __init__(self, reason):
        self.reason = reason


def _file_hash(root, relative):
    # Final component must be a regular file; never read devices or unbounded data.
    fd = os.open(os.path.join(root, relative), os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE:
            raise Refusal("file-unavailable")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(MAX_FILE + 1)
        after = os.fstat(fd)
        if (len(data) > MAX_FILE or len(data) != before.st_size or
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise Refusal("file-changed")
        return hashlib.sha256(data).hexdigest()
    finally:
        os.close(fd)


def _head(root, remaining):
    if remaining <= 0:
        raise Refusal("timeout")
    try:
        proc = subprocess.run([GIT, "--no-optional-locks", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              timeout=remaining, check=False, env={"PATH": "/usr/bin:/bin", "HOME": "/dev/null",
                              "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                              "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"})
    except subprocess.TimeoutExpired:
        raise Refusal("timeout") from None
    except OSError:
        raise Refusal("git-unavailable") from None
    if proc.returncode or not re.fullmatch(rb"[0-9a-f]{40}\n", proc.stdout):
        raise Refusal("head-unavailable")
    return proc.stdout.decode("ascii").strip()


def observe(request):
    """Observe fixed checkout pins; never execute or retry an engine action.

    request: exact dict {operation:'observe', checkouts:{app,agent,runtime,
    pinokio:absolute directories}, timeout_seconds:int 1..30}. Returns a bounded
    diagnostic dict; neither input paths nor returned observations are authority.
    """
    result = {"schema": "pinokio-linux-action-provider/v1", "status": "unknown",
              "reason": "terminal-source-unavailable", "pin_status": "not-run",
              "observations": [], "action": "not-run", "settlement": "unknown",
              "control_plane": "unknown", "busy": "not-run", "restoration": "not-run"}
    try:
        if sys.platform != "linux":
            raise Refusal("unsupported-platform")
        if not isinstance(request, dict) or set(request) != {"operation", "checkouts", "timeout_seconds"}:
            raise Refusal("invalid-request")
        if request["operation"] != "observe":
            raise Refusal("unsupported-operation")
        roots = request["checkouts"]
        if not isinstance(roots, dict) or set(roots) != set(PINS):
            raise Refusal("invalid-checkouts")
        if any(not isinstance(p, str) or not p or len(os.fsencode(p)) > 4096 or
               "\x00" in p or not os.path.isabs(p) or not os.path.isdir(p) for p in roots.values()):
            raise Refusal("invalid-checkouts")
        timeout = request["timeout_seconds"]
        if type(timeout) is not int or not 1 <= timeout <= 30:
            raise Refusal("invalid-timeout")
        deadline = time.monotonic() + timeout
        result["pin_status"] = "unknown"
        for name, expected in PINS.items():
            value = _head(roots[name], deadline - time.monotonic())
            result["observations"].append({"kind": "checkout-head", "name": name, "value": value})
            if value != expected:
                raise Refusal("foreign-head")
        for (name, relative), expected in FILES.items():
            if time.monotonic() >= deadline:
                raise Refusal("timeout")
            try:
                value = _file_hash(roots[name], relative)
            except OSError:
                raise Refusal("file-unavailable") from None
            result["observations"].append({"kind": "file-sha256", "name": name, "path": relative, "value": value})
            if value != expected:
                raise Refusal("foreign-file")
        # Re-read HEADs: moving refs during this capture invalidates the snapshot.
        for name, expected in PINS.items():
            if _head(roots[name], deadline - time.monotonic()) != expected:
                raise Refusal("head-changed")
        result["pin_status"] = "matched"
    except Refusal as exc:
        result["reason"] = exc.reason
    except (OSError, ValueError, TypeError, RecursionError):
        result["reason"] = "invalid-request"
    return result


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def main():
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise ValueError("request too large")
        request = json.loads(data, object_pairs_hook=_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))
    except (ValueError, UnicodeError, RecursionError):
        request = None
    print(json.dumps(observe(request), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
