"""Synthetic unit evidence, not a hosted execution or provenance proof."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PATH = Path(__file__).resolve().parents[1] / "pinokio/providers/linux-action-provider.py"
spec = importlib.util.spec_from_file_location("linux_action_provider", PATH)
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sentinel = self.root / "sentinel"
        self.sentinel.write_bytes(b"unchanged")
        self.request = {"operation": "observe", "checkouts": {n: str(self.root) for n in provider.PINS},
                        "timeout_seconds": 3}

    def heads(self, root, remaining):
        # The same fixture root is deliberately reused; order is the provider's fixed order.
        name = list(provider.PINS)[self.calls % len(provider.PINS)]
        self.calls += 1
        return provider.PINS[name]

    def file_hash(self, root, relative):
        return next(value for (name, path), value in provider.FILES.items() if path == relative)

    def run_capture(self, request=None):
        self.calls = 0
        with mock.patch.object(provider, "_head", side_effect=self.heads), \
             mock.patch.object(provider, "_file_hash", side_effect=self.file_hash):
            return provider.observe(self.request if request is None else request)

    def test_matching_pins_still_do_not_authorize_or_run_action(self):
        result = self.run_capture()
        self.assertEqual(result["pin_status"], "matched")
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["settlement"], "unknown")
        self.assertEqual(result["control_plane"], "unknown")
        self.assertEqual(result["action"], "not-run")
        self.assertEqual(result["busy"], "not-run")
        self.assertEqual(result["restoration"], "not-run")
        self.assertEqual(len(result["observations"]), 10)
        self.assertEqual(self.calls, 8)
        self.assertEqual(self.sentinel.read_bytes(), b"unchanged")

    def test_malformed_and_foreign_fields_refused_before_io(self):
        cases = [None, {}, {**self.request, "operation": "update"},
                 {**self.request, "status": "success"},
                 {**self.request, "checkouts": {"app": str(self.root)}},
                 {**self.request, "timeout_seconds": True},
                 {**self.request, "timeout_seconds": 31},
                 {**self.request, "checkouts": {**self.request["checkouts"], "app": "relative"}}]
        with mock.patch.object(provider, "_head") as head, mock.patch.object(provider, "_file_hash") as fh:
            for request in cases:
                with self.subTest(request=request):
                    result = provider.observe(request)
                    self.assertEqual(result["status"], "unknown")
                    self.assertEqual(result["action"], "not-run")
                    self.assertEqual(result["pin_status"], "not-run")
            head.assert_not_called()
            fh.assert_not_called()
        self.assertEqual(self.sentinel.read_bytes(), b"unchanged")

    def test_foreign_head_and_file_stop_observation_without_retry(self):
        with mock.patch.object(provider, "_head", return_value="0" * 40) as head, \
             mock.patch.object(provider, "_file_hash") as fh:
            result = provider.observe(self.request)
            self.assertEqual(result["reason"], "foreign-head")
            self.assertEqual(result["observations"][0]["value"], "0" * 40)
            self.assertEqual(head.call_count, 1)
            fh.assert_not_called()
        self.calls = 0
        with mock.patch.object(provider, "_head", side_effect=self.heads) as head, \
             mock.patch.object(provider, "_file_hash", return_value="f" * 64) as fh:
            result = provider.observe(self.request)
            self.assertEqual(result["reason"], "foreign-file")
            self.assertEqual(result["pin_status"], "unknown")
            self.assertEqual(head.call_count, 4)
            self.assertEqual(fh.call_count, 1)
        self.assertEqual(self.sentinel.read_bytes(), b"unchanged")

    def test_timeout_and_moving_head_are_unknown(self):
        with mock.patch.object(provider.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 1)) as run:
            result = provider.observe(self.request)
            self.assertEqual(result["reason"], "timeout")
            self.assertEqual(result["action"], "not-run")
            self.assertEqual(run.call_count, 1)
        self.calls = 0
        def moving(root, remaining):
            value = self.heads(root, remaining)
            return "0" * 40 if self.calls == 5 else value
        with mock.patch.object(provider, "_head", side_effect=moving), \
             mock.patch.object(provider, "_file_hash", side_effect=self.file_hash):
            result = provider.observe(self.request)
            self.assertEqual(result["reason"], "head-changed")
            self.assertEqual(result["pin_status"], "unknown")
            self.assertEqual(self.calls, 5)

    def test_file_bounds_and_no_follow(self):
        (self.root / "file").write_bytes(b"abc")
        self.assertEqual(provider._file_hash(str(self.root), "file"),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        (self.root / "link").symlink_to(self.root / "file")
        with self.assertRaises(OSError):
            provider._file_hash(str(self.root), "link")
        (self.root / "large").write_bytes(b"x" * (provider.MAX_FILE + 1))
        with self.assertRaises(provider.Refusal):
            provider._file_hash(str(self.root), "large")

    def test_checked_in_action_files_match_fixed_source_hashes(self):
        root = str(PATH.parents[2])
        for (name, relative), digest in provider.FILES.items():
            if name == "pinokio":
                with self.subTest(relative=relative):
                    self.assertEqual(provider._file_hash(root, relative), digest)

    def test_cli_rejects_duplicate_keys_and_oversized_or_malformed_input(self):
        for data in (b'{"operation":"observe","operation":"update"}', b'x' * (provider.MAX_INPUT + 1), b'{'):
            with self.subTest(data=data[:30]):
                proc = subprocess.run([sys.executable, str(PATH)], input=data, capture_output=True, timeout=5, check=True)
                result = json.loads(proc.stdout)
                self.assertEqual(result["reason"], "invalid-request")
                self.assertEqual(result["action"], "not-run")
                self.assertEqual(proc.stderr, b"")


if __name__ == "__main__":
    unittest.main()
