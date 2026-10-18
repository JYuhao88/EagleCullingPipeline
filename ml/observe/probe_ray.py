"""CPU-only CelebA attribute probe; downloaded images and packaged p0 images are ephemeral."""
import base64
import concurrent.futures
import collections
import hashlib
import importlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import random
import shutil
import signal
import tempfile
import time
import urllib.request

import numpy as np
from PIL import Image

SHARD = ('https://huggingface.co/datasets/flwrlabs/celeba/resolve/main/'
         'img_align%2Bidentity%2Battr/test-00000-of-00003.parquet')
RESOLUTIONS = (384, 160, 96)
ATTRIBUTES = ('smile', 'mouth')
SEED = 20261016


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 ** 2), b''):
            result.update(chunk)
    return result.hexdigest()


def report(value):
    print('PROBE_REPORT ' + json.dumps(value), flush=True)


def export(path):
    encoded = base64.b64encode(Path(path).read_bytes()).decode()
    size = 192 * 1024
    count = (len(encoded) + size - 1) // size
    checksum = digest(path)
    for index in range(count):
        print('PROBE_ARTIFACT ' + json.dumps({'name': Path(path).name, 'index': index, 'count': count,
              'sha256': checksum, 'data': encoded[index * size:(index + 1) * size]}), flush=True)


def binary_label(value):
    if value not in (True, False, -1, 0, 1):
        raise ValueError('Unexpected CelebA attribute label')
    return value > 0


def select_rows(labels, excluded, per_cell=750, seed=SEED):
    order = list(range(len(labels)))
    random.Random(seed).shuffle(order)
    counts, selected = {}, []
    for index in order:
        if index in excluded:
            continue
        key = (binary_label(labels[index]['Smiling']), binary_label(labels[index]['Mouth_Slightly_Open']))
        if counts.get(key, 0) < per_cell:
            counts[key] = counts.get(key, 0) + 1
            selected.append(index)
    if len(selected) != 4 * per_cell:
        raise ValueError('Insufficient labels for the requested balanced split')
    return sorted(selected)


def center_face(image):
    image = image.convert('RGB')
    side = min(image.size)
    left, top = (image.width - side) // 2, (image.height - side) // 2
    return image.crop((left, top, left + side, top + side)).resize((384, 384), Image.Resampling.LANCZOS)


def degraded(image, resolution):
    if resolution == 384:
        return image
    return image.resize((resolution, resolution), Image.Resampling.LANCZOS).resize((384, 384), Image.Resampling.LANCZOS)


def init_worker(clip_path, dino_path):
    global ENCODERS
    from ml.observe.embed import Encoder
    ENCODERS = {'clip': Encoder('clip', clip_path, threads=2), 'dino': Encoder('dino', dino_path, threads=2)}


def extract_sample(task):
    index, content, crop, all_resolutions = task
    with tempfile.TemporaryDirectory(prefix='observe-face-') as folder:
        folder = Path(folder)
        if crop:
            with Image.open(io.BytesIO(content)) as source:
                image = center_face(source)
            path = folder / '384.jpg'
            image.save(path, 'JPEG', quality=90)
            with Image.open(path) as source:
                image = source.convert('RGB')
        else:
            path = Path(content)
            with Image.open(path) as source:
                image = source.convert('RGB')
        vectors = {name: [] for name in ENCODERS}
        for resolution in RESOLUTIONS if all_resolutions else (384,):
            current = path
            if resolution != 384:
                current = folder / (str(resolution) + '.png')
                degraded(image, resolution).save(current, 'PNG')
            for name, encoder in ENCODERS.items():
                vectors[name].append(encoder.embed(current))
    return index, {name: np.asarray(values, dtype=np.float32) for name, values in vectors.items()}


def extract(pool, tasks, count, stage):
    rows = {}
    started = time.monotonic()
    for index, vectors in pool.map(extract_sample, tasks, chunksize=4):
        rows[index] = vectors
        if len(rows) % 100 == 0 or len(rows) == count:
            report({'stage': stage, 'completed': len(rows), 'total': count,
                    'elapsed_s': round(time.monotonic() - started, 1)})
    if len(rows) != count:
        raise RuntimeError('Incomplete feature extraction')
    return {name: np.asarray([rows[index][name] for index in range(count)], dtype=np.float32)
            for name in ('clip', 'dino')}


def cosine(left, right):
    left, right = np.asarray(left, dtype=np.float64), np.asarray(right, dtype=np.float64)
    return float(np.dot(left, right) / max(1e-12, np.linalg.norm(left) * np.linalg.norm(right)))


def remove_package_blob():
    uri = os.environ.get('PROBE_PACKAGE_URI')
    if not uri:
        return
    try:
        import ray
        from ray._private import ray_constants
        from ray.experimental.internal_kv import _internal_kv_del
        ray.init(address='auto', logging_level='ERROR')
        removed = _internal_kv_del(uri.encode(), namespace=ray_constants.KV_NAMESPACE_PACKAGE)
        report({'package_blob_removed': bool(removed)})
        ray.shutdown()
    except Exception as error:
        report({'package_blob_removed': False, 'error': type(error).__name__})


