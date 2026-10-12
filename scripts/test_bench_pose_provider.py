import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('bench-pose-provider.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeDirectoryTest(unittest.TestCase):
    def test_cache_namespace_is_pose_only(self):
        self.assertEqual(probe.probe_cache_directory(), Path('data/cache/pose-provider'))
        self.assertFalse(probe.probe_cache_directory().is_absolute())


if __name__ == '__main__':
    unittest.main()
