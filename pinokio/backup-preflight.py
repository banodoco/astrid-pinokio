"""Read-only eligibility check for the installed updater's support-tree copy."""

import json
import os
import sys
from pathlib import Path

def document(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def scan(source, policy, *, support=False):
    if not source.is_dir():
        raise ValueError(f"Backup source is unavailable: {source}")

    def failed(error):
        raise error

    for folder, directories, files in os.walk(source, onerror=failed, followlinks=False):
        parent = Path(folder)
        ignored = policy(source, parent, directories + files, support=support)
        directories[:] = [name for name in directories if name not in ignored]


def preflight(root):
    from astrid.installer.backend import Backend
    from astrid.installer.core import absolute
    from astrid.installer import service

    root = absolute(root)
    install = document(root / "install.json")
    if install.get("owner") != "haus.astrid.runtime" or install.get("managed_by") != "pinokio":
        raise ValueError("The Astrid install record is not owned by Pinokio.")
    data = absolute(install["data_root"])
    selection = absolute(service.install_selection(Path.home(), sys.platform))
    if selection.exists():
        recorded = document(selection)
        if recorded and recorded.get("owner") != "haus.astrid.runtime":
            raise ValueError(f"The Astrid selection record belongs to another installer: {selection}")
        if recorded:
            if not isinstance(recorded.get("data_root"), str) or not recorded["data_root"]:
                raise ValueError(f"The Astrid selection record has no support root: {selection}")
            if absolute(recorded["data_root"]) != data:
                raise ValueError(f"Astrid selection record and install.json name different support roots: {selection}")
            if "program_root" in recorded:
                if not isinstance(recorded["program_root"], str) or not recorded["program_root"]:
                    raise ValueError(f"The Astrid selection record has no valid program root: {selection}")
                if absolute(recorded["program_root"]) != root:
                    raise ValueError(f"Astrid selection record names a different program root: {selection}")
    scan(data, Backend._backup_ignored, support=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Expected the Astrid program root.")
        preflight(Path(sys.argv[1]))
    except ImportError as error:
        raise SystemExit(f"Installed backup policy is unavailable: {error}")
    except Exception as error:
        raise SystemExit(f"Backup preflight refused: {error}")

