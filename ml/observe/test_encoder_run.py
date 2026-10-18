"""Offline regression tests for incremental encoder training artifacts."""
import contextlib
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ml.observe import encoder_run
from ml.observe.encoder_ray import read_sources, resolve_image


class EncoderRunTests(unittest.TestCase):
    def test_completed_precision_is_trained_and_exported_before_later_failure(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            model = {"id": "test-encoder", "dimensions": 4}
            Path("labels.jsonl").write_bytes(b"labels\n")
            Path("encoder-config.json").write_text(json.dumps({"models": [model], "train": True,
                 "inputSha256": {"labels.jsonl": hashlib.sha256(b"labels\n").hexdigest()}}))
            features = Path("output/test-encoder/fp32")
            exported, workspaces = [], []

            def train(args):
                self.assertEqual(args.model_sha256, "b" * 64)
                self.assertEqual(args.oi_features, str(features / "oi.npz"))
                self.assertEqual(args.p0_features, str(features / "p0.npz"))
                self.assertEqual(args.holdout_features, str(features / "panel.npz"))
                Path(args.report).write_text(json.dumps({"attributes": {"smile": {"passed": True, "gates": {"launch": True}}}}))
                Path(args.head).write_text("{}\n")

            def extract(_config, *, on_precision_complete):
                workspaces.append(Path.cwd())
                features.mkdir(parents=True)
                (features / "oi.json").write_text(json.dumps({"modelSha256": "b" * 64}))
                on_precision_complete(model, "fp32", features)
                self.assertEqual(exported, ["test-encoder/training-fp32.json", "test-encoder/head-fp32.json"])
                raise RuntimeError("later precision failed")

            with patch.object(encoder_run, "run", side_effect=extract), \
                    patch.object(encoder_run, "train_heads", side_effect=train), \
                    patch.object(encoder_run, "encoder_artifact", side_effect=lambda _path, name: exported.append(name)), \
                    patch.object(encoder_run, "encoder_report"):
                with self.assertRaisesRegex(RuntimeError, "later precision failed"):
                    encoder_run.main()
            self.assertEqual(Path.cwd(), Path(folder).resolve())
            self.assertFalse(workspaces[0].exists())

    def test_hash_materialization_accepts_linked_package_files_and_keeps_path_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            package, content = root / "package", root / "content"
            package.mkdir()
            (content / "face").mkdir(parents=True)
            manifest = json.dumps({"id": "face-a", "image": "face/a.jpg"}).encode() + b"\n"
            (content / "manifest.jsonl").write_bytes(manifest)
            (content / "face/a.jpg").write_bytes(b"synthetic-crop")
            (package / "panel").symlink_to(content, target_is_directory=True)
            (package / "unlisted.txt").write_bytes(b"do not copy")
            config = {"sources": [{"name": "panel", "manifest": "panel/manifest.jsonl", "root": "local"}],
                      "inputSha256": {"panel/manifest.jsonl": hashlib.sha256(manifest).hexdigest(),
                                      "panel/face/a.jpg": hashlib.sha256(b"synthetic-crop").hexdigest()}}
            (package / "encoder-config.json").write_text(json.dumps(config))
            workspaces = []

            def run(staged_config, *, on_precision_complete):
                workspace = Path.cwd()
                workspaces.append(workspace)
                self.assertIsNone(on_precision_complete)
                self.assertFalse((workspace / "unlisted.txt").exists())
                self.assertFalse((workspace / "panel").is_symlink())
                source = read_sources(staged_config)[0]
                image = resolve_image(source["rows"][0], source)
                self.assertTrue(image.is_relative_to(workspace))
                self.assertEqual(image.read_bytes(), b"synthetic-crop")

            with contextlib.chdir(package), patch.object(encoder_run, "run", side_effect=run):
                encoder_run.main()
                self.assertEqual(Path.cwd(), package.resolve())
            self.assertFalse(workspaces[0].exists())

    def test_hash_mismatch_is_rejected_before_running(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            Path("manifest.jsonl").write_bytes(b"actual")
            Path("encoder-config.json").write_text(json.dumps({"inputSha256": {"manifest.jsonl": "b" * 64}}))
            with patch.object(encoder_run, "run") as run:
                with self.assertRaisesRegex(ValueError, "input checksum mismatch"):
                    encoder_run.main()
                run.assert_not_called()
            self.assertEqual(Path.cwd(), Path(folder).resolve())

    def test_empty_hashes_bad_hashes_and_traversal_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            for hashes in (None, {}, {"../outside.jpg": "b" * 64}, {"/outside.jpg": "b" * 64},
                           {"face/../outside.jpg": "b" * 64}, {"face/a.jpg": "B" * 64}):
                Path("encoder-config.json").write_text(json.dumps({"inputSha256": hashes}))
                with patch.object(encoder_run, "run") as run:
                    with self.assertRaises(ValueError):
                        encoder_run.main()
                    run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
