import importlib.util
from pathlib import Path
import unittest
import os
from unittest.mock import patch
import types

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('bench-pose-provider.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeDirectoryTest(unittest.TestCase):
    def test_cache_namespace_is_pose_only(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(probe.probe_cache_directory(), Path('data/cache/pose-provider'))
        with patch.dict(os.environ, {'EAGLE_POSE_PROBE_ROOT': 'data/cache/w23-threads/probes'}):
            self.assertEqual(probe.probe_cache_directory(), Path('data/cache/w23-threads/probes'))


    def test_cpu_override_preserves_accelerator_options(self):
        calls = []
        runtime = types.SimpleNamespace(InferenceSession=lambda model, **kwargs: calls.append(
            (kwargs['sess_options'].intra_op_num_threads, kwargs['providers'])))
        probe.configure_probe_threads(runtime, 3)
        for providers in [['CPUExecutionProvider'], ['DmlExecutionProvider', 'CPUExecutionProvider'],
                          ['CUDAExecutionProvider', 'CPUExecutionProvider'],
                          ['CoreMLExecutionProvider', 'CPUExecutionProvider']]:
            options = types.SimpleNamespace(intra_op_num_threads=1)
            runtime.InferenceSession('local.onnx', sess_options=options, providers=providers)
        self.assertEqual([v[0] for v in calls], [3, 1, 1, 1])

    def test_invalid_thread_counts_rejected(self):
        for value in [0, 9, 1.5, '3', True]:
            with self.assertRaises(ValueError):
                probe.configure_probe_threads(types.SimpleNamespace(), value)


if __name__ == '__main__':
    unittest.main()
