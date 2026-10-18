#!/usr/bin/env python3
"""Run and collect the bounded CPU face-attribute probe while holding the shared Ray lock."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import sys
import subprocess
import time
import urllib.request
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, setting  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w29-probe-'
LOCK = Path('/tmp/w29-ray.lock')
TERMINAL = ('SUCCEEDED', 'FAILED', 'STOPPED')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PACKAGES = {'numpy': 'numpy', 'PIL': 'Pillow', 'onnxruntime': 'onnxruntime', 'pyvips': 'pyvips',
            'pyarrow': 'pyarrow', 'sklearn': 'scikit-learn'}
ASSET_CHUNK_BYTES = 48 * 1024 ** 2


def request(path, body=None, method=None, data=None, timeout=120):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=timeout) as response:
        value = response.read()
    return json.loads(value) if value else None


def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 ** 2), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def checked_job(job):
    if not job.startswith(PREFIX) or not job[len(PREFIX):].isalnum():
        raise ValueError('An explicit own probe job id is required')
    return job


def wait(job):
    checked_job(job)
    previous = None
    while True:
        state = request('/api/jobs/' + job)
        status = state.get('status')
        if status != previous:
            print(json.dumps({'job': job, 'status': status}), flush=True)
            previous = status
        if status in TERMINAL:
            return state
        time.sleep(10)


def collect(job, output):
    checked_job(job)
    logs = request('/api/jobs/' + job + '/logs')['logs']
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'job.log').write_text(logs)
    chunks, reports = {}, []
    for line in logs.splitlines():
        if line.startswith('PROBE_REPORT '):
            reports.append(json.loads(line[len('PROBE_REPORT '):]))
        if not line.startswith('PROBE_ARTIFACT '):
            continue
        row = json.loads(line[len('PROBE_ARTIFACT '):])
        name = row['name']
        if Path(name).name != name or name in ('', '.', '..'):
            raise ValueError('Unsafe artifact name')
        previous = chunks.setdefault(name, {'count': row['count'], 'sha256': row['sha256'], 'parts': {}})
        if previous['count'] != row['count'] or previous['sha256'] != row['sha256']:
            raise ValueError('Inconsistent artifact chunks')
        previous['parts'][row['index']] = row['data']
    written = []
    for name, record in chunks.items():
        if set(record['parts']) != set(range(record['count'])):
            raise ValueError('Incomplete artifact: ' + name)
        content = base64.b64decode(''.join(record['parts'][index] for index in range(record['count'])), validate=True)
        if hashlib.sha256(content).hexdigest() != record['sha256']:
            raise ValueError('Artifact checksum mismatch: ' + name)
        (output / name).write_bytes(content)
        written.append({'name': name, 'bytes': len(content), 'sha256': record['sha256']})
    (output / 'collection.json').write_text(json.dumps({'job': job, 'artifacts': written, 'reports': reports}, indent=2) + '\n')
    print(json.dumps({'job': job, 'artifacts': written, 'reports': reports[-3:]}), flush=True)
    return written


def active_count():
    return sum(job.get('status') in ('RUNNING', 'PENDING')
               and str(job.get('submission_id', '')).startswith(tuple('w' + str(i) + '-' for i in range(1, 40)))
               for job in request('/api/jobs/'))


def preflight(output):
    code = ('import importlib, json\n'
            'result = {}\n'
            'for name in ' + repr(list(PACKAGES)) + ':\n'
            '    try:\n'
            '        module = importlib.import_module(name)\n'
            '        result[name] = {"available": True, "version": getattr(module, "__version__", "unknown")}\n'
            '    except (ImportError, OSError) as error:\n'
            '        result[name] = {"available": False, "error": type(error).__name__}\n'
            'print("PROBE_ENV " + json.dumps(result), flush=True)\n')
    job = PREFIX + uuid.uuid4().hex[:12]
    request('/api/jobs/', {'submission_id': job, 'entrypoint': 'timeout 90s python -c ' + shlex.quote(code),
                           'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 512 * 1024 ** 2})
    try:
        state = wait(job)
    except BaseException:
        state = request('/api/jobs/' + job)
        if state.get('status') not in TERMINAL:
            request('/api/jobs/' + job + '/stop', body={})
            wait(job)
        raise
    logs = request('/api/jobs/' + job + '/logs')['logs']
    (output / 'preflight.json').write_text(json.dumps({'job': job, 'status': state.get('status'), 'logs': logs}, indent=2))
    if state.get('status') != 'SUCCEEDED':
        raise RuntimeError('Ray environment inspection failed; see preflight.json')
    rows = [json.loads(line[len('PROBE_ENV '):]) for line in logs.splitlines() if line.startswith('PROBE_ENV ')]
    if len(rows) != 1:
        raise RuntimeError('Missing environment inspection result')
    print(json.dumps({'preflight_job': job, 'modules': rows[0]}), flush=True)
    return rows[0]


def package(p0, config):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for source in ('ml/__init__.py', 'ml/observe/__init__.py', 'ml/observe/embed.py',
                       'ml/observe/evaluate.py', 'ml/observe/metrics.py', 'ml/observe/probe_ray.py'):
            path = ROOT / source
            if path.exists():
                archive.write(path, source)
            elif source.endswith('__init__.py'):
                archive.writestr(source, '')
            else:
                raise FileNotFoundError(source)
        archive.writestr('probe-config.json', json.dumps(config))
        archive.write(p0 / 'items.jsonl', 'p0/items.jsonl')
        items = [json.loads(line) for line in (p0 / 'items.jsonl').read_text().splitlines() if line.strip()]
        paths = {image for item in items for image in item['images'].values()}
        for relative in sorted(paths):
            image = p0 / relative
            if not image.resolve().is_relative_to(p0.resolve()) or not relative.startswith('images/'):
                raise ValueError('p0 image outside expected directory')
            archive.write(image, 'p0/' + relative)
    return buffer.getvalue()


def model_packages(models):
    """Split large ONNX files into importable Ray py_modules.

    The jobs API closes a single upload around the 100 MB boundary.  Keeping
    each stored chunk below that limit also avoids compressing already
    compressed ONNX data and lets the worker reconstruct and checksum the
    original file before loading it.
    """
    packages = []
    metadata = {}
    for kind, relative in models.items():
        source = ROOT / relative
        chunks = []
        with source.open('rb') as stream:
            index = 0
            while data := stream.read(ASSET_CHUNK_BYTES):
                module = f'observe_model_{kind}_{index}'
                payload = io.BytesIO()
                with zipfile.ZipFile(payload, 'w', compression=zipfile.ZIP_STORED) as archive:
                    archive.writestr(module + '/__init__.py', '')
                    archive.writestr(module + '/chunk', data)
                raw = payload.getvalue()
                name = '_ray_pkg_' + hashlib.sha256(raw).hexdigest()[:16] + '.zip'
                packages.append((name, raw))
                chunks.append({'module': module, 'index': index, 'sha256': hashlib.sha256(data).hexdigest()})
                index += 1
        metadata[kind] = chunks
    return packages, metadata


def node_parity_reference(p0):
    """Compute five references through the production Node paths before upload."""
    command = ['nice', '-n', '15', 'node', 'scripts/observe-embed-reference.mjs',
               str(Path(p0) / 'items.jsonl'), str(p0)]
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
    return json.loads(result.stdout.strip().splitlines()[-1])


def run(args):
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    print(json.dumps({'waiting_for_shared_ray_lock': str(LOCK)}), flush=True)
    while True:
        try:
            LOCK.mkdir()
            (LOCK / 'owner.json').write_text(json.dumps({'line': 'w29-obs-probe', 'pid': os.getpid()}))
            break
        except FileExistsError:
            time.sleep(10)
    job = None
    try:
        if active_count() >= 2:
            raise RuntimeError('Two project Ray jobs are already active')
        modules = preflight(output)
        models = {'clip': 'models/clip/vision_model_quantized.onnx', 'dino': 'models/dinov2-small/model.onnx'}
        config = {'models': models, 'model_sha256': {name: digest(ROOT / path) for name, path in models.items()},
                  'workers': args.workers, 'per_cell': args.per_cell, 'parity_only': args.parity_only}
        config['parity_reference'] = node_parity_reference(Path(args.p0))
        model_assets, config['model_chunks'] = model_packages(models)
        content = package(Path(args.p0), config)
        name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
        uri = 'gcs://' + name
        request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=300)
        del content
        model_uris = []
        for model_name, model_data in model_assets:
            request('/api/packages/gcs/' + model_name, method='PUT', data=model_data, timeout=300)
            model_uris.append('gcs://' + model_name)
        job = PREFIX + uuid.uuid4().hex[:12]
        proxy = setting('ECP_HTTP_PROXY', '')
        env = {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'CUDA_VISIBLE_DEVICES': '', 'ECP_RAY_WORKER': '1',
               'PROBE_PACKAGE_URI': uri, 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}
        runtime = {'working_dir': uri, 'py_modules': model_uris, 'env_vars': env}
        missing = []
        if not modules['onnxruntime']['available']:
            # Match the installed onnxruntime-node binding used by the Node
            # parity reference; quantized CLIP kernels changed across minors.
            missing.append('onnxruntime==1.24.3')
        if not modules['pyvips']['available']:
            missing.extend(['pyvips==3.2.0', 'pyvips-binary==8.18.7'])
        if missing:
            runtime['pip'] = list(dict.fromkeys(missing))
        body = {'submission_id': job,
                'entrypoint': 'timeout --signal=TERM --kill-after=20s %ds python -m ml.observe.probe_ray' % args.timeout,
                'entrypoint_num_cpus': args.workers * 2, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 12 * 1024 ** 3,
                'runtime_env': runtime}
        request('/api/jobs/', body)
        (output / 'job.json').write_text(json.dumps({'job': job, 'package': name,
                                                      'model_packages': [name for name, _ in model_assets],
                                                      'config': config}, indent=2) + '\n')
        state = wait(job)
        collect(job, output)
        if state.get('status') != 'SUCCEEDED':
            raise RuntimeError('Probe job failed; see the collected job.log')
    finally:
        if job:
            state = request('/api/jobs/' + checked_job(job))
            if state.get('status') not in TERMINAL:
                request('/api/jobs/' + job + '/stop', body={})
                wait(job)
        marker = LOCK / 'owner.json'
        try:
            if marker.exists() and json.loads(marker.read_text()).get('line') == 'w29-obs-probe':
                marker.unlink()
                LOCK.rmdir()
        except (FileNotFoundError, OSError, ValueError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    run_parser = sub.add_parser('run')
    run_parser.add_argument('--p0', default='data/cache/observe/p0')
    run_parser.add_argument('--output', default='data/cache/observe-probe')
    run_parser.add_argument('--workers', type=int, choices=range(1, 5), default=4)
    run_parser.add_argument('--per-cell', type=int, default=750)
    run_parser.add_argument('--timeout', type=int, default=7200)
    run_parser.add_argument('--parity-only', action='store_true', help='Run the five-image parity gate only')
    status_parser = sub.add_parser('status')
    status_parser.add_argument('job')
    collect_parser = sub.add_parser('collect')
    collect_parser.add_argument('job')
    collect_parser.add_argument('output')
    args = parser.parse_args()
    if args.action == 'run':
        if not 60 <= args.timeout <= 6 * 3600 or not 1 <= args.per_cell <= 750:
            parser.error('timeout must be 60..21600 seconds and per-cell must be 1..750')
        run(args)
    elif args.action == 'status':
        state = request('/api/jobs/' + checked_job(args.job))
        print(json.dumps({'job': args.job, 'status': state.get('status')}))
    else:
        collect(args.job, args.output)


if __name__ == '__main__':
    main()
