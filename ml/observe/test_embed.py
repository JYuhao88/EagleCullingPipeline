"""Offline tests for encoder preprocessing; ONNX weights are not needed."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from ml.observe.embed import CLIP_MEAN, CLIP_STD, clip_preprocess, dino_preprocess


class EmbedPreprocessTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="observe-embed-test-")
        path = Path(self.folder.name) / "sample.png"
        pixels = np.zeros((80, 120, 3), dtype=np.uint8)
        pixels[:, :, 0] = np.arange(120, dtype=np.uint8)[None, :]
        pixels[:, :, 1] = np.arange(80, dtype=np.uint8)[:, None]
        pixels[:, :, 2] = 127
        Image.fromarray(pixels, mode="RGB").save(path)
        self.path = path

    def tearDown(self):
        self.folder.cleanup()

    def test_clip_shape_dtype_and_finite(self):
        tensor = clip_preprocess(self.path)
        self.assertEqual(tensor.shape, (1, 3, 224, 224))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(np.isfinite(tensor).all())
        self.assertTrue(tensor.flags.c_contiguous)

    def test_dino_shape_dtype_and_finite(self):
        tensor = dino_preprocess(self.path)
        self.assertEqual(tensor.shape, (1, 3, 224, 224))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(np.isfinite(tensor).all())
        self.assertTrue(tensor.flags.c_contiguous)

    def test_normalization_constants_are_float32(self):
        self.assertEqual(CLIP_MEAN.dtype, np.float32)
        self.assertEqual(CLIP_STD.dtype, np.float32)
        self.assertTrue(np.all(CLIP_STD > 0))


if __name__ == "__main__":
    unittest.main()
