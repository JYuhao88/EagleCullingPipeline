"""Local MediaPipe Face Landmarker worker for blink/closed-eye flags."""
import json
import os
import sys

import mediapipe as mp
import numpy as np
from PIL import Image, ImageOps
from mediapipe.tasks import python
from mediapipe.tasks.python import vision


def detect_region(detector, image, rectangle):
    left, top, right, bottom = rectangle
    result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image.crop(rectangle))))
    faces = []
    for index, landmarks in enumerate(result.face_landmarks):
        categories = result.face_blendshapes[index] if index < len(result.face_blendshapes or []) else []
        scores = {item.category_name: float(item.score) for item in categories}
        assessed = "eyeBlinkLeft" in scores and "eyeBlinkRight" in scores
        blink_left, blink_right = scores.get("eyeBlinkLeft"), scores.get("eyeBlinkRight")
        xs = [(left + landmark.x * (right-left)) / image.width for landmark in landmarks]
        ys = [(top + landmark.y * (bottom-top)) / image.height for landmark in landmarks]
        faces.append({"box": [max(0,min(xs)), max(0,min(ys)), min(1,max(xs)), min(1,max(ys))],
                      "eyesAssessed": assessed, "eyeBlinkLeft": blink_left, "eyeBlinkRight": blink_right,
                      "eyesClosed": assessed and (blink_left >= 0.5 or blink_right >= 0.5)})
    return faces


def same_face(a, b):
    ax, ay, ar, ab = a["box"]
    bx, by, br, bb = b["box"]
    intersection = max(0,min(ar,br)-max(ax,bx)) * max(0,min(ab,bb)-max(ay,by))
    union = (ar-ax)*(ab-ay)+(br-bx)*(bb-by)-intersection
    return union > 0 and intersection / union > 0.3


def analyze_faces(detector, image, scale_fallback=False):
    faces = detect_region(detector,image,(0,0,image.width,image.height))
    method, regions = "whole-preview", 1
    if not faces and scale_fallback and max(image.size) >= 640:
        method = "whole-plus-tiles-v1"
        for x in (0,0.4):
            for y in (0,0.4):
                rectangle = (int(x*image.width),int(y*image.height),min(image.width,int((x+0.6)*image.width)),min(image.height,int((y+0.6)*image.height)))
                regions += 1
                for face in detect_region(detector,image,rectangle):
                    if not any(same_face(face,known) for known in faces):
                        faces.append(face)
    return {"faceCount":len(faces),"faces":[{**face,"index":index} for index,face in enumerate(faces)],"detectionMethod":method,"regionsAnalyzed":regions}


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
                with Image.open(record["filePath"]) as source:
                    # Check dimensions before RGB conversion/full allocation.
                    # Thumbnailing alone does not prevent decoding a huge source.
                    if source.width * source.height > 16_000_000:
                        raise ValueError("Use a bounded preview for face detection, not a high-resolution original")
                    image = ImageOps.exif_transpose(source).convert("RGB")
                    image.thumbnail((1280, 1280), Image.Resampling.LANCZOS)
                result = analyze_faces(detector,image,record.get("scaleFallback") is True)
                emit({"id": record.get("id"), "available": True, **result})
            except Exception as exc:
                emit({"id": record.get("id"), "available": False, "error": {"code": "inference_error", "message": str(exc)}})


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
