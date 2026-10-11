#!/usr/bin/env python3
"""Submit own CPU Photo Triage probe / query it / receive checksummed log exports."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, setting, require_path, jobs_url, merge_private_env
import os
import argparse
import base64
import gzip
import hashlib
import json
import re
import shlex
import urllib.request
from pathlib import Path

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PREFIX = 'w2-bench-triage-'


def request(suffix='', body=None):
    if body and "entrypoint" in body:
        merge_private_env(body)
    req = urllib.request.Request(jobs_url() + suffix, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=60) as response:
        return json.load(response)


def receive(logs, destination):
    root = Path(destination).resolve()
    files = {}
    for line in logs.splitlines():
        if not line.startswith('W2_CHUNK '):
            continue
        item = json.loads(line[9:])
        name = item['path']
        if not (root / name).resolve().is_relative_to(root):
            raise ValueError('export path traversal')
        chunk = gzip.decompress(base64.b64decode(item['data'], validate=True))
        if hashlib.sha256(chunk).hexdigest() != item['chunk_sha256']:
            raise ValueError('chunk checksum')
        entry = files.setdefault(name, {'parts': {}, 'sha': item['sha256'], 'size': item['size'], 'count': item['count']})
        if (entry['sha'], entry['size'], entry['count']) != (item['sha256'], item['size'], item['count']) or item['index'] in entry['parts']:
            raise ValueError('inconsistent/duplicate chunk')
        entry['parts'][item['index']] = chunk
    if 'W2_TRANSFER_DONE' not in logs.splitlines():
        raise ValueError('incomplete transfer')
    validated = []
    for name, entry in files.items():
        if set(entry['parts']) != set(range(entry['count'])):
            raise ValueError('missing chunks')
        raw = b''.join(entry['parts'][i] for i in range(entry['count']))
        if len(raw) != entry['size'] or hashlib.sha256(raw).hexdigest() != entry['sha']:
            raise ValueError('file checksum')
        validated.append((name, raw))
    for name, raw in validated:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + '.part')
        temp.write_bytes(raw)
        temp.replace(target)
    return len(validated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['probe', 'status', 'logs', 'stop', 'receive'])
    parser.add_argument('--id', required=True)
    parser.add_argument('--dest', default='data/cache/bench/phototriage')
    args = parser.parse_args()
    if not re.fullmatch(PREFIX + r'[A-Za-z0-9_-]+', args.id):
        parser.error('Only this benchmark job prefix is allowed')
    if args.action != 'probe':
        suffix = '/logs' if args.action in ('logs', 'receive') else '/stop' if args.action == 'stop' else ''
        result = request(args.id + suffix, {} if args.action == 'stop' else None)
        if args.action == 'receive':
            print('SHA256_VERIFIED_FILES', receive(result['logs'], args.dest))
        elif args.action == 'logs':
            print(result['logs'])
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    require_path('ECP_CEPH_ROOT')
    source = worker_source(Path(__file__).with_name('phototriage_job.py').read_text(), required=('ECP_CEPH_ROOT',)).encode()
    encoded = base64.b64encode(source).decode()
    proxy = setting('ECP_HTTP_PROXY', '')
    env = {key: proxy for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']}
    env.update(OMP_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2', MKL_NUM_THREADS='2')
    command = 'import base64;exec(compile(base64.b64decode(' + repr(encoded) + '),"phototriage_job.py","exec"))'
    body = {'submission_id': args.id, 'entrypoint': 'python -c ' + shlex.quote(command),
            'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'runtime_env': {'env_vars': env}}
    merge_private_env(body)
    print(json.dumps(request(body=body)))


if __name__ == '__main__':
    main()
