import math
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from ml.observe.train_heads import (CHEAP, STRONG, THIRD, CLIP_SHA, choose_threshold, ece, fit_temperature, load_npz,
                                    panel, positive_scores, sigmoid, two_teacher, validate_feature_metadata, wilson_low)


class TrainHeadsTest(unittest.TestCase):
    def test_two_teacher_needs_flash_first_ask_and_gpt_to_agree(self):
        self.assertEqual(two_teacher({CHEAP: [1], STRONG: [1]}), 1)
        self.assertIsNone(two_teacher({CHEAP: [1], STRONG: [0]}))
        self.assertIsNone(two_teacher({CHEAP: [None], STRONG: [None]}))
        self.assertIsNone(two_teacher({CHEAP: [1]}))

    def test_panel_needs_flash_majority_and_both_strong_models(self):
        self.assertEqual(panel({CHEAP: [1, 1, 0], STRONG: [1], THIRD: [1]}), 1)
        self.assertIsNone(panel({CHEAP: [1, 0, None], STRONG: [1], THIRD: [1]}))
        self.assertIsNone(panel({CHEAP: [0, 0, 0], STRONG: [0], THIRD: [1]}))

    def test_wilson_lower_bound(self):
        self.assertAlmostEqual(wilson_low(90, 100), 0.826, places=3)
        self.assertEqual(wilson_low(0, 0), 0.0)

    def test_temperature_recovers_a_known_scale(self):
        rng = np.random.default_rng(0)
        true_logits = rng.normal(0, 2, 20000)
        labels = (rng.random(20000) < sigmoid(true_logits)).astype(float)
        self.assertAlmostEqual(fit_temperature(true_logits * 3, labels), 3, delta=0.15)

    def test_ece_is_zero_for_calibrated_bins_and_large_when_overconfident(self):
        p = np.array([0.95] * 20 + [0.05] * 20)
        y = np.array([1] * 19 + [0] + [0] * 19 + [1])
        self.assertLess(ece(p, y), 1e-9)
        self.assertGreater(ece(np.full(10, 0.99), np.zeros(10)), 0.9)

    def test_threshold_is_the_smallest_reaching_the_target_with_enough_statements(self):
        p = np.linspace(0, 1, 1000)
        y = (p > 0.7).astype(int)
        threshold = choose_threshold(p, y, 0.95)
        self.assertTrue(0.6 < threshold <= 0.72)
        self.assertGreaterEqual(positive_scores(p, y, threshold)['precision'], 0.95)
        self.assertIsNone(choose_threshold(p[:20], y[:20], 0.95))
        self.assertTrue(math.isfinite(positive_scores(p, y, 0.99)['precisionLow']))

    def test_npz_ids_do_not_get_a_second_openimages_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'features.npz'
            np.savez(path, ids=np.array(['openimages-a', 'b']), features=np.ones((2, 3)))
            values = load_npz(path, 'openimages-', dimensions=3)
            self.assertEqual(set(values), {'openimages-a', 'openimages-b'})

    def test_feature_sidecar_binds_encoder_dimensions_and_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'features.npz'
            np.savez(path, ids=np.array(['x']), features=np.ones((1, 3)))
            path.with_suffix('.json').write_text(json.dumps({'encoder': {'id': 'test', 'dimensions': 3,
                                                                          'modelSha256': CLIP_SHA}}))
            validate_feature_metadata(path, 'test', 3, CLIP_SHA)
            with self.assertRaises(SystemExit):
                validate_feature_metadata(path, 'other', 3, CLIP_SHA)


if __name__ == '__main__':
    unittest.main()
