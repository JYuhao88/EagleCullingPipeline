"""Public AVA embedding parity, teacher extraction and bounded artifact export."""
import base64
import hashlib
import io
import json
import os
import time
import urllib.request
import zipfile
import gzip
import concurrent.futures
import multiprocessing
import tarfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
import pyvips
import onnxruntime as ort
from ml.common.private_env import require_path

ROOT = Path(require_path('ECP_CEPH_ROOT'))
OUT = ROOT / 'research' / 'w26-aes'
DINO_SHA = '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea'
TEACHER_SHA = '1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad'


def digest(path):
    checksum = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def export(path):
    data = base64.b64encode(path.read_bytes()).decode()
    size = 256 * 1024
    count = (len(data) + size - 1) // size
    checksum = digest(path)
    for index in range(count):
        print('ARTIFACT ' + json.dumps({'name': path.name, 'index': index, 'count': count,
              'sha256': checksum, 'data': data[index * size:(index + 1) * size]}), flush=True)


def session(path, gpu=True):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    provider = 'CUDAExecutionProvider' if gpu else 'CPUExecutionProvider'
    result = ort.InferenceSession(path.read_bytes(), options, providers=[provider])
    if result.get_providers()[0] != provider:
        raise RuntimeError('Requested ONNX provider failed')
    return result


def mean_patch_tensor(path):
    path = Path(path)
    # Match sharp's default Lanczos3 cover resize, then its 224 center extraction.
    image = pyvips.Image.new_from_file(str(path), access='sequential', fail_on='warning')
    shrink = min(image.width, image.height) / 256
    jpeg_shrink = 8 if shrink >= 8 else 4 if shrink >= 4 else 2 if shrink >= 2 else 1
    if jpeg_shrink > 1 and int(shrink) == jpeg_shrink:
        jpeg_shrink //= 2
    if path.suffix.lower() in ['.jpg', '.jpeg'] and jpeg_shrink > 1:
        image = pyvips.Image.jpegload(str(path), shrink=jpeg_shrink, access='sequential', fail_on='warning')
    if image.get_typeof('icc-profile-data'):
        try:
            image = image.icc_transform('srgb', embedded=True, depth=8, intent='perceptual')
        except pyvips.Error:
            pass  # Sharp also retains pixels when an embedded profile is invalid.
    elif image.interpretation == 'cmyk':
        image = image.icc_transform('srgb', input_profile='cmyk', intent='perceptual')
    image = image.resize(256 / min(image.width, image.height), kernel='lanczos3')
    # Sharp uses ceil, whereas vips thumbnail's center crop uses floor on odd residuals.
    left, top = (image.width - 256 + 1) // 2, (image.height - 256 + 1) // 2
    image = image.extract_area(left + 16, top + 16, 224, 224)
    if image.hasalpha():
        image = image.extract_band(0, n=image.bands - 1)
    image = image.colourspace('srgb').cast('uchar')
    array = np.frombuffer(image.write_to_memory(), dtype=np.uint8).reshape(224, 224, 3)
    array = (array.astype(np.float64) / 255 - np.array([0.485, 0.456, 0.406])) / np.array([0.229, 0.224, 0.225])
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)


def embedding(model, tensor):
    tokens = model.run(['last_hidden_state'], {'pixel_values': tensor})[0][0]
    # JS accumulates each divided patch in a Float32Array, rounding at every addition.
    vector = np.zeros(tokens.shape[1], dtype=np.float32)
    for token in tokens[1:]:
        vector = (vector.astype(np.float64) + token.astype(np.float64) / (len(tokens) - 1)).astype(np.float32)
    return vector.astype(np.float64) / np.linalg.norm(vector.astype(np.float64))


def teacher_tensor(path):
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert('RGB').resize((512, 512), Image.Resampling.BILINEAR)
        return np.asarray(image, dtype=np.float32).transpose(2, 0, 1)[None] / 255


def score_record(record, model, teacher):
    split, row = record
    vector = embedding(model, mean_patch_tensor(row['path']))
    raw = float(teacher.run(None, {'image': teacher_tensor(row['path'])})[0].reshape(-1)[0])
    if not np.isfinite(raw) or not np.isfinite(vector).all():
        raise RuntimeError('Nonfinite training record')
    return {'id': str(row['id']), 'split': split, 'mos': row['mos'], 'teacher_raw': raw, 'embedding': vector.tolist()}


