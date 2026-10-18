"""Ray worker for exporting vision towers and extracting face features with ORT.

The worker deliberately keeps model export (Torch/Hugging Face) separate from
feature extraction: every feature written by this module is produced by the
exported ONNX file through CUDAExecutionProvider.  It accepts sanitized local
manifests for the panel/p0 crops and a Ceph manifest for Open Images.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import signal
import tempfile
import time
import numpy as np
from PIL import Image, ImageOps

IMAGE_ROOT = "photography/eagle-culling/observe/openimages-v1"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
MODEL_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
PRECISIONS = ("fp32", "fp16")


def remove_package_blob() -> None:
    """Best-effort cleanup for the Ray package KV entry."""
    uri = os.environ.get("PROBE_PACKAGE_URI")
    if not uri:
        return
    try:
        import ray
        from ray._private import ray_constants
        from ray.experimental.internal_kv import _internal_kv_del
        ray.init(address="auto", logging_level="ERROR")
        _internal_kv_del(uri.encode(), namespace=ray_constants.KV_NAMESPACE_PACKAGE)
        ray.shutdown()
    except Exception:
        # Package cleanup must never hide a completed feature extraction.
        return


def digest(path: str | Path) -> str:
    checksum = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def encoder_report(value: dict) -> None:
    print("ENCODER_REPORT " + json.dumps(value, ensure_ascii=False), flush=True)


def encoder_artifact(path: str | Path, name: str | None = None) -> None:
    """Emit one bounded artifact without putting model files into the logs."""
    path = Path(path)
    artifact_name = path.name if name is None else name
    if not artifact_name or Path(artifact_name).is_absolute() or any(part in ("", ".", "..") for part in artifact_name.split("/")):
        raise ValueError("invalid artifact name")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    chunk_size = 192 * 1024
    count = max(1, (len(encoded) + chunk_size - 1) // chunk_size)
    checksum = digest(path)
    for index in range(count):
        print("ENCODER_ARTIFACT " + json.dumps({"name": artifact_name, "index": index, "count": count,
              "sha256": checksum, "data": encoded[index * chunk_size:(index + 1) * chunk_size]}), flush=True)


def relative_path(value: str, label: str = "path") -> Path:
    if (not isinstance(value, str) or not value or "\\" in value
            or Path(value).is_absolute() or any(part in ("", ".", "..") for part in value.split("/"))):
        raise ValueError(f"{label} must be a relative path without traversal")
    return Path(value)


def safe_id(value: str, label: str = "id") -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError(f"{label} is not a safe id")
    return value


def _inside(root: Path, value: Path, label: str) -> Path:
    root, value = root.resolve(), value.resolve()
    if root != value and root not in value.parents:
        raise ValueError(f"{label} escapes its root")
    return value


def read_manifest(path: str | Path) -> list[dict]:
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    if not isinstance(rows, list):
        raise ValueError("manifest must contain JSON objects")
    ids = [safe_id(row.get("id"), "manifest id") for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("manifest ids must be unique")
    for row in rows:
        value = row.get("image", row.get("face"))
        if not isinstance(value, str):
            raise ValueError("manifest row is missing image")
        relative_path(value, "manifest image")
    return rows


def read_sources(config: dict, root: Path | None = None) -> list[dict]:
    """Read source manifests and return rows with their resolution metadata."""
    root = Path.cwd() if root is None else Path(root)
    expected = config.get("expectedCounts", {})
    result = []
    sources = config.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("sources must be a non-empty list")
    names = set()
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("source must be an object")
        name = safe_id(source.get("name"), "source name")
        if name in names:
            raise ValueError("duplicate source name")
        names.add(name)
        manifest = _inside(root, root / relative_path(source.get("manifest"), "manifest"), "manifest")
        rows = read_manifest(manifest)
        if name in expected and len(rows) != int(expected[name]):
            raise ValueError(f"manifest count for {name} is {len(rows)}, expected {expected[name]}")
        image_root = source.get("imageRoot", IMAGE_ROOT if source.get("root", "local") == "ceph" else "")
        if image_root:
            image_root = str(relative_path(image_root, "imageRoot"))
        else:
            image_root = "."
        source_root = source.get("root", "local")
        if source_root not in ("ceph", "local"):
            raise ValueError("source root must be ceph or local")
        result.append({"name": name, "manifest": manifest, "rows": rows, "root": source_root,
                       "imageRoot": image_root, "base": manifest.parent})
    return result


def resolve_image(row: dict, source: dict, *, ceph_root: str | Path | None = None) -> Path:
    value = row.get("image", row.get("face"))
    relative = relative_path(value, "manifest image")
    if source["root"] == "ceph":
        configured = ceph_root if ceph_root is not None else os.environ.get("ECP_CEPH_ROOT")
        if not configured or not Path(configured).is_absolute():
            raise ValueError("ECP_CEPH_ROOT must be an absolute path")
        base = _inside(Path(configured), Path(configured) / source["imageRoot"], "imageRoot")
    else:
        base = _inside(source["base"], source["base"] / source["imageRoot"], "imageRoot")
    return _inside(base, base / relative, "image")


def _resample(name: str):
    table = {"nearest": Image.Resampling.NEAREST, "bilinear": Image.Resampling.BILINEAR,
             "bicubic": Image.Resampling.BICUBIC, "cubic": Image.Resampling.BICUBIC,
             "lanczos": Image.Resampling.LANCZOS,
             "lanczos3": Image.Resampling.LANCZOS}
    try:
        return table[name]
    except KeyError as error:
        raise ValueError("unsupported resize kernel") from error


def pixels(path: str | Path, preprocessing: dict) -> np.ndarray:
    """Return deterministic RGB pixels matching the declared preprocessing."""
    size = int(preprocessing.get("size", preprocessing.get("cropSize", 224)))
    resize_size = int(preprocessing.get("resizeSize", size))
    if size < 16 or size > 2048:
        raise ValueError("preprocessing size is outside the supported range")
    image = Image.open(path)
    if preprocessing.get("autorot", False):
        image = ImageOps.exif_transpose(image)
    image = image.convert("RGB")
    kernel = _resample(str(preprocessing.get("kernel", "bicubic")))
    resize = preprocessing.get("resize", "square")
    crop = preprocessing.get("crop", "none")
    if resize == "square":
        image = image.resize((size, size), kernel)
    elif resize in ("shortest", "cover"):
        scale = max(resize_size / image.width, resize_size / image.height)
        dimensions = (max(resize_size, round(image.width * scale)), max(resize_size, round(image.height * scale)))
        image = image.resize(dimensions, kernel)
        if crop in ("center", "none"):
            left = max(0, (image.width - size) // 2)
            top = max(0, (image.height - size) // 2)
            image = image.crop((left, top, left + size, top + size))
    else:
        raise ValueError("unsupported resize mode")
    if image.size != (size, size):
        raise ValueError("preprocessing did not produce a square image")
    return np.asarray(image, dtype=np.uint8)


def preprocess(path: str | Path, preprocessing: dict, *, dtype=np.float32) -> np.ndarray:
    mean = np.asarray(preprocessing.get("mean", [0.5, 0.5, 0.5]), dtype=np.float64)
    std = np.asarray(preprocessing.get("std", [0.5, 0.5, 0.5]), dtype=np.float64)
    if (mean.shape != (3,) or std.shape != (3,) or not np.isfinite(mean).all()
            or not np.isfinite(std).all() or np.any(std <= 0)):
        raise ValueError("preprocessing mean/std must contain three positive channels")
    values = pixels(path, preprocessing).astype(np.float64) / 255.0
    values = (values - mean) / std
    return np.ascontiguousarray(values.transpose(2, 0, 1), dtype=dtype)


def normalise_features(value: np.ndarray, dimensions: int | None = None) -> np.ndarray:
    rows = np.asarray(value).reshape((-1, np.asarray(value).shape[-1])).astype(np.float32)
    if dimensions is not None and rows.shape[1] != int(dimensions):
        raise ValueError(f"feature dimension {rows.shape[1]} != expected {dimensions}")
    if not np.isfinite(rows).all():
        raise ValueError("features contain non-finite values")
    norms = np.linalg.norm(rows.astype(np.float64), axis=1, keepdims=True)
    if not np.isfinite(norms).all() or np.any(norms <= 0):
        raise ValueError("features contain a zero or invalid norm")
    return np.ascontiguousarray(rows.astype(np.float64) / norms, dtype=np.float32)


def _model_id(spec: dict) -> str:
    value = safe_id(spec.get("id"), "model id")
    if not MODEL_PATTERN.fullmatch(value):
        raise ValueError("model id contains unsupported characters")
    return value


def _torch_model(spec: dict):
    import torch
    from transformers import AutoModel

    family = spec.get("family", "")
    repo, revision = spec.get("repo"), spec.get("revision")
    if not isinstance(repo, str) or not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("model repo and immutable revision are required")
    kwargs = {"revision": revision, "use_safetensors": True, "attn_implementation": "eager",
              "trust_remote_code": False}
    if family.startswith("siglip"):
        try:
            from transformers import SiglipVisionModel
            model = SiglipVisionModel.from_pretrained(repo, **kwargs)
        except ImportError:
            model = AutoModel.from_pretrained(repo, **kwargs)
    elif family.startswith("dino"):
        model = AutoModel.from_pretrained(repo, **kwargs)
    else:
        raise ValueError("model family must be siglip or dino")
    model.eval()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for model export")
    return model.to("cuda")


def model_precisions(spec: dict) -> list[str]:
    values = spec.get("precisions", list(PRECISIONS))
    if (not isinstance(values, list) or not values or any(value not in PRECISIONS for value in values)
            or len(set(values)) != len(values)):
        raise ValueError("precisions must be a nonempty unique subset of fp32/fp16")
    return [precision for precision in PRECISIONS if precision in values]


def _export_tower(spec: dict, destination: Path, batch_size: int, precision: str) -> None:
    """Export each precision directly from the same pinned Torch image tower."""
    import torch

    class VisionTower(torch.nn.Module):
        def __init__(self, model, family):
            super().__init__()
            self.model, self.family = model, family

        def forward(self, pixel_values):
            outputs = self.model(pixel_values=pixel_values)
            if self.family.startswith("dino"):
                tokens = outputs.last_hidden_state
                return tokens[:, 1:, :].mean(dim=1)
            pooled = getattr(outputs, "pooler_output", None)
            if pooled is not None:
                return pooled
            image_embeds = getattr(outputs, "image_embeds", None)
            if image_embeds is not None:
                return image_embeds
            if isinstance(outputs, (tuple, list)):
                return outputs[0][:, 0, :] if outputs[0].ndim == 3 else outputs[0]
            raise RuntimeError("vision model produced no pooled output")

    model = _torch_model(spec)
    model = model.half() if precision == "fp16" else model.float()
    wrapper = VisionTower(model, spec["family"]).eval()
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = int(spec.get("input", {}).get("size", spec.get("input", {}).get("cropSize", 224)))
    dtype = torch.float16 if precision == "fp16" else torch.float32
    dummy = torch.zeros((int(batch_size), 3, size, size), dtype=dtype, device="cuda")
    try:
        torch.onnx.export(wrapper, dummy, str(destination), input_names=["pixel_values"], output_names=["features"],
                          dynamic_axes={"pixel_values": {0: "batch"}, "features": {0: "batch"}},
                          opset_version=17, do_constant_folding=True, dynamo=False)
    finally:
        del wrapper, model, dummy
        torch.cuda.empty_cache()


def _ort_session(path: Path, threads: int = 2):
    # The image's Torch CUDA major may differ from ORT's.  Load ORT's declared
    # NVIDIA pip libraries explicitly rather than relying on Torch's copies.
    import torch
    import onnxruntime as ort

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; refusing a CPU feature run")
    available = ort.get_available_providers()
    if "CUDAExecutionProvider" not in available:
        raise RuntimeError("onnxruntime lacks CUDAExecutionProvider")
    if hasattr(ort, "preload_dlls"):
        ort.preload_dlls(directory="")
    options = ort.SessionOptions()
    options.intra_op_num_threads = int(threads)
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CUDAExecutionProvider"])
    if session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("ORT did not select CUDAExecutionProvider")
    return session


def _output_rows(session, tensor: np.ndarray, family: str, dimensions: int | None) -> np.ndarray:
    output_names = [output.name for output in session.get_outputs()]
    preferred = ("features", "image_embeds", "pooler_output", "last_hidden_state")
    name = next((candidate for candidate in preferred if candidate in output_names), output_names[0])
    value = np.asarray(session.run([name], {session.get_inputs()[0].name: tensor})[0])
    if value.ndim == 3:
        value = value[:, 1:, :].mean(axis=1) if family.startswith("dino") else value[:, 0, :]
    if value.ndim != 2:
        value = value.reshape((value.shape[0], -1))
    return normalise_features(value, dimensions)


def extract_source(session, model: dict, source: dict, *, ceph_root: str | Path | None,
                   batch_size: int, report_stage: str) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    rows, ids, features, failures = source["rows"], [], [], []
    input_info = session.get_inputs()[0]
    input_type = np.float16 if "float16" in str(input_info.type) else np.float32
    shape_batch = input_info.shape[0] if input_info.shape else None
    if isinstance(shape_batch, int) and shape_batch > 0:
        batch_size = min(batch_size, shape_batch)
    started = time.monotonic()
    pending, tensors = [], []
    completed = 0

    def flush():
        nonlocal pending, tensors, completed
        if not pending:
            return
        actual = len(pending)
        tensor = np.stack(tensors).astype(input_type, copy=False)
        fixed = shape_batch if isinstance(shape_batch, int) and shape_batch > actual else actual
        if fixed > actual:
            tensor = np.concatenate([tensor, np.zeros((fixed - actual, *tensor.shape[1:]), dtype=input_type)])
        values = _output_rows(session, tensor, model["family"], model.get("dimensions"))[:actual]
        ids.extend(item[0] for item in pending)
        features.extend(values)
        completed += actual
        encoder_report({"stage": report_stage, "completed": completed, "total": len(rows),
                        "elapsed_s": round(time.monotonic() - started, 1)})
        pending, tensors = [], []

    for row in rows:
        item_id = safe_id(row["id"], "manifest id")
        try:
            image = resolve_image(row, source, ceph_root=ceph_root)
            tensor = preprocess(image, model["input"], dtype=input_type)
        except Exception as error:
            failures.append({"id": item_id, "image": row.get("image", row.get("face")),
                             "error": (type(error).__name__ + ": " + str(error).replace("\n", " "))[:400]})
            continue
        tensors.append(tensor)
        pending.append((item_id, image))
        if len(pending) >= batch_size:
            # Inference errors abort the candidate; repeating one CUDA error
            # for every image can turn a failed GPU run into a long CPU run.
            flush()
    flush()
    return np.asarray(ids, dtype=str), np.asarray(features, dtype=np.float32).reshape((-1, int(model["dimensions"]))), failures


def _model_store(config: dict, model_id: str, precision: str) -> Path:
    configured = config.get("modelStore", "photography/eagle-culling/observe/w33-encoder")
    configured = Path(configured)
    if configured.is_absolute():
        raise ValueError("modelStore must be relative to ECP_CEPH_ROOT")
    root = os.environ.get("ECP_CEPH_ROOT")
    if not root or not Path(root).is_absolute():
        raise ValueError("ECP_CEPH_ROOT is required for modelStore")
    return _inside(Path(root), Path(root) / configured / model_id / precision, "modelStore")


def write_features(output: Path, model: dict, precision: str, source: dict, ids: np.ndarray,
                   features: np.ndarray, failures: list[dict], model_sha: str) -> dict:
    target = output / _model_id(model) / precision
    target.mkdir(parents=True, exist_ok=True)
    npz = target / f"{source['name']}.npz"
    metadata_path = target / f"{source['name']}.json"
    np.savez_compressed(npz, ids=ids.astype(str), features=features.astype(np.float32))
    metadata = {"format": "numpy npz; allow_pickle=False; ids/features aligned",
                "encoder": model["id"], "family": model["family"], "precision": precision,
                "dimensions": int(model["dimensions"]), "count": len(ids),
                "expectedCount": len(source["rows"]), "failures": failures,
                "modelSha256": model_sha, "repo": model["repo"], "revision": model["revision"],
                "license": model.get("license", "Apache-2.0"), "preprocessing": model["input"],
                "source": source["name"], "normalised": True}
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return {"npz": npz, "metadata": metadata_path, "details": metadata}


def _versions() -> dict[str, str]:
    values = {}
    for package in ("numpy", "Pillow", "torch", "transformers", "onnx", "onnxruntime-gpu", "onnxconverter-common"):
        try:
            values[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            values[package] = "importable-without-distribution-metadata"
    try:
        import torch
        import onnxruntime as ort
        values["onnxruntime"] = ort.__version__
    except ImportError:
        values["onnxruntime"] = "unavailable"
    return values


def run(config: dict, *, on_precision_complete=None) -> None:
    """Call ``on_precision_complete(model, precision, feature_dir)`` after all sources."""
    root = Path.cwd()
    output = _inside(root, root / relative_path(config.get("output", "output"), "output"), "output")
    output.mkdir(parents=True, exist_ok=True)
    models = config.get("models", config.get("encoders"))
    if not isinstance(models, list) or not models:
        raise ValueError("models must be a non-empty list")
    normalised_models = []
    for original in models:
        model = dict(original)
        model["input"] = dict(model.get("input", model.get("preprocessing", {})))
        model["family"] = str(model.get("family", ""))
        model["precisions"] = model_precisions(model)
        normalised_models.append(model)
    models = normalised_models
    sources = read_sources(config, root)
    ceph_root = os.environ.get("ECP_CEPH_ROOT")
    batch_size = int(config.get("batchSize", 16))
    if batch_size < 1 or batch_size > 64:
        raise ValueError("batchSize must be in [1, 64]")
    versions = _versions()
    encoder_report({"stage": "verified", "versions": versions, "models": [m.get("id") for m in models],
                    "precisions": {model["id"]: model["precisions"] for model in models},
                    "sources": {source["name"]: len(source["rows"]) for source in sources},
                    "provider": "CUDAExecutionProvider", "batch_size": batch_size})
    all_results, model_artifacts = [], 0
    with tempfile.TemporaryDirectory(prefix="observe-encoder-") as temporary:
        temporary = Path(temporary)
        for model in models:
            model_id = _model_id(model)
            if model.get("license") != "Apache-2.0":
                raise ValueError(f"unsupported weights license for {model_id}")
            if int(model.get("dimensions", 0)) <= 0:
                raise ValueError(f"invalid dimensions for {model_id}")
            for precision in model["precisions"]:
                model_path = temporary / model_id / f"{precision}.onnx"
                _export_tower(model, model_path, int(config.get("exportBatchSize", batch_size)), precision)
                model_sha = digest(model_path)
                store = _model_store(config, model_id, precision)
                store.mkdir(parents=True, exist_ok=True)
                stored = store / f"{model_sha}.onnx"
                shutil.copyfile(model_path, stored)
                if digest(stored) != model_sha:
                    raise RuntimeError("model store checksum mismatch")
                model_metadata = output / model_id / f"model-{precision}.json"
                model_metadata.parent.mkdir(parents=True, exist_ok=True)
                model_metadata.write_text(json.dumps({"encoder": model_id, "precision": precision,
                                                       "modelSha256": model_sha, "modelPath": str(stored.relative_to(Path(ceph_root).resolve())),
                                                       "repo": model["repo"], "revision": model["revision"],
                                                       "license": model.get("license", "Apache-2.0"),
                                                       "dimensions": int(model["dimensions"]),
                                                       "preprocessing": model["input"]}, ensure_ascii=False, indent=2) + "\n")
                encoder_artifact(model_metadata, f"{model_id}/model-{precision}.json")
                model_artifacts += 1
                session = _ort_session(model_path, int(config.get("ortThreads", 2)))
                providers = session.get_providers()
                encoder_report({"stage": "session", "encoder": model_id, "precision": precision,
                                "providers": providers, "modelSha256": model_sha})
                for source in sources:
                    ids, features, failures = extract_source(session, model, source, ceph_root=ceph_root,
                                                              batch_size=batch_size,
                                                              report_stage=f"{model_id}/{precision}/{source['name']}")
                    artifact = write_features(output, model, precision, source, ids, features, failures, model_sha)
                    artifact["details"]["modelPath"] = str(stored.relative_to(Path(ceph_root).resolve()))
                    artifact["details"]["providers"] = providers
                    artifact["metadata"].write_text(json.dumps(artifact["details"], ensure_ascii=False, indent=2) + "\n")
                    encoder_artifact(artifact["npz"], f"{model_id}/{precision}/{source['name']}.npz")
                    encoder_artifact(artifact["metadata"], f"{model_id}/{precision}/{source['name']}.json")
                    all_results.append(artifact)
                del session
                if on_precision_complete is not None:
                    on_precision_complete(model, precision, output / model_id / precision)
            encoder_report({"stage": "model-complete", "encoder": model_id})
    summary = {"versions": versions, "artifacts": [{"npz": str(item["npz"].relative_to(output)),
                                                       "metadata": str(item["metadata"].relative_to(output)),
                                                       "details": item["details"]} for item in all_results]}
    summary_path = output / "encoder-results.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    encoder_artifact(summary_path, "encoder-results.json")
    encoder_report({"stage": "complete", "artifacts": len(all_results) * 2 + model_artifacts + 1})


def main() -> None:
    signal.signal(signal.SIGTERM, lambda _signum, _frame: (_ for _ in ()).throw(SystemExit(143)))
    config = json.loads(Path("encoder-config.json").read_text())
    try:
        run(config)
    finally:
        remove_package_blob()


if __name__ == "__main__":
    main()
