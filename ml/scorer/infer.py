#!/usr/bin/env python3
"""Torch-free JSONL inference for the default ONNX scorer."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps
BASE_MODEL = 'technical-aesthetic-lite'
DEFAULT_MODEL = 'topiq-nr-onnx'
DEFAULT_AESTHETIC_MODEL = 'topiq-iaa-onnx'
VERSION = '2.2'
MODEL_DIR = Path(__file__).resolve().parents[2] / 'models' / 'scorer'
ONNX_PATH = MODEL_DIR / 'topiq_nr_512.onnx'

def open_array(path: str, size: int = 512) -> np.ndarray:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
        image = image.resize((size, size), Image.Resampling.BILINEAR)
        return np.asarray(image, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0

def score_technical(path: str) -> tuple[float, float]:
    image = open_array(path)[0].transpose(1, 2, 0)
    luminance = 0.2126 * image[..., 0] + 0.7152 * image[..., 1] + 0.0722 * image[..., 2]
    gradient_x = np.diff(luminance, axis=1)
    gradient_y = np.diff(luminance, axis=0)
    sharpness = min(1.0, float(np.mean(gradient_x**2) + np.mean(gradient_y**2)) / 0.018)
    exposure = max(0.0, 1.0 - abs(float(np.mean(luminance)) - 0.5) / 0.5)
    clipped = float(np.mean((luminance < 0.015) | (luminance > 0.985)))
    clipping = max(0.0, 1.0 - clipped / 0.12)
    quality = float(np.clip(0.55 * sharpness + 0.30 * exposure + 0.15 * clipping, 0, 1))
    histogram, _ = np.histogram(luminance, bins=32, range=(0, 1), density=True)
    probabilities = histogram / max(np.sum(histogram), 1e-9)
    entropy = float(-np.sum(probabilities[probabilities > 0] * np.log2(probabilities[probabilities > 0])) / 5)
    colour = float(np.clip(np.mean(np.std(image, axis=2)) / 0.25, 0, 1))
    aesthetic = float(np.clip(0.55 * quality + 0.30 * min(1, entropy) + 0.15 * colour, 0, 1))
    return quality, aesthetic

class OnnxScorer:
    def __init__(self, path: Path = ONNX_PATH, threads: int = 3):
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError('安装 ml/.venv/bin/pip install onnxruntime') from error
        if not path.exists():
            raise FileNotFoundError(f'缺少权重 {path}，先运行 fetch_weights.py')
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(max(1, threads), 3)
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def raw_score(self, path: str) -> float:
        return float(np.asarray(self.session.run(None, {self.input_name: open_array(path)})[0]).reshape(-1)[0])

    def score(self, path: str) -> tuple[float, None]:
        raw = self.raw_score(path)
        # Dataset reporting uses KonIQ (MOS 1..5) -> (MOS-1)/4 and AVA (1..10) -> (MOS-1)/9.
        # TOPIQ's exported head is already a unit score; keep it in [0,1].
        value = float(np.clip(raw / 100.0 if raw > 1.0 else raw, 0, 1))
        # Aesthetic inference is an explicit opt-in below; loading NR alone
        # must never silently substitute a technical score for aesthetics.
        return value, None

def make_scorer(model: str, threads: int = 3):
    if model == BASE_MODEL:
        return score_technical
    if model == DEFAULT_MODEL:
        return OnnxScorer(threads=threads).score
    raise RuntimeError(f'不支持模型 {model}；可用 {BASE_MODEL} 或 {DEFAULT_MODEL}')

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='*')
    parser.add_argument('--list', dest='list_file')
    parser.add_argument('--model', default=os.environ.get('EAGLE_SCORER_MODEL', DEFAULT_MODEL))
    parser.add_argument('--threads', type=int, default=3, help='CPU intra-op threads (clamped to 1..3)')
    parser.add_argument('--aesthetic-onnx', type=Path, help='Explicitly enable an evaluated aesthetic ONNX model')
    parser.add_argument('--aesthetic-model', default=DEFAULT_AESTHETIC_MODEL)
    parser.add_argument('--aesthetic-version', default='topiq-iaa-512-v1')
    parser.add_argument('--aesthetic-scale', type=float, default=1.0 / 9.0,
                        help='Raw AVA MOS (1..10) to unit-score multiplier')
    parser.add_argument('--aesthetic-offset', type=float, default=-1.0 / 9.0,
                        help='Verified raw-head to unit-score offset')
    args = parser.parse_args()
    paths = list(args.paths)
    if args.list_file:
        paths.extend(line.strip() for line in Path(args.list_file).read_text().splitlines() if line.strip())
    scorer = make_scorer(args.model, threads=args.threads)
    aesthetic_scorer = None
    aesthetic_load_warning = None
    if args.aesthetic_onnx:
        try:
            aesthetic_scorer = OnnxScorer(args.aesthetic_onnx, threads=args.threads)
        except Exception as error:
            aesthetic_load_warning = f'{type(error).__name__}: {error}'
    aesthetic_metadata = {
        'aesthetic_model': args.aesthetic_model if args.aesthetic_onnx else None,
        'aesthetic_version': args.aesthetic_version if args.aesthetic_onnx else None,
    }
    for path in paths:
        try:
            quality, aesthetic = scorer(path)
            aesthetic_warning = aesthetic_load_warning
            if args.aesthetic_onnx:
                aesthetic = None
            if aesthetic_scorer is not None:
                try:
                    aesthetic = aesthetic_scorer.raw_score(path) * args.aesthetic_scale + args.aesthetic_offset
                    if not np.isfinite(aesthetic):
                        raise ValueError('aesthetic 模型输出非有限值')
                except Exception as error:
                    aesthetic = None
                    aesthetic_warning = f'{type(error).__name__}: {error}'
            row = {'path': str(path), 'quality': round(float(np.clip(quality, 0, 1)), 6),
                   'aesthetic': None if aesthetic is None else round(float(np.clip(aesthetic, 0, 1)), 6),
                   'model': args.model, 'version': VERSION if args.model == DEFAULT_MODEL else '1.1',
                   **aesthetic_metadata}
            if aesthetic_warning:
                row['aesthetic_warning'] = aesthetic_warning
        except Exception as error:
            row = {'path': str(path), 'error': f'{type(error).__name__}: {error}',
                   'model': args.model, 'version': VERSION, **aesthetic_metadata}
        print(json.dumps(row, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
