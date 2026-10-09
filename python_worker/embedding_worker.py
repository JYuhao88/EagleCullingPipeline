"""Offline DINOv2 JSONL worker. Sequential CPU/DirectML, bounded preview input."""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def preprocess(file_path, config):
    with Image.open(file_path) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError("Use a bounded preview, not a full high-resolution original")
        image = ImageOps.exif_transpose(image).convert("RGB")
        scale = config["size"]["shortest_edge"] / min(image.size)
        resized_size = (int(image.width * scale), int(image.height * scale))
        # A small input pixel count alone does not bound shortest-edge resizing:
        # e.g. a 96x1 strip would expand to 24576x256 before the center crop.
        # Reject before allocation; do not distort the model's preprocessing.
        if max(resized_size) > 4096:
            raise ValueError("Preview aspect ratio would exceed the bounded model resize; review manually")
        image = image.resize(resized_size, Image.Resampling.BICUBIC)
        width, height = config["crop_size"]["width"], config["crop_size"]["height"]
        left, top = (image.width - width) // 2, (image.height - height) // 2
        image = image.crop((left, top, left + width, top + height))
        array = np.asarray(image, dtype=np.float32) * config["rescale_factor"]
        array = (array - np.asarray(config["image_mean"], dtype=np.float32)) / np.asarray(config["image_std"], dtype=np.float32)
        return np.ascontiguousarray(array.transpose(2, 0, 1)[None])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["cpu", "dml"], default="cpu")
    parser.add_argument("--profile-dir")
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    manifest = json.loads(Path("python_worker/model-manifest.json").read_text(encoding="utf-8"))
    model = next(model for model in manifest["models"] if model["name"] == "dinov2-small")
    model_path = Path(model["path"])
    with model_path.open("rb") as stream:
        actual_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual_sha != model["sha256"]:
        raise ValueError("DINOv2 checksum mismatch; refusing to load")
    config = json.loads(Path("python_worker/dinov2-preprocessor.json").read_text(encoding="utf-8"))
    provider = "DmlExecutionProvider" if args.provider == "dml" else "CPUExecutionProvider"
    if provider not in ort.get_available_providers():
        raise ValueError(f"Requested provider unavailable: {provider}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False if args.provider == "dml" else True
    for name, value in {"batch_size": 1, "num_channels": 3, "height": 224, "width": 224}.items():
        options.add_free_dimension_override_by_name(name, value)
    if args.profile_dir:
        options.enable_profiling = True
        options.profile_file_prefix = str(Path(args.profile_dir) / args.provider)
    started = time.perf_counter()
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=[provider, "CPUExecutionProvider"] if args.provider == "dml" else [provider])
    emit({"type": "ready", "requestedProvider": provider, "providers": session.get_providers(), "modelSha256": actual_sha,
          "loadMs": round((time.perf_counter() - started) * 1000), "embeddingVersion": "dinov2-small-cls-224-v1"})
    for line in sys.stdin:
        if not line.strip():
            continue
        record = json.loads(line)
        started = time.perf_counter()
        try:
            tensor = preprocess(record["filePath"], config)
            tokens = session.run(["last_hidden_state"], {"pixel_values": tensor})[0]
            # Use the global CLS representation, not an unexplained mean across
            # class and patch tokens. It is for scene similarity, not quality.
            vector = tokens[0, 0].astype(np.float32)
            norm = np.linalg.norm(vector)
            if not np.isfinite(vector).all() or not np.isfinite(norm) or norm <= 0:
                raise ValueError("Invalid embedding")
            emit({"id": record["id"], "available": True, "embedding": (vector / norm).tolist(),
                  "embeddingVersion": "dinov2-small-cls-224-v1", "elapsedMs": round((time.perf_counter() - started) * 1000)})
        except Exception as error:
            emit({"id": record.get("id"), "available": False, "error": str(error)})
    if args.profile_dir:
        emit({"type": "profile", "path": session.end_profiling()})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": {"code": "model_unavailable", "message": str(error)}})
        sys.exit(1)
