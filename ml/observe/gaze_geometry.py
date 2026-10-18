"""Small MediaPipe iris/head-pose feature extractor for gaze probes.

The module keeps model I/O separate from the feature calculation so a probe
can use exactly the same geometry in a later runtime adapter.  A result is
``None`` when the face does not contain the 478 landmarks, either iris is
missing, or the eye geometry is outside conservative sanity bounds.  The
features are dimensionless and are intended for a calibrated probe, not for a
standalone gaze decision.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


# MediaPipe Face Mesh's two corner pairs and the five iris points.  The corner
# order is outer-to-inner for both eyes, so a positive horizontal iris offset
# has the same anatomical meaning on the two sides.
EYES = (
    ((33, 133), (468, 469, 470, 471, 472), (159, 160), (145, 144)),
    ((263, 362), (473, 474, 475, 476, 477), (386, 385), (374, 380)),
)
MIN_EYE_WIDTH = 1e-3
MAX_EYE_WIDTH = 0.5
MIN_IRIS_RADIUS = 1e-5
MAX_IRIS_RADIUS = 0.25


def _xyz(point: Any) -> np.ndarray | None:
    """Read a MediaPipe NormalizedLandmark or a numeric x/y[/z] sequence."""
    if point is None:
        return None
    if isinstance(point, dict):
        values = (point.get("x"), point.get("y"), point.get("z", 0.0))
    else:
        values = (getattr(point, "x", None), getattr(point, "y", None),
                  getattr(point, "z", 0.0))
        if values[0] is None and isinstance(point, Sequence):
            values = tuple(point[:3])
            if len(values) == 2:
                values = (*values, 0.0)
        elif values[0] is None and hasattr(point, "__len__"):
            values = tuple(point[:3])
            if len(values) == 2:
                values = (*values, 0.0)
    try:
        out = np.asarray(values, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    return out if out.shape == (3,) and np.isfinite(out).all() else None


def _points(landmarks: Iterable[Any]) -> list[np.ndarray] | None:
    values = [] if landmarks is None else list(landmarks)
    if len(values) < 478:
        return None
    output = [_xyz(value) for value in values[:478]]
    return output if all(value is not None for value in output) else None


def _rotation_matrix(matrix: Any) -> np.ndarray | None:
    """Return a 3x3 rotation block from MediaPipe's 4x4 transform."""
    try:
        value = np.asarray(matrix, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if value.shape == (4, 4):
        value = value[:3, :3]
    elif value.shape == (3, 3):
        value = value
    elif value.size == 16:
        value = value.reshape(4, 4)[:3, :3]
    elif value.size == 9:
        value = value.reshape(3, 3)
    else:
        return None
    if not np.isfinite(value).all():
        return None
    # The task's matrix is numerically a rotation plus scale.  Project away
    # the scale before Euler decomposition; SVD also tolerates tiny drift.
    u, singular_values, vt = np.linalg.svd(value)
    if singular_values[-1] < 1e-8 or singular_values[-1] / singular_values[0] < 0.05:
        return None
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        u[:, -1] *= -1
        rotation = u @ vt
    return rotation


def pose_from_matrix(matrix: Any) -> tuple[float, float, float] | None:
    """Convert a facial transform to Z/Y/X (yaw/pitch/roll) degrees.

    This is the conventional right-handed ZYX decomposition.  The values are
    retained as numeric features and should be calibrated with the same model
    and image orientation used by the runtime; the extractor does not attach
    a camera-facing interpretation to a sign.
    """
    rotation = _rotation_matrix(matrix)
    if rotation is None:
        return None
    sy = math.hypot(float(rotation[0, 0]), float(rotation[1, 0]))
    singular = sy < 1e-7
    if not singular:
        x = math.atan2(float(rotation[2, 1]), float(rotation[2, 2]))
        y = math.atan2(float(-rotation[2, 0]), sy)
        z = math.atan2(float(rotation[1, 0]), float(rotation[0, 0]))
    else:
        x = math.atan2(float(-rotation[1, 2]), float(rotation[1, 1]))
        y = math.atan2(float(-rotation[2, 0]), sy)
        z = 0.0
    # Return yaw around vertical, pitch around horizontal, roll in-plane.
    return tuple(math.degrees(value) for value in (y, x, z))


def _eye_features(points: list[np.ndarray], corners: tuple[int, int], iris: tuple[int, ...],
                  uppers: tuple[int, ...], lowers: tuple[int, ...]) -> tuple[float, ...] | None:
    outer, inner = points[corners[0]], points[corners[1]]
    axis = inner[:2] - outer[:2]
    width = float(np.linalg.norm(axis))
    if not MIN_EYE_WIDTH <= width <= MAX_EYE_WIDTH:
        return None
    unit = axis / width
    normal = np.asarray((-unit[1], unit[0]))
    midpoint = (outer[:2] + inner[:2]) / 2.0
    iris_points = np.asarray([points[index][:2] for index in iris])
    iris_center = iris_points.mean(axis=0)
    radius = float(np.median(np.linalg.norm(iris_points - iris_center, axis=1)))
    if not MIN_IRIS_RADIUS <= radius <= MAX_IRIS_RADIUS:
        return None
    offset = iris_center - midpoint
    horizontal = float(np.dot(offset, unit) / width)
    vertical = float(np.dot(offset, normal) / width)
    upper = np.asarray([points[index][:2] for index in uppers]).mean(axis=0)
    lower = np.asarray([points[index][:2] for index in lowers]).mean(axis=0)
    # Preserve the signed lid component used by the frozen research features.
    lid = float(np.dot(lower - upper, normal) / width)
    angle = math.atan2(float(axis[1]), float(axis[0]))
    # Eye corners and iris must remain in a plausible local neighbourhood.  A
    # false 478-face detection otherwise creates very confident nonsense.
    if max(abs(horizontal), abs(vertical)) > 0.8 or abs(lid) > 0.8:
        return None
    return horizontal, vertical, lid, radius / width, math.sin(angle), math.cos(angle)


def geometry_features(landmarks: Iterable[Any], matrix: Any = None) -> dict[str, Any] | None:
    """Extract an ordered, JSON-safe feature vector from one face result.

    The six values per eye are ``iris_x``, ``iris_y``, ``lid_ratio``,
    ``iris_radius_ratio``, ``eye_axis_sin`` and ``eye_axis_cos``.  Four pooled
    iris values are appended, followed by ``yaw``, ``pitch`` and ``roll`` in
    degrees.  A missing facial matrix leaves pose values as ``None`` and sets
    ``poseAvailable`` false; callers may drop such rows rather than mixing a
    different pose estimator into the training set.
    """
    points = _points(landmarks)
    if points is None:
        return None
    eyes = [_eye_features(points, *spec) for spec in EYES]
    if any(value is None for value in eyes):
        return None
    first, second = eyes
    iris_x = [first[0], second[0]]
    iris_y = [first[1], second[1]]
    values = [*first, *second,
              float(np.mean(iris_x)), float(np.mean(iris_y)),
              float(np.mean(np.abs(iris_x))), float(iris_x[0] - iris_x[1])]
    pose = pose_from_matrix(matrix)
    if pose is None:
        pose_values = [None, None, None]
    else:
        pose_values = list(pose)
    vector = [*values, *pose_values]
    if not np.isfinite(vector[:16]).all():
        return None
    return {
        "features": vector,
        "irisX": iris_x,
        "irisY": iris_y,
        "lidRatio": [first[2], second[2]],
        "irisRadiusRatio": [first[3], second[3]],
        "pose": {"yaw": pose_values[0], "pitch": pose_values[1], "roll": pose_values[2]},
        "poseAvailable": pose is not None,
    }


class GeometryExtractor:
    """Reusable Face Landmarker session for bounded research batches."""

    def __init__(self, model_path: str | Path):
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision

        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(f"Missing local model: {model_path}")
        self._mp = mp
        self._vision = vision
        self._detector = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=True,
        ))

    def __enter__(self) -> "GeometryExtractor":
        return self

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        close = getattr(self._detector, "close", None)
        if close:
            close()

    def extract(self, file_path: str | Path) -> np.ndarray | None:
        from PIL import Image, ImageOps

        with Image.open(file_path) as source:
            if source.width * source.height > 16_000_000:
                raise ValueError("Use a bounded face crop")
            image = ImageOps.exif_transpose(source).convert("RGB")
            data = np.asarray(image)
        result = self._detector.detect(self._mp.Image(
            image_format=self._mp.ImageFormat.SRGB, data=data))
        if not result.face_landmarks:
            return None
        matrices = getattr(result, "facial_transformation_matrixes", None) or []
        if not matrices:
            return None
        details = geometry_features(result.face_landmarks[0], matrices[0])
        if details is None or not details["poseAvailable"]:
            return None
        return np.asarray(details["features"], dtype=np.float32)


def geometry_terms_vector(raw19: Any) -> np.ndarray:
    """Expand raw, absolute and row-major upper-triangle products in float64."""
    value = np.asarray(raw19, dtype=np.float64)
    if value.shape != (19,) or not np.isfinite(value).all():
        raise ValueError("Expected 19 finite geometry features")
    with np.errstate(over='ignore', invalid='ignore'):
        terms = np.concatenate((value, np.abs(value),
                                (value[:, None] * value[None, :])[np.triu_indices(19)]))
    if not np.isfinite(terms).all():
        raise ValueError("Geometry products must be finite")
    return terms


__all__ = ["EYES", "GeometryExtractor", "geometry_features", "geometry_terms_vector", "pose_from_matrix"]
