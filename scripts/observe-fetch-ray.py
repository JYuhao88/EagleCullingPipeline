#!/usr/bin/env python3
"""Bring the held-out Open Images face crops from Ceph to the local cache, byte for byte, for acceptance on the
runtime's Node features. The holdout is the fixed 10% of manifest ids with sha256('holdout|' + id) % 10 == 0.

submit                     one CPU job reads the Ceph manifest and prints each held-out face crop
collect <job id> <name>    write data/cache/observe/<name>/face/<id>.jpg and check SHA-256 against the job's digest
The crops are CC BY 2.0 Open Images views; attribution stays in the Ceph ATTRIBUTION.csv.
"""
import argparse
import base64
import hashlib
import json
import sys
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, setting  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PREFIX = 'w28-fetch-'
PROJECT_PREFIXES = tuple('w%d-' % n for n in range(1, 40))
IMAGE_ROOT = 'photography/eagle-culling/observe/openimages-v1'
REMOTE = r'''
import base64, hashlib, json, os, sys
from pathlib import Path
root = (Path(os.environ['ECP_CEPH_ROOT']) / sys.argv[1]).resolve()
count = 0
for line in (root / 'manifest.jsonl').read_text().splitlines():
    row = json.loads(line)
    if int(hashlib.sha256(('holdout|' + row['id']).encode()).hexdigest()[:8], 16) % 10:
        continue
    file = (root / row['face']).resolve()
    if root not in file.parents or file.suffix != '.jpg':
        raise SystemExit('face path outside image root')
    data = file.read_bytes()
    print('FX_ITEM ' + json.dumps({'id': row['id'], 'sha256': hashlib.sha256(data).hexdigest(),
                                   'jpeg': base64.b64encode(data).decode()}), flush=True)
    count += 1
print('FX_DONE ' + json.dumps({'items': count}), flush=True)
'''


def request(path, body=None):
    req = urllib.request.Request(dashboard_url() + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=120) as response:
        return json.loads(response.read() or b'null')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['submit', 'collect'])
    parser.add_argument('args', nargs='*')
    args = parser.parse_args()
    if args.action == 'submit':
        active = [job for job in request('/api/jobs/') if job.get('status') in ('PENDING', 'RUNNING')
                  and str(job.get('submission_id', '')).startswith(PROJECT_PREFIXES)]
        if len(active) >= 2:
            raise SystemExit('Two photography jobs active; wait before submitting')
        job = PREFIX + uuid.uuid4().hex[:12]
        code = REMOTE.replace("'", "'\\''")
        request('/api/jobs/', {'submission_id': job, 'entrypoint': "timeout 900s python -c '%s' %s" % (code, IMAGE_ROOT),
                               'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 1024 ** 3,
                               'runtime_env': {'env_vars': {'ECP_CEPH_ROOT': setting('ECP_CEPH_ROOT', required=True),
                                                            'CUDA_VISIBLE_DEVICES': ''}}})
        print(json.dumps({'job': job}))
        return
    job, name = args.args
    if not job.startswith(PREFIX) or not job[len(PREFIX):].isalnum() or not name.replace('-', '').isalnum():
        parser.error('explicit own job id and a plain observation name required')
    state = request('/api/jobs/' + job)
    logs = request('/api/jobs/' + job + '/logs')['logs'].splitlines()
    target = ROOT / 'data/cache/observe' / name / 'face'
    target.mkdir(parents=True, exist_ok=True)
    written = 0
    for line in logs:
        if not line.startswith('FX_ITEM '):
            continue
        row = json.loads(line.removeprefix('FX_ITEM '))
        data = base64.b64decode(row['jpeg'])
        if hashlib.sha256(data).hexdigest() != row['sha256'] or not row['id'].isalnum():
            raise SystemExit('Corrupt or unexpected item ' + row['id'][:32])
        (target / (row['id'] + '.jpg')).write_bytes(data)
        written += 1
    print(json.dumps({'job': job, 'status': state.get('status'), 'items': written,
                      'tail': [line for line in logs if not line.startswith('FX_ITEM ')][-3:]}))


if __name__ == '__main__':
    main()
