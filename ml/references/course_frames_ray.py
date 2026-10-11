#!/usr/bin/env python3
"""Own-ledger CPU jobs for posing-course QA; never upload sources or stop others.

Run inspect, fetch, decode, fetch, review locally, then export reviewed decisions.
All downloaded raw content is confined to /tmp/w4-frames-qa. Repository output
must be explicitly validated metadata with short paraphrases only.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, setting, merge_private_env
import os
import argparse
import base64
from contextlib import contextmanager
import fcntl
import gzip
import hashlib
import json
from pathlib import Path
import shlex
import time
import uuid
from course_frames import CEPH, COURSES, select_videos, safe_path
from submit import request

DATA = Path('/tmp/w4-frames-qa')
PREFIX = 'w4-frames-'


@contextmanager
def locked(name="ray-jobs.lock"):
    DATA.mkdir(parents=True,exist_ok=True)
    with (DATA/name).open('a') as h:
        fcntl.flock(h,fcntl.LOCK_EX)
        yield


def jobs():
    p=DATA/'ray-jobs.json'
    return json.loads(p.read_text()) if p.exists() else []


def own(identity):
    if not identity.startswith(PREFIX) or identity not in jobs():
        raise ValueError('own recorded job required')
    return identity


def submit(code, stage, deps=None):
    with locked():
        ledger=jobs()
        if sum(request(j)['status'] in ('RUNNING','PENDING') for j in ledger)>=2:
            raise ValueError('two own jobs active')
        identity=PREFIX+stage+'-'+uuid.uuid4().hex[:12]
        encoded=base64.b64encode(gzip.compress(worker_source(code, required=('ECP_CEPH_ROOT',)).encode())).decode()
        env={'env_vars':{'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}}
        if deps:
            env['pip']=deps
            env['env_vars'].update(HTTP_PROXY=setting('ECP_HTTP_PROXY', ''),HTTPS_PROXY=setting('ECP_HTTP_PROXY', ''))
        entry='python -c '+shlex.quote('import base64,gzip;exec(compile(gzip.decompress(base64.b64decode('+repr(encoded)+')),"course-frames-ray","exec"))')
        if len(entry.encode())>120000:raise ValueError('entrypoint too large; reduce selected metadata')
        (DATA/'ray-jobs.json').write_text(json.dumps(ledger+[identity],indent=2))
        result=request(body=merge_private_env({'submission_id':identity,'entrypoint':entry,'entrypoint_num_cpus':1,
                             'entrypoint_num_gpus':0,'runtime_env':env}))
        print(json.dumps(result));return identity


def prelude():
    return Path(__file__).with_name('course_frames.py').read_text()+'\n'


def probe_source(files, wait_seconds=0):
    if wait_seconds and wait_seconds<300:
        raise ValueError('poll interval must be >=300 seconds')
    return prelude()+'files='+repr(files)+'\nwait_seconds='+repr(wait_seconds)+'''
import time
remaining=files;ready=[];started=time.monotonic()
while True:
 missing=[]
 for v in remaining:
  try:audit(CEPH,v);ready.append(v['remote_rel'])
  except ValueError:missing.append(v)
 print('READINESS '+json.dumps({'ready':ready,'missing':[f['remote_rel'] for f in missing],'time':time.time()}),flush=True)
 if not missing:print('READY_DONE',flush=True);break
 remaining=missing
 if time.monotonic()-started+300>wait_seconds:break
 time.sleep(300)
'''


def text_source():
    return prelude()+'''
import base64,gzip
root=Path(CEPH)/'materials-course-texts/text'
m=json.loads((root/'materials-course-texts-manifest.json').read_text())
if not m.get('complete'):raise ValueError('incomplete text extraction')
rows=[]
for v in m['videos']:
 if v['slug'] not in COURSES.values() or v['format']!='srt':continue
 raw=safe_path(root,v['output']).read_bytes()
 if len(raw)!=v['output_size'] or hashlib.sha256(raw).hexdigest()!=v['output_sha256']:raise ValueError('text integrity')
 rows.append(dict(v,data=json.loads(raw)))
raw=json.dumps(rows,ensure_ascii=False).encode()
print('TEXT_BUNDLE '+base64.b64encode(gzip.compress(raw)).decode(),flush=True)
'''


def decode_source(selected, videos, fps=1):
    if not 1<=fps<=2:
        raise ValueError('fps must be 1–2')
    lookup={v['remote_rel']:v for v in videos}
    for w in selected:
        if w['slug'] not in COURSES.values() or w['video_remote_rel'] not in lookup:
            raise ValueError('unknown course/video')
        safe_path(DATA,w['id'])
    return prelude()+'selected='+repr(selected)+'\nvideos='+repr(lookup)+'\nfps='+repr(fps)+'''
import base64
root=Path(CEPH);out=root/'materials-courses/frames';results=[];verified={}
for w in selected:
 rel=w['video_remote_rel']
 if rel not in verified:verified[rel]=audit(root,videos[rel])
 dest=out/w['slug']/'w4-frames-20261011'/w['id']
 try:
  fs=decode_window(verified[rel],w,dest,fps)
  result=dict(w,frames=fs,output=str(dest.relative_to(out)))
  print('WINDOW '+json.dumps(result,ensure_ascii=False),flush=True)
  raw=(dest/'contact.jpg').read_bytes()
  print('CONTACT '+json.dumps({'id':w['id'],'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}),flush=True)
 except Exception as e:
  result=dict(w,error=str(e));print('WINDOW_ERROR '+json.dumps(result),flush=True)
 results.append(result)
(out/'w4-frames-20261011-windows.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print('DECODE_DONE',len(results),flush=True)
'''


def fetch(identity):
    own(identity);logs=request(identity+'/logs')['logs']
    (DATA/(identity+'.log')).write_text(logs)
    decoded=[];readiness=[];pairs=[]
    for line in logs.splitlines():
        if line.startswith('TEXT_BUNDLE '):
            raw=gzip.decompress(base64.b64decode(line[12:]));json.loads(raw)
            (DATA/'subtitles.json').write_bytes(raw)
        elif line.startswith('CONTACT '):
            row=json.loads(line[8:]);raw=base64.b64decode(row['data'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('contact checksum')
            target=safe_path(DATA/'contacts',row['id']+'.jpg');target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        elif line.startswith('PAIR_IMAGE '):
            row=json.loads(line[11:]);raw=base64.b64decode(row['data'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('pair image checksum')
            target=safe_path(DATA,row['path']);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        elif line.startswith('PAIR '):pairs.append(json.loads(line[5:]))
        elif line.startswith('WINDOW '):decoded.append(json.loads(line[7:]))
        elif line.startswith('READINESS '):readiness.append(json.loads(line[10:]))
    if pairs:(DATA/(identity+'-pairs.json')).write_text(json.dumps(pairs,ensure_ascii=False,indent=2))
    if decoded:(DATA/(identity+'-decoded.json')).write_text(json.dumps(decoded,ensure_ascii=False,indent=2))
    if readiness:(DATA/(identity+'-readiness.json')).write_text(json.dumps(readiness,ensure_ascii=False,indent=2))
    print(json.dumps({'id':identity,'status':request(identity)['status'],'windows':len(decoded),'probes':len(readiness)}))


def compact_export(decisions, decoded):
    by_id={w['id']:w for w in decoded};compact_decisions=[];compact_windows=[]
    for d in decisions:
        w=by_id[d['window_id']]
        indices=list(dict.fromkeys([d['a'],d['b']]))
        compact_windows.append(dict(w,frames=[w['frames'][i] for i in indices]))
        compact_decisions.append(dict(d,a=indices.index(d['a']),b=indices.index(d['b'])))
    return compact_decisions,compact_windows


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['inspect','watch','decode','export','fetch','jobs','stop'])
    p.add_argument('--id');p.add_argument('--manifest',type=Path,default=Path(__file__).with_name('portrait_courses_manifest.json'))
    p.add_argument('--windows',type=Path);p.add_argument('--decisions',type=Path);p.add_argument('--rules',type=Path);p.add_argument('--fps',type=float,default=1)
    p.add_argument('--wait-seconds',type=int,default=7200)
    a=p.parse_args()
    DATA.mkdir(parents=True,exist_ok=True)
    if a.action=='jobs':
        for j in jobs():
            v=request(own(j));print(json.dumps({k:v.get(k) for k in ('submission_id','status','start_time','end_time')}))
        return
    if a.action in ('fetch','stop'):
        if not a.id:p.error('--id required')
        if a.action=='fetch':fetch(a.id)
        else:print(json.dumps(request(own(a.id)+'/stop',{})))
        return
    videos=select_videos(json.loads(a.manifest.read_text()))
    if a.action in ('inspect','watch'):
        with locked('readiness.lock'):
            stamp=DATA/'last-readiness.json'
            if stamp.exists():
                previous=json.loads(stamp.read_text());state=request(own(previous['id']))
                last=max(previous['time'],(state.get('end_time') or 0)/1000)
                if state['status'] in ('RUNNING','PENDING') or time.time()-last<300:
                    raise ValueError('readiness probes must be >=300s apart; watcher must finish')
            code=probe_source(videos,a.wait_seconds if a.action=='watch' else 0)
            if a.action=='inspect':code=text_source()+code
            j=submit(code,a.action)
            stamp.write_text(json.dumps({'time':time.time(),'id':j}))
    elif a.action=='export':
        for path in (a.windows,a.decisions,a.rules):
            if not path or not path.resolve().is_relative_to(DATA.resolve()):p.error('export inputs must be in /tmp/w4-frames-qa')
        decisions=json.loads(a.decisions.read_text());decoded=json.loads(a.windows.read_text())
        compact_decisions,compact_decoded=compact_export(decisions,decoded)
        chosen={w['video_remote_rel'] for w in compact_decoded}
        code=prelude()+'\nexport_reviewed(CEPH,'+repr(compact_decisions)+','+repr(compact_decoded)+','+repr([v for v in videos if v['remote_rel'] in chosen])+','+repr(set(json.loads(a.rules.read_text())))+')\n'
        submit(code,'export',['imageio-ffmpeg','pillow'])
    else:
        if not a.windows or not a.windows.resolve().is_relative_to(DATA.resolve()):p.error('--windows must be in /tmp/w4-frames-qa')
        submit(decode_source(json.loads(a.windows.read_text()),videos,a.fps),'decode',['imageio-ffmpeg','pillow','numpy','opencv-python-headless'])

if __name__=='__main__':main()
