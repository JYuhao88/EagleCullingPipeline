#!/usr/bin/env python3
"""Prepare CC BY 2.0 portrait views on Ray/Ceph, without downloading source pictures locally.

submit [--count 8000]       CPU-only, resumable sampling job (hold the shared Ray lock until terminal)
submit --mode check        separate random ten-pair metadata/geometry/thumbnail check
status JOB                 own job status; collect JOB exports only manifest, attribution, summary or check previews
Use ECP_CEPH_ROOT and ECP_HTTP_PROXY from private configuration; no model endpoint or credential is needed.
"""
import argparse
import base64
import csv
import gzip
import hashlib
import io
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.request
import uuid
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w29-oidata-'
IMAGE_ROOT = 'photography/eagle-culling/observe/openimages-v1'
LICENSE = 'https://creativecommons.org/licenses/by/2.0/'
FACE, PERSON = '/m/0dzct', '/m/01g317'
STRATA = ('small', 'mid', 'large')
BASE = 'https://storage.googleapis.com/openimages/'
# Verified against the official V7 download page (2026-10-16): V7 reuses these V5/V6 box files.
# https://storage.googleapis.com/openimages/web/download_v7.html
# Image CSV fields: ImageID, [Subset], OriginalURL, OriginalLandingURL, License, AuthorProfileURL,
# Author, Title, OriginalSize, OriginalMD5, Thumbnail300KURL, Rotation.
# Box CSV fields used: ImageID, Source (xclick/activemil: human drawn/verified), LabelName, Confidence,
# XMin, XMax, YMin, YMax, IsGroupOf, IsDepiction. All coordinates are normalized BEFORE Rotation.
SOURCES = {
    'validation': (BASE + '2018_04/validation/validation-images-with-rotation.csv',
                   BASE + 'v5/validation-annotations-bbox.csv'),
    'test': (BASE + '2018_04/test/test-images-with-rotation.csv', BASE + 'v5/test-annotations-bbox.csv'),
    'train': (BASE + '2018_04/train/train-images-boxable-with-rotation.csv',
              BASE + 'v6/oidv6-train-annotations-bbox.csv'),
}
# Official downloader.py uses this public CVDF bucket. Its images are the released source pixels,
# already stripped of metadata and capped at 1024 on the long edge, not full-resolution Flickr originals.
# https://github.com/cvdfoundation/open-images-dataset#download-images-with-bounding-boxes-annotations
MIRROR = 'https://open-images-dataset.s3.amazonaws.com/{split}/{id}.jpg'
IMAGE_SESSIONS = threading.local()


