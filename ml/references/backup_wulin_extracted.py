#!/usr/bin/env python3
"""Back up extracted JSON using one owned CPU Ray package, without uploader state."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, dashboard_url, merge_private_env
import os
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import tempfile
import time
import uuid
import zipfile

from upload_to_ceph import CEPH, HTTP, TERMINAL, digest, save

REMOTE = CEPH + '/wulin/extracted'
WORKER = r'''
import hashlib,json,os
from pathlib import Path
os.umask(0o077)
root=Path(config['remote'])
manifest=json.loads(Path('manifest.json').read_text())
print('BACKUP_START '+str(len(manifest)),flush=True)
verified=[]
for item in manifest:
 rel=Path(item['path'])
 if rel.is_absolute() or '..' in rel.parts or rel.suffix!='.json': raise ValueError('unsafe destination')
 target=root/rel
 if not target.resolve().is_relative_to(root.resolve()): raise ValueError('destination escape')
 data=(Path('payload')/rel).read_bytes()
 actual=hashlib.sha256(data).hexdigest()
 if actual!=item['sha256'] or len(data)!=item['size']: raise ValueError('package mismatch')
 if target.is_symlink(): raise ValueError('destination symlink')
 if target.exists():
  if target.read_bytes()!=data: raise ValueError('existing destination differs: '+str(rel))
 else:
  target.parent.mkdir(parents=True,exist_ok=True)
  part=target.with_name(target.name+'.'+config['token']+'.part')
  with part.open('xb') as handle:
   handle.write(data);handle.flush();os.fsync(handle.fileno())
  part.replace(target)
 if hashlib.sha256(target.read_bytes()).hexdigest()!=item['sha256']: raise ValueError('remote SHA mismatch')
 verified.append(item)
 if len(verified)%100==0: print('BACKUP_PROGRESS '+str(len(verified)),flush=True)
encoded=json.dumps(verified,sort_keys=True,separators=(',',':')).encode()
print('BACKUP_RESULT '+json.dumps({'files':len(verified),'bytes':sum(x['size'] for x in verified),'manifest_sha256':hashlib.sha256(encoded).hexdigest(),'remote':str(root)}),flush=True)
'''
CLEANUP = r'''
import ray,json
from ray.experimental.internal_kv import _internal_kv_del,_internal_kv_exists
from ray._private.ray_constants import KV_NAMESPACE_PACKAGE
ray.init(address='auto',logging_level='ERROR')
uri=config['uri'].encode()
_internal_kv_del(uri,namespace=KV_NAMESPACE_PACKAGE)
remaining=bool(_internal_kv_exists(uri,namespace=KV_NAMESPACE_PACKAGE))
if remaining: raise ValueError('owned package remains')
print('BACKUP_RESULT '+json.dumps({'uri':config['uri'],'exists_after':remaining}),flush=True)
'''


def manifest(root):
    root = Path(root)
    files = []
    for path in sorted(root.rglob('*.json')):
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('not a regular contained JSON: ' + str(path))
        files.append({'path': path.relative_to(root).as_posix(),
                      'size': path.stat().st_size, 'sha256': digest(path)})
    if not files:
        raise ValueError('no extracted JSON files')
    return files


def manifest_digest(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def build_package(root, path, files, token):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('worker.py', worker_source(WORKER, required=('ECP_CEPH_ROOT',)))
        archive.writestr('manifest.json', json.dumps(files))
        archive.writestr('owner.txt', token)
        for item in files:
            source = Path(root) / item['path']
            if digest(source) != item['sha256']:
                raise ValueError('source changed')
            archive.write(source, 'payload/' + item['path'])
    if Path(path).stat().st_size >= 90 * 1024 * 1024:
        raise ValueError('package exceeds small independent transfer limit')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/tmp/w3-genres-data/wulin/extracted'))
    parser.add_argument('--dashboard', default=None)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    files = manifest(args.source)
    token = uuid.uuid4().hex
    http = HTTP(args.dashboard or dashboard_url())
    state = {'token': token, 'remote': REMOTE, 'files': len(files),
             'bytes': sum(item['size'] for item in files), 'manifest_sha256': manifest_digest(files),
             'jobs': [], 'package_cleaned': False, 'status': 'running'}
    save(args.receipt, state)

    def run(code, config, uri=None):
        job = {'id': 'w4-wulin-backup-' + uuid.uuid4().hex, 'deleted': False}
        state['jobs'].append(job)
        save(args.receipt, state)
        source = worker_source('config=' + repr(config) + '\n' + code, required=('ECP_CEPH_ROOT',) if code == WORKER else ())
        if uri:
            command = 'config=' + repr(config) + ';exec(open("worker.py").read())'
        else:
            command = 'import base64;exec(base64.b64decode(' + repr(base64.b64encode(source.encode()).decode()) + '))'
        body = {'submission_id': job['id'], 'entrypoint': 'python -c ' + shlex.quote(command),
                'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0}
        if uri:
            body['runtime_env'] = {'working_dir': uri}
        merge_private_env(body)
        http.request('POST', '/api/jobs/', body)
        try:
            while True:
                info = http.request('GET', '/api/jobs/' + job['id'])
                if info['status'] in TERMINAL:
                    break
                time.sleep(2)
        except BaseException:
            # Only the job created here is stopped; finish it before cleanup jobs.
            http.request('POST', '/api/jobs/' + job['id'] + '/stop')
            while http.request('GET', '/api/jobs/' + job['id'])['status'] not in TERMINAL:
                time.sleep(2)
            http.request('DELETE', '/api/jobs/' + job['id'])
            job['deleted'] = True
            save(args.receipt, state)
            raise
        job['status'] = info['status']
        logs = http.request('GET', '/api/jobs/' + job['id'] + '/logs')['logs']
        http.request('DELETE', '/api/jobs/' + job['id'])
        job['deleted'] = True
        save(args.receipt, state)
        if info['status'] != 'SUCCEEDED':
            raise RuntimeError('owned job failed: ' + logs)
        results = [line.split('BACKUP_RESULT ', 1)[1] for line in logs.splitlines() if line.startswith('BACKUP_RESULT ')]
        if len(results) != 1:
            raise ValueError('missing backup result')
        return json.loads(results[0])

    try:
        with tempfile.TemporaryDirectory(prefix='w4-wulin-backup-') as temporary:
            package = Path(temporary) / 'extracted.zip'
            build_package(args.source, package, files, token)
            state['package_sha256'] = digest(package)
            package_name = '_ray_pkg_' + state['package_sha256'][:32] + '.zip'
            uri = 'gcs://' + package_name
            state['package_uri'] = uri
            save(args.receipt, state)
            http.upload(package, package_name)
            result = run(WORKER, {'remote': REMOTE, 'token': token}, uri)
            if result['manifest_sha256'] != state['manifest_sha256'] or result['files'] != len(files):
                raise ValueError('remote manifest SHA mismatch')
            state['verification'] = result
            state['status'] = 'verified'
    finally:
        # Cleanup only this invocation's URI and job IDs; never use /tmp/ceph-upload.
        if state.get('package_uri'):
            state['cleanup'] = run(CLEANUP, {'uri': state['package_uri']})
            state['package_cleaned'] = not state['cleanup']['exists_after']
        for _ in range(3):
            listed = http.request('GET', '/api/jobs/')
            owned = {job['id'] for job in state['jobs']}
            remaining = [job for job in listed if job.get('submission_id') in owned]
            for job in remaining:
                if job['status'] not in TERMINAL:
                    raise RuntimeError('owned job unexpectedly still running')
                http.request('DELETE', '/api/jobs/' + job['submission_id'])
            time.sleep(2)
        state['owned_jobs_remaining'] = [job['submission_id'] for job in http.request('GET', '/api/jobs/')
                                         if job.get('submission_id') in owned]
        if state['owned_jobs_remaining']:
            raise RuntimeError('owned job records remain')
        if state['status'] == 'verified':
            state['status'] = 'complete'
        save(args.receipt, state)
    print(json.dumps(state, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
