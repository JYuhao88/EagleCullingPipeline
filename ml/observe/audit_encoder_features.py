"""Audit collected encoder features against the original ordered source manifests."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy as np


SOURCES = ('oi', 'panel', 'p0')
PRECISIONS = ('fp32', 'fp16')
DEFAULT_COUNTS = {'oi': 8000, 'panel': 786, 'p0': 605}
NORM_TOLERANCE = 1e-6


def digest_ids(ids):
    return hashlib.sha256(json.dumps(list(ids), separators=(',', ':')).encode()).hexdigest()


def load_manifests(cache, oi_manifest, expected_counts=DEFAULT_COUNTS):
    cache, oi_manifest = Path(cache), Path(oi_manifest)
    files = {'oi': oi_manifest, 'panel': cache / 'p1-panel/items.jsonl', 'p0': cache / 'p0/items.jsonl'}
    result = {}
    for source, path in files.items():
        content = path.read_bytes()
        rows = [json.loads(line) for line in content.splitlines() if line.strip()]
        ids = [('openimages-' + row['id']) if source == 'oi' else row['id'] for row in rows
               if source == 'oi' or row.get('images', {}).get('face')]
        if (len(ids) != expected_counts[source] or len(set(ids)) != len(ids)
                or any(not isinstance(value, str) or not value for value in ids)):
            raise ValueError(f'{source} manifest ids or count are invalid')
        result[source] = {'ids': ids, 'manifestSha256': hashlib.sha256(content).hexdigest(),
                          'orderedIdsSha256': digest_ids(ids)}
    return result


def _read_json(path):
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f'{path.name} must be a JSON object')
    return value


def _validate_identity(metadata, expected, label):
    if any(type(metadata.get(key)) is not type(value) or metadata[key] != value for key, value in expected.items()):
        raise ValueError(f'{label} model metadata mismatch')


def audit_precision(root, model, precision, manifests):
    root = Path(root)
    folder = root / model['id'] / precision
    paths = [folder / (source + suffix) for source in SOURCES for suffix in ('.npz', '.json')]
    model_path = folder.parent / ('model-' + precision + '.json')
    missing = [str(path.relative_to(root)) for path in [model_path, *paths] if not path.is_file()]
    identity = {'encoder': model['id'], 'precision': precision}
    if missing:
        return {**identity, 'status': 'incomplete', 'validated': False, 'missing': missing}
    expected = {**identity, 'dimensions': model['dimensions'], 'repo': model['repo'], 'revision': model['revision'],
                'license': model['license'], 'preprocessing': model['input']}
    metadata = _read_json(model_path)
    _validate_identity(metadata, expected, model_path.name)
    sha = metadata.get('modelSha256')
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{64}', sha):
        raise ValueError('invalid model SHA-256')
    expected.update(modelSha256=sha, modelPath=metadata.get('modelPath'))
    if not isinstance(expected['modelPath'], str) or not expected['modelPath']:
        raise ValueError('missing stored model path')
    sources = {}
    for source in SOURCES:
        sidecar = _read_json(folder / (source + '.json'))
        _validate_identity(sidecar, {**expected, 'family': model['family'], 'source': source,
                                    'normalised': True, 'count': len(manifests[source]['ids']),
                                    'expectedCount': len(manifests[source]['ids']), 'failures': []}, source)
        with np.load(folder / (source + '.npz'), allow_pickle=False) as values:
            ids, features = values['ids'], values['features']
        expected_ids = manifests[source]['ids']
        if ids.ndim != 1 or ids.dtype.kind not in ('U', 'S') or ids.tolist() != expected_ids:
            raise ValueError(f'{source} ids differ from the ordered manifest')
        if features.dtype != np.float32 or features.shape != (len(ids), model['dimensions']):
            raise ValueError(f'{source} feature shape or dtype mismatch')
        norm_min, norm_max = float('inf'), 0.0
        for start in range(0, len(features), 256):
            block = features[start:start + 256].astype(np.float64)
            if not np.isfinite(block).all():
                raise ValueError(f'{source} features contain non-finite values')
            norms = np.linalg.norm(block, axis=1)
            norm_min, norm_max = min(norm_min, float(norms.min())), max(norm_max, float(norms.max()))
        error = max(abs(norm_min - 1), abs(norm_max - 1))
        if error > NORM_TOLERANCE:
            raise ValueError(f'{source} feature L2 norm error exceeds {NORM_TOLERANCE}')
        sources[source] = {'rows': len(ids), 'uniqueIds': len(set(ids.tolist())), 'shape': list(features.shape),
                           'dtype': str(features.dtype), 'finite': True, 'failures': 0, 'orderedIdsMatch': True,
                           'orderedIdsSha256': manifests[source]['orderedIdsSha256'],
                           'manifestSha256': manifests[source]['manifestSha256'],
                           'normMin': norm_min, 'normMax': norm_max, 'maxNormError': error}
    return {**identity, 'status': 'audited', 'validated': True, 'dimensions': model['dimensions'],
            'modelSha256': sha, 'normTolerance': NORM_TOLERANCE, 'sources': sources}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='data/cache/w33-encoder')
    parser.add_argument('--cache', default='data/cache/observe')
    parser.add_argument('--oi-manifest', default='data/cache/observe-oi/manifest.jsonl')
    parser.add_argument('--config', default='ml/observe/encoder-candidates.json')
    parser.add_argument('--only', action='append', default=[], help='encoder/fp32 or encoder/fp16; repeat as needed')
    parser.add_argument('--exclude', action='append', default=[])
    parser.add_argument('--output', default=None, help='optional JSON output inside --root')
    args = parser.parse_args()
    config = _read_json(Path(args.config))
    manifests = load_manifests(args.cache, args.oi_manifest, config.get('expectedCounts', DEFAULT_COUNTS))
    models = {model['id']: model for model in config['models']}
    valid = {name + '/' + precision for name in models for precision in PRECISIONS}
    if (set(args.only) | set(args.exclude)) - valid:
        parser.error('--only/--exclude must name a configured encoder and fp32/fp16')
    results = []
    for name in sorted((set(args.only) or valid) - set(args.exclude)):
        encoder, precision = name.split('/')
        try:
            results.append(audit_precision(args.root, models[encoder], precision, manifests))
        except (OSError, ValueError, KeyError, TypeError) as error:
            results.append({'encoder': encoder, 'precision': precision, 'status': 'invalid', 'validated': False,
                            'error': str(error)})
    summary = {'normTolerance': NORM_TOLERANCE, 'audits': results}
    content = json.dumps(summary, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        output, root = Path(args.output).resolve(), Path(args.root).resolve()
        if root not in output.parents:
            parser.error('--output must be inside --root')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(content)
    print(content, end='')
    if any(result['status'] == 'invalid' for result in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
