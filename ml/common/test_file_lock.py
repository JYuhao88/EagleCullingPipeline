"""Check process exclusion and release, including the Windows implementation."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from ml.common import file_lock


class FileLockTests(unittest.TestCase):
    def test_exclusive_nonblocking_and_release(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'lock'
            program = (
                'from ml.common import file_lock; import sys; '
                'h=open(sys.argv[1], "a"); '
                'file_lock.flock(h, file_lock.LOCK_EX | file_lock.LOCK_NB)'
            )
            with target.open('a') as handle:
                file_lock.flock(handle, file_lock.LOCK_EX | file_lock.LOCK_NB)
                blocked = subprocess.run([sys.executable, '-c', program, str(target)], capture_output=True, timeout=10)
                self.assertNotEqual(blocked.returncode, 0)
            released = subprocess.run([sys.executable, '-c', program, str(target)], capture_output=True, timeout=10)
            self.assertEqual(released.returncode, 0, released.stderr)


if __name__ == '__main__':
    unittest.main()
