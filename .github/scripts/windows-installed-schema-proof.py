"""Run the candidate-bound Windows schema selectors with a bounded child diagnostic.

The installed-wheel selector intentionally runs an isolated child interpreter.  Its
test fixture turns any non-zero child exit into ``CalledProcessError`` and pytest's
normal JUnit report omits that exception's ``output`` field.  This hook observes
only that exact selector and records no child text: it writes fixed, bounded
metadata that maps a Python exception to the line in the selector's inline script.
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


TARGET_NODEID = (
    "tests/test_installer_installed_schema.py::"
    "test_stage_binds_installed_reader_validator_and_service_to_verified_schema"
)
SELECTED_NODES = (
    TARGET_NODEID,
    "tests/core/rendering/test_local_schema.py::test_windows_captured_acl_same_owner_is_admitted",
    "tests/core/rendering/test_local_schema.py::test_windows_schema_rejects_unsafe_acl",
    "tests/core/rendering/test_local_schema.py::test_windows_installed_schema_checks_both_source_and_destination",
    "tests/core/rendering/test_local_schema.py::test_windows_schema_admission_uses_sid_policy",
    "tests/core/rendering/test_local_schema.py::test_windows_native_schema_dacl_allows_privileged_and_rejects_foreign",
    "tests/core/rendering/test_remotion_host_regressions.py::test_admission_reprobes_node_after_successful_launch",
)
CHILD_DIAGNOSTIC = "windows-installed-schema-child-diagnostic.txt"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
INLINE_LINE = re.compile(r'\s*File "<string>", line ([0-9]{1,6}), in <module>\s*\Z')
KNOWN_EXCEPTION = re.compile(
    r"(?:AssertionError|AttributeError|FileNotFoundError|ImportError|JSONDecodeError|"
    r"KeyError|ModuleNotFoundError|OSError|PermissionError|RuntimeError|"
    r"SystemExit|TypeError|ValueError)\b"
)


def _safe_sha(value: object) -> str:
    """Return a SHA only when it is already a public, immutable identifier."""
    text = str(value)
    return text if SHA40.fullmatch(text) else "unverified"


def _runtime_sha() -> str:
    try:
        value = json.loads(Path("runtime.lock.json").read_text(encoding="utf-8"))["source_commit"]
    except (OSError, ValueError, KeyError, TypeError):
        return "unverified"
    return _safe_sha(value)


def _child_error_fields(output: object) -> tuple[str, str]:
    """Extract only an allowlisted exception class and inline-script line number.

    The child output can include paths, URLs, environment-derived strings, or
    exception messages.  It is never returned or written.  The retained values
    are constrained to an allowlisted exception token and a decimal source line.
    """
    if isinstance(output, bytes):
        text = output.decode("utf-8", errors="replace")
    elif isinstance(output, str):
        text = output
    else:
        text = ""
    error_class = "unclassified"
    line_number = "unavailable"
    for line in reversed(text.splitlines()):
        if error_class == "unclassified":
            match = KNOWN_EXCEPTION.search(line)
            if match:
                error_class = match.group(0)
        if line_number == "unavailable":
            match = INLINE_LINE.fullmatch(line)
            if match:
                line_number = match.group(1)
        if error_class != "unclassified" and line_number != "unavailable":
            break
    return error_class, line_number


class ChildFailureDiagnostic:
    """A no-throw pytest hook that cannot alter the candidate test result."""

    def __init__(self, proof_dir: Path) -> None:
        self.proof_dir = proof_dir
        self.recorded = False

    def pytest_exception_interact(self, node, call, report) -> None:
        if self.recorded or getattr(node, "nodeid", None) != TARGET_NODEID:
            return
        error = getattr(getattr(call, "excinfo", None), "value", None)
        if not isinstance(error, subprocess.CalledProcessError):
            return
        try:
            returncode = int(error.returncode)
            if not -2147483648 <= returncode <= 2147483647:
                return
            error_class, line_number = _child_error_fields(error.output)
            payload = (
                "format=windows-installed-schema-child-diagnostic-v1\n"
                f"nodeid={TARGET_NODEID}\n"
                f"agent_sha={_safe_sha(os.environ.get('AGENT_REF', ''))}\n"
                f"runtime_sha={_runtime_sha()}\n"
                f"child_returncode={returncode}\n"
                f"child_error_class={error_class}\n"
                f"child_error_line={line_number}\n"
            ).encode("ascii")
            # This is fixed metadata; retaining a hard cap makes accidental future
            # expansion fail closed rather than turning this into a log sink.
            if len(payload) > 512:
                return
            (self.proof_dir / CHILD_DIAGNOSTIC).write_bytes(payload)
            self.recorded = True
        except (OSError, TypeError, ValueError):
            # The hook is observational.  A diagnostic write problem must never
            # replace or hide the selected test's original failure.
            return


def main() -> None:
    sys.path.insert(0, os.getcwd())
    import pytest
    import tests.lanes as lanes
    from runtime_protocol import windows_security

    assert sys.platform == "win32"
    proof_dir = Path(os.environ["PROOF_DIR"])
    user = windows_security._user_sid()
    owner = windows_security._default_owner_sid()
    same_owner = bool(windows_security._api()[0].EqualSid(user, owner))
    identity = (
        f"Windows token user SID: {windows_security._sid_text(user)}\n"
        f"Windows default owner SID: {windows_security._sid_text(owner)}\n"
        f"Windows token user/default owner match: {same_owner}\n"
    )
    print(identity, end="", flush=True)
    with (proof_dir / "identity.txt").open("a", encoding="utf-8") as stream:
        stream.write(identity)
    # This one installed-wheel test is marked linux_native at module scope.
    # Enable its collection on Windows explicitly; all test assertions remain intact.
    lanes.LANES["linux_native"] = dataclasses.replace(lanes.LANES["linux_native"], available=lambda: True)
    xml = proof_dir / "windows-schema.xml"
    result = pytest.main([
        "-q", "-rA", *SELECTED_NODES,
        f"--junitxml={xml}",
    ], plugins=[ChildFailureDiagnostic(proof_dir)])
    if result != 0:
        raise SystemExit(result)
    cases = list(ET.parse(xml).getroot().iter("testcase"))
    required = (
        "test_stage_binds_installed_reader_validator_and_service_to_verified_schema",
        "test_windows_native_schema_dacl_allows_privileged_and_rejects_foreign",
    )
    if any(sum(
        case.get("name") == name and not any(
            case.find(tag) is not None for tag in ("skipped", "failure", "error")
        )
        for case in cases
    ) != 1 for name in required):
        raise SystemExit("Required installed or native test did not pass exactly once")
    if any(case.find("skipped") is not None for case in cases):
        raise SystemExit("A selected proof test was skipped")


if __name__ == "__main__":
    main()
