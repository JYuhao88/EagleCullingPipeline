"""Bounded eye-region/iris experiment. Artifacts are research-only, never shipped heads."""
import concurrent.futures
import importlib.metadata
import json
from pathlib import Path
import tempfile
import time

import numpy as np

from ml.observe.embed import Encoder
from ml.observe.embed_ray import ceph_image_path, normalise_embedding
from ml.observe.gaze_eye import EYE_VERSION, eye_crop
from ml.observe.probe_ray import digest, export, materialize_models, report


def extract_eyes(rows, config, output, started):
    import onnxruntime as ort
    ort.preload_dlls(directory='')
    # Quantized CLIP keeps the established CPU numerical path; DINO uses the reserved GPU.
    provider = 'CUDAExecutionProvider' if 'CUDAExecutionProvider' in ort.get_available_providers() else 'CPUExecutionProvider'
    encoders = {'clip': Encoder('clip', config['models']['clip'], threads=2),
                'dino': Encoder('dino', config['models']['dino'], threads=2, provider=provider)}
    report({'stage': 'verified', 'eyeVersion': EYE_VERSION,
            'dinoProviders': encoders['dino']._session.get_providers(),
            'onnxruntime': ort.__version__,
            'versions': {name: importlib.metadata.version(name) for name in
                         ('numpy', 'pyvips', 'mediapipe', 'scikit-learn')}})
    features, failures = {}, []

    def one(row):
        source = ceph_image_path(row['face']) if row['remote'] else Path('p0') / row['face']
        try:
            with tempfile.TemporaryDirectory(prefix='gaze-eye-') as folder:
                crop = Path(folder) / 'eye.png'
                eye_crop(source, crop)
                result = {kind: normalise_embedding(encoder.embed(crop), dimension)
                          for kind, dimension, encoder in [('clip', 512, encoders['clip']), ('dino', 384, encoders['dino'])]}
            return row['id'], result, None
        except Exception as error:
            return row['id'], None, {'id': row['id'], 'error': type(error).__name__}

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for index, (item_id, feature, error) in enumerate(pool.map(one, rows), 1):
            if error:
                failures.append(error)
            else:
                features[item_id] = feature
            if index % 200 == 0 or index == len(rows):
                report({'stage': 'eye', 'completed': index, 'total': len(rows), 'failed': len(failures),
                        'elapsed': round(time.monotonic() - started, 1)})
    for kind in ('clip', 'dino'):
        ids = [r['id'] for r in rows if r['id'] in features]
        dimension = 512 if kind == 'clip' else 384
        np.savez_compressed(output / (kind + '-eye.npz'), ids=ids,
                            features=np.stack([features[i][kind] for i in ids]) if ids else np.empty((0, dimension)))
        export(output / (kind + '-eye.npz'))
    return failures


def run(config):
    from ml.observe.gaze_geometry import GeometryExtractor

    materialize_models(config)
    for name, expected in config['model_sha256'].items():
        if digest(config['models'][name]) != expected:
            raise ValueError('model checksum mismatch: ' + name)
    rows = [json.loads(line) for line in Path('manifest.jsonl').read_text().splitlines() if line]
    output = Path('output')
    output.mkdir(exist_ok=True)
    started = time.monotonic()
    geometry_only = config.get('mode') == 'geometry'
    failures = [] if geometry_only else extract_eyes(rows, config, output, started)
    geometry, geometry_failures = {}, []
    with GeometryExtractor(config['models']['landmarker']) as extractor:
        for index, row in enumerate(rows, 1):
            source = ceph_image_path(row['face']) if row['remote'] else Path('p0') / row['face']
            try:
                vector = extractor.extract(source)
                if vector is None:
                    geometry_failures.append({'id': row['id'], 'error': 'abstain'})
                else:
                    geometry[row['id']] = vector
            except Exception as error:
                geometry_failures.append({'id': row['id'], 'error': type(error).__name__})
            if index % 500 == 0 or index == len(rows):
                report({'stage': 'geometry', 'completed': index, 'total': len(rows),
                        'valid': len(geometry), 'elapsed': round(time.monotonic() - started, 1)})
    ids = [r['id'] for r in rows if r['id'] in geometry]
    np.savez_compressed(output / 'geometry.npz', ids=ids,
                        features=np.stack([geometry[i] for i in ids]) if ids else np.empty((0, 19)))
    export(output / 'geometry.npz')
    details = {'eyeVersion': EYE_VERSION, 'rows': len(rows), 'eyeFailures': failures,
               'geometryFailures': geometry_failures, 'geometryValid': len(ids),
               'elapsed': round(time.monotonic() - started, 1), 'modelSha256': config['model_sha256']}
    (output / 'extraction.json').write_text(json.dumps(details, indent=2))
    export(output / 'extraction.json')
    if not geometry_only:
        from ml.observe.gaze_probe import run as evaluate
        evaluate(Path.cwd(), output)
        export(output / 'gaze-report.json')
    report({'stage': 'complete', 'elapsed': details['elapsed']})


if __name__ == '__main__':
    run(json.loads(Path('gaze-config.json').read_text()))
