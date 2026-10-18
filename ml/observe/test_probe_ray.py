"""Network-free checks for sampling and the probe's face/resolution protocol."""
import unittest

import numpy as np
from PIL import Image

from ml.observe.probe_ray import binary_label, center_face, degraded, select_rows


class ProbeDataTests(unittest.TestCase):
    def test_balanced_deterministic_sample_excludes_original_rows(self):
        labels = [{'Smiling': smile, 'Mouth_Slightly_Open': mouth}
                  for _ in range(10) for smile, mouth in ((False, False), (False, True), (True, False), (True, True))]
        excluded = set(range(4))
        chosen = select_rows(labels, excluded, per_cell=5)
        self.assertEqual(chosen, select_rows(labels, excluded, per_cell=5))
        self.assertEqual(len(chosen), 20)
        self.assertFalse(set(chosen) & excluded)
        for key in ((False, False), (False, True), (True, False), (True, True)):
            count = sum((labels[index]['Smiling'], labels[index]['Mouth_Slightly_Open']) == key for index in chosen)
            self.assertEqual(count, 5)

    def test_signed_labels_and_insufficient_cells(self):
        self.assertFalse(binary_label(-1))
        self.assertFalse(binary_label(0))
        self.assertTrue(binary_label(1))
        with self.assertRaises(ValueError):
            binary_label(2)
        with self.assertRaises(ValueError):
            select_rows([{'Smiling': False, 'Mouth_Slightly_Open': False}], set(), per_cell=1)

    def test_center_crop_matches_aligned_celeba_protocol(self):
        array = np.zeros((20, 10, 3), dtype=np.uint8)
        array[5:15, :, 0] = 255
        result = center_face(Image.fromarray(array))
        self.assertEqual(result.size, (384, 384))
        self.assertTrue(np.all(np.asarray(result)[:, :, 0] == 255))
        self.assertTrue(np.all(np.asarray(result)[:, :, 1:] == 0))

    def test_small_condition_removes_detail_and_returns_384(self):
        pixels = (np.indices((384, 384)).sum(axis=0) % 2 * 255).astype(np.uint8)
        image = Image.fromarray(pixels).convert('RGB')
        self.assertIs(degraded(image, 384), image)
        for resolution in (160, 96):
            result = degraded(image, resolution)
            self.assertEqual(result.size, (384, 384))
            self.assertLess(np.asarray(result).var(), np.asarray(image).var() / 10)


if __name__ == '__main__':
    unittest.main()
