#!/usr/bin/env python3
"""CPU Ray text checks/extraction and explicitly selected, verified text exports.

No upload/package/ASR/video access. Only own job ledger is queried; <=2 jobs.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import worker_source, setting, merge_private_env
import os
import argparse
import base64
from contextlib import contextmanager
import fcntl
import gzip
import json
from pathlib import Path
import shlex
import sys
import time
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from submit import request
from transfer_rules import receive
from extract import CEPH, SOURCE, select

LOCAL = Path('/tmp/w4-mastercourses')


@contextmanager
def locked(name):
    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / name).open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def submit(source, stage, deps=None):
    with locked('ray-jobs.lock'):
        return _submit(source, stage, deps)


def _submit(source, stage, deps=None):
    LOCAL.mkdir(parents=True, exist_ok=True)
    ledger = LOCAL / 'ray-jobs.json'
    jobs = json.loads(ledger.read_text()) if ledger.exists() else []
    if sum(request(j)['status'] in ('RUNNING', 'PENDING') for j in jobs) >= 2:
        raise ValueError('two own jobs active')
    job = 'w4-mastercourses-' + stage + '-' + uuid.uuid4().hex[:12]
    code = base64.b64encode(gzip.compress(worker_source(source, required=('ECP_CEPH_ROOT',)).encode())).decode()
    body = {'submission_id': job, 'entrypoint': 'python -c ' + shlex.quote('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode(' + repr(code) + ')),"course-texts-ray","exec"))'),
            'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0,
            'runtime_env': {'env_vars': {'OMP_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}}}
    if deps:
        body['runtime_env']['pip'] = deps
        body['runtime_env']['env_vars'].update(HTTP_PROXY=setting('ECP_HTTP_PROXY', ''), HTTPS_PROXY=setting('ECP_HTTP_PROXY', ''))
    ledger.write_text(json.dumps(jobs + [job], indent=2))
    merge_private_env(body)
    print(json.dumps(request(body=body)))
    return job


def prefix(files):
    return 'import types\nextractor=types.ModuleType("extractor")\nexec(compile(' + repr(Path(__file__).with_name('extract.py').read_text()) + ',"extract.py","exec"),extractor.__dict__)\nroot=' + repr(CEPH) + '\nfiles=' + repr(files) + '\n'


def check_source(files, wait_seconds=0):
    return prefix(files) + 'wait_seconds=' + repr(wait_seconds) + '''
import time,json
start=time.monotonic()
while True:
 ready=[];missing=[]
 for f in files:
  try:extractor.audited(root,f);ready.append(f['bvid'])
  except ValueError:missing.append(f['bvid'])
 print('TEXT_READY '+json.dumps({'ready':len(ready),'total':len(files),'missing':missing}),flush=True)
 if not missing:print('TEXT_READY_DONE',flush=True);break
 if time.monotonic()-start+300>wait_seconds:break
 time.sleep(300)
'''


def export_source(ids=None, manifest_only=False):
    return '''from pathlib import Path
import base64,gzip,hashlib,json
root=Path(''' + repr(CEPH) + ''')/''' + repr(SOURCE) + '''/'text'
p=root/''' + repr(SOURCE + '-manifest.json') + '''
manifest=json.loads(p.read_text())
if not manifest.get('complete'):raise ValueError('incomplete extraction')
ids=''' + repr(ids or []) + '''
metadata={v['bvid']:v for v in manifest['videos']}
if len(set(ids))!=len(ids) or any(i not in metadata for i in ids):raise ValueError('unknown/duplicate IDs')
files=[(p.name,p.read_bytes())]
if not ''' + repr(manifest_only) + ''':
 for identity in ids:
  v=metadata[identity];p=(root/v['output']).resolve()
  if not p.is_relative_to(root.resolve()):raise ValueError('unsafe output')
  raw=p.read_bytes()
  if len(raw)!=v['output_size'] or hashlib.sha256(raw).hexdigest()!=v['output_sha256']:raise ValueError('output checksum')
  files.append((v['output'],raw))
for name,raw in files:
 chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for i,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def search_source(terms):
    """Concordance is a reading aid, never rule evidence without context review."""
    if not terms or any(not isinstance(t, str) or not t for t in terms):
        raise ValueError('nonempty search terms required')
    return export_source(manifest_only=True).replace("print('W2_TRANSFER_DONE',flush=True)", '') + 'terms=' + repr(terms) + """
