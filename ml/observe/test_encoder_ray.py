"""Small offline tests for the encoder worker's paths, pixels and artifacts."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from ml.observe.encoder_ray import (
    encoder_artifact, extract_source, normalise_features, pixels, preprocess,
    read_sources, relative_path, resolve_image, write_features,
)
from ml.observe import encoder_ray


class FakeSession:
    def __init__(self, fixed_batch=None, fail=False):
        self.fixed_batch, self.fail = fixed_batch, fail
        self.batches = []

    def get_inputs(self):
        return [SimpleNamespace(name="pixel_values", type="tensor(float)", shape=[self.fixed_batch, 3, 16, 16])]

    def get_outputs(self):
        return [SimpleNamespace(name="features")]

    def run(self, _outputs, values):
        if self.fail:
            raise RuntimeError("GPU inference failed")
        tensor = values["pixel_values"]
        self.batches.append(tensor.shape[0])
        return [np.stack([np.ones(4, dtype=np.float32) for _ in tensor])]


class EncoderRayTests(unittest.TestCase):
    def test_paths_reject_traversal_and_source_counts(self):
        for value in ("../a.jpg", "x/../a.jpg", "/tmp/a.jpg", "x\\a.jpg", "x//a.jpg"):
            with self.assertRaises(ValueError):
                relative_path(value)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "manifest.jsonl").write_text(json.dumps({"id": "face-a", "image": "images/a.jpg"}) + "\n")
            config = {"sources": [{"name": "p0", "manifest": "manifest.jsonl", "root": "local"}],
                      "expectedCounts": {"p0": 1}}
            source = read_sources(config, root)[0]
            self.assertEqual(resolve_image(source["rows"][0], source), (root / "images/a.jpg").resolve())
            config["expectedCounts"]["p0"] = 2
            with self.assertRaises(ValueError):
                read_sources(config, root)

    def test_preprocess_records_resize_then_center_crop_and_float32(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "gradient.png"
            image = np.zeros((32, 64, 3), dtype=np.uint8)
            image[:, :, 0] = np.arange(64)[None, :]
            Image.fromarray(image).save(path)
            contract = {"size": 16, "resizeSize": 32, "resize": "shortest", "crop": "center",
                        "kernel": "cubic", "mean": [0.5] * 3, "std": [0.5] * 3}
            actual = pixels(path, contract)
            np.testing.assert_array_equal(actual, image[8:24, 24:40])
            tensor = preprocess(path, contract)
            self.assertEqual(tensor.shape, (3, 16, 16))
            self.assertEqual(tensor.dtype, np.float32)
            self.assertAlmostEqual(float(tensor[0, 0, 0]), float((24 / 255 - 0.5) / 0.5), places=6)

    def test_normalisation_rejects_zero_and_nonfinite(self):
        values = normalise_features(np.asarray([[3, 4]], dtype=np.float32), 2)
        np.testing.assert_allclose(values, [[0.6, 0.8]], atol=1e-7)
        for bad in ([[0, 0]], [[float("nan"), 1]]):
            with self.assertRaises(ValueError):
                normalise_features(np.asarray(bad), 2)

    def test_extract_preserves_order_reports_missing_image_and_pads_fixed_batch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("a", "c"):
                Image.new("RGB", (16, 16), (30, 50, 70)).save(root / f"{name}.png")
            source = {"name": "p0", "root": "local", "base": root, "imageRoot": ".",
                      "rows": [{"id": name, "image": f"{name}.png"} for name in ("a", "b", "c")]}
            model = {"family": "siglip", "dimensions": 4, "input": {"size": 16}}
            session = FakeSession(fixed_batch=4)
            with contextlib.redirect_stdout(io.StringIO()):
                ids, values, failures = extract_source(session, model, source, ceph_root=None,
                                                       batch_size=4, report_stage="test")
            self.assertEqual(ids.tolist(), ["a", "c"])
            self.assertEqual(values.shape, (2, 4))
            self.assertEqual(failures[0]["id"], "b")
            self.assertEqual(session.batches, [4])
            with self.assertRaisesRegex(RuntimeError, "GPU inference failed"):
                extract_source(FakeSession(fail=True), model, source, ceph_root=None,
                               batch_size=1, report_stage="test")

    def test_artifact_name_and_feature_sidecar_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            model = {"id": "siglip2-base", "family": "siglip", "dimensions": 4, "repo": "google/model",
                     "revision": "a" * 40, "license": "Apache-2.0", "input": {"size": 16}}
            artifact = write_features(output, model, "fp32", {"name": "oi", "rows": [1]},
                                      np.asarray(["face-a"]), np.ones((1, 4)), [], "b" * 64)
            self.assertEqual(artifact["npz"].relative_to(output).as_posix(), "siglip2-base/fp32/oi.npz")
            metadata = json.loads(artifact["metadata"].read_text())
            self.assertEqual(metadata["modelSha256"], "b" * 64)
            self.assertEqual(metadata["dimensions"], 4)
            with contextlib.redirect_stdout(io.StringIO()) as logs:
                encoder_artifact(artifact["metadata"], "siglip2-base/fp32/oi.json")
            self.assertTrue(logs.getvalue().startswith("ENCODER_ARTIFACT "))
            with self.assertRaises(ValueError):
                encoder_artifact(artifact["metadata"], "../oi.json")

    def test_fp32_callback_and_artifacts_survive_later_fp16_export_failure(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            root, events = Path(folder).resolve(), []
            model = {"id": "test-encoder", "family": "siglip", "dimensions": 4, "repo": "google/model",
                     "revision": "a" * 40, "license": "Apache-2.0", "input": {"size": 16}}
            sources = [{"name": name, "rows": [{"id": "face-a"}]} for name in ("oi", "panel", "p0")]

            def export_model(_model, destination, _batch_size, precision):
                events.append("export-" + precision)
                if precision == "fp16":
                    raise RuntimeError("fp16 export failed")
                destination.parent.mkdir()
                destination.write_bytes(b"fp32-test-model")

            def extract(_session, _model, source, **_kwargs):
                events.append("extract-" + source["name"])
                return np.asarray(["face-a"]), np.full((1, 4), 0.5, dtype=np.float32), []

            def completed(_model, precision, features):
                self.assertEqual(precision, "fp32")
                self.assertTrue(all((features / f"{name}.npz").exists() for name in ("oi", "panel", "p0")))
                events.append("trained-fp32")

            (root / "ceph").mkdir()
            (root / "ceph-link").symlink_to(root / "ceph", target_is_directory=True)
            with patch.dict("os.environ", {"ECP_CEPH_ROOT": str(root / "ceph-link")}), \
                    patch.object(encoder_ray, "read_sources", return_value=sources), \
                    patch.object(encoder_ray, "_export_tower", side_effect=export_model), \
                    patch.object(encoder_ray, "_versions", return_value={"onnxruntime": "test"}), \
                    patch.object(encoder_ray, "_ort_session", return_value=SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider"])), \
                    patch.object(encoder_ray, "extract_source", side_effect=extract), \
                    patch.object(encoder_ray, "encoder_artifact"), patch.object(encoder_ray, "encoder_report"):
                with self.assertRaisesRegex(RuntimeError, "fp16 export failed"):
                    encoder_ray.run({"models": [model]}, on_precision_complete=completed)
            self.assertEqual(events, ["export-fp32", "extract-oi", "extract-panel", "extract-p0",
                                      "trained-fp32", "export-fp16"])
            metadata = json.loads((root / "output/test-encoder/model-fp32.json").read_text())
            self.assertEqual((root / "ceph" / metadata["modelPath"]).read_bytes(), b"fp32-test-model")
            self.assertFalse((root / "output/test-encoder/model-fp16.json").exists())

    def test_precision_selection_defaults_orders_and_rejects_invalid_values(self):
        self.assertEqual(encoder_ray.model_precisions({}), ["fp32", "fp16"])
        self.assertEqual(encoder_ray.model_precisions({"precisions": ["fp16", "fp32"]}), ["fp32", "fp16"])
        self.assertEqual(encoder_ray.model_precisions({"precisions": ["fp16"]}), ["fp16"])
        for values in ([], ["fp16", "fp16"], ["fp64"], "fp16", None):
            with self.assertRaises(ValueError):
                encoder_ray.model_precisions({"precisions": values})

    def test_fp16_only_run_exports_and_reports_only_requested_precision(self):
        with tempfile.TemporaryDirectory() as folder, contextlib.chdir(folder):
            root = Path(folder).resolve()
            model = {"id": "test-encoder", "family": "siglip", "dimensions": 4, "repo": "google/model",
                     "revision": "a" * 40, "license": "Apache-2.0", "input": {"size": 16}, "precisions": ["fp16"]}
            sources = [{"name": name, "rows": [{"id": "face-a"}]} for name in ("oi", "panel", "p0")]

            def export_model(_model, destination, _batch_size, precision):
                self.assertEqual(precision, "fp16")
                destination.parent.mkdir()
                destination.write_bytes(b"fp16-test-model")

            with patch.dict("os.environ", {"ECP_CEPH_ROOT": str(root / "ceph")}), \
                    patch.object(encoder_ray, "read_sources", return_value=sources), \
                    patch.object(encoder_ray, "_export_tower", side_effect=export_model) as export_model, \
                    patch.object(encoder_ray, "_versions", return_value={"onnxruntime": "test"}), \
                    patch.object(encoder_ray, "_ort_session", return_value=SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider"])), \
                    patch.object(encoder_ray, "extract_source", return_value=(np.asarray(["face-a"]), np.full((1, 4), 0.5), [])), \
                    patch.object(encoder_ray, "encoder_artifact") as artifact, \
                    patch.object(encoder_ray, "encoder_report") as report:
                completed = []
                encoder_ray.run({"models": [model]}, on_precision_complete=lambda _m, p, _f: completed.append(p))
            self.assertEqual(export_model.call_count, 1)
            self.assertEqual(completed, ["fp16"])
            self.assertEqual(artifact.call_count, 8)
            reports = [call.args[0] for call in report.call_args_list]
            self.assertEqual(reports[0]["precisions"], {"test-encoder": ["fp16"]})
            self.assertEqual(reports[-1], {"stage": "complete", "artifacts": 8})
            self.assertFalse((root / "output/test-encoder/fp32").exists())

    def test_direct_exports_use_matching_model_and_dummy_dtypes(self):
        events = []

        class Module:
            def eval(self):
                return self

        class Model:
            def half(self):
                events.append("model-fp16")
                return self

            def float(self):
                events.append("model-fp32")
                return self

        def zeros(shape, dtype, device):
            self.assertEqual(shape, (1, 3, 16, 16))
            self.assertEqual(device, "cuda")
            events.append("dummy-" + dtype)
            return SimpleNamespace(dtype=dtype)

        def export(_wrapper, dummy, destination, **kwargs):
            self.assertFalse(kwargs["dynamo"])
            self.assertEqual(kwargs["opset_version"], 17)
            events.append("export-" + dummy.dtype)
            Path(destination).write_bytes(dummy.dtype.encode())

        torch = SimpleNamespace(nn=SimpleNamespace(Module=Module), zeros=zeros, float16="fp16", float32="fp32",
                                onnx=SimpleNamespace(export=export), cuda=SimpleNamespace(empty_cache=lambda: None))
        with tempfile.TemporaryDirectory() as folder, \
                patch.dict("sys.modules", {"torch": torch}), patch.object(encoder_ray, "_torch_model", return_value=Model()) as load:
            model = {"family": "siglip", "input": {"size": 16}, "revision": "a" * 40}
            for precision in ("fp32", "fp16"):
                encoder_ray._export_tower(model, Path(folder) / f"{precision}.onnx", 1, precision)
            self.assertEqual(load.call_args_list[0].args, load.call_args_list[1].args)
        self.assertEqual(events, ["model-fp32", "dummy-fp32", "export-fp32", "model-fp16", "dummy-fp16", "export-fp16"])

    def test_versions_record_runtime_import_and_gpu_distribution(self):
        with patch.dict("sys.modules", {"torch": SimpleNamespace(), "onnxruntime": SimpleNamespace(__version__="ort-import")}), \
                patch.object(encoder_ray.importlib.metadata, "version", side_effect=lambda name: "dist-" + name):
            versions = encoder_ray._versions()
        self.assertEqual(versions["onnxruntime"], "ort-import")
        self.assertEqual(versions["onnxruntime-gpu"], "dist-onnxruntime-gpu")


if __name__ == "__main__":
    unittest.main()
