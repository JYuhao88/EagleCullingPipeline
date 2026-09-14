"""GPU-capable ONNX image embedding worker.

Requires a local DINOv2 ONNX model and `onnxruntime-gpu`. The model path is
explicit so production runs remain offline and reproducible.
"""
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image
import onnxruntime as ort


def load_session(model_path):
    try:
        ort.preload_dlls()
    except Exception:
        pass
    # On Windows the prebuilt Node binding does not expose CUDA; Python
    # DirectML is the practical GPU path for this workstation.
    providers = ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]
    available = ort.get_available_providers()
    providers = [p for p in providers if p in available]
    return ort.InferenceSession(model_path, providers=providers), providers[0]


def preprocess(path):
    # Xenova/dinov2-small ONNX export has a fixed 224x224 input (257 tokens).
    image = Image.open(path).convert("RGB").resize((224, 224), Image.Resampling.BICUBIC)
    data = np.asarray(image, dtype=np.float32) / 255.0
    data = (data - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    return np.transpose(data, (2, 0, 1))[None, ...]


def main():
    # Node/PowerShell pipes carry UTF-8 JSON even when the Windows locale does
    # not. Configure the streams explicitly so Eagle paths may contain CJK.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    model_path = os.environ.get("EAGLE_DINO_ONNX", "models/dinov2-small/model.onnx")
    if not os.path.exists(model_path):
        emit({"error": {"code": "model_unavailable", "message": f"Missing local model: {model_path}"}})
        return
    try:
        session, provider = load_session(model_path)
    except Exception as exc:
        emit({"error": {"code": "runtime_unavailable", "message": str(exc)}})
        return
    input_name = session.get_inputs()[0].name
    for line in sys.stdin:
        if not line.strip():
            continue
        record = json.loads(line)
        try:
            output = session.run(None, {input_name: preprocess(record["filePath"])})[0]
            vector = output.reshape(-1, output.shape[-1]).mean(axis=0) if output.ndim == 3 else output.reshape(-1)
            vector = vector / max(float(np.linalg.norm(vector)), 1e-12)
            emit({"id": record.get("id"), "embedding": vector.astype(float).tolist(), "provider": provider, "sha256": file_hash(record["filePath"])})
        except Exception as exc:
            emit({"id": record.get("id"), "error": {"code": "inference_error", "message": str(exc)}})


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
