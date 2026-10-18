"""Read-only, two-thread TOPIQ-IAA inference on at most 60 local previews."""
import argparse
import hashlib
import json
import time
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.limit <= 60:
        parser.error('--limit must be 1..60')
    with args.model.open('rb') as stream:
        checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checksum != '1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad':
        raise ValueError('Teacher checksum mismatch')
    results = json.loads(args.results.read_text())['results']
    available = sorted((row for row in results if row.get('embedding') and Path(row.get('previewPath', '')).is_file()),
                       key=lambda row: row['unitId'])
    selected = [available[index] for index in np.linspace(0, len(available) - 1, min(args.limit, len(available)), dtype=int)]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(args.model), options, providers=['CPUExecutionProvider'])
    rows = []
    for row in selected:
        started = time.perf_counter()
        with Image.open(row['previewPath']) as source:
            image = ImageOps.exif_transpose(source).convert('RGB').resize((512, 512), Image.Resampling.BILINEAR)
            tensor = np.asarray(image, dtype=np.float32).transpose(2, 0, 1)[None] / 255
        raw = float(session.run(None, {'image': tensor})[0].reshape(-1)[0])
        rows.append({'unitId': row['unitId'], 'teacher_raw': raw, 'elapsed_ms': (time.perf_counter() - started) * 1000})
    args.output.write_text(json.dumps({'n': len(rows), 'teacher_sha256': checksum, 'threads': 2, 'rows': rows}))
    print(json.dumps({'n': len(rows), 'mean_ms': float(np.mean([r['elapsed_ms'] for r in rows])),
                      'p95_ms': float(np.percentile([r['elapsed_ms'] for r in rows], 95))}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'failed': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