selected=[]
for v in manifest['videos']:
 p=(root/v['output']).resolve()
 if not p.is_relative_to(root.resolve()):raise ValueError('unsafe output')
 raw=p.read_bytes()
 if len(raw)!=v['output_size'] or hashlib.sha256(raw).hexdigest()!=v['output_sha256']:raise ValueError('output checksum')
 data=json.loads(raw)
 rows=data.get('sentences',data.get('pages',[]))
 hit={i for i,row in enumerate(rows) if any(t.casefold() in row['text'].casefold() for t in terms)}
 context=sorted({j for i in hit for j in range(max(0,i-2),min(len(rows),i+3))})
 selected.append({'bvid':v['bvid'],'slug':v['slug'],'episode':v['episode'],'title':v['title'],'rows':[dict(rows[i],index=i,hit=i in hit) for i in context]})
raw=json.dumps(selected,ensure_ascii=False).encode();name='concordance.json'
chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
for i,chunk in enumerate(chunks):
 print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['check', 'watch', 'extract', 'export', 'search', 'receive', 'jobs', 'status'])
    p.add_argument('--id'); p.add_argument('--ids', nargs='*'); p.add_argument('--terms', nargs='+'); p.add_argument('--manifest-only', action='store_true')
    p.add_argument('--wait-seconds', type=int, default=3600)
    p.add_argument('--manifest', type=Path, default=Path(__file__).resolve().parents[1] / 'portrait_courses_manifest.json')
    a = p.parse_args()
    if a.action == 'jobs':
        for j in json.loads((LOCAL/'ray-jobs.json').read_text()):
            info=request(j);print(json.dumps({k: info.get(k) for k in ('submission_id', 'status', 'start_time', 'end_time')}))
        return
    if a.action in ('receive', 'status'):
        if not a.id or a.id not in json.loads((LOCAL/'ray-jobs.json').read_text()):p.error('own job ID required')
        info=request(a.id)
        if a.action=='status':
            value={k:info.get(k) for k in ('submission_id','status','message')}
            if '-watch-' in a.id or '-check-' in a.id:
                logs=request(a.id+'/logs')['logs']
                records=[json.loads(line[11:]) for line in logs.splitlines() if line.startswith('TEXT_READY ')]
                if records:value.update(ready=records[-1]['ready'],total=records[-1]['total'])
                value['readyComplete']='TEXT_READY_DONE' in logs.splitlines()
            print(json.dumps(value));return
        if info['status']!='SUCCEEDED':raise ValueError('export not successful')
        print('SHA256_VERIFIED_FILES',receive(request(a.id+'/logs')['logs'],LOCAL));return
    files=select(json.loads(a.manifest.read_text()))
    if a.action in ('check','watch'):
        with locked('readiness.lock'):
            stamp=LOCAL/'last-check.json'
            if stamp.exists():
                previous=json.loads(stamp.read_text())
                info=request(previous['id'])
                if info['status'] in ('RUNNING','PENDING'):
                    raise ValueError('readiness job already active')
                last=max(previous['time'],(info.get('end_time') or 0)/1000)
                if info.get('error_type') != 'JOB_ENTRYPOINT_COMMAND_START_ERROR' and time.time()-last<300:
                    raise ValueError('readiness probes must be >=300s apart')
            if a.wait_seconds<300:p.error('wait-seconds must be >=300')
            job=submit(check_source(files,a.wait_seconds if a.action=='watch' else 0),a.action)
            stamp.write_text(json.dumps({'time':time.time(),'id':job}))
    elif a.action=='extract':submit(prefix(files)+'extractor.extract(root,files)\n','extract',['pypdf==6.1.1'])
    elif a.action=='search':
        if not a.terms:p.error('search terms required')
        submit(search_source(a.terms),'search')
    else:
        if not a.ids and not a.manifest_only:p.error('explicit IDs or --manifest-only required')
        submit(export_source(a.ids,a.manifest_only),'export')

if __name__=='__main__':main()
