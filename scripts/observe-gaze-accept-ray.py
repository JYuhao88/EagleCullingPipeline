#!/usr/bin/env python3
"""Submit exact Node gaze acceptance with the shared project quota; never export a shipped head."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.common.private_env import require_path, setting
from ml.observe.gaze_accept import research_head
from ml.observe.gaze_probe import eligible_faces, label_rows, read_jsonl, split_rows

spec = importlib.util.spec_from_file_location('gaze_submit', ROOT / 'scripts/observe-gaze-ray.py')
GAZE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(GAZE)


def runtime_head(model, hashes):
    if model.get('researchOnly') is not True or model['name'] != 'iris-geometry-terms-clip-face':
        raise ValueError('Expected frozen research candidate')
    return research_head(model, {'model_sha256': hashes})


def runtime_sources():
    return [source.relative_to(ROOT).as_posix() for source in sorted((ROOT / 'src/core').glob('*.js'))] + [
        'src/plugin/image-formats.js', 'src/plugin/display-url.js']


def package(output, config):
    photos = label_rows(ROOT / 'data/cache/observe/p0/labels.jsonl')
    oi = read_jsonl(ROOT / 'data/cache/observe/p1-oi/items.jsonl')
    holdout = {row['id'] for row in read_jsonl(ROOT / 'data/cache/observe/p1-panel/items.jsonl')}
    _, calibration = split_rows(label_rows(ROOT / 'data/cache/observe/p1-oi/labels.jsonl'), holdout)
    needed = holdout | {i for i, _ in calibration}
    eligible = eligible_faces(oi, photos)
    rows = [{'id': row['id'], 'box': row['faceBox']} for row in oi if row['id'] in needed & eligible]
    recovered = json.loads((output / 'runtime-photos.json').read_text())
    rows += recovered['rows']
    model = json.loads((output / 'research-model.json').read_text())
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        # Explicit code/data allowlist excludes private config, credentials, original photos and CelebA.
        for source in runtime_sources():
            archive.write(ROOT / source, source)
        for name in ('ml/observe/embed.py', 'ml/observe/embed_ray.py', 'ml/observe/probe_ray.py',
                     'ml/observe/train_heads.py', 'ml/observe/gaze_geometry.py', 'ml/observe/gaze_probe.py',
                     'ml/observe/gaze_accept.py', 'ml/observe/gaze_accept_ray.py', 'ml/observe/gaze_parity.py',
                     'scripts/observe-gaze-accept.mjs', 'python_worker/gaze_worker.py',
                     'python_worker/memory_guard.py'):
            archive.write(ROOT / name, name)
        archive.writestr('ml/__init__.py', '')
        archive.writestr('ml/observe/__init__.py', '')
        archive.writestr('package.json', json.dumps({'private': True, 'type': 'module',
                        'dependencies': {'sharp': '0.33.5', 'onnxruntime-node': '1.24.3'}}))
        archive.writestr('accept-manifest.json', json.dumps(rows))
        archive.writestr('accept-config.json', json.dumps(config))
        archive.writestr('gaze-config.json', json.dumps(config))
        archive.write(output / 'research-model.json', 'output/research-model.json')
        archive.writestr('accept-heads/gaze.json', json.dumps(runtime_head(model, config['model_sha256'])))
        archive.writestr('inputs/runtime-photos.json', json.dumps(recovered))
        for row in recovered['rows']:
            if not row.get('file'):
                continue
            # Reuse the stricter privacy guard, with an isolated root and relative images/ path.
            source = GAZE.photo_crop(output, row['file'])
            archive.write(source, row['file'])
        for source, target in [('p1-oi/labels.jsonl', 'oi-labels.jsonl'),
                               ('p1-oi/items.jsonl', 'oi-items.jsonl'),
                               ('p1-panel/labels.jsonl', 'panel-labels.jsonl'),
                               ('p1-panel/items.jsonl', 'holdout-items.jsonl')]:
            archive.write(ROOT / 'data/cache/observe' / source, 'inputs/' + target)
        archive.writestr('inputs/p0-labels.jsonl', ''.join(json.dumps(row) + '\n' for row in photos.values()
                                                         if row['set'] == 'photos'))
    return buffer.getvalue(), {'openImages': len(rows) - len(recovered['rows']), 'photos': recovered['counts']}


def submit(output):
    models = {'clip': 'models/clip/vision_model_quantized.onnx', 'landmarker': 'models/mediapipe/face_landmarker.task'}
    config = {'models': models, 'model_sha256': {k: GAZE.SHARED.digest(ROOT / v) for k, v in models.items()}}
    config['runtime_source_sha256'] = {name: GAZE.SHARED.digest(ROOT / name) for name in (
        'src/core/observation-runtime.js', 'src/core/observation-head.js', 'src/core/gaze-geometry.js',
        'src/core/ai-tags.js', 'python_worker/gaze_worker.py', 'ml/observe/gaze_geometry.py')}
    assets, config['model_chunks'] = GAZE.SHARED.model_packages(models)
    content, counts = package(output, config)
    name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
    def upload():
        GAZE.SHARED.request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=300)
        for asset, raw in assets:
            GAZE.SHARED.request('/api/packages/gcs/' + asset, method='PUT', data=raw, timeout=300)
    upload()
    uris = ['gcs://' + asset for asset, _ in assets]
    proxy = setting('ECP_HTTP_PROXY', '')
    registry = setting('ECP_NPM_REGISTRY', '')
    env_vars = {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy,
                'ECP_CEPH_ROOT': require_path('ECP_CEPH_ROOT'), 'ECP_RAY_WORKER': '1',
                'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}
    if registry:
        env_vars['npm_config_registry'] = registry
    body = {'submission_id': GAZE.PREFIX + uuid.uuid4().hex[:12],
            'entrypoint': 'python -m pip install -q --force-reinstall --no-deps opencv-python-headless && '
                          'timeout --signal=TERM --kill-after=20s 7200s python -m ml.observe.gaze_accept_ray',
            'entrypoint_num_cpus': 4, 'entrypoint_num_gpus': 1, 'entrypoint_memory': 12 * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + name, 'py_modules': uris,
                            'pip': ['onnxruntime==1.24.4', 'pyvips==3.2.0', 'pyvips-binary==8.18.7', 'mediapipe==0.10.32'],
                            'env_vars': env_vars}}
    return GAZE.quota_submit(body, output, {'mode': 'exact-node-acceptance', 'counts': counts, 'package': name,
                                           'modelSha256': config['model_sha256']}, refresh=upload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/cache/w33-gaze')
    args = parser.parse_args()
    submit(args.output)


if __name__ == '__main__':
    main()
