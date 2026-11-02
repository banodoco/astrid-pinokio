#!/usr/bin/env python3
"""Synthetic protocol checks only; no live action or M4-6 evidence."""
from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "pinokio/providers/r25-linux-mode-actions.py"
SPEC = importlib.util.spec_from_file_location("r25_mode_actions", SOURCE)
assert SPEC is not None and SPEC.loader is not None
r25 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r25)


class ModeActionTests(unittest.TestCase):
    def setUp(self):
        self.request = {
            "schema": r25.SCHEMA,
            "candidate": dict(r25.r24.BINDING["candidate"]),
            "mode": "backend",
            "provider": {"ref": "a" * 40,
                         "sources": {name: "b" * 64 for name in r25.FILES}},
            "r24_request_sha256": "c" * 64,
            "r24_seam_sha256": "d" * 64,
            "config_sha256": "e" * 64,
            "run_id": "f" * 32,
        }

    def controller_result(self, mode="backend"):
        rows = []
        for operation in r25.OPERATIONS[mode]:
            request_id = f"request-{operation}"
            rows.append({"operation": operation, "uri": r25.ACTION_URIS[operation],
                         "request_id": request_id, "error": "busy task-1",
                         "fence": {"request_id": request_id, "connect_observed": True,
                                   "disconnect_observed": True, "idle_observed": True}})
        return {"schema": r25.CONTROL_SCHEMA, "session": "1" * 32,
                "request_sha256": r25.sha(r25.canonical(self.request)),
                "mode": mode, "actions": rows}

    def test_validates_exact_refusals_and_redacts_raw_error(self):
        projected = r25.validate_control_result(
            r25.canonical(self.controller_result()), self.request, "1" * 32,
            "backend", {"task-1"})
        self.assertEqual([row["operation"] for row in projected],
                         ["update", "keep_data_uninstall"])
        self.assertNotIn("busy task-1", json.dumps(projected))
        forged = self.controller_result()
        forged["actions"][0]["error"] = "generic refusal"
        with self.assertRaisesRegex(r25.ModeActionFailure, "genuine busy refusal"):
            r25.validate_control_result(r25.canonical(forged), self.request, "1" * 32,
                                        "backend", {"task-1"})

    def test_collect_keeps_protected_state_equal_and_scenarios_not_run(self):
        snapshot = {"active_tasks": [{"task_id": "task-1"}],
                    "runtime": {"pid": 42}, "files": {}}
        process = subprocess.CompletedProcess(
            ["node"], 0, r25.canonical(self.controller_result()), b"")
        with patch.object(r25.r24, "protected_snapshot", return_value=snapshot), \
             patch.object(r25, "mode_snapshot", return_value={"mode": "backend"}), \
             patch.object(r25, "invoke_controller", return_value=process), \
             patch.object(r25.secrets, "token_hex", return_value="1" * 32):
            result = r25.collect(self.request, {})
        self.assertEqual(result["slot_id"], "pinokio-backend-linux")
        self.assertTrue(result["protected"]["unchanged"])
        self.assertEqual(result["scenarios"]["interruption_recovery"]["status"], "not-run")
        self.assertFalse(result["scenarios"]["keep_data_uninstall"]["successful_uninstall"])
        self.assertFalse(result["boundary"]["authenticated_custody"])
        self.assertFalse(result["boundary"]["m4_6_receipt"])

    def test_fully_local_never_dispatches_update(self):
        self.request["mode"] = "fully-local"
        result = self.controller_result("fully-local")
        result["request_sha256"] = r25.sha(r25.canonical(self.request))
        projected = r25.validate_control_result(
            r25.canonical(result), self.request, "1" * 32,
            "fully-local", {"task-1"})
        self.assertEqual([row["operation"] for row in projected], ["keep_data_uninstall"])

    def test_request_binding_delegates_to_exact_r24_validator(self):
        r24_request = {"schema": "astrid.r24.provider-request.v1",
                       "candidate": self.request["candidate"], "provider": {}, "stop": {},
                       "config_sha256": "2" * 64, "run_id": self.request["run_id"]}
        config = {"fixture": True}
        self.request["r24_request_sha256"] = r25.sha(r25.canonical(r24_request))
        self.request["config_sha256"] = r25.sha(r25.canonical(config))
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(r25, "_provider_sources"), \
             patch.object(r25.r24, "validate", return_value={"validated": True}) as validate:
            result = r25.validate_request(
                self.request, r24_request, config, Path(directory).resolve())
        self.assertEqual(result[3], {"validated": True})
        validate.assert_called_once_with(r24_request, config)

    def test_failure_is_diagnostic_not_a_success_record(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(r25, "validate_request", side_effect=r25.ModeActionFailure("closed")):
            result, diagnostic = r25.run(
                self.request, {}, {}, Path(directory).resolve())
        self.assertIsNone(result)
        self.assertEqual(diagnostic["status"], "unknown")
        self.assertEqual(diagnostic["qualification"], "not-evaluated")


if __name__ == "__main__":
    unittest.main()