def emit(tag, value):
    print(tag + ' ' + json.dumps(value, ensure_ascii=False), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def image_stream(url):
    import requests
    if not hasattr(IMAGE_SESSIONS, 'session'):
        IMAGE_SESSIONS.session = requests.Session()
    response = IMAGE_SESSIONS.session.get(url, stream=True, timeout=90, headers={'Accept-Encoding': 'identity'})
    try:
        if urlsplit(response.url).scheme != 'https':
            raise ValueError('Insecure redirect')
        response.raise_for_status()
        response.raw.decode_content = True
        yield response.raw
    finally:
        # A fully read urllib3 stream has already returned its connection; partial/error streams are discarded.
        response.close()


def fetch(url):
    if urlsplit(url).scheme != 'https':
        raise ValueError('Only HTTPS public sources are allowed')
    if urlsplit(url).netloc == urlsplit(MIRROR).netloc:
        return image_stream(url)
    response = urllib.request.urlopen(url, timeout=90)
    if urlsplit(response.url).scheme != 'https':
        response.close()
        raise ValueError('Insecure redirect')
    return response


def metadata_file(root, split, kind, train_prefixes):
    suffix = '-' + train_prefixes if split == 'train' else ''
    subset = '-boxable' if split == 'train' and kind == 'images' else ''
    target = root / 'metadata' / (split + '-' + kind + subset + suffix + '.csv')
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    url = SOURCES[split][0 if kind == 'images' else 1]
    for attempt in range(4):
        try:
            with fetch(url) as response, target.with_suffix('.part').open('w', newline='') as stream:
                reader = csv.DictReader(io.TextIOWrapper(response, encoding='utf-8-sig', newline=''))
                required = ({'ImageID', 'License', 'Author', 'OriginalURL', 'Rotation'} if kind == 'images'
                            else {'ImageID', 'LabelName', 'Source', 'Confidence', 'XMin', 'XMax', 'YMin',
                                  'YMax', 'IsGroupOf', 'IsDepiction'})
                if not required.issubset(reader.fieldnames or []):
                    raise ValueError('Official metadata schema changed')
                writer = csv.DictWriter(stream, fieldnames=reader.fieldnames)
                writer.writeheader()
                count = 0
                for row in reader:
                    image_id = row['ImageID']
                    if split == 'train':
                        # Scan completely: the official image metadata is NOT ImageID ordered.
                        # The bounded hash prefix limits retained candidates, never truncates an image's boxes.
                        if image_id[0] not in train_prefixes:
                            continue
                    writer.writerow(row)
                    count += 1
            target.with_suffix('.part').replace(target)
            emit('OI_METADATA', {'split': split, 'kind': kind, 'url': url, 'rows': count,
                                 'sha256': sha(target.read_bytes()), 'trainPrefixes': suffix.lstrip('-') or None})
            return target
        except Exception as error:
            if attempt == 3:
                raise
            emit('OI_RETRY', {'kind': kind, 'split': split, 'attempt': attempt + 1, 'error': type(error).__name__})
            time.sleep(2 ** attempt)


def rotated_box(box, rotation):
    x0, y0, x1, y1 = box
    return {0: [x0, y0, x1, y1], 90: [y0, 1 - x1, y1, 1 - x0],
            180: [1 - x1, 1 - y1, 1 - x0, 1 - y0], 270: [1 - y1, x0, 1 - y0, x1]}[rotation]


def stratum(box):
    height = round(box[3] - box[1], 12)
    return 'small' if height < .08 else 'mid' if height <= .13 else 'large'


def crop_geometry(size, box):
    # Same clamp/floor/Math.round geometry as observe-teacher.mjs photos(), including edge-clamped crops.
    width, height = size
    x0, y0, x1, y1 = box
    side = math.floor(min(width, height, 1.8 * max((x1 - x0) * width, (y1 - y0) * height)))
    if side < 1:
        raise ValueError('Empty face crop')
    left = math.floor(min(width - side, max(0, (x0 + x1) / 2 * width - side / 2)) + .5)
    top = math.floor(min(height - side, max(0, (y0 + y1) / 2 * height - side / 2)) + .5)
    return [left, top, side]


def candidates(root, split, prefixes, stats):
    stats['excludedImages:licenseNotExplicitCCBY20'] += 0
    boxes = defaultdict(lambda: {'faces': [], 'persons': []})
    with metadata_file(root, split, 'boxes', prefixes).open(newline='') as stream:
        for row in csv.DictReader(stream):
            label = row['LabelName']
            stats['boxRows'] += 1
            if label not in (FACE, PERSON):
                continue
            kind = 'faces' if label == FACE else 'persons'
            stats[kind + 'BoxRows'] += 1
            if row['IsDepiction'] == '1' or row['IsGroupOf'] == '1':
                stats['excludedBoxes:' + kind + ':depictionOrGroup'] += 1
                continue
            if row['Source'] not in ('xclick', 'activemil') or float(row['Confidence']) != 1:
                stats['excludedBoxes:' + kind + ':notHumanVerified'] += 1
                continue
            box = [float(row[key]) for key in ('XMin', 'YMin', 'XMax', 'YMax')]
            if not all(math.isfinite(x) and 0 <= x <= 1 for x in box) or box[0] >= box[2] or box[1] >= box[3]:
                stats['excludedBoxes:' + kind + ':invalidGeometry'] += 1
                continue
            boxes[row['ImageID']][kind].append(box)
    out = []
    licenses = Counter()
    with metadata_file(root, split, 'images', prefixes).open(newline='') as stream:
        for row in csv.DictReader(stream):
            stats['imageRows'] += 1
            licenses[row['License']] += 1
            # Exact equality: do not infer permissions from Flickr availability or the dataset's general license.
            if row['License'] != LICENSE:
                stats['excludedImages:licenseNotExplicitCCBY20'] += 1
                continue
            if not boxes.get(row['ImageID'], {}).get('faces'):
                stats['excludedImages:noEligibleFace'] += 1
                continue
            try:
                rotation = float(row['Rotation'])
                if rotation not in (0, 90, 180, 270):
                    raise ValueError('Unknown rotation')
                rotation = int(rotation)
            except ValueError:
                stats['excludedImages:unknownRotation'] += 1
                continue
            transformed = {key: [rotated_box(box, rotation) for box in value]
                           for key, value in boxes[row['ImageID']].items()}
            face = max(transformed['faces'], key=lambda box: box[3] - box[1])
            if round(face[3] - face[1], 12) < .05:
                stats['excludedImages:faceBelow5Percent'] += 1
                continue
            if not row['Author'].strip() or not row['OriginalURL'].strip():
                stats['excludedImages:missingAttribution'] += 1
                continue
            out.append({'id': row['ImageID'], 'split': split, 'license': row['License'], 'author': row['Author'],
                        'originalUrl': row['OriginalURL'], 'originalLandingUrl': row.get('OriginalLandingURL', ''),
                        'authorProfileUrl': row.get('AuthorProfileURL', ''), 'title': row.get('Title', ''),
                        'rotation': rotation, 'faceBox': face, **transformed, 'stratum': stratum(face)})
    stats['candidates'] = len(out)
    stats['licenseValues'] = dict(licenses)
    stats['strata'] = dict(Counter(row['stratum'] for row in out))
    stats['multiplePersonsByStratum'] = dict(Counter(row['stratum'] for row in out if len(row['persons']) >= 2))
    emit('OI_CANDIDATES', {'split': split, **stats})
    return out


def quotas(count):
    return {key: count // 3 + (index < count % 3) for index, key in enumerate(STRATA)}


def enough(rows, count):
    goals = quotas(count)
    return (all(sum(row['stratum'] == key for row in rows) >= goal for key, goal in goals.items())
            and sum(multi_quotas(rows, count).values()) >= math.ceil(count * .3))


def multi_quotas(rows, count):
    goals = quotas(count)
    available = Counter(row['stratum'] for row in rows if len(row['persons']) >= 2)
    targets = {key: min(available[key], math.ceil(goal * .3)) for key, goal in goals.items()}
    remaining = max(0, math.ceil(count * .3) - sum(targets.values()))
    # The 30% requirement is global: compensate in other strata when close portraits lack Person boxes.
    for key, goal in goals.items():
        extra = min(remaining, goal - targets[key], available[key] - targets[key])
        targets[key] += extra
        remaining -= extra
    return targets


def ordered(rows, seed):
    out = []
    # Exhaust the smaller public splits before taking any bounded train-prefix candidates.
    for split in ('validation', 'test', 'train'):
        group = sorted((row for row in rows if row['split'] == split), key=lambda row: row['id'])
        random.Random(str(seed) + split).shuffle(group)
        out.extend(group)
    return out


def save_jpeg(image, path):
    from PIL import Image
    # Starting with a new pixel object strips EXIF, ICC, XMP and comments even if a source decoder retained them.
    clean = Image.frombytes('RGB', image.size, image.convert('RGB').tobytes())
    temporary = path.with_suffix('.part')
    clean.save(temporary, 'JPEG', quality=90)
    temporary.replace(path)


def prepare(row, root):
    from PIL import Image
    record = root / 'records' / (row['id'] + '.json')
    if record.exists():
        saved = json.loads(record.read_text())
        compatible = saved['rotation'] == row['rotation'] and saved['faceBox'] == row['faceBox']
        if max(saved.get('sourceSize', [768])) < 768 and max(saved.get('fullSize', [0])) != 768:
            compatible = False
        if all((root / saved[key]).is_file() for key in ('full', 'face')) and compatible:
            current = {**saved, **row}
            if current != saved:
                temporary = record.with_suffix('.part')
                temporary.write_text(json.dumps(current, ensure_ascii=False))
                temporary.replace(record)
            return current, 'resumed'
    last = None
    for attempt in range(4):
        try:
            with fetch(MIRROR.format(**row)) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('Unexpected image size')
            with Image.open(io.BytesIO(data)) as source:
                # CVDF removed EXIF without rotating. Apply the CSV Rotation once; never EXIF-transpose as well.
                image = source.convert('RGB').rotate(row['rotation'], expand=True)
            geometry = crop_geometry(image.size, row['faceBox'])
            left, top, side = geometry
            face = image.crop((left, top, left + side, top + side)).resize((384, 384), Image.Resampling.LANCZOS)
            scale = 768 / max(image.size)
            full = image.resize(tuple(max(1, math.floor(value * scale + .5)) for value in image.size),
                                Image.Resampling.LANCZOS)
            saved = {**row, 'full': 'full/' + row['id'] + '.jpg', 'face': 'face/' + row['id'] + '.jpg',
                     'sourceSize': list(image.size), 'fullSize': list(full.size),
                     'crop': geometry, 'mirrorUrl': MIRROR.format(**row),
                     'sourceSha256': sha(data), 'sourceResolution': 'CVDF long edge at most 1024',
                     'changes': 'CSV rotation; full resize; square face crop; JPEG pixel re-encoding; metadata removed'}
            save_jpeg(full, root / saved['full'])
            save_jpeg(face, root / saved['face'])
            temporary = record.with_suffix('.part')
            temporary.write_text(json.dumps(saved, ensure_ascii=False))
            temporary.replace(record)
            return saved, 'downloaded'
        except Exception as error:
            last = type(error).__name__
            if attempt < 3:
                time.sleep(2 ** attempt)
    return {'id': row['id'], 'error': last}, 'failed'


def export_file(path, name=None):
    raw = path.read_bytes()
    encoded = base64.b64encode(gzip.compress(raw, mtime=0)).decode()
    size = 128 * 1024
    chunks = math.ceil(len(encoded) / size)
    for index in range(chunks):
        emit('OI_FILE', {'name': name or path.name, 'index': index, 'count': chunks, 'sha256': sha(raw),
                         'data': encoded[index * size:(index + 1) * size]})


def sample(args, root):
    for folder in ('full', 'face', 'records'):
        (root / folder).mkdir(parents=True, exist_ok=True)
    stats, rows = {}, []
    for split in ('validation', 'test'):
        stats[split] = Counter()
        rows.extend(candidates(root, split, args.train_prefixes, stats[split]))
    if not enough(rows, args.count):
        stats['train'] = Counter()
        rows.extend(candidates(root, 'train', args.train_prefixes, stats['train']))
    if not enough(rows, args.count):
        raise RuntimeError('Insufficient stratified candidates; expand --train-prefixes')
    pool = ordered(rows, args.seed)
    multiple = multi_quotas(rows, args.count)
    emit('OI_PLAN', {'strata': quotas(args.count), 'multiplePersonMinimums': multiple})
    selected, failures, outcomes = [], [], Counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        for key, goal in quotas(args.count).items():
            seen = set()
            for multi_only, target in ((True, multiple[key]), (False, goal)):
                choices = iter(row for row in pool if row['stratum'] == key and row['id'] not in seen
                               and (not multi_only or len(row['persons']) >= 2))
                while sum(row['stratum'] == key for row in selected) < target:
                    need = target - sum(row['stratum'] == key for row in selected)
                    batch = []
                    for row in choices:
                        if row['id'] in seen:
                            continue
                        seen.add(row['id'])
                        batch.append(row)
                        if len(batch) >= min(64, need):
                            break
                    if not batch:
                        raise RuntimeError('Download failures exhausted a stratum; rerun with a larger train portion')
                    for record, outcome in executor.map(lambda row: prepare(row, root), batch):
                        outcomes[outcome] += 1
                        if outcome == 'failed':
                            failures.append(record)
                        else:
                            selected.append(record)
                    emit('OI_PROGRESS', {'selected': len(selected), 'stratum': key, 'outcomes': dict(outcomes)})
    selected.sort(key=lambda row: row['id'])
    manifest = root / 'manifest.jsonl'
    temporary = manifest.with_suffix('.part')
    temporary.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in selected))
    temporary.replace(manifest)
    with (root / 'ATTRIBUTION.csv').open('w', newline='') as stream:
        fields = ('id', 'title', 'author', 'authorProfileUrl', 'originalUrl', 'originalLandingUrl', 'license', 'changes')
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(selected)
    summary = {'count': len(selected), 'seed': args.seed, 'requested': args.count, 'imageRoot': IMAGE_ROOT,
               'strata': dict(Counter(row['stratum'] for row in selected)),
               'splits': dict(Counter(row['split'] for row in selected)),
               'rotations': dict(Counter(row['rotation'] for row in selected)),
               'multiplePersons': sum(len(row['persons']) >= 2 for row in selected),
               'candidateCount': len(rows), 'metadata': stats, 'outcomes': dict(outcomes),
               'downloadFailures': len(failures), 'failures': failures, 'manifestSha256': sha(manifest.read_bytes()),
               'sources': SOURCES, 'trainPrefixes': args.train_prefixes if 'train' in stats else None}
    (root / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    for filename in ('manifest.jsonl', 'ATTRIBUTION.csv', 'summary.json'):
        export_file(root / filename)
    emit('OI_DONE', summary)


def check(args, root):
    import importlib.util
    from PIL import Image, ImageDraw
    spec = importlib.util.spec_from_file_location('ceph_reader', Path(__file__).with_name('ceph-reader.py'))
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    rows = [json.loads(line) for line in (root / 'manifest.jsonl').read_text().splitlines()]
    picked = random.Random(args.seed).sample(rows, min(10, len(rows)))
    reports = []
    for row in picked:
        entry = {'id': row['id'], 'rotation': row['rotation'], 'stratum': row['stratum'], 'views': {}}
        body = {'messages': [{'role': 'user', 'content': [
            {'type': 'image_url', 'image_file': row[kind]} for kind in ('full', 'face')]}]}
        parts = reader.resolve(body, {'imageRoot': IMAGE_ROOT})['messages'][0]['content']
        for kind, part in zip(('full', 'face'), parts):
            url = part['image_url']['url']
            if not url.startswith('data:image/jpeg;base64,'):
                raise ValueError('Unexpected resolved image format')
            resolved_sha = sha(base64.b64decode(url.split(',', 1)[1], validate=True))
            with Image.open(root / row[kind]) as image:
                entry['views'][kind] = {'size': list(image.size), 'exif': bool(image.getexif()),
                                        'icc': bool(image.info.get('icc_profile')),
                                        'xmp': bool(image.info.get('xmp')), 'sha256': sha((root / row[kind]).read_bytes())}
                entry['views'][kind]['resolverMatches'] = resolved_sha == entry['views'][kind]['sha256']
                preview = image.convert('RGB')
                if kind == 'full':
                    box = row['faceBox']
                else:
                    left, top, side = row['crop']
                    width, height = row['sourceSize']
                    x0, y0, x1, y1 = row['faceBox']
                    box = [(x0 * width - left) / side, (y0 * height - top) / side,
                           (x1 * width - left) / side, (y1 * height - top) / side]
                    entry['faceCenter'] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
                    entry['centered'] = all(abs(value - .5) <= .02 for value in entry['faceCenter'])
                    entry['edgeClamped'] = left == 0 or top == 0 or left + side == width or top + side == height
                    entry['geometryMatches'] = row['crop'] == crop_geometry(row['sourceSize'], row['faceBox'])
                draw = ImageDraw.Draw(preview)
                draw.rectangle([box[0] * preview.width, box[1] * preview.height,
                                box[2] * preview.width, box[3] * preview.height], outline='red', width=2)
                preview.thumbnail((384, 384), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                preview.save(buffer, 'JPEG', quality=85)
                raw = buffer.getvalue()
                emit('OI_FILE', {'name': 'check/' + row['id'] + '-' + kind + '.jpg', 'index': 0, 'count': 1,
                                 'sha256': sha(raw), 'data': base64.b64encode(gzip.compress(raw, mtime=0)).decode()})
        entry['resolverMatches'] = all(view['resolverMatches'] for view in entry['views'].values())
        reports.append(entry)
        emit('OI_CHECK', entry)
    report = root / 'check.json'
    report.write_text(json.dumps({'seed': args.seed, 'pairs': reports}, indent=2))
    export_file(report, 'check/check.json')
    emit('OI_CHECK_DONE', {'pairs': len(reports), 'views': 2 * len(reports),
                           'metadataFree': all(not view['exif'] and not view['icc'] and not view['xmp']
                                               for row in reports for view in row['views'].values()),
                           'geometryMatches': all(row['geometryMatches'] for row in reports),
                           'resolverMatches': all(row['resolverMatches'] for row in reports)})


def request(path, body=None, data=None, method=None):
    sys.path.insert(0, str(ROOT))
    from ml.common.private_env import dashboard_url
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=120) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def submit(args):
    sys.path.insert(0, str(ROOT))
    from ml.common.private_env import setting, require_path
    active = [job for job in request('/api/jobs/') if job['status'] in ('RUNNING', 'PENDING')
              and re.match(r'w\d+-', str(job.get('submission_id', '')))]
    if len(active) >= 2:
        raise SystemExit('Two photography jobs active; wait before submitting')
    content = io.BytesIO()
    with zipfile.ZipFile(content, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(Path(__file__), 'worker.py')
        archive.write(ROOT / 'scripts/aihub-ray-worker.py', 'ceph-reader.py')
    raw = content.getvalue()
    package = '_ray_pkg_' + sha(raw)[:16] + '.zip'
    request('/api/packages/gcs/' + package, data=raw, method='PUT')
    job = PREFIX + uuid.uuid4().hex[:12]
    proxy = setting('ECP_HTTP_PROXY', '')
    entry = ('timeout --signal=TERM --kill-after=15s %ds python worker.py worker --mode %s '
             '--count %d --seed %d --concurrency %d --train-prefixes %s') % (
                 args.timeout, args.mode, args.count, args.seed, args.concurrency, args.train_prefixes)
    body = {'submission_id': job, 'entrypoint': entry, 'entrypoint_num_cpus': 2,
            'entrypoint_num_gpus': 0, 'entrypoint_memory': 8 * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + package, 'env_vars': {
                'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'ECP_CEPH_ROOT': require_path('ECP_CEPH_ROOT'),
                'ECP_RAY_WORKER': '1', 'CUDA_VISIBLE_DEVICES': '', 'OMP_NUM_THREADS': '2'}}}
    response = request('/api/jobs/', body)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / ('job-' + args.mode + '.json')).write_text(json.dumps({'job': job, 'response': response}, indent=2))
    emit('OI_JOB', {'job': job, 'mode': args.mode})


