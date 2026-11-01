import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('idle_cleanup', Path(__file__).with_name('installed-idle-cleanup.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CleanupTest(unittest.TestCase):
    def test_census_detects_matching_real_or_saved_uid_with_foreign_effective_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Path(tmp)
            for pid, uids in [(123, '1001 0 1001 0'), (124, '2000 2000 2000 2000')]:
                folder = proc / str(pid); folder.mkdir()
                (folder / 'status').write_text('Name:\ttest\nUid:\t' + uids + '\n')
            self.assertEqual(module.process_ids(1001, proc), [123])
            self.assertEqual(module.process_uids(123, proc), (1001,0,1001,0))

    def test_collector_copy_uses_isolated_python_and_minimal_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)/'out'
            with patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'{}')) as run:
                module.copy_collector('astrid123',1001,1001,'/tmp/astrid-idle-12-3',str(target))
                args, kwargs = run.call_args
                self.assertIn('-I', args[0])
                self.assertEqual(kwargs['env'], {'HOME':'/tmp/astrid-idle-12-3/home','PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
                self.assertEqual(target.read_bytes(), b'{}')

    def test_missing_custody_marker_never_signals_or_deletes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(module.os, 'geteuid', return_value=0), patch.object(module.os, 'kill') as kill, patch.object(module.subprocess, 'run') as run:
            out = Path(tmp) / 'out'
            module.cleanup('astrid123', '/tmp/astrid-idle-12-3', str(Path(tmp)/'missing'), str(Path(tmp)/'collector'), str(out))
            result = json.loads(out.read_text())
            self.assertTrue(result['forcedTeardown'])
            self.assertFalse(result['accountRemoved'])
            kill.assert_not_called()
            run.assert_not_called()

    def test_wrong_custody_uid_cannot_signal(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp)/'marker'; marker.write_text(json.dumps({'user':'astrid123','root':'/tmp/astrid-idle-12-3','uid':9999}))
            out = Path(tmp)/'out'
            stat = SimpleNamespace(st_mode=0o100600, st_uid=0)
            with patch.object(module.os, 'geteuid', return_value=0), patch.object(module.os, 'getuid', return_value=0), patch.object(Path, 'lstat', return_value=stat), patch.object(module.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_dir='/tmp/astrid-idle-12-3/home')), patch.object(module.os, 'kill') as kill, patch.object(module.subprocess, 'run') as run:
                module.cleanup('astrid123','/tmp/astrid-idle-12-3',str(marker),str(Path(tmp)/'collector'),str(out))
                self.assertFalse(json.loads(out.read_text())['accountRemoved'])
                kill.assert_not_called(); run.assert_not_called()

    def test_only_owned_account_with_empty_process_census_is_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp)/'marker'; marker.write_text(json.dumps({'user':'astrid123','root':'/tmp/astrid-idle-12-3','uid':1001}))
            out = Path(tmp)/'out'
            stat = SimpleNamespace(st_mode=0o100600, st_uid=0)
            with patch.object(module.os, 'geteuid', return_value=0), patch.object(module.os, 'getuid', return_value=0), patch.object(Path, 'lstat', return_value=stat), patch.object(module.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_dir='/tmp/astrid-idle-12-3/home')), patch.object(module, 'copy_collector'), patch.object(module, 'process_ids', return_value=[]), patch.object(module, 'no_listener', return_value=True), patch.object(module.subprocess, 'run') as run:
                module.cleanup('astrid123','/tmp/astrid-idle-12-3',str(marker),str(Path(tmp)/'collector'),str(out))
                result = json.loads(out.read_text())
                self.assertTrue(result['accountRemoved']); self.assertFalse(result['forcedTeardown'])
                run.assert_called_once_with(['userdel','astrid123'], check=True, capture_output=True, timeout=10)

if __name__ == '__main__': unittest.main()