def init_cpu(dino_path, teacher_path):
    global CPU_DINO, CPU_TEACHER
    CPU_DINO = session(dino_path, gpu=False)
    CPU_TEACHER = session(teacher_path, gpu=False)


def cpu_record(record):
    return score_record(record, CPU_DINO, CPU_TEACHER)


def safe_record(record, model, teacher):
    try:
        return score_record(record, model, teacher)
    except (pyvips.Error, OSError) as error:
        if record[0] != 'train':
            raise RuntimeError('Public generic_test image failed decoding') from None
        return {'skipped': str(record[1]['id']), 'error': type(error).__name__}


def resume_record(record):
    return safe_record(record, CPU_DINO, CPU_TEACHER)


def stream_records(pool, records):
    pending = list(enumerate(records))
    active = {}
    paths = set()
    next_scan = 0
    deadline = time.monotonic() + 7200
    while pending or active:
        now = time.monotonic()
        if now > deadline:
            raise RuntimeError('Public image stream exceeded the bounded wait')
        if now >= next_scan:
            for directory in {Path(row['path']).parent for _, row in records}:
                paths.update(str(directory / entry.name) for entry in os.scandir(directory))
            next_scan = now + 15
        submitted = set()
        for index, record in pending:
            if len(active) >= 64:
                break
            path = Path(record[1]['path'])
            if str(path) not in paths:
                continue
            # New archive images become visible only after atomic rename; JPEG trailing data need not end in EOI.
            active[pool.submit(resume_record, record)] = index
            submitted.add(index)
        pending = [(index, record) for index, record in pending if index not in submitted]
        if not active:
            time.sleep(5)
            continue
        completed, _ = concurrent.futures.wait(active, timeout=5, return_when=concurrent.futures.FIRST_COMPLETED)
        for future in completed:
            yield active.pop(future), future.result()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if os.environ['AES_STAGE'] == 'approve':
        report = json.loads(os.environ['AES_PARITY_REPORT'])
        if report.get('n') != 20 or not report.get('pass') or report.get('cosine_min', 0) < 0.999:
            raise RuntimeError('Local parity failed')
        (OUT / 'local-parity-pass.json').write_text(json.dumps(report))
        base = ROOT / 'datasets' / 'ava' / 'AVA_dataset'
        inventory = [str(p.relative_to(base)) for p in base.rglob('*.txt')]
        print('REPORT ' + json.dumps({'local_parity_approved': True, 'ava_texts': inventory}), flush=True)
        return
    models = ROOT / 'models' / 'onnx'
    if os.environ['AES_STAGE'] == 'teacher':
        model_path = models / 'topiq_iaa_512.onnx'
        if digest(model_path) != TEACHER_SHA:
            raise RuntimeError('Teacher checksum mismatch')
        with model_path.open('rb') as source, gzip.open(OUT / 'teacher.onnx.gz', 'wb', compresslevel=1) as target:
            import shutil
            shutil.copyfileobj(source, target, length=1024 * 1024)
        export(OUT / 'teacher.onnx.gz')
        print('REPORT ' + json.dumps({'teacher_sha256': TEACHER_SHA}), flush=True)
        return
    dino_path = models / 'dinov2-small.onnx'
    if not dino_path.exists():
        source = json.loads(Path('python_worker/model-manifest.json').read_text())['models'][0]['source']
        urllib.request.urlretrieve(source, dino_path)
    if digest(dino_path) != DINO_SHA:
        raise RuntimeError('DINO checksum mismatch')
    # Preload CUDA/cuDNN from the installed torch distribution where available.
    try:
        import torch
    except ImportError:
        pass
    ort.preload_dlls()
    model = session(dino_path, gpu=os.environ.get('AES_CPU') != '1') if os.environ['AES_STAGE'] == 'parity' \
        or os.environ.get('AES_CPU') != '1' else None
    rows = json.loads((ROOT / 'datasets' / 'ava-test-5000.json').read_text())
    if os.environ['AES_STAGE'] == 'parity':
        cpu = session(dino_path, gpu=False)
        vectors, cosines = [], []
        with zipfile.ZipFile(OUT / 'parity-fixtures.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for row in rows[:20]:
                path = Path(row['path'])
                tensor = mean_patch_tensor(path)
                vector = embedding(model, tensor)
                reference = embedding(cpu, tensor)
                cosines.append(float(np.dot(vector, reference)))
                vectors.append(vector)
                archive.write(path, str(row['id']) + '.jpg')
                buffer = io.BytesIO(); np.save(buffer, tensor)
                archive.writestr(str(row['id']) + '.npy', buffer.getvalue())
        report = {'n': 20, 'onnx_reference_cosine_min': min(cosines), 'provider': model.get_providers()[0], 'dino_sha256': DINO_SHA,
                  'embedding_version': 'dinov2-small-mean-patch-224-v1', 'pyvips': pyvips.__version__,
                  'vips': '.'.join(str(pyvips.version(i)) for i in range(3))}
        (OUT / 'parity.json').write_text(json.dumps(report))
        np.save(OUT / 'parity-embeddings.npy', vectors)
        print('REPORT ' + json.dumps(report), flush=True)
        for name in ['parity-fixtures.zip', 'parity.json', 'parity-embeddings.npy']:
            export(OUT / name)
        return
    if not (OUT / 'local-parity-pass.json').exists():
        raise RuntimeError('Local sharp/ONNX parity approval missing')
    test_ids = {str(row['id']) for row in rows}
    annotations = ROOT / 'datasets' / 'ava' / 'AVA_dataset' / 'AVA.txt'
    image_dir = Path(rows[0]['path']).parent
    base = annotations.parent
    train_list = base / 'aesthetics_image_lists' / 'generic_train.jpgl'
    if not train_list.exists():
        train_list = base / 'train_splits' / 'ILGnet_train.txt'
    train_ids = {Path(line.split()[0]).stem for line in train_list.read_text().splitlines() if line.strip()}
    for name in ['aesthetics_image_lists/generic_test.jpgl', 'train_splits/ILGnet_val.txt',
                 'train_splits/official_test_challenges.txt']:
        path = base / name
        if path.exists():
            test_ids.update(Path(line.split()[0]).stem for line in path.read_text().splitlines() if line.strip())
    locations = [base / 'images', image_dir, OUT / 'ava-train']
    locations[-1].mkdir(exist_ok=True)
    available = [{entry.name for entry in os.scandir(directory)} for directory in locations]
    print('REPORT ' + json.dumps({'stage': 'manifest', 'available_images': [len(names) for names in available]}), flush=True)
    candidates = []
    for line in annotations.read_text().splitlines():
        fields = line.split()
        identifier = fields[1]
        if identifier in test_ids or identifier not in train_ids:
            continue
        if not identifier.isdigit():
            raise ValueError('AVA ID must be numeric')
        votes = np.array(fields[2:12], dtype=float)
        name = identifier + '.jpg'
        image_path = next((directory / name for directory, names in zip(locations, available) if name in names),
                          OUT / 'ava-train' / name)
        candidates.append({'id': identifier, 'path': str(image_path),
                           'mos': float(np.dot(votes, np.arange(1, 11)) / votes.sum())})
    rng = np.random.default_rng(26)
    rng.shuffle(candidates)
    train = candidates[:20000]
    if len(train) != 20000 or len(rows) != 5000:
        raise RuntimeError('Insufficient AVA split coverage')
    existing_paths = {str(directory / name) for directory, names in zip(locations, available) for name in names}
    missing = {row['id'] for row in train if row['path'] not in existing_paths}
    if missing and os.environ['AES_STAGE'] not in ['stream', 'resume']:
        print('REPORT ' + json.dumps({'stage': 'archive', 'missing_train': len(missing)}), flush=True)
        with tarfile.open(ROOT / 'datasets' / 'ava.tgz', 'r|gz', bufsize=8 * 1024 * 1024) as archive:
            for member in archive:
                identifier = Path(member.name).stem
                if not member.isfile() or identifier not in missing or not member.name.lower().endswith('.jpg'):
                    continue
                if not 0 < member.size <= 32 * 1024 * 1024:
                    raise ValueError('Unbounded AVA archive member')
                temporary = OUT / 'ava-train' / (identifier + '.jpg.partial')
                with archive.extractfile(member) as source, temporary.open('wb') as target:
                    import shutil
                    shutil.copyfileobj(source, target, length=1024 * 1024)
                temporary.replace(OUT / 'ava-train' / (identifier + '.jpg'))
                missing.remove(identifier)
                if len(missing) % 2000 == 0:
                    print('REPORT ' + json.dumps({'stage': 'archive', 'remaining_train': len(missing)}), flush=True)
                if not missing:
                    break
        if missing:
            raise RuntimeError('Selected AVA train images absent from public archive')
    teacher_path = models / 'topiq_iaa_512.onnx'
    if digest(teacher_path) != TEACHER_SHA:
        raise RuntimeError('Teacher checksum mismatch')
    teacher = None if os.environ.get('AES_CPU') == '1' else session(teacher_path)
    print('REPORT ' + json.dumps({'stage': 'inference', 'train_n': len(train), 'test_n': len(rows)}), flush=True)
    vectors, targets, mos, splits, ids = [], [], [], [], []
    started = time.perf_counter()
    target = OUT.parent / ('w26-aes-' + os.environ['AES_STAGE']) \
        if os.environ['AES_STAGE'] in ['stream', 'resume'] else OUT
    target.mkdir(exist_ok=True)
    records = [(split, row) for split, selected in [('train', train), ('generic_test', rows)] for row in selected]
    previous = {}
    if os.environ['AES_STAGE'] == 'resume':
        with (OUT.parent / 'w26-aes-stream' / 'samples.jsonl').open(buffering=8 * 1024 * 1024) as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                previous[(record['split'], record['id'])] = record
        print('REPORT ' + json.dumps({'reused': len(previous), 'remaining': len(records) - len(previous)}), flush=True)
    pool = None
    if os.environ.get('AES_CPU') == '1':
        pool = concurrent.futures.ProcessPoolExecutor(max_workers=32, mp_context=multiprocessing.get_context('fork'),
                                                     initializer=init_cpu, initargs=(dino_path, teacher_path))
        if os.environ['AES_STAGE'] == 'resume':
            missing_indices = [index for index, (split, row) in enumerate(records)
                               if (split, str(row['id'])) not in previous]
            output = zip(missing_indices, pool.map(resume_record, [records[index] for index in missing_indices]))
        else:
            output = stream_records(pool, records) if os.environ['AES_STAGE'] == 'stream' \
                else enumerate(pool.map(resume_record, records, chunksize=8))
    else:
        output = enumerate(safe_record(record, model, teacher) for record in records)
    ordered = {index: previous[(split, str(row['id']))] for index, (split, row) in enumerate(records)
               if (split, str(row['id'])) in previous}
    skipped = []
    try:
        with (target / 'samples.jsonl').open('w', buffering=8 * 1024 * 1024) as stream:
            for index, record in ordered.items():
                stream.write(json.dumps(record) + '\n')
            for index, record in output:
                if 'skipped' in record:
                    skipped.append(record)
                    print('REPORT ' + json.dumps(record), flush=True)
                    continue
                ordered[index] = record
                vector = record['embedding']
                raw = record['teacher_raw']
                vectors.append(vector); targets.append((raw - 1) / 9); mos.append(record['mos'])
                splits.append(record['split']); ids.append(record['id'])
                stream.write(json.dumps(record) + '\n')
                if len(ids) % 500 == 0:
                    print('REPORT ' + json.dumps({'processed': len(ids), 'elapsed_s': round(time.perf_counter() - started)}), flush=True)
    finally:
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)
    completed = [ordered[index] for index in sorted(ordered)]
    vectors = [row['embedding'] for row in completed]
    targets = [(row['teacher_raw'] - 1) / 9 for row in completed]
    mos = [row['mos'] for row in completed]
    splits = [row['split'] for row in completed]
    ids = [row['id'] for row in completed]
    np.savez_compressed(target / 'matrix.npz', x=np.array(vectors, dtype=np.float32), y=np.array(targets),
                        mos=np.array(mos), split=np.array(splits), ids=np.array(ids))
    report = {'train_n': sum(row['split'] == 'train' for row in completed), 'test_n': len(rows),
              'skipped_train': skipped, 'reused': len(previous), 'elapsed_s': time.perf_counter() - started,
              'teacher_sha256': TEACHER_SHA, 'dino_sha256': DINO_SHA, 'seed': 26,
              'train_list': str(train_list.relative_to(base)), 'excluded_test_ids': len(test_ids),
              'cpu_workers': 32 if os.environ.get('AES_CPU') == '1' else 0}
    (target / 'extraction.json').write_text(json.dumps(report))
    export(target / 'matrix.npz'); export(target / 'extraction.json')
    print('REPORT ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exceptions from storage/network libraries may contain private paths or addresses.
        print('REPORT ' + json.dumps({'failed': type(error).__name__}), flush=True)
        raise SystemExit(1)
