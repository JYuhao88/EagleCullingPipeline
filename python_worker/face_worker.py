"""Local MediaPipe Face Landmarker worker for blink/closed-eye flags."""
import json
import os
import sys

import mediapipe as mp
import numpy as np
from PIL import Image
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


def main():
    # Node pipes are UTF-8 JSON even when the Windows locale is not UTF-8.
    # Reconfigure explicitly so non-ASCII Eagle filenames remain intact.
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    model_path = os.environ.get("EAGLE_FACE_MODEL", "models/mediapipe/face_landmarker.task")
    if not os.path.exists(model_path):
        emit({"error": {"code": "model_unavailable", "message": f"Missing local model: {model_path}"}})
        return
    options = vision.FaceLandmarkerOptions(
        base_options=python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=10,
        output_face_blendshapes=True,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    with vision.FaceLandmarker.create_from_options(options) as detector:
        for line in sys.stdin:
            if not line.strip():
                continue
            record = json.loads(line)
            try:
                # Decode through Pillow so PNG thumbnails and JPEG originals
                # use the same RGB path; MediaPipe's file helper is stricter
                # about some Eagle-generated thumbnail encodings.
                image = Image.open(record["filePath"]).convert("RGB")
                # Keep one bounded proxy in memory; never decode a 40–100MP
                # original for landmark inference.
                image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image))
                result = detector.detect(image)
                faces = []
                for index, categories in enumerate(result.face_blendshapes or []):
                    scores = {item.category_name: float(item.score) for item in categories}
                    left = scores.get("eyeBlinkLeft", 0.0)
                    right = scores.get("eyeBlinkRight", 0.0)
                    faces.append({"index": index, "eyeBlinkLeft": left, "eyeBlinkRight": right, "eyesClosed": left >= 0.5 or right >= 0.5})
                emit({"id": record.get("id"), "faceCount": len(result.face_landmarks), "faces": faces})
            except Exception as exc:
                emit({"id": record.get("id"), "error": {"code": "inference_error", "message": str(exc)}})


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
