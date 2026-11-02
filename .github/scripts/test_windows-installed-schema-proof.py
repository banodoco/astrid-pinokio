"""Focused, dependency-free checks for the Windows child diagnostic boundary."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).with_name("windows-installed-schema-proof.py")
SPEC = importlib.util.spec_from_file_location("windows_schema_proof", SCRIPT)
assert SPEC and SPEC.loader
proof = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = proof
SPEC.loader.exec_module(proof)


class Node:
    nodeid = proof.TARGET_NODEID


class OtherNode:
    nodeid = "tests/test_installer_installed_schema.py::unrelated_failure"


def interact(plugin, output: str, returncode: int = 1, node=Node()):
    error = subprocess.CalledProcessError(returncode, ["python"], output=output)
    plugin.pytest_exception_interact(node, SimpleNamespace(excinfo=SimpleNamespace(value=error)), None)
    return error


def main() -> None:
    prior_agent = os.environ.get("AGENT_REF")
    os.environ["AGENT_REF"] = "a" * 40
    try:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "runtime.lock.json").write_text(
                '{"source_commit": "b' + "b" * 39 + '"}', encoding="utf-8"
            )
            previous = Path.cwd()
            os.chdir(root)
            try:
                plugin = proof.ChildFailureDiagnostic(root)
                raw = (
                    "Traceback (most recent call last):\n"
                    '  File "<string>", line 42, in <module>\n'
                    "AssertionError: https://example.invalid/private-value\n"
                )
                interact(plugin, raw, node=OtherNode())
                assert not (root / proof.CHILD_DIAGNOSTIC).exists()
                original = interact(plugin, raw)
                assert original.returncode == 1 and original.output == raw
                retained = (root / proof.CHILD_DIAGNOSTIC).read_text(encoding="ascii")
                expected = (
                    "format=windows-installed-schema-child-diagnostic-v1\n"
                    f"nodeid={proof.TARGET_NODEID}\n"
                    f"agent_sha={'a' * 40}\n"
                    f"runtime_sha={'b' * 40}\n"
                    "child_returncode=1\n"
                    "child_error_class=AssertionError\n"
                    "child_error_line=42\n"
                )
                assert retained == expected
                assert "example.invalid" not in retained and "private-value" not in retained
                # The first observed failure is retained; later output cannot replace it.
                interact(plugin, 'File "<string>", line 99, in <module>\nValueError: changed')
                assert (root / proof.CHILD_DIAGNOSTIC).read_text(encoding="ascii") == expected
            finally:
                os.chdir(previous)
    finally:
        if prior_agent is None:
            os.environ.pop("AGENT_REF", None)
        else:
            os.environ["AGENT_REF"] = prior_agent
    print("windows child diagnostic focused checks: ok")


if __name__ == "__main__":
    main()
