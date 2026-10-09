"""Read-only scale probe using the same offline model and thresholds as production."""
import hashlib
import json
import sys
import time
from pathlib import Path

import mediapipe as mp
import numpy as np
from PIL import Image, ImageOps
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

sys.stdout.reconfigure(encoding="utf-8")
model_path = Path("models/mediapipe/face_landmarker.task")
options = vision.FaceLandmarkerOptions(
    base_options=python.BaseOptions(model_asset_path=str(model_path)),
    running_mode=vision.RunningMode.IMAGE, num_faces=10,
    output_face_blendshapes=True, min_face_detection_confidence=0.5,
    min_face_presence_confidence=0.5, min_tracking_confidence=0.5)
reports = []
with vision.FaceLandmarker.create_from_options(options) as detector:
    for file_path in sys.argv[1:]:
        with Image.open(file_path) as source:
            if source.width * source.height > 16_000_000:
                raise ValueError("Probe accepts bounded previews only")
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
        views = [("whole", (0, 0, image.width, image.height))]
        for x in (0, 0.4):
            for y in (0, 0.4):
                views.append((f"tile-{x}-{y}", (int(x*image.width), int(y*image.height), min(image.width,int((x+0.6)*image.width)), min(image.height,int((y+0.6)*image.height)))))
        rows = []
        for name, rectangle in views:
            started = time.perf_counter()
            result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image.crop(rectangle))))
            rows.append({"view": name, "rectangle": rectangle, "faceCount": len(result.face_landmarks),
                         "elapsedMs": round((time.perf_counter()-started)*1000),
                         "eyes": [{category.category_name: float(category.score) for category in categories if category.category_name in ("eyeBlinkLeft", "eyeBlinkRight")} for categories in result.face_blendshapes]})
        reports.append({"filePath": file_path, "rows": rows})
with model_path.open("rb") as stream:
    sha = hashlib.file_digest(stream,"sha256").hexdigest()
print(json.dumps({"modelSha256":sha,"threshold":0.5,"reports":reports,"caveat":"Crop detections are not deduplicated or accuracy-calibrated; no Eagle writes."},ensure_ascii=False,indent=2))
