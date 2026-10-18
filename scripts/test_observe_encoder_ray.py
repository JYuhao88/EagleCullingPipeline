import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image

SPEC = importlib.util.spec_from_file_location('encoder_submit', Path(__file__).with_name('observe-encoder-ray.py'))
submit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(submit)


class EncoderSubmissionTest(unittest.TestCase):
    def test_only_sanitized_bounded_crops_are_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'crop.jpg'
            Image.new('RGB', (384, 384)).save(path)
            rows = [{'id': 'one', 'images': {'face': 'crop.jpg'}}, {'id': 'no-face', 'images': {}}]
            self.assertEqual(len(submit.face_files(root, rows)), 1)
            Image.new('RGB', (769, 384)).save(path)
            with self.assertRaises(ValueError):
                submit.face_files(root, rows)
            exif = Image.Exif()
            exif[270] = 'private metadata'
            Image.new('RGB', (384, 384)).save(path, exif=exif)
            with self.assertRaises(ValueError):
                submit.face_files(root, rows)
            with self.assertRaises(ValueError):
                submit.face_files(root, [{'id': 'unsafe', 'images': {'face': '../crop.jpg'}}])


if __name__ == '__main__':
    unittest.main()
