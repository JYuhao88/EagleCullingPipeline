"""Geometry/control-flow tests; no private photos or model weights in fixtures."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image
import face_worker


class FaceRegionsTest(unittest.TestCase):
    def test_overlap_is_deduplicated_but_different_people_remain(self):
        a = {"box": [0.1, 0.1, 0.3, 0.3]}
        b = {"box": [0.11, 0.11, 0.31, 0.31]}
        c = {"box": [0.6, 0.6, 0.8, 0.8]}
        self.assertTrue(face_worker.same_face(a,b))
        self.assertFalse(face_worker.same_face(a,c))
        image = Image.new("RGB", (1280,1280))
        with patch.object(face_worker,"detect_region",side_effect=[[],[a],[b],[c],[]]):
            result = face_worker.analyze_faces(None,image,True)
        self.assertEqual(result["faceCount"],2)
        self.assertEqual(result["regionsAnalyzed"],5)

    def test_tiles_only_run_after_no_detection_and_on_bounded_large_previews(self):
        with patch.object(face_worker,"detect_region",return_value=[]) as detect:
            result=face_worker.analyze_faces(None,Image.new("RGB",(1280,1280)),False)
            self.assertEqual(result["regionsAnalyzed"],1)
            self.assertEqual(detect.call_count,1)
        with patch.object(face_worker,"detect_region",return_value=[]) as detect:
            face_worker.analyze_faces(None,Image.new("RGB",(320,480)),True)
            self.assertEqual(detect.call_count,1)
        with patch.object(face_worker,"detect_region",return_value=[{"box":[0.1,0.1,0.3,0.3]}]) as detect:
            face_worker.analyze_faces(None,Image.new("RGB",(1280,1280)),True)
            self.assertEqual(detect.call_count,1)

    def test_missing_blendshapes_are_not_normal_eyes(self):
        landmarks=[SimpleNamespace(x=0.2,y=0.2),SimpleNamespace(x=0.4,y=0.4)]
        detector=SimpleNamespace(detect=lambda image:SimpleNamespace(face_landmarks=[landmarks],face_blendshapes=[]))
        faces=face_worker.detect_region(detector,Image.new("RGB",(100,100)),(0,0,100,100))
        self.assertFalse(faces[0]["eyesAssessed"])
        self.assertFalse(faces[0]["eyesClosed"])
        self.assertIsNone(faces[0]["eyeBlinkLeft"])


if __name__ == "__main__":
    unittest.main()
