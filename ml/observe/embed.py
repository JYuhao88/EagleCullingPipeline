"""Local ONNX image encoders used by the observation probe.

The preprocessing here mirrors the production Node paths.  DINOv2 uses the
mean of patch tokens (excluding CLS), while CLIP returns the image embedding
as exported by its ONNX model.  ``pyvips`` is preferred because Node ``sharp``
uses libvips; Pillow remains a small, dependency-light fallback for tests.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np


CLIP_MEAN = np.asarray([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
CLIP_STD = np.asarray([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
# Keep decimal constants at JS double precision before the final Float32 cast.
_CLIP_MEAN64 = np.asarray([0.48145466, 0.4578275, 0.40821073], dtype=np.float64)
_CLIP_STD64 = np.asarray([0.26862954, 0.26130258, 0.27577711], dtype=np.float64)
_IMAGENET_MEAN64 = np.asarray([0.485, 0.456, 0.406], dtype=np.float64)
_IMAGENET_STD64 = np.asarray([0.229, 0.224, 0.225], dtype=np.float64)
DINO_VERSION = "dinov2-small-mean-patch-224-v1"
CLIP_VERSION = "clip-vit-base-patch32-local-v1"


def _vips_image(path: str | Path, *, autorot: bool = False, fast_shrink_size: int | None = None) -> Any:
    """Load an image through libvips when available, preserving RGB pixels."""
    try:
        import pyvips
    except (ImportError, OSError):
        return None
    image = pyvips.Image.new_from_file(str(path), access="sequential", fail_on="warning")
    if fast_shrink_size and Path(path).suffix.lower() in {".jpg", ".jpeg"}:
        shrink = min(image.width, image.height) / fast_shrink_size
        jpeg_shrink = 8 if shrink >= 8 else 4 if shrink >= 4 else 2 if shrink >= 2 else 1
        if jpeg_shrink > 1 and int(shrink) == jpeg_shrink:
            jpeg_shrink //= 2
        if jpeg_shrink > 1:
            image = pyvips.Image.jpegload(str(path), shrink=jpeg_shrink, access="sequential", fail_on="warning")
    if autorot:
        image = image.autorot()
    # sharp's toColourspace('srgb') is equivalent to this conversion for the
    # ordinary RGB/JPEG inputs used by the probe.  Keep invalid ICC profiles as
    # sharp does by retaining the source pixels when conversion fails.
    if image.get_typeof("icc-profile-data"):
        try:
            image = image.icc_transform("srgb", embedded=True, depth=8, intent="perceptual")
        except pyvips.Error:
            pass
    elif image.interpretation == "cmyk":
        image = image.icc_transform("srgb", input_profile="cmyk", intent="perceptual")
    if image.bands > 3:
        image = image.extract_band(0, n=3)
    if image.bands == 1:
        image = image.bandjoin(image).bandjoin(image)
    return image.colourspace("srgb").cast("uchar")


def _pil_image(path: str | Path, *, autorot: bool = False):
    from PIL import Image, ImageOps

    image = Image.open(path)
    if autorot:
        image = ImageOps.exif_transpose(image)
    return image.convert("RGB")


def _cover_pixels(path: str | Path, size: int, *, kernel: str, autorot: bool) -> np.ndarray:
    """Return HWC uint8 pixels equivalent to sharp's centered cover resize."""
    image = _vips_image(path, autorot=autorot, fast_shrink_size=size)
    if image is not None:
        scale = max(size / image.width, size / image.height)
        image = image.resize(scale, kernel=kernel)
        left = max(0, (image.width - size + 1) // 2)
        top = max(0, (image.height - size + 1) // 2)
        image = image.extract_area(left, top, size, size)
        return np.frombuffer(image.write_to_memory(), dtype=np.uint8).reshape(size, size, 3)

    from PIL import Image

    image = _pil_image(path, autorot=autorot)
    scale = max(size / image.width, size / image.height)
    dimensions = (max(size, round(image.width * scale)), max(size, round(image.height * scale)))
    resample = Image.Resampling.BICUBIC if kernel == "cubic" else Image.Resampling.LANCZOS
    image = image.resize(dimensions, resample)
    left = max(0, (image.width - size + 1) // 2)
    top = max(0, (image.height - size + 1) // 2)
    return np.asarray(image.crop((left, top, left + size, top + size)), dtype=np.uint8)


def _normalised_chw(pixels: np.ndarray, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    # Node assigns each JS double calculation to a Float32Array.  Keep the
    # arithmetic in float64 until that final assignment instead of rounding
    # after the /255 operation as NumPy float32 would do.
    values = (pixels.astype(np.float64) / 255.0 - mean.astype(np.float64)) / std.astype(np.float64)
    return np.ascontiguousarray(values.transpose(2, 0, 1)[None], dtype=np.float32)


def clip_preprocess(path: str | Path, size: int = 224) -> np.ndarray:
    """Match ``src/core/ai-tags.js`` CLIP preprocessing."""
    pixels = clip_pixels(path, size)
    return _normalised_chw(pixels, _CLIP_MEAN64, _CLIP_STD64)


def clip_pixels(path: str | Path, size: int = 224) -> np.ndarray:
    """Return the RGB pixels before CLIP normalization for parity diagnostics."""
    return _cover_pixels(path, size, kernel="cubic", autorot=True)


def dino_preprocess(path: str | Path) -> np.ndarray:
    """Match the ``dinov2-small-mean-patch-224-v1`` sharp/libvips path."""
    pixels = _cover_pixels(path, 256, kernel="lanczos3", autorot=False)
    pixels = pixels[16:240, 16:240]
    return _normalised_chw(pixels, _IMAGENET_MEAN64, _IMAGENET_STD64)


def model_sha256(path: str | Path) -> str:
    checksum = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def _session(path: str | Path, threads: int, provider: str):
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError("onnxruntime is required for local observation embeddings") from error
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    available = ort.get_available_providers()
    if provider not in available:
        raise RuntimeError(f"Requested ONNX provider unavailable: {provider}")
    return ort.InferenceSession(str(path), sess_options=options, providers=[provider])


def _dino_embedding(session, tensor: np.ndarray) -> np.ndarray:
    output = session.run(["last_hidden_state"], {session.get_inputs()[0].name: tensor})[0]
    tokens = output[0]
    if tokens.ndim != 2 or tokens.shape[0] < 2:
        raise ValueError(f"Unexpected DINOv2 output shape: {output.shape}")
    # Match src/core/embeddings.js: every addition is rounded by Float32Array.
    vector = np.zeros(tokens.shape[1], dtype=np.float32)
    divisor = tokens.shape[0] - 1
    for token in tokens[1:]:
        # NumPy's float32 division can round before the addition.  JavaScript
        # divides as float64 and rounds only when assigning to Float32Array.
        vector = (vector.astype(np.float64) + token.astype(np.float64) / divisor).astype(np.float32)
    norm = np.linalg.norm(vector.astype(np.float64))
    if not np.isfinite(norm) or norm <= 0 or not np.isfinite(vector).all():
        raise ValueError("Invalid DINOv2 embedding")
    return (vector.astype(np.float64) / norm).astype(np.float32)


class Encoder:
    """One local ONNX encoder, with a production-compatible ``embed`` method."""

    def __init__(self, kind: str, model_path: str | Path, *, threads: int = 2, provider: str = "CPUExecutionProvider"):
        if kind not in {"clip", "dino"}:
            raise ValueError("kind must be 'clip' or 'dino'")
        self.kind = kind
        self.model_path = Path(model_path)
        self.version = CLIP_VERSION if kind == "clip" else DINO_VERSION
        self._session = _session(self.model_path, threads, provider)

    def preprocess(self, path: str | Path) -> np.ndarray:
        return clip_preprocess(path) if self.kind == "clip" else dino_preprocess(path)

    def embed(self, path: str | Path) -> np.ndarray:
        tensor = self.preprocess(path)
        if self.kind == "dino":
            return _dino_embedding(self._session, tensor)
        outputs = self._session.run(None, {self._session.get_inputs()[0].name: tensor})
        names = [output.name for output in self._session.get_outputs()]
        index = names.index("image_embeds") if "image_embeds" in names else 0
        vector = np.asarray(outputs[index]).reshape(-1).astype(np.float32)
        if not np.isfinite(vector).all() or not vector.size:
            raise ValueError("Invalid CLIP embedding")
        return vector


__all__ = [
    "CLIP_VERSION",
    "DINO_VERSION",
    "Encoder",
    "clip_preprocess",
    "clip_pixels",
    "dino_preprocess",
    "model_sha256",
]
