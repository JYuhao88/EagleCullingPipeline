#!/usr/bin/env python3
"""Run prepared AIHub requests on Ray, for hosts whose local network may not reach AIHub.

submit <work dir>  package requests.jsonl, the worker and the key file; submit one CPU-only job
status <job id>    job state
collect <job id> <work dir>  write results.jsonl from the job's result lines
The key is read from ECP_AIHUB_URL / ECP_AIHUB_KEY at submit time and travels only inside the package.
"""
import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, setting  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w28-aihub-'
PROJECT_PREFIXES = tuple('w' + str(i) + '-' for i in range(1, 40))


def request(path, body=None, method=None, data=None, timeout=120):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=timeout) as response:
        text = response.read()
        return json.loads(text) if text else None


def package(work):
    url, key = os.environ.get('ECP_AIHUB_URL'), os.environ.get('ECP_AIHUB_KEY')
    if not url or not key:
        raise SystemExit('Missing AIHub environment')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(ROOT / 'scripts/aihub-ray-worker.py', 'worker.py')
        archive.write(work / 'requests.jsonl', 'requests.jsonl')
        if (work / 'config.json').exists():
            archive.write(work / 'config.json', 'config.json')
        for image in sorted((work / 'images').glob('*.jpg')):
            archive.write(image, 'images/' + image.name, compress_type=zipfile.ZIP_STORED)
        archive.writestr('secret.json', json.dumps({'url': url, 'key': key}))
    return buffer.getvalue()


def job_environment(config):
    proxy = setting('ECP_HTTP_PROXY', '')
    values = {'HTTPS_PROXY': proxy, 'HTTP_PROXY': proxy, 'NO_PROXY': 'localhost,127.0.0.1',
              'CUDA_VISIBLE_DEVICES': '', 'ECP_RAY_WORKER': '1'}
    if 'imageRoot' in config:
        root = setting('ECP_CEPH_ROOT', required=True)
        if not Path(root).is_absolute():
            raise ValueError('ECP_CEPH_ROOT must be an absolute path when imageRoot is set')
        values['ECP_CEPH_ROOT'] = root
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['submit', 'status', 'collect'])
    parser.add_argument('target')
    parser.add_argument('work', nargs='?')
    args = parser.parse_args()
    if args.action == 'submit':
        work = Path(args.target)
        active = [job for job in request('/api/jobs/') if job['status'] in ('RUNNING', 'PENDING')
                  and str(job.get('submission_id', '')).startswith(PROJECT_PREFIXES)]
        if len(active) >= 2:
            raise SystemExit('Two photography jobs active; wait before submitting')
        config = json.loads((work / 'config.json').read_text()) if (work / 'config.json').exists() else {}
        environment = job_environment(config)
        content = package(work)
        name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
        request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=180)
        job = PREFIX + uuid.uuid4().hex[:12]
        seconds = int(min(6 * 3600, max(60, config.get('timeoutSeconds', 1800))))
        entry = 'timeout --signal=TERM --kill-after=15s %ds python worker.py' % seconds
        body = {'submission_id': job, 'entrypoint': entry,
                'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 1024 ** 3,
                'runtime_env': {'working_dir': 'gcs://' + name, 'env_vars': environment}}
        result = request('/api/jobs/', body)
        (work / 'job.json').write_text(json.dumps({'job': job, 'package': name, 'response': result}, indent=2))
        print(json.dumps({'job': job}))
        return
    if not args.target.startswith(PREFIX) or not args.target[len(PREFIX):].isalnum():
        parser.error('explicit own job id required')
    state = request('/api/jobs/' + args.target)
    if args.action == 'status':
        print(json.dumps({k: state.get(k) for k in ('submission_id', 'status', 'message')}))
        return
    logs = request('/api/jobs/' + args.target + '/logs')['logs']
    rows = [line.removeprefix('MN_RESULT ') for line in logs.splitlines() if line.startswith('MN_RESULT ')]
    Path(args.work, 'results.jsonl').write_text(''.join(row + '\n' for row in rows))
    print(json.dumps({'job': args.target, 'status': state.get('status'), 'results': len(rows),
                      'tail': [line for line in logs.splitlines() if not line.startswith('MN_RESULT ')][-5:]}))


if __name__ == '__main__':
    main()
