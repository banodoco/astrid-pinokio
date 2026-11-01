import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class FreezeDirectoryChecksTest(unittest.TestCase):
    def run_checks(self, root):
        workflow = (Path(__file__).parents[1] / '.github/workflows/installed-idle-diagnostic.yml').read_text()
        loop = workflow.split('          for name in pinokiod pterm; do\n', 1)[1].split('          done\n', 1)[0]
        script = 'set -e\nfor name in pinokiod pterm; do\n' + loop + 'done\n'
        bin_dir = root / 'bin'
        bin_dir.mkdir(exist_ok=True)
        log = root / 'sudo.log'
        sudo = bin_dir / 'sudo'
        sudo.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$SUDO_LOG"\nexec "$@"\n')
        sudo.chmod(0o755)
        env = dict(os.environ, DIAG_ROOT=str(root), SUDO_LOG=str(log), PATH=str(bin_dir) + ':' + os.environ['PATH'])
        result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
        return result.returncode, log.read_text().splitlines()

    def test_checks_use_privilege_for_both_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('pinokiod', 'pterm'):
                (root / 'home' / name).mkdir(parents=True)
            code, calls = self.run_checks(root)
            self.assertEqual(code, 0)
            self.assertEqual(calls, [f'test {flag} {root}/home/{name}' for name in ('pinokiod', 'pterm') for flag in ('-d', '! -L')])

    def test_missing_and_symlink_directories_fail_closed(self):
        for kind in ('missing', 'symlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'home').mkdir()
                if kind == 'symlink':
                    (root / 'home' / 'pinokiod').symlink_to(root / 'home', target_is_directory=True)
                code, _ = self.run_checks(root)
                self.assertNotEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
