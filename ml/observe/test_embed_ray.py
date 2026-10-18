"""Offline tests for Open Images embedding path and result assembly helpers."""

import tempfile
import unittest
from pathlib import Path

import numpy as np

from ml.observe.embed_ray import assemble_results, ceph_image_path, relative_path


class EmbedRayPureTests(unittest.TestCase):
    def test_relative_path_rejects_traversal_and_absolute_values(self):
        self.assertEqual(relative_path("face/0123456789abcdef.jpg"), Path("face/0123456789abcdef.jpg"))
        for value in ("../face/a.jpg", "face/../a.jpg", "/tmp/a.jpg", "face\\a.jpg", "face//a.jpg"):
            with self.assertRaises(ValueError):
                relative_path(value)

    def test_ceph_path_stays_below_configured_root(self):
        with tempfile.TemporaryDirectory(prefix="observe-oi-root-") as folder:
            root = Path(folder)
            path = root / "photography/eagle-culling/observe/openimages-v1/face/0123456789abcdef.jpg"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"jpg")
            self.assertEqual(ceph_image_path("face/0123456789abcdef.jpg", ceph_root=root), path.resolve())
            with self.assertRaises(ValueError):
                ceph_image_path("../outside.jpg", ceph_root=root)

    def test_assembly_preserves_manifest_order_and_reports_failures(self):
        manifest = [{"id": "0000000000000001"}, {"id": "0000000000000002"}, {"id": "0000000000000003"}]
        successful = {
            "0000000000000003": {"clip": np.ones(512, dtype=np.float32), "dino": np.ones(384, dtype=np.float32)},
            "0000000000000001": {"clip": np.zeros(512, dtype=np.float32), "dino": np.zeros(384, dtype=np.float32)},
        }
        result = assemble_results(manifest, successful, [{"id": "0000000000000002", "error": "bad jpeg"}])
        self.assertEqual(result["ids"].tolist(), ["0000000000000001", "0000000000000003"])
        self.assertEqual(result["clip"].shape, (2, 512))
        self.assertEqual(result["dino"].shape, (2, 384))
        self.assertEqual(result["failures"][0]["id"], "0000000000000002")


if __name__ == "__main__":
    unittest.main()