def collect(job, output):
    logs = request('/api/jobs/' + job + '/logs')['logs']
    output.mkdir(parents=True, exist_ok=True)
    diagnostic = '\n'.join(line for line in logs.splitlines() if not line.startswith('OI_FILE '))
    (output / (job + '.log')).write_text(diagnostic)
    complete_sample = any(line.startswith('OI_DONE ') for line in logs.splitlines())
    check_done = [json.loads(line[len('OI_CHECK_DONE '):]) for line in logs.splitlines() if line.startswith('OI_CHECK_DONE ')]
    complete_check = bool(check_done)
    if not complete_sample and not complete_check:
        raise ValueError('Job has not exported a completed result; diagnostic log saved, existing artifacts preserved')
    groups = defaultdict(dict)
    for line in logs.splitlines():
        if line.startswith('OI_FILE '):
            row = json.loads(line[len('OI_FILE '):])
            name = row['name']
            if name not in ('manifest.jsonl', 'summary.json', 'ATTRIBUTION.csv', 'check/check.json') \
                    and not re.fullmatch(r'check/[0-9a-f]{16}-(?:full|face)\.jpg', name):
                raise ValueError('Unexpected exported artifact')
            groups[name][row['index']] = row
    if complete_sample and not {'manifest.jsonl', 'ATTRIBUTION.csv', 'summary.json'}.issubset(groups):
        raise ValueError('Incomplete sample export')
    if complete_check:
        pairs = check_done[-1].get('pairs')
        if not isinstance(pairs, int) or not 1 <= pairs <= 10 or check_done[-1].get('views') != 2 * pairs:
            raise ValueError('Invalid check export counts')
        if 'check/check.json' not in groups or len(groups) != 2 * pairs + 1:
            raise ValueError('Incomplete check export')
    decoded = {}
    for name, parts in groups.items():
        first = parts[0]
        if set(parts) != set(range(first['count'])) or any(row['sha256'] != first['sha256'] for row in parts.values()):
            raise ValueError('Incomplete artifact chunks')
        raw = gzip.decompress(base64.b64decode(''.join(parts[index]['data'] for index in range(first['count']))))
        if sha(raw) != first['sha256']:
            raise ValueError('Artifact checksum mismatch')
        decoded[name] = raw
    for name, raw in decoded.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix('.part')
        temporary.write_bytes(raw)
        temporary.replace(target)
    emit('OI_COLLECT', {'job': job, 'files': list(groups)})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=('submit', 'status', 'collect', 'worker'))
    parser.add_argument('job', nargs='?')
    parser.add_argument('--mode', choices=('sample', 'check'), default='sample')
    parser.add_argument('--count', type=int, default=8000)
    parser.add_argument('--seed', type=int, default=20261016)
    parser.add_argument('--concurrency', type=int, choices=range(1, 9), default=8)
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--train-prefixes', default='0123')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/cache/observe-oi')
    args = parser.parse_args()
    if args.count < 1 or not args.train_prefixes or args.train_prefixes not in [
            '0123456789abcdef'[:length] for length in range(1, 17)]:
        parser.error('positive count and contiguous hexadecimal train prefixes starting at 0 required')
    if not 60 <= args.timeout <= 21600:
        parser.error('timeout must be between 60 and 21600 seconds')
    if args.action == 'worker':
        root = Path(os.environ['ECP_CEPH_ROOT']) / IMAGE_ROOT
        root.mkdir(parents=True, exist_ok=True)
        emit('OI_ENV', {'Pillow': __import__('PIL').__version__, 'concurrency': args.concurrency, 'mode': args.mode})
        (sample if args.mode == 'sample' else check)(args, root)
    elif args.action == 'submit':
        submit(args)
    else:
        if not args.job or not re.fullmatch(PREFIX + '[0-9a-f]{12}', args.job):
            parser.error('explicit own job id required')
        state = request('/api/jobs/' + args.job)
        emit('OI_STATUS', {key: state.get(key) for key in ('submission_id', 'status', 'message')})
        if args.action == 'collect':
            if state.get('status') != 'SUCCEEDED':
                raise SystemExit('Collect requires a succeeded job; inspect status before collecting')
            collect(args.job, args.output)


if __name__ == '__main__':
    main()
