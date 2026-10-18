#!/usr/bin/env python3
"""Submit one bounded GPU encoder comparison; collect only its verified feature artifacts."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.request
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, require_path, setting

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w33-encoder-'
LOCK = Path('/tmp/w29-ray.lock')
TERMINAL = ('SUCCEEDED', 'FAILED', 'STOPPED')
PROJECT = re.compile(r'^w(?:[1-9]|[12][0-9]|3[0-9])-')
ARTIFACT = re.compile(r'(?:[a-z0-9-]+/(?:fp32|fp16)/(?:oi|panel|p0)\.(?:npz|json)|'
                      r'[a-z0-9-]+/(?:model|training|head)-(?:fp32|fp16)\.json|encoder-results\.json)')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, body=None, data=None, method=None):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=300) as response:
        value = response.read()
        return json.loads(value) if value else None


def checked_job(job):
    if not re.fullmatch(PREFIX + r'[0-9a-f]{12}', job):
        raise ValueError('an explicit w33 encoder job id is required')
    return job


def active_jobs(jobs):
    return [j for j in jobs if j.get('status') in ('RUNNING', 'PENDING')
            and PROJECT.match(str(j.get('submission_id', '')))]


def acquire_lock(deadline=None):
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError('timed out waiting for the shared submission lock')
        try:
            LOCK.mkdir()
        except FileExistsError:
            time.sleep(10)
            continue
        (LOCK / 'owner.json').write_text(json.dumps({'line': 'w33-encoder', 'pid': os.getpid()}))
        return


def release_lock():
    marker = LOCK / 'owner.json'
    owner = json.loads(marker.read_text())
    if owner != {'line': 'w33-encoder', 'pid': os.getpid()}:
        raise RuntimeError('Ray lock ownership changed')
    marker.unlink()
    LOCK.rmdir()


def face_files(root, items):
    from PIL import Image
    result = []
    for row in items:
        image = row.get('images', {}).get('face')
        if not image:
            continue
        relative = Path(image)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('unsafe crop path')
        path = (root / relative).resolve()
        if root.resolve() not in path.parents:
            raise ValueError('crop outside source cache')
        with Image.open(path) as crop:
            if max(crop.size) > 768 or crop.getexif() or any(k in crop.info for k in
                    ('exif', 'xmp', 'XML:com.adobe.xmp', 'comment', 'icc_profile')):
                raise ValueError('only sanitized crops with long edge <=768 may leave this machine')
        result.append((row['id'], relative.as_posix(), path))
    return result


def package(config, cache):
    buffer = io.BytesIO()
    config['inputSha256'] = {}
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        def data(name, content):
            if isinstance(content, Path):
                content = content.read_bytes()
            elif isinstance(content, str):
                content = content.encode()
            checksum = hashlib.sha256(content).hexdigest()
            previous = config['inputSha256'].get(name)
            if previous is not None:
                if previous != checksum:
                    raise ValueError('input changed while packaging')
                return
            archive.writestr(name, content)
            config['inputSha256'][name] = checksum

        for name in ('ml/__init__.py', 'ml/observe/__init__.py', 'ml/observe/encoder_ray.py',
                     'ml/observe/encoder_run.py', 'ml/observe/train_heads.py'):
            path = ROOT / name
            if path.exists():
                archive.write(path, name)
            else:
                archive.writestr(name, '')
        rows = [json.loads(line) for line in (cache.parent / 'observe-oi/manifest.jsonl').read_text().splitlines() if line]
        data('oi/manifest.jsonl', ''.join(json.dumps({'id': 'openimages-' + r['id'], 'image': r['face']}) + '\n'
                                         for r in rows))
        for group, name in (('p1-panel', 'panel'), ('p0', 'p0')):
            source = cache / group
            items = [json.loads(line) for line in (source / 'items.jsonl').read_text().splitlines() if line]
            files = face_files(source, items)
            data(name + '/manifest.jsonl', ''.join(json.dumps({'id': i, 'image': image}) + '\n'
                                                  for i, image, _ in files))
            for _, image, path in files:
                data(name + '/' + image, path)
            data(name + '/items.jsonl', source / 'items.jsonl')
            data(name + '/labels.jsonl', source / 'labels.jsonl')
        data('oi/labels.jsonl', cache / 'p1-oi/labels.jsonl')
        archive.writestr('encoder-config.json', json.dumps(config))
    return buffer.getvalue()


def submit(args):
    config = json.loads(Path(args.config).read_text())
    content = package(config, Path(args.cache))
    print(json.dumps({'stage': 'package', 'bytes': len(content)}), flush=True)
    name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
    request('/api/packages/gcs/' + name, data=content, method='PUT')
    print(json.dumps({'stage': 'package-uploaded'}), flush=True)
    del content
    job = PREFIX + uuid.uuid4().hex[:12]
    proxy = setting('ECP_HTTP_PROXY', '')
    env = {'ECP_CEPH_ROOT': require_path('ECP_CEPH_ROOT'), 'ECP_RAY_WORKER': '1',
           'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2',
           'TOKENIZERS_PARALLELISM': 'false'}
    if proxy:
        env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy)
    body = {'submission_id': job,
            'entrypoint': 'timeout --signal=TERM --kill-after=30s %ds python -m ml.observe.encoder_run' % args.timeout,
            'entrypoint_num_cpus': 4, 'entrypoint_num_gpus': 1, 'entrypoint_memory': 24 * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + name,
                            'pip': ['onnxruntime-gpu[cuda,cudnn]==1.24.4', 'onnxconverter-common==1.16.0'], 'env_vars': env}}
    waiting, deadline = None, time.monotonic() + args.admission_timeout
    while True:
        acquire_lock(deadline)
        try:
            active = active_jobs(request('/api/jobs/'))
            if len(active) < 2 and not any(str(j.get('submission_id', '')).startswith(PREFIX) for j in active):
                response = request('/api/jobs/', body)
                break
            state = tuple(sorted(str(j.get('submission_id', '')) for j in active))
            if state != waiting:
                print(json.dumps({'stage': 'waiting-for-project-slot', 'active': list(state)}), flush=True)
                waiting = state
        finally:
            release_lock()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('project slots remained occupied for the admission timeout')
        time.sleep(min(300, remaining))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'job.json').write_text(json.dumps({'job': job, 'response': response, 'config': config}, indent=2) + '\n')
    print(json.dumps({'job': job, 'submitted': True}), flush=True)
    return job


def collect(job, output):
    checked_job(job)
    logs = request('/api/jobs/' + job + '/logs')['logs']
    output.mkdir(parents=True, exist_ok=True)
    (output / 'job.log').write_text(logs)
    chunks, reports = {}, []
    for line in logs.splitlines():
        if line.startswith('ENCODER_REPORT '):
            reports.append(json.loads(line[len('ENCODER_REPORT '):]))
        if not line.startswith('ENCODER_ARTIFACT '):
            continue
        row = json.loads(line[len('ENCODER_ARTIFACT '):])
        name = row.get('name', '')
        if not ARTIFACT.fullmatch(name):
            raise ValueError('unexpected encoder artifact')
        record = chunks.setdefault(name, {'count': row['count'], 'sha256': row['sha256'], 'parts': {}})
        if record['count'] != row['count'] or record['sha256'] != row['sha256']:
            raise ValueError('inconsistent artifact metadata')
        record['parts'][row['index']] = row['data']
    written = []
    for name, record in chunks.items():
        if set(record['parts']) != set(range(record['count'])):
            raise ValueError('incomplete encoder artifact: ' + name)
        content = base64.b64decode(''.join(record['parts'][i] for i in range(record['count'])), validate=True)
        if hashlib.sha256(content).hexdigest() != record['sha256']:
            raise ValueError('encoder artifact checksum mismatch')
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.with_suffix(target.suffix + '.part').write_bytes(content)
        target.with_suffix(target.suffix + '.part').replace(target)
        written.append({'name': name, 'sha256': record['sha256'], 'bytes': len(content)})
    (output / 'collection.json').write_text(json.dumps({'job': job, 'artifacts': written, 'reports': reports}, indent=2) + '\n')
    print(json.dumps({'job': job, 'artifacts': written, 'reports': reports[-4:]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('submit', 'status', 'collect'))
    parser.add_argument('job', nargs='?')
    parser.add_argument('--config')
    parser.add_argument('--cache', default=str(ROOT / 'data/cache/observe'))
    parser.add_argument('--output', default=str(ROOT / 'data/cache/w33-encoder'))
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--admission-timeout', type=int, default=14400)
    args = parser.parse_args()
    if args.action == 'submit':
        if not args.config or not 60 <= args.timeout <= 21600 or not 1 <= args.admission_timeout <= 14400:
            parser.error('submit requires --config, timeout 60..21600 and admission timeout 1..14400')
        submit(args)
    else:
        if not args.job:
            parser.error('status/collect require an own job id')
        state = request('/api/jobs/' + checked_job(args.job))
        if args.action == 'status':
            print(json.dumps({'job': args.job, 'status': state.get('status')}))
        elif state.get('status') in TERMINAL:
            collect(args.job, Path(args.output))
        else:
            parser.error('collect requires a terminal job')


if __name__ == '__main__':
    main()
