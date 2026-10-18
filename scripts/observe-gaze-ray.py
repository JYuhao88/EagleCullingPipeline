#!/usr/bin/env python3
"""Submit/collect one research-only eye/iris gaze probe with the shared Ray quota."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import require_path, setting

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w33-gaze-'
LOCK = Path('/tmp/w29-ray.lock')
spec = importlib.util.spec_from_file_location('gaze_shared', ROOT / 'scripts/observe-probe-ray.py')
SHARED = importlib.util.module_from_spec(spec)
spec.loader.exec_module(SHARED)
SHARED.PREFIX = PREFIX


def own(job):
    if not re.fullmatch(PREFIX + '[0-9a-f]{12}', job):
        raise ValueError('explicit own gaze job id required')
    return job


def photo_crop(root, relative):
    from PIL import Image
    source = (root / relative).resolve()
    if not source.is_relative_to(root.resolve()) or not relative.startswith('images/'):
        raise ValueError('photo crop outside expected directory')
    with Image.open(source) as image:
        if max(image.size) > 768 or image.getexif() or image.info:
            raise ValueError('photo crops must be at most 768px and metadata stripped')
    return source


def package(config):
    import numpy as np
    from ml.observe.train_heads import read_jsonl
    p0 = ROOT / 'data/cache/observe/p0'
    items = read_jsonl(p0 / 'items.jsonl')
    photos = [r for r in items if r['set'] == 'photos' and r.get('images', {}).get('face')
              and (r.get('faceHeight') or 0) >= .05]
    oi = read_jsonl(ROOT / 'data/cache/observe/p1-oi/items.jsonl')
    manifest = [{'id': r['id'], 'face': r['images']['face'], 'remote': True} for r in oi]
    manifest += [{'id': r['id'], 'face': r['images']['face'], 'remote': False} for r in photos]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for source in ('ml/observe/embed.py', 'ml/observe/embed_ray.py', 'ml/observe/probe_ray.py',
                       'ml/observe/train_heads.py', 'ml/observe/gaze_eye.py', 'ml/observe/gaze_geometry.py',
                       'ml/observe/gaze_ray.py', 'ml/observe/gaze_probe.py'):
            archive.write(ROOT / source, source)
        archive.writestr('ml/__init__.py', '')
        archive.writestr('ml/observe/__init__.py', '')
        archive.writestr('manifest.jsonl', ''.join(json.dumps(r) + '\n' for r in manifest))
        archive.writestr('gaze-config.json', json.dumps(config))
        for source, target in [('p1-oi/labels.jsonl', 'oi-labels.jsonl'),
                               ('p1-oi/items.jsonl', 'oi-items.jsonl'),
                               ('p1-panel/labels.jsonl', 'panel-labels.jsonl'),
                               ('p1-panel/items.jsonl', 'holdout-items.jsonl')]:
            archive.write(ROOT / 'data/cache/observe' / source, 'inputs/' + target)
        labels = [r for r in read_jsonl(p0 / 'labels.jsonl') if r['set'] == 'photos']
        archive.writestr('inputs/p0-labels.jsonl', ''.join(json.dumps(r) + '\n' for r in labels))
        for kind in ('clip', 'dino'):
            archive.write(ROOT / f'data/cache/observe-oi/embeddings/{kind}-face.npz', f'inputs/{kind}-face.npz')
        data = np.load(ROOT / 'data/cache/observe-probe/p0-embeddings.npz', allow_pickle=False)
        selected = (data['views'] == 'face') & np.isin(data['ids'], [r['id'] for r in photos])
        arrays = io.BytesIO()
        np.savez_compressed(arrays, ids=data['ids'][selected], views=data['views'][selected],
                            clip=data['clip'][selected], dino=data['dino'][selected])
        archive.writestr('inputs/p0-face.npz', arrays.getvalue())
        for relative in sorted({r['images']['face'] for r in photos}):
            archive.write(photo_crop(p0, relative), 'p0/' + relative)
    return buffer.getvalue(), {'openImages': len(oi), 'photoCrops': len(photos)}


def submit(output, geometry_only=False):
    models = {'clip': 'models/clip/vision_model_quantized.onnx', 'dino': 'models/dinov2-small/model.onnx',
              'landmarker': 'models/mediapipe/face_landmarker.task'}
    if geometry_only:
        models = {'landmarker': models['landmarker']}
    config = {'models': models, 'model_sha256': {k: SHARED.digest(ROOT / v) for k, v in models.items()}}
    config['mode'] = 'geometry' if geometry_only else 'all'
    assets, config['model_chunks'] = SHARED.model_packages(models)
    content, counts = package(config)
    name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
    SHARED.request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=300)
    del content
    uris = []
    for asset, raw in assets:
        SHARED.request('/api/packages/gcs/' + asset, method='PUT', data=raw, timeout=300)
        uris.append('gcs://' + asset)
    proxy = setting('ECP_HTTP_PROXY', '')
    body = {'submission_id': PREFIX + uuid.uuid4().hex[:12],
            'entrypoint': 'python -m pip install -q --force-reinstall --no-deps opencv-python-headless && '
                          'timeout --signal=TERM --kill-after=20s 10800s python -m ml.observe.gaze_ray',
            'entrypoint_num_cpus': 4, 'entrypoint_num_gpus': 1, 'entrypoint_memory': 12 * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + name, 'py_modules': uris,
                            'pip': ['mediapipe==0.10.32'] if geometry_only else
                                   ['onnxruntime-gpu[cuda,cudnn]==1.24.4', 'pyvips==3.2.0',
                                    'pyvips-binary==8.18.7', 'mediapipe==0.10.32'],
                            'env_vars': {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy,
                                         'ECP_CEPH_ROOT': require_path('ECP_CEPH_ROOT'), 'ECP_RAY_WORKER': '1',
                                         'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}}}
    return quota_submit(body, output, {'counts': counts, 'modelSha256': config['model_sha256'],
                                       'package': name})


def quota_submit(body, output, metadata, refresh=None):
    # Packaging/uploads do not consume quota. Hold the shared lock only for count + submission.
    stale = False
    while True:
        refresh_inputs = False
        try:
            LOCK.mkdir()
            (LOCK / 'owner.json').write_text(json.dumps({'line': 'w33-gaze', 'pid': os.getpid()}))
        except FileExistsError:
            time.sleep(10)
            stale = True
            continue
        try:
            jobs = SHARED.request('/api/jobs/')
            active = [j for j in jobs if j.get('status') in ('RUNNING', 'PENDING')
                      and str(j.get('submission_id', '')).startswith(tuple('w' + str(i) + '-' for i in range(1, 40)))]
            if any(str(j.get('submission_id', '')).startswith(PREFIX) for j in active):
                raise RuntimeError('an own gaze job is already active')
            if len(active) < 2:
                if stale and refresh:
                    refresh_inputs = True
                else:
                    SHARED.request('/api/jobs/', body)
                    job = body['submission_id']
                    record = {'job': job, **metadata}
                    (output / 'job.json').write_text(json.dumps(record, indent=2))
                    (output / (job + '.json')).write_text(json.dumps(record, indent=2))
                    print(json.dumps({'job': job, **metadata}), flush=True)
                    return job
        finally:
            (LOCK / 'owner.json').unlink()
            LOCK.rmdir()
        if refresh_inputs:
            refresh()
            stale = False
            continue
        print(json.dumps({'stage': 'project-quota-full', 'retrySeconds': 300}), flush=True)
        time.sleep(300)
        stale = True


def fit(output):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for source in ('ml/observe/gaze_probe.py', 'ml/observe/gaze_geometry.py',
                       'ml/observe/train_heads.py', 'ml/observe/probe_ray.py'):
            archive.write(ROOT / source, source)
        archive.writestr('ml/__init__.py', '')
        archive.writestr('ml/observe/__init__.py', '')
        for source, target in [('p1-oi/labels.jsonl', 'oi-labels.jsonl'),
                               ('p1-oi/items.jsonl', 'oi-items.jsonl'),
                               ('p1-panel/labels.jsonl', 'panel-labels.jsonl'),
                               ('p1-panel/items.jsonl', 'holdout-items.jsonl')]:
            archive.write(ROOT / 'data/cache/observe' / source, 'inputs/' + target)
        from ml.observe.train_heads import read_jsonl
        import numpy as np
        photos = [r for r in read_jsonl(ROOT / 'data/cache/observe/p0/labels.jsonl') if r['set'] == 'photos']
        archive.writestr('inputs/p0-labels.jsonl', ''.join(json.dumps(r) + '\n' for r in photos))
        for kind in ('clip', 'dino'):
            archive.write(ROOT / f'data/cache/observe-oi/embeddings/{kind}-face.npz', f'inputs/{kind}-face.npz')
            archive.write(output / (kind + '-eye.npz'), 'output/' + kind + '-eye.npz')
        archive.write(output / 'geometry.npz', 'output/geometry.npz')
        data = np.load(ROOT / 'data/cache/observe-probe/p0-embeddings.npz', allow_pickle=False)
        selected = (data['views'] == 'face') & np.isin(data['ids'], [r['id'] for r in photos])
        arrays = io.BytesIO()
        np.savez_compressed(arrays, ids=data['ids'][selected], views=data['views'][selected],
                            clip=data['clip'][selected], dino=data['dino'][selected])
        archive.writestr('inputs/p0-face.npz', arrays.getvalue())
    content = buffer.getvalue()
    name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
    SHARED.request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=300)
    entrypoint = ("timeout 1800s python -c \"from pathlib import Path; "
                  "from ml.observe.gaze_probe import run; from ml.observe.probe_ray import export; "
                  "run(Path('.'), Path('output')); export(Path('output/gaze-report.json')); "
                  "export(Path('output/research-model.json'))\"")
    body = {'submission_id': PREFIX + uuid.uuid4().hex[:12], 'entrypoint': entrypoint,
            'entrypoint_num_cpus': 2, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 4 * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + name,
                            'env_vars': {'ECP_RAY_WORKER': '1', 'OMP_NUM_THREADS': '2',
                                         'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}}}
    return quota_submit(body, output, {'mode': 'fit-existing-features', 'package': name})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('submit', 'geometry', 'fit', 'status', 'collect'))
    parser.add_argument('job', nargs='?')
    parser.add_argument('--progress', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/cache/w33-gaze')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.action in ('submit', 'geometry'):
        submit(args.output, geometry_only=args.action == 'geometry')
        return
    if args.action == 'fit':
        fit(args.output)
        return
    own(args.job or '')
    state = SHARED.request('/api/jobs/' + args.job)
    if args.action == 'collect':
        if state.get('status') not in SHARED.TERMINAL:
            raise ValueError('collect requires a terminal job')
        SHARED.collect(args.job, args.output)
    else:
        logs = SHARED.request('/api/jobs/' + args.job + '/logs')['logs'] if args.progress else ''
        reports = [json.loads(line[13:]) for line in logs.splitlines() if line.startswith('PROBE_REPORT ')]
        print(json.dumps({'job': args.job, 'status': state.get('status'), 'progress': reports[-2:]}), flush=True)


if __name__ == '__main__':
    main()
