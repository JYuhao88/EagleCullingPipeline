"""JSONL GPU worker for optional local DINOv2 embeddings.

The process is deliberately stateless per input line and never mutates source
files. A checkpoint path must be supplied explicitly through
EAGLE_DINO_CHECKPOINT; this avoids hidden network downloads in the production
pipeline.
"""
import hashlib
import json
import os
import sys


def main():
    checkpoint = os.environ.get("EAGLE_DINO_CHECKPOINT")
    try:
        import torch
        from PIL import Image
        from torchvision import transforms
    except Exception as exc:  # pragma: no cover - exercised on deployment host
        emit_error("runtime_unavailable", str(exc))
        return
    if not checkpoint or not os.path.exists(checkpoint):
        emit_error("model_unavailable", "Set EAGLE_DINO_CHECKPOINT to a local TorchScript/checkpoint path")
        return
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = torch.jit.load(checkpoint, map_location=device).eval()
    transform = transforms.Compose([
        transforms.Resize((518, 518)),
        transforms.ToTensor(),
        transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    ])
    for line in sys.stdin:
        if not line.strip():
            continue
        record = json.loads(line)
        try:
            image = Image.open(record["filePath"]).convert("RGB")
            tensor = transform(image).unsqueeze(0).to(device)
            with torch.inference_mode():
                vector = model(tensor).flatten().float().cpu()
            vector /= vector.norm().clamp_min(1e-12)
            emit({"id": record.get("id"), "embedding": vector.tolist(), "device": device, "sha256": file_hash(record["filePath"])})
        except Exception as exc:  # keep the stream alive for other images
            emit_error("inference_error", str(exc), record.get("id"))


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def emit_error(code, message, item_id=None):
    emit({"id": item_id, "error": {"code": code, "message": message}})


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

