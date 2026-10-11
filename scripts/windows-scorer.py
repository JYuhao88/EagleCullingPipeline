"""Serial, resumable Python CPU/DirectML TOPIQ comparison on synthetic data only."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.scorer.infer import OnnxScorer


def main():
    if os.name != 'nt':
        raise RuntimeError('Cold inference is restricted to Windows')
    manifest = json.loads((ROOT / 'test/fixtures/bench-syn-manifest.json').read_text(encoding='utf-8'))
    directory = ROOT / 'data/cache/windows-validation/python-scorer'
    directory.mkdir(parents=True, exist_ok=True)
    summary = {}
    for provider in ('CPUExecutionProvider', 'DmlExecutionProvider'):
        os.environ['EAGLE_SCORER_PROVIDER'] = provider
        scorer = OnnxScorer(threads=2)
        rows = []
        for image in manifest['images']:
            image_path = ROOT / 'data/cache/bench/syn' / image['path']
            if hashlib.sha256(image_path.read_bytes()).hexdigest() != image['sha256']:
                raise RuntimeError('Synthetic checksum mismatch')
            output = directory / (provider + '-' + image['id'] + '.json')
            if output.exists():
                row = json.loads(output.read_text())
            else:
                started = time.perf_counter()
                quality, _ = scorer.score(str(image_path))
                row = {'id': image['id'], 'quality': quality, 'seconds': time.perf_counter() - started}
                temporary = output.with_suffix('.tmp')
                temporary.write_text(json.dumps(row))
                temporary.replace(output)
            rows.append(row)
        summary[provider] = {'providers': scorer.session.get_providers(), 'images': len(rows),
                             'seconds': sum(row['seconds'] for row in rows), 'rows': rows}
        (directory / 'summary.json').write_text(json.dumps(summary))
        print(provider, len(rows), flush=True)
    differences = [abs(a['quality'] - b['quality']) for a, b in zip(
        summary['CPUExecutionProvider']['rows'], summary['DmlExecutionProvider']['rows'])]
    summary['maxAbsoluteDifference'] = max(differences)
    summary['meanAbsoluteDifference'] = sum(differences) / len(differences)
    (directory / 'summary.json').write_text(json.dumps(summary))


if __name__ == '__main__':
    main()
