#!/usr/bin/env python3
"""Upload code-only working_dir, submit one CPU stress job, collect own reports."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[1]))
from ml.common.private_env import setting, require_path, dashboard_url, merge_private_env
import os
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request
import uuid
import zipfile

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
LOCAL = Path('/tmp/w6-ray')
ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w10-scale-stress-'


def request(path, body=None, method=None):
    if body and "entrypoint" in body:
        merge_private_env(body)
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=120) as response:
        return json.load(response)


def package(target):
    # Whitelist source only: no symlinked cache/models, node_modules or credentials.
    files = [p for base in ('src/core', 'src/server', 'src/rules') for p in (ROOT / base).rglob('*')
             if p.is_file() and not p.is_symlink() and p.suffix in ('.js', '.json')]
    files += [ROOT / 'scripts/stress.mjs', ROOT / 'scripts/stress-results.mjs', ROOT / 'scripts/stress-ray-worker.py', ROOT / 'ml/common/private_env.py']
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(ROOT))
        archive.writestr('package.json', json.dumps({'type': 'module', 'private': True,
            'dependencies': {'sharp': '0.33.5', 'exiftool-vendored.pl': '13.59.3', 'onnxruntime-node': '1.30.0'}}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['submit', 'status', 'collect', 'stop', 'audit'])
    parser.add_argument('--id')
    args = parser.parse_args()
    LOCAL.mkdir(exist_ok=True)
    if args.action == 'audit':
        own = [request('/api/jobs/' + file.name.removesuffix('-submission.json'))
               for file in sorted(LOCAL.glob(PREFIX + '*-submission.json'))]
        print(json.dumps([{k: r.get(k) for k in ('submission_id', 'status')} for r in own])); return
    if args.action == 'submit':
        require_path('ECP_CEPH_ROOT')
        jobs = request('/api/jobs/')
        own = [r for r in jobs if str(r.get('submission_id', '')).startswith(PREFIX)]
        active = [r for r in own if r['status'] in ('RUNNING', 'PENDING')]
        if active:
            raise RuntimeError('Own stress job is already active; no second submission')
        # Other photography lines use w*- IDs; never stop them or inspect their arguments.
        project_active = [r for r in jobs if r['status'] in ('RUNNING', 'PENDING')
                          and str(r.get('submission_id', '')).startswith(tuple('w' + str(i) + '-' for i in range(1, 11)))]
        if len(project_active) >= 2:
            raise RuntimeError('Two photography jobs active; wait before submitting')
        with tempfile.TemporaryDirectory(prefix='w6-package-') as folder:
            zipped = Path(folder) / 'code.zip'
            package(zipped)
            content = zipped.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
            name = '_ray_pkg_' + digest[:16] + '.zip'
            req = urllib.request.Request(dashboard_url() + '/api/packages/gcs/' + name, data=content, method='PUT')
            with OPENER.open(req, timeout=180) as response:
                response.read()
            job = PREFIX + uuid.uuid4().hex[:12]
            body = {'submission_id': job, 'entrypoint': 'timeout --signal=TERM --kill-after=15s 3600s python scripts/stress-ray-worker.py',
                    'entrypoint_num_cpus': 2, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 8 * 1024 ** 3,
                    'runtime_env': {'working_dir': 'gcs://' + name, 'env_vars': {
                        'ECP_CEPH_ROOT': require_path('ECP_CEPH_ROOT'), 'STRESS_JOB_ID': job, 'HTTP_PROXY': setting('ECP_HTTP_PROXY', ''),
                        'HTTPS_PROXY': setting('ECP_HTTP_PROXY', ''), 'NO_PROXY': 'localhost,127.0.0.1',
                        'CUDA_VISIBLE_DEVICES': '', 'OMP_NUM_THREADS': '2'}}}
            merge_private_env(body)
            result = request('/api/jobs/', body)
            (LOCAL / (job + '-submission.json')).write_text(json.dumps({'request': body, 'response': result,
                                                                       'packageSha256': digest}, indent=2))
            print(json.dumps(result)); return
    if not args.id or not args.id.startswith(PREFIX) or not args.id[len(PREFIX):].isalnum():
        parser.error('explicit own job id required')
    path = '/api/jobs/' + args.id
    if args.action == 'status':
        state = request(path)
        print(json.dumps({k: state.get(k) for k in ('submission_id', 'status', 'message', 'start_time', 'end_time')}))
    elif args.action == 'stop':
        print(json.dumps(request(path + '/stop', {}, 'POST')))
    else:
        logs = request(path + '/logs')['logs']
        (LOCAL / (args.id + '.log')).write_text(logs)
        reports = [json.loads(line.removeprefix('W6_RESULT ')) for line in logs.splitlines() if line.startswith('W6_RESULT ')]
        for report in reports:
            (LOCAL / (str(report['units']) + '.json')).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'job': args.id, 'reports': [r['units'] for r in reports], 'tail': [line for line in logs.splitlines() if not line.startswith('W6_RESULT ')][-10:]}))


if __name__ == '__main__':
    main()
