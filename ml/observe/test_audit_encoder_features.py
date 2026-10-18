import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from ml.observe.audit_encoder_features import audit_precision, digest_ids, load_manifests


def fixture(root):
    model = {'id': 'test-encoder', 'dimensions': 2, 'family': 'siglip', 'repo': 'example/model',
             'revision': 'a' * 40, 'license': 'Apache-2.0', 'input': {'size': 224}}
    folder = root / model['id'] / 'fp32'
    folder.mkdir(parents=True)
    identity = {'encoder': model['id'], 'precision': 'fp32', 'dimensions': 2, 'repo': model['repo'],
                'revision': model['revision'], 'license': model['license'], 'preprocessing': model['input'],
                'modelSha256': 'b' * 64, 'modelPath': 'models/test.onnx'}
    (folder.parent / 'model-fp32.json').write_text(json.dumps(identity))
    manifests = {}
    for source in ('oi', 'panel', 'p0'):
        ids = [source + '-a', source + '-b']
        manifests[source] = {'ids': ids, 'manifestSha256': 'c' * 64, 'orderedIdsSha256': digest_ids(ids)}
        metadata = {**identity, 'family': 'siglip', 'source': source, 'normalised': True,
                    'count': 2, 'expectedCount': 2, 'failures': []}
        (folder / (source + '.json')).write_text(json.dumps(metadata))
        np.savez(folder / (source + '.npz'), ids=np.array(ids), features=np.array([[0.6, 0.8]] * 2, dtype=np.float32))
    return model, manifests, folder


class AuditEncoderFeaturesTest(unittest.TestCase):
    def test_complete_precision_validates_every_ordered_source_and_norm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, manifests, folder = fixture(root)
            result = audit_precision(root, model, 'fp32', manifests)
            self.assertTrue(result['validated'])
            self.assertEqual(result['modelSha256'], 'b' * 64)
            for source in ('oi', 'panel', 'p0'):
                values = result['sources'][source]
                self.assertEqual(values['rows'], 2)
                self.assertEqual(values['uniqueIds'], 2)
                self.assertTrue(values['orderedIdsMatch'])
                self.assertLess(values['maxNormError'], 1e-7)

    def test_incomplete_precision_does_not_open_npz_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, manifests, folder = fixture(root)
            (folder / 'panel.json').unlink()
            with patch('ml.observe.audit_encoder_features.np.load', side_effect=AssertionError('must not load')):
                result = audit_precision(root, model, 'fp32', manifests)
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['missing'], ['test-encoder/fp32/panel.json'])

    def test_order_duplicates_nonfinite_dimensions_dtype_and_norm_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, manifests, folder = fixture(root)
            correct = np.array([[0.6, 0.8]] * 2, dtype=np.float32)
            cases = [('order', ['oi-b', 'oi-a'], correct), ('duplicate', ['oi-a', 'oi-a'], correct),
                     ('nonfinite', ['oi-a', 'oi-b'], np.array([[float('nan'), 1], [0.6, 0.8]], dtype=np.float32)),
                     ('dimensions', ['oi-a', 'oi-b'], np.ones((2, 3), dtype=np.float32)),
                     ('dtype', ['oi-a', 'oi-b'], correct.astype(np.float64)),
                     ('norm', ['oi-a', 'oi-b'], np.zeros((2, 2), dtype=np.float32))]
            for name, ids, values in cases:
                np.savez(folder / 'oi.npz', ids=np.array(ids), features=values)
                with self.subTest(name=name), self.assertRaises(ValueError):
                    audit_precision(root, model, 'fp32', manifests)

    def test_sidecar_model_failure_and_count_mismatches_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model, manifests, folder = fixture(root)
            path = folder / 'p0.json'
            metadata = json.loads(path.read_text())
            for key, value in (('modelSha256', 'd' * 64), ('precision', 'fp16'), ('dimensions', 3),
                               ('preprocessing', {'size': 384}), ('failures', [{'id': 'bad'}]),
                               ('count', 1), ('expectedCount', 3), ('normalised', False)):
                path.write_text(json.dumps({**metadata, key: value}))
                with self.subTest(key=key), self.assertRaises(ValueError):
                    audit_precision(root, model, 'fp32', manifests)

    def test_manifest_binding_preserves_order_and_only_includes_local_face_items(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            oi = root / 'oi.jsonl'
            oi.write_text('{"id":"two"}\n{"id":"one"}\n')
            for folder in ('p1-panel', 'p0'):
                target = root / folder
                target.mkdir()
                (target / 'items.jsonl').write_text('{"id":"skip","images":{}}\n'
                                                   '{"id":"second","images":{"face":"b.jpg"}}\n'
                                                   '{"id":"first","images":{"face":"a.jpg"}}\n')
            expected = {'oi': 2, 'panel': 2, 'p0': 2}
            result = load_manifests(root, oi, expected)
            self.assertEqual(result['oi']['ids'], ['openimages-two', 'openimages-one'])
            self.assertEqual(result['p0']['ids'], ['second', 'first'])
            self.assertEqual(result['panel']['orderedIdsSha256'], digest_ids(['second', 'first']))
            oi.write_text('{"id":"same"}\n{"id":"same"}\n')
            with self.assertRaisesRegex(ValueError, 'oi manifest'):
                load_manifests(root, oi, expected)


if __name__ == '__main__':
    unittest.main()
