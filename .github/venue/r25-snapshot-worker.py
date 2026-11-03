#!/usr/bin/env python3
"""Small protocol bridge that keeps one real SnapshotSession open per action."""

import json
import sys
from pathlib import Path

from scripts.pinokio_snapshot_collector import SnapshotSession, platform_capture


def send(value):
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: r25-snapshot-worker.py REQUEST OUTPUT")
    request_path = Path(sys.argv[1])
    output = Path(sys.argv[2])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    session = SnapshotSession(request, output, capture=platform_capture(request))
    current = None
    for line in sys.stdin:
        command = json.loads(line)
        operation = command.get("op")
        if operation == "open":
            if current is not None:
                raise RuntimeError("snapshot action already open")
            action = command["action"]
            current = session.action(action, poll_interval_seconds=30.0, max_poll_samples=1)
            current.__enter__()
            send({"ok": True, "op": "open", "action": action})
        elif operation == "close":
            if current is None:
                raise RuntimeError("snapshot action is not open")
            failed = bool(command.get("failed"))
            error = RuntimeError("real engine action failed") if failed else None
            current.__exit__(RuntimeError, error, None) if error else current.__exit__(None, None, None)
            current = None
            send({"ok": True, "op": "close"})
        elif operation == "finalize":
            if current is not None:
                raise RuntimeError("cannot finalize with an open snapshot action")
            receipt = session.finalize()
            send({"ok": True, "op": "finalize", "status": receipt.get("status")})
            return
        else:
            raise RuntimeError(f"unknown worker operation: {operation!r}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        send({"ok": False, "error": str(error)[:240]})
        raise
