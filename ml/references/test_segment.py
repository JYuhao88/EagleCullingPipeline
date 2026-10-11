"""Segmentation regression checks; optional actual pilot-image checks use /tmp QA.

Run with the segmentation environment: python -m unittest discover -s
ml/references -p test_segment.py. No fixture images are committed.
"""
import sys as _test_sys
from pathlib import Path as _TestPath
_test_sys.path.insert(0, str(_TestPath(__file__).resolve().parents[2]))

from ml.common.private_env_test_fixture import configured_private_environment as _configured_private_environment
_import_private_environment = _configured_private_environment()
_import_private_environment.__enter__()

import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
from segment_job import atomic_json


@unittest.skipUnless(all(importlib.util.find_spec(p) for p in ('cv2','numpy','PIL')), 'needs segmentation pip dependencies')
class PhotoIdentityTests(unittest.TestCase):
    def setUp(self):
        import cv2
        cv2.setNumThreads(1)

    def test_static_ui_does_not_merge_different_photos(self):
        import cv2
        import numpy as np
        from segment_job import features, same_photo
        rng = np.random.default_rng(97)
        a = np.full((480, 854, 3), 195, dtype=np.uint8)
        # Shared sidebar/menu chrome has plentiful identical SIFT keypoints.
        for y in range(15, 200, 20):
            cv2.putText(a, 'rank 1 static UI', (8,y), cv2.FONT_HERSHEY_SIMPLEX, .4,(0,0,0),1)
        b = a.copy()
        a[35:360,300:600] = rng.integers(0,256,(325,300,3),dtype=np.uint8)
        b[35:360,300:600] = rng.integers(0,256,(325,300,3),dtype=np.uint8)
        from unittest.mock import patch
        for layout in ('yidao', 'wulin'):
            with self.subTest(layout=layout), patch.dict('os.environ', {'REF_LAYOUT':layout}):
                self.assertFalse(same_photo(features(a),features(b)))
                self.assertTrue(same_photo(features(a),features(a.copy())))

    def test_actual_pilot_same_photo_and_shared_ui(self):
        import numpy as np
        from PIL import Image
        from segment_job import features, same_photo, classify
        old = Path('/tmp/w1-refs-qa/samples/BV1M34y1e7nY.jpg')
        modern = Path('/tmp/w1-refs-qa/samples/BV1TxLV6oE88.jpg')
        if not old.exists() or not modern.exists():
            self.skipTest('optional pilot contact sheets unavailable')
        def frame(path, i):
            im = Image.open(path)
            x,y=i%3*320,i//3*200
            return features(np.array(im.crop((x,y,x+319,y+180))))
        self.assertTrue(same_photo(frame(old,0),frame(old,1)))
        self.assertFalse(same_photo(frame(modern,1),frame(modern,2)))
        self.assertFalse(same_photo(frame(modern,3),frame(modern,4)))
        desktop = {'feature':frame(old,8),'start':0,'end':10,'motion':[0]*10}
        self.assertEqual(classify(desktop,1),'other')

    def test_pilot_host_composites_and_browser_are_excluded(self):
        import numpy as np
        from PIL import Image
        from segment_job import features, same_photo, classify
        sample = Path('/tmp/w1-refs-qa/samples/BV1za411Y7TW.jpg')
        pilot = Path('/tmp/w1-refs-qa/pilot/BV1za411Y7TW-0.jpg')
        if not sample.exists() or not pilot.exists():
            self.skipTest('optional real pilot screenshots unavailable')
        host_image = Image.open(sample)
        host = features(np.array(host_image.crop((0,200,319,380))))
        image = Image.open(pilot)
        def f(i):
            x,y = i%4*300,i//4*230
            return features(np.array(image.crop((x,y,x+300,y+169))))
        self.assertTrue(same_photo(host, f(0), negative=True))
        self.assertTrue(same_photo(host, f(8), negative=True))
        self.assertFalse(same_photo(host, f(5), negative=True))
        for i in [3,4,9]:
            self.assertEqual(classify({'feature':f(i),'start':0,'end':10,'motion':[0]*10},1),'other')

    def test_extreme_zoom_preserves_editor_document(self):
        import numpy as np
        from PIL import Image
        from segment_job import features, same_photo
        root = Path('/tmp/w1-refs-qa/native')
        if not all((root/f'{t}.jpg').exists() for t in (565,1258,1334,1358,2006)):
            self.skipTest('optional native pilot frames unavailable')
        f = {t: features(np.array(Image.open(root/f'{t}.jpg'))) for t in (565,1258,1334,1358,2006)}
        self.assertTrue(same_photo(f[1258],f[1334]))
        self.assertTrue(same_photo(f[1258],f[1358]))
        self.assertFalse(same_photo(f[1258],f[565]))
        self.assertFalse(same_photo(f[1258],f[2006]))

    def test_other_classification_excludes_motion_and_blank(self):
        import numpy as np
        from segment_job import classify, features
        blank = {'feature':features(np.full((480,854,3),180,np.uint8)),
                 'start':0,'end':20,'motion':[0]*20}
        self.assertEqual(classify(blank,1),'other')
        noisy = dict(blank,feature=features(np.random.default_rng(1).integers(0,256,(480,854,3),dtype=np.uint8)),motion=[10]*20)
        self.assertEqual(classify(noisy,1),'other')


class LayoutConfigurationTests(unittest.TestCase):
    def test_fixed_sidebar_never_supplies_wulin_host_negatives(self):
        from segment_job import use_host_negatives
        self.assertFalse(use_host_negatives("wulin", [10, 12, 8]))
        self.assertTrue(use_host_negatives("yidao", [10, 12, 8]))
        self.assertFalse(use_host_negatives("yidao", [0, 2, 1]))
        self.assertFalse(use_host_negatives("yidao", []))

    def test_wulin_settings_do_not_change_yidao_defaults(self):
        from unittest.mock import patch
        from segment_job import layout_config
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(layout_config()['crop'], (.04,.84,.05,.78))
            self.assertEqual(layout_config()['decode_width'], 0)
        with patch.dict('os.environ', {'REF_LAYOUT':'wulin','REF_VIDEO_NAME':'video1080.m4s'}, clear=True):
            settings=layout_config()
            self.assertEqual(settings['crop'], (.02,.98,.03,.97))
            self.assertEqual(settings['decode_width'], 854)
            self.assertEqual(settings['video_name'], 'video1080.m4s')
            self.assertEqual(settings['identity_version'], 'wulin-central-sift@1')
        with patch.dict('os.environ', {'REF_LAYOUT':'unknown'}, clear=True):
            with self.assertRaises(ValueError):layout_config()


_import_private_environment.__exit__(None, None, None)


def setUpModule():
    global _running_private_environment
    _running_private_environment = _configured_private_environment()
    _running_private_environment.__enter__()


def tearDownModule():
    _running_private_environment.__exit__(None, None, None)

if __name__ == '__main__':
    unittest.main()
