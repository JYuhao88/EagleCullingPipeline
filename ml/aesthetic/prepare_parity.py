"""Unpack only public parity fixtures and verify exact preprocessed RGB pixels."""
import argparse
import json
import zipfile
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--verify-pixels', action='store_true')
    args = parser.parse_args()
    if args.verify_pixels:
        report_path = args.fixtures / 'local-parity.json'
        report = json.loads(report_path.read_text())
        differences = []
        for row in report['rows']:
            identifier = row['id']
            if not identifier.isdigit():
                raise ValueError('Invalid AVA fixture ID')
            tensor = np.load(args.fixtures / (identifier + '.npy'), allow_pickle=False)[0].transpose(1, 2, 0)
            reference = np.clip(np.rint((tensor * [.229, .224, .225] + [.485, .456, .406]) * 255), 0, 255).astype(np.uint8)
            actual = np.frombuffer((args.fixtures / (identifier + '.rgb')).read_bytes(), dtype=np.uint8).reshape(224, 224, 3)
            differences.append(np.abs(reference.astype(int) - actual))
        report['pixel_max_diff'] = int(max(array.max() for array in differences))
        report['pixel_mean_abs_diff'] = float(np.mean([array.mean() for array in differences]))
        report['pass'] = report['pass'] and report['pixel_max_diff'] == 0
        report_path.write_text(json.dumps(report))
        print(json.dumps({key: report[key] for key in ['n', 'cosine_min', 'pixel_max_diff', 'pixel_mean_abs_diff', 'pass']}))
        return
    args.fixtures.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.artifacts / 'parity-fixtures.zip') as archive:
        names = [name for name in archive.namelist() if name.endswith('.jpg')]
        if len(names) != 20:
            raise ValueError('Require exactly 20 public fixtures')
        for info in archive.infolist():
            path = Path(info.filename)
            if path.name != info.filename or not path.stem.isdigit() or path.suffix not in ['.jpg', '.npy']:
                raise ValueError('Unsafe public fixture filename')
            if info.file_size > 32 * 1024 * 1024:
                raise ValueError('Unbounded fixture')
            (args.fixtures / info.filename).write_bytes(archive.read(info))
    vectors = np.load(args.artifacts / 'parity-embeddings.npy', allow_pickle=False)
    if vectors.shape != (20, 384) or not np.isfinite(vectors).all():
        raise ValueError('Invalid parity vectors')
    (args.fixtures / 'remote-vectors.json').write_text(json.dumps({Path(name).stem: vector.tolist()
                                                                for name, vector in zip(names, vectors)}))
    print(json.dumps({'prepared_public_fixtures': len(names)}))


if __name__ == '__main__':
    main()