def materialize_models(config):
    """Reassemble ONNX files from bounded Ray py_modules before checksum checks."""
    for kind, chunks in config.get('model_chunks', {}).items():
        target = Path(config['models'][kind])
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('wb') as output:
            for chunk in sorted(chunks, key=lambda item: item['index']):
                module = importlib.import_module(chunk['module'])
                source = Path(module.__file__).with_name('chunk')
                if digest(source) != chunk['sha256']:
                    raise RuntimeError('Model chunk checksum mismatch: ' + kind)
                with source.open('rb') as stream:
                    shutil.copyfileobj(stream, output)


def run(config):
    import onnxruntime as ort
    import pyarrow.parquet as pq
    from ml.observe.evaluate import evaluate_probe

    root = Path.cwd()
    output = Path('output')
    output.mkdir(exist_ok=True)
    materialize_models(config)
    for name, expected in config['model_sha256'].items():
        actual = digest(root / config['models'][name])
        if actual != expected:
            raise RuntimeError('Model checksum mismatch: ' + name)
    versions = {}
    for name in ('numpy', 'Pillow', 'onnxruntime', 'pyvips', 'pyarrow', 'scikit-learn'):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = 'importable-without-distribution-metadata'
    report({'stage': 'verified', 'model_sha256': config['model_sha256'], 'versions': versions,
            'cpu_workers': config['workers'], 'onnx_threads_per_worker': 2,
            'onnxruntime_import': ort.__version__})
    items = [json.loads(line) for line in Path('p0/items.jsonl').read_text().splitlines() if line.strip()]
    holdout = [item for item in items if item['set'] == 'celeba']
    excluded = {int(item['id'].removeprefix('celeba-')) for item in holdout}
    if len(holdout) != 400 or len(excluded) != 400:
        raise ValueError('Expected the 400 distinct p0 CelebA rows')
    with tempfile.TemporaryDirectory(prefix='observe-probe-') as folder:
        parquet = Path(folder) / 'test.parquet'
        urllib.request.urlretrieve(SHARD, parquet)
        labels = pq.read_table(parquet, columns=['Smiling', 'Mouth_Slightly_Open']).to_pylist()
        for item in holdout:
            label = labels[int(item['id'].removeprefix('celeba-'))]
            if (binary_label(label['Smiling']) != item['truth']['smile']
                    or binary_label(label['Mouth_Slightly_Open']) != item['truth']['mouth']):
                raise RuntimeError('p0 holdout label differs from its source shard row')
        requested_per_cell = config.get('per_cell', 750)
        available = collections.Counter((binary_label(row['Smiling']), binary_label(row['Mouth_Slightly_Open']))
                                         for index, row in enumerate(labels) if index not in excluded)
        effective_per_cell = min(requested_per_cell, *(available[key] for key in ((False, False), (False, True),
                                                                                    (True, False), (True, True))))
        selected = select_rows(labels, excluded, effective_per_cell)
        images = pq.read_table(parquet, columns=['image']).take(selected).to_pylist()
        if set(selected) & excluded:
            raise RuntimeError('Probe split overlaps p0')
        manifest = [{'id': 'celeba-' + str(index), 'shard_row': index,
                     'smile': binary_label(labels[index]['Smiling']),
                     'mouth': binary_label(labels[index]['Mouth_Slightly_Open'])}
                    for index in selected]
        (output / 'probe-samples.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in manifest))
        report({'stage': 'sampled', 'shard_rows': len(labels), 'requested': 4 * requested_per_cell,
                'effective_per_cell': effective_per_cell, 'selected': len(selected), 'excluded_p0': len(excluded),
                'shortfall': 4 * requested_per_cell - len(selected),
                'overlap': 0, 'cells': {str(key): sum((row['smile'], row['mouth']) == key for row in manifest)
                                      for key in ((False, False), (False, True), (True, False), (True, True))}})
        # Runtime_env pip paths are installed on the Ray driver.  Threads
        # share that interpreter path; subprocesses do not reliably inherit it
        # on this Python 3.13 Ray image.  ONNX Runtime sessions are thread-safe
        # and each session is bounded to two intra-op threads.
        init_worker(config['models']['clip'], config['models']['dino'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=config['workers']) as pool:
            reference = config.get('parity_reference', {}).get('rows', [])
            if len(reference) == 5:
                parity_tasks = ((index, str(root / 'p0' / row['path']), False, False)
                                for index, row in enumerate(reference))
                parity = extract(pool, parity_tasks, len(reference), 'parity')
                parity_cosines = {name: [cosine(parity[name][index, 0], reference[index][name])
                                         for index in range(len(reference))] for name in ('clip', 'dino')}
                from ml.observe.embed import clip_pixels, clip_preprocess
                pixel_errors = []
                tensor_errors = []
                for row in reference:
                    actual = clip_pixels(root / 'p0' / row['path']).astype(np.int16)
                    expected = np.frombuffer(base64.b64decode(row['clipPixels']), dtype=np.uint8).reshape(actual.shape).astype(np.int16)
                    pixel_errors.append(np.abs(actual - expected))
                    actual_tensor = clip_preprocess(root / 'p0' / row['path'])
                    expected_tensor = np.frombuffer(base64.b64decode(row['clipTensor']), dtype=np.float32).reshape(actual_tensor.shape)
                    tensor_errors.append(np.abs(actual_tensor - expected_tensor))
                report({'stage': 'parity', 'n': len(reference),
                        'cosine_min': {name: min(values) for name, values in parity_cosines.items()},
                        'cosine_mean': {name: sum(values) / len(values) for name, values in parity_cosines.items()},
                        'pixel_mae': float(np.concatenate([value.ravel() for value in pixel_errors]).mean()),
                        'pixel_max': int(max(value.max() for value in pixel_errors)),
                        'tensor_mae': float(np.concatenate([value.ravel() for value in tensor_errors]).mean()),
                        'tensor_max': float(max(value.max() for value in tensor_errors)),
                        'pass': all(value >= 0.999 for values in parity_cosines.values() for value in values),
                        'model_sha256': {key: config.get('parity_reference', {}).get(key)
                                         for key in ('clipModelSha256', 'dinoModelSha256')}})
                if config.get('parity_only'):
                    report({'stage': 'complete', 'parity_only': True})
                    return
            tasks = ((index, row['image']['bytes'], True, True) for index, row in enumerate(images))
            probe = extract(pool, tasks, len(images), 'probe')
            del images
            p0_rows = [{'id': item['id'], 'set': item['set'], 'view': view, 'image': image}
                       for item in items for view, image in sorted(item['images'].items())]
            unique = list(dict.fromkeys(row['image'] for row in p0_rows))
            tasks = ((index, str(root / 'p0' / path), False, False) for index, path in enumerate(unique))
            unique_vectors = extract(pool, tasks, len(unique), 'p0')
            image_index = {path: index for index, path in enumerate(unique)}
            indices = [image_index[row['image']] for row in p0_rows]
            p0_vectors = {name: vectors[indices, 0] for name, vectors in unique_vectors.items()}
            np.savez_compressed(output / 'p0-embeddings.npz', **p0_vectors,
                                ids=np.asarray([row['id'] for row in p0_rows]),
                                views=np.asarray([row['view'] for row in p0_rows]),
                                images=np.asarray([row['image'] for row in p0_rows]))
            tasks = ((index, str(root / 'p0' / row['images']['face']), False, True)
                     for index, row in enumerate(holdout))
            held = extract(pool, tasks, len(holdout), 'holdout')
        target = np.asarray([[row[name] for name in ATTRIBUTES] for row in manifest], dtype=np.int64)
        held_target = np.asarray([[row['truth'][name] for name in ATTRIBUTES] for row in holdout], dtype=np.int64)
        np.savez_compressed(output / 'probe-features.npz', **probe, y=target,
                            ids=np.asarray([row['id'] for row in manifest]), resolutions=np.asarray(RESOLUTIONS),
                            holdout_clip=held['clip'], holdout_dino=held['dino'], holdout_y=held_target,
                            holdout_ids=np.asarray([row['id'] for row in holdout]))
        feature_metadata = {'format': 'numpy npz; allow_pickle=False', 'items': len(items), 'rows': len(p0_rows),
                            'unique_images': len(unique), 'models': config['model_sha256'], 'versions': versions,
                            'embedding_versions': {'clip': 'clip-vit-base-patch32-local-v1',
                                                   'dino': 'dinov2-small-mean-patch-224-v1'},
                            'row_metadata': p0_rows, 'seed': SEED, 'resolutions': list(RESOLUTIONS),
                            'split': (f'balanced requested {4 * requested_per_cell}; effective {len(selected)} '
                                      f'test-00000 shard rows excluding p0 400; per-cell {effective_per_cell}')}
        (output / 'p0-embeddings.json').write_text(json.dumps(feature_metadata, ensure_ascii=False, indent=2) + '\n')
        result = evaluate_probe(probe, target, held, held_target, output, seed=SEED)
        (output / 'probe-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        report({'stage': 'evaluation', 'result': result})
        for path in sorted(output.iterdir()):
            if path.is_file():
                export(path)
    report({'stage': 'complete'})


def main():
    def terminate(_signum, _frame):
        raise SystemExit(143)

    signal.signal(signal.SIGTERM, terminate)
    config = json.loads(Path('probe-config.json').read_text())
    try:
        run(config)
    finally:
        photos = Path('p0/images')
        shutil.rmtree(photos, ignore_errors=True)
        report({'p0_images_removed': not photos.exists()})
        remove_package_blob()


if __name__ == '__main__':
    main()
