#!/usr/bin/env python3
"""Bounded Linux mode-action observations layered on the approved R-24 seam.

This provider executes only genuine actions that are safe while R-24's real
busy task remains active.  Backend Update and both modes' keep-data Uninstall
must refuse before any pull/bootstrap/removal, and the protected snapshots
must remain identical.  Fully-local Update is intentionally not dispatched:
it stages/builds before its final Stop fence.  Interruption/recovery, failed-
candidate rollback and successful uninstall still require the authenticated
R-36 session/removal/finalization interface and remain explicitly not-run.

The output is a non-qualifying observation record, never an M4-6 receipt.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping

HERE = Path(__file__).resolve().parent
BASE = HERE.parent.parent
R24_PATH = HERE / "r24-linux.py"
_SPEC = importlib.util.spec_from_file_location("astrid_r24_linux", R24_PATH)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - source invariant
    raise RuntimeError("R-24 provider module is unavailable")
r24 = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(r24)

SCHEMA = "astrid.r25.linux-mode-actions-request.v1"
RESULT_SCHEMA = "astrid.r25.linux-mode-actions-result.v1"
CONTROL_SCHEMA = "astrid.r25.linux-mode-action-control-result.v1"
FILES = (
    "pinokio/providers/r25-linux-mode-actions.py",
    "pinokio/providers/r25-mode-actions.cjs",
)
MODES = {"backend": "backend", "fully-local": "local"}
OPERATIONS = {
    "backend": ("update", "keep_data_uninstall"),
    "fully-local": ("keep_data_uninstall",),
}
ACTION_URIS = {
    "update": "~/api/astrid/pinokio/update.js",
    "keep_data_uninstall": "~/api/astrid/pinokio/uninstall.js",
}
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
MAX_STREAM_BYTES = 64 * 1024
APP_ORIGIN = "https://github.com/banodoco/astrid-app"


class ModeActionFailure(ValueError):
    """The bounded action could not be observed without changing its meaning."""


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact(value: object, keys: tuple[str, ...], label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != set(keys):
        raise ModeActionFailure(f"{label} fields differ")
    return dict(value)


def digest(value: object, label: str) -> str:
    if not isinstance(value, str) or HEX64.fullmatch(value) is None:
        raise ModeActionFailure(f"{label} must be a SHA-256 digest")
    return value


def decode(value: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in items:
            if key in result:
                raise ModeActionFailure(f"duplicate JSON key: {key}")
            result[key] = item
        return result
    try:
        return json.loads(value, object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              ModeActionFailure("invalid JSON constant")))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise ModeActionFailure("invalid JSON") from exc


def git(root: Path, *args: str) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(root), *args],
                                       stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ModeActionFailure("Git identity validation failed") from exc


def regular(path: Path, limit: int = 8 * 1024 * 1024) -> bytes:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ModeActionFailure(f"missing bounded regular file: {path.name}")
    return path.read_bytes()


def _provider_sources(request: Mapping[str, Any]) -> Path:
    provider = exact(request.get("provider"), ("ref", "sources"), "provider")
    ref = provider.get("ref")
    if not isinstance(ref, str) or HEX40.fullmatch(ref) is None:
        raise ModeActionFailure("provider ref is invalid")
    sources = exact(provider.get("sources"), FILES, "provider sources")
    root = r24.checkout(str(BASE), ref)
    for relative in FILES:
        expected = digest(sources[relative], f"provider source {relative}")
        if (sha(regular(root / relative)) != expected
                or sha(r24.git_blob(root, ref, relative)) != expected):
            raise ModeActionFailure("mode-action provider source mismatch")
    return root


def validate_request(request: object, r24_request: object, config: object,
                     r24_provider_root: Path) -> tuple[
        dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    row = exact(request, ("schema", "candidate", "mode", "provider",
                          "r24_request_sha256", "r24_seam_sha256",
                          "config_sha256", "run_id"), "request")
    if row.get("schema") != SCHEMA or row.get("candidate") != r24.BINDING["candidate"]:
        raise ModeActionFailure("request tuple differs from the R-24 binding")
    mode = row.get("mode")
    if mode not in MODES:
        raise ModeActionFailure("mode must be backend or fully-local")
    if not isinstance(row.get("run_id"), str) or HEX32.fullmatch(row["run_id"]) is None:
        raise ModeActionFailure("run ID is invalid")
    r24_row = exact(r24_request, ("schema", "candidate", "provider", "stop",
                                  "config_sha256", "run_id"), "R-24 request")
    if (sha(canonical(r24_row)) != digest(row.get("r24_request_sha256"), "R-24 request")
            or r24_row.get("run_id") != row["run_id"]
            or r24_row.get("candidate") != row["candidate"]):
        raise ModeActionFailure("R-24 request binding differs")
    digest(row.get("r24_seam_sha256"), "R-24 seam")
    if sha(canonical(config)) != digest(row.get("config_sha256"), "config"):
        raise ModeActionFailure("config binding differs")
    _provider_sources(row)
    if (not isinstance(r24_provider_root, Path) or not r24_provider_root.is_absolute()
            or r24_provider_root.is_symlink() or not r24_provider_root.is_dir()):
        raise ModeActionFailure("absolute R-24 producer checkout is required")
    # R-24 validates this checkout's exact ref, source hashes and cleanliness.
    # Point only its source-root lookup at the separately checked out immutable
    # producer; no request/config semantics are changed.
    r24.BASE = r24_provider_root.resolve(strict=True)
    context = r24.validate(r24_row, config)
    return row, r24_row, dict(config), context


def _tree_inventory(context: Mapping[str, Any]) -> tuple[list[dict[str, str]], str]:
    checkout = context["roots"]["pinokio"]
    ref = r24.BINDING["candidate"]["pinokio"]
    raw_paths = git(checkout, "ls-tree", "-r", "--name-only", ref, "--", "pinokio").decode("utf-8")
    paths = [item for item in raw_paths.splitlines() if item]
    if not paths or len(paths) > 256:
        raise ModeActionFailure("candidate Pinokio action inventory is unavailable")
    resource = context["resource"]
    rows: list[dict[str, str]] = []
    for relative in paths:
        if relative.startswith("/") or any(part in {"", ".", ".."} for part in relative.split("/")):
            raise ModeActionFailure("candidate action path is unsafe")
        expected = sha(r24.git_blob(checkout, ref, relative))
        if sha(regular(resource / relative)) != expected:
            raise ModeActionFailure("materialized action tree differs from candidate")
        rows.append({"path": relative, "sha256": expected})
    return rows, sha(canonical(rows))


def _editor_identity(context: Mapping[str, Any], mode: str) -> dict[str, Any] | None:
    editor = context["resource"] / "app/editor"
    if mode == "backend":
        if editor.exists() or editor.is_symlink():
            raise ModeActionFailure("backend mode unexpectedly contains an editor checkout")
        return None
    if editor.is_symlink() or not editor.is_dir():
        raise ModeActionFailure("fully-local editor checkout is unavailable")
    root = Path(os.fsdecode(git(editor, "rev-parse", "--show-toplevel").strip())).resolve()
    if root != editor.resolve(strict=True) or git(editor, "status", "--porcelain=v1", "--untracked-files=all"):
        raise ModeActionFailure("fully-local editor checkout is dirty or ambiguous")
    head = git(editor, "rev-parse", "HEAD").decode().strip()
    tree = git(editor, "rev-parse", "HEAD^{tree}").decode().strip()
    app_checkout = context["roots"]["app"]
    candidate = r24.BINDING["candidate"]["app"]
    candidate_tree = git(app_checkout, "rev-parse", f"{candidate}^{{tree}}").decode().strip()
    parents = git(app_checkout, "show", "-s", "--format=%P", candidate).decode().split()
    equivalent = [parent for parent in parents
                  if git(app_checkout, "rev-parse", f"{parent}^{{tree}}").decode().strip() == candidate_tree]
    origin = git(editor, "remote", "get-url", "origin").decode().strip().removesuffix(".git").rstrip("/")
    branch = git(editor, "branch", "--show-current").decode().strip()
    if (tree != candidate_tree or head not in equivalent or not branch
            or origin.lower() != APP_ORIGIN.lower()):
        raise ModeActionFailure("fully-local editor is not the published App's tree-equivalent parent")
    return {"head": head, "tree": tree, "candidate": candidate,
            "candidate_tree": candidate_tree, "branch": branch, "origin": APP_ORIGIN}


def mode_snapshot(context: Mapping[str, Any], mode: str) -> dict[str, Any]:
    mode_file = context["resource"] / "app/install-mode.json"
    raw_mode = regular(mode_file, 4096)
    parsed = decode(raw_mode)
    if parsed != {"schema_version": 1, "mode": MODES[mode]}:
        raise ModeActionFailure("installed Pinokio mode differs from the requested slot")
    inventory, tree_sha = _tree_inventory(context)
    return {
        "mode_file_sha256": sha(raw_mode),
        "mode": mode,
        "action_tree_sha256": tree_sha,
        "action_file_count": len(inventory),
        "editor": _editor_identity(context, mode),
    }


def invoke_controller(context: Mapping[str, Any], request: Mapping[str, Any],
                      session: str, mode: str) -> subprocess.CompletedProcess[bytes]:
    control_dir = context["scratch"] / f"r25-mode-{session}-{secrets.token_hex(8)}"
    control_dir.mkdir(mode=0o700)
    control_path = control_dir / "control.json"
    control = {"schema": "astrid.r25.linux-mode-action-control.v1",
               "pterm": str(context["pterm"]), "session": session,
               "request_sha256": sha(canonical(request)), "mode": mode}
    descriptor = os.open(control_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(control))
        argv = [str(context["node"]), str(HERE / "r25-mode-actions.cjs"), str(control_path)]
        return subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=120, check=False)
    finally:
        try:
            control_path.unlink()
            control_dir.rmdir()
        except OSError:
            pass


def validate_control_result(raw: bytes, request: Mapping[str, Any], session: str,
                            mode: str, blockers: set[str]) -> list[dict[str, Any]]:
    if not isinstance(raw, bytes) or len(raw) > MAX_STREAM_BYTES:
        raise ModeActionFailure("mode-action controller output is invalid")
    value = exact(decode(raw), ("schema", "session", "request_sha256", "mode", "actions"),
                  "controller result")
    if (value.get("schema") != CONTROL_SCHEMA or value.get("session") != session
            or value.get("request_sha256") != sha(canonical(request))
            or value.get("mode") != mode):
        raise ModeActionFailure("mode-action controller binding differs")
    actions = value.get("actions")
    if not isinstance(actions, list) or len(actions) != len(OPERATIONS[mode]):
        raise ModeActionFailure("mode-action controller inventory differs")
    projected = []
    for expected, raw_action in zip(OPERATIONS[mode], actions, strict=True):
        action = exact(raw_action, ("operation", "uri", "request_id", "error", "fence"),
                       "mode action")
        error = action.get("error")
        if (action.get("operation") != expected or action.get("uri") != ACTION_URIS[expected]
                or not isinstance(action.get("request_id"), str)
                or not isinstance(error, str) or not error.strip()
                or any(task not in error for task in blockers)):
            raise ModeActionFailure("mode action did not preserve the genuine busy refusal")
        fence = exact(action.get("fence"), ("request_id", "connect_observed",
                                             "disconnect_observed", "idle_observed"), "action fence")
        if (fence.get("request_id") != action["request_id"]
                or any(fence.get(key) is not True for key in
                       ("connect_observed", "disconnect_observed", "idle_observed"))):
            raise ModeActionFailure("mode action request was not fenced")
        projected.append({"operation": expected, "uri": action["uri"],
                          "request_id": action["request_id"],
                          "refusal_sha256": sha(error.encode("utf-8")), "fenced": True})
    return projected


def collect(request: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    mode = str(request["mode"])
    session = secrets.token_hex(16)
    before = {"r24": r24.protected_snapshot(context), "mode": mode_snapshot(context, mode)}
    blockers = {str(row["task_id"]) for row in before["r24"]["active_tasks"]}
    if not blockers:
        raise ModeActionFailure("genuine busy task is unavailable")
    process = invoke_controller(context, request, session, mode)
    if process.returncode != 0:
        raise ModeActionFailure("mode-action controller failed")
    actions = validate_control_result(process.stdout, request, session, mode, blockers)
    after = {"r24": r24.protected_snapshot(context), "mode": mode_snapshot(context, mode)}
    if before != after:
        raise ModeActionFailure("protected state changed across refused mode actions")
    snapshot_sha = sha(canonical(before))
    missing = "R-36 authenticated platform session/removal authorization/finalization interface"
    rollback_status = "not-reached-after-preflight-refusal" if mode == "backend" else "not-dispatched-pre-stop-staging-is-unsafe"
    return {
        "schema": RESULT_SCHEMA,
        "request_sha256": sha(canonical(request)),
        "r24_request_sha256": request["r24_request_sha256"],
        "r24_seam_sha256": request["r24_seam_sha256"],
        "run_id": request["run_id"],
        "session": session,
        "slot_id": f"pinokio-{mode}-linux",
        "mode": mode,
        "actions": actions,
        "protected": {"before_sha256": snapshot_sha, "after_sha256": snapshot_sha,
                      "unchanged": True},
        "scenarios": {
            "stop_safety": {"refused": "mode-actions-observed",
                            "unknown": "bound-to-r24-seam-untrusted",
                            "restoration": "bound-to-r24-seam-untrusted",
                            "status": "partial"},
            "interruption_recovery": {"status": "not-run", "missing": missing},
            "failed_candidate_rollback": {"status": rollback_status, "missing": missing},
            "keep_data_uninstall": {"status": "busy-refusal-observed",
                                    "successful_uninstall": False,
                                    "data_state": "unchanged-preflight-snapshot",
                                    "missing": missing},
        },
        "boundary": {"authenticated_custody": False, "qualification": "not-evaluated",
                     "m4_6_receipt": False, "missing": missing},
    }


def run(request: object, r24_request: object, config: object,
        r24_provider_root: Path) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    request_sha = sha(canonical(request)) if isinstance(request, Mapping) else "0" * 64
    try:
        row, _, _, context = validate_request(
            request, r24_request, config, r24_provider_root)
        return collect(row, context), None
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None, {"schema": "astrid.r25.linux-mode-actions-diagnostic.v1",
                      "request_sha256": request_sha, "status": "unknown",
                      "actions": "not-established", "protected_state": "unknown",
                      "qualification": "not-evaluated"}


def main() -> int:
    if len(sys.argv) != 5:
        print(json.dumps({"schema": "astrid.r25.linux-mode-actions-error.v1",
                          "status": "unknown"}), file=sys.stderr)
        return 2
    try:
        request = decode(Path(sys.argv[1]).read_bytes())
        r24_request = decode(Path(sys.argv[2]).read_bytes())
        config = decode(Path(sys.argv[3]).read_bytes())
        result, diagnostic = run(
            request, r24_request, config, Path(sys.argv[4]))
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        print(json.dumps({"schema": "astrid.r25.linux-mode-actions-error.v1",
                          "status": "unknown"}), file=sys.stderr)
        return 1
    if result is None:
        print(json.dumps(diagnostic, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
