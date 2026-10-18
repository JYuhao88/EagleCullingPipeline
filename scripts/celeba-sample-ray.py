#!/usr/bin/env python3
"""Sample CelebA test faces on Ray, balanced on Smiling x Mouth_Slightly_Open, for scoring teacher models.

submit [per cell]          one CPU job reads a public test shard through the cluster proxy
collect <job id> <file>    write {index, smile, mouth, jpeg(base64)} lines; the images are evaluation-only
CelebA is licensed for non-commercial research; samples stay in the local cache and never enter training.
"""
import argparse
import json
import sys
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, setting  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
PREFIX = 'w28-celeba-'
SHARD = ('https://huggingface.co/datasets/flwrlabs/celeba/resolve/main/'
         'img_align%2Bidentity%2Battr/test-00000-of-00003.parquet')
REMOTE = r'''
import base64, io, json, random, sys, urllib.request
import pyarrow.parquet as pq
from PIL import Image
per_cell, shard = int(sys.argv[1]), sys.argv[2]
urllib.request.urlretrieve(shard, '/tmp/celeba-test.parquet')
labels = pq.read_table('/tmp/celeba-test.parquet', columns=['Smiling', 'Mouth_Slightly_Open']).to_pylist()
order = list(range(len(labels)))
random.Random(20261016).shuffle(order)
cells, picked = {}, []
for i in order:
    key = (labels[i]['Smiling'], labels[i]['Mouth_Slightly_Open'])
    if cells.get(key, 0) < per_cell:
        cells[key] = cells.get(key, 0) + 1
        picked.append(i)
images = pq.read_table('/tmp/celeba-test.parquet', columns=['image']).take(sorted(picked)).to_pylist()
for i, row in zip(sorted(picked), images):
    buffer = io.BytesIO()
    face = Image.open(io.BytesIO(row['image']['bytes'])).convert('RGB')
    side = min(face.size)
    top = (face.size[1] - side) // 2
    face.crop((0, top, side, top + side)).resize((384, 384), Image.LANCZOS).save(buffer, 'JPEG', quality=90)
    print('CB_ITEM ' + json.dumps({'index': i, 'smile': labels[i]['Smiling'], 'mouth': labels[i]['Mouth_Slightly_Open'],
                                   'jpeg': base64.b64encode(buffer.getvalue()).decode()}), flush=True)
print('CB_DONE ' + json.dumps({'rows': len(labels), 'picked': len(picked)}), flush=True)
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
        per_cell = int(args.args[0]) if args.args else 100
        proxy = setting('ECP_HTTP_PROXY', '')
        job = PREFIX + uuid.uuid4().hex[:12]
        code = REMOTE.replace("'", "'\\''")
        request('/api/jobs/', {'submission_id': job,
                               'entrypoint': "timeout 1800s python -c '%s' %d '%s'" % (code, per_cell, SHARD),
                               'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 4 * 1024 ** 3,
                               'runtime_env': {'env_vars': {'HTTPS_PROXY': proxy, 'HTTP_PROXY': proxy,
                                                            'CUDA_VISIBLE_DEVICES': ''}}})
        print(json.dumps({'job': job}))
        return
    job, target = args.args
    if not job.startswith(PREFIX) or not job[len(PREFIX):].isalnum():
        parser.error('explicit own job id required')
    state = request('/api/jobs/' + job)
    logs = request('/api/jobs/' + job + '/logs')['logs'].splitlines()
    rows = [line.removeprefix('CB_ITEM ') for line in logs if line.startswith('CB_ITEM ')]
    Path(target).write_text(''.join(row + '\n' for row in rows))
    print(json.dumps({'job': job, 'status': state.get('status'), 'items': len(rows),
                      'tail': [line for line in logs if not line.startswith('CB_ITEM ')][-5:]}))


if __name__ == '__main__':
    main()
