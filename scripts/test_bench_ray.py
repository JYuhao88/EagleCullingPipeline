"""Integrity boundaries for Ray cache collection; no models or network."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bench_ray', Path(__file__).with_name('bench-ray.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class CollectionTest(unittest.TestCase):
    def setUp(self):
        self.manifest = {'images': [{'sha256': 'a' * 64}]}
        self.expected = {'signature': 's', 'models': {'model': 'hash'}, 'sources': {'code': 'hash'}}
        key = hashlib.sha256(('a' * 64 + ':s').encode()).hexdigest()
        raw = json.dumps({'warnings': [], 'scorer': {'model': 'topiq-nr-onnx'},
                          'metrics': {'faces': 0}, 'signals': {}})
        self.artifact = {**self.expected, 'caches': {key: raw},
                         'cacheSha256': {key: hashlib.sha256(raw.encode()).hexdigest()}}

    def validate(self, artifact):
        with patch.object(Path, 'read_text', return_value=json.dumps(self.manifest)):
            return bench.validate_cache(artifact, self.expected)

    def test_valid_exact_cache_set(self):
        self.assertEqual(len(self.validate(self.artifact)), 1)

    def test_reject_signature_model_code_missing_and_corrupt_cache(self):
        for field in ('signature', 'models', 'sources', 'caches', 'cacheSha256'):
            bad = copy.deepcopy(self.artifact)
            bad[field] = 'wrong' if field == 'signature' else {}
            with self.subTest(field=field), self.assertRaises((ValueError, KeyError)):
                self.validate(bad)

    def test_reject_unavailable_model_and_missing_pose(self):
        for change in ({'warnings': ['unavailable']}, {'signals': None}):
            bad = copy.deepcopy(self.artifact)
            key = next(iter(bad['caches']))
            row = json.loads(bad['caches'][key])
            row.update(change)
            if row['signals'] is None:
                del row['signals']
            raw = json.dumps(row)
            bad['caches'][key] = raw
            bad['cacheSha256'][key] = hashlib.sha256(raw.encode()).hexdigest()
            with self.assertRaises(ValueError):
                self.validate(bad)

    def test_thread_environment_is_propagated_without_changing_signature_inputs(self):
        with patch.dict(os.environ, {'EAGLE_POSE_THREADS': '3', 'EAGLE_PERFORMANCE_MODE': 'turbo'}, clear=True):
            self.assertEqual(bench.env()['EAGLE_POSE_THREADS'], '3')
            self.assertEqual(bench.env()['EAGLE_PERFORMANCE_MODE'], 'normal')
        self.assertNotIn('EAGLE_POSE_THREADS', bench.SIGNATURE_ENV)

    def test_each_cache_must_confirm_actual_threads(self):
        self.expected['poseThreads'] = 3
        key = next(iter(self.artifact['caches']))
        row = json.loads(self.artifact['caches'][key])
        row['poseDiagnostics'] = {'intraOpThreads': {'pose': 3}}
        raw = json.dumps(row)
        self.artifact['caches'][key] = raw
        self.artifact['cacheSha256'][key] = hashlib.sha256(raw.encode()).hexdigest()
        self.assertEqual(len(self.validate(self.artifact)), 1)
        self.expected['poseThreads'] = 4
        with self.assertRaisesRegex(ValueError, 'thread diagnostics'):
            self.validate(self.artifact)

    def test_source_package_excludes_private_data(self):
        paths = [str(f.relative_to(bench.ROOT)) for f in bench.source_files()]
        self.assertFalse(any(p.startswith(('data/', 'models/', 'config/', 'node_modules/')) for p in paths))
        self.assertIn('scripts/bench.mjs', paths)


if __name__ == '__main__':
    unittest.main()
