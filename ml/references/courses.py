#!/usr/bin/env python3
"""Course manifests, read-only Ray arrival probes and verified private exports.

No uploads or local media processing. A probe runs at most once per five minutes.
Use unique w4-courses-* IDs; at most two owned jobs, only one owned GPU job.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, require_path, merge_private_env
import os
import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import time
from submit import request
from transfer_rules import receive

CEPH = require_path('ECP_CEPH_ROOT') + '/references'
MEYEROWITZ = 'materials-courses-meyerowitz'
SOURCES = ('hanjing', 'liqiang', 'linhaiyin', MEYEROWITZ)
TITLES = {MEYEROWITZ:'Joel Meyerowitz — Masters of Photography', 'hanjing':'韩晶《拍照姿势教学》', 'liqiang':'李强《韩系灯光课》', 'linhaiyin':'林海音商业人像 / 第三期 / 第二季'}
HERE = Path(__file__).resolve().parent
DATA = Path('/tmp/w4-courses-data')
MEYEROWITZ_DATA = Path('/tmp/w4-meyerowitz-data')

def valid_data(path, source):
    root = MEYEROWITZ_DATA if source == MEYEROWITZ else DATA
    return path.resolve().is_relative_to(root.resolve())

def asr_env(source):
    return ['REF_ASR_BACKEND=whisper', 'REF_ASR_LANGUAGE=en', 'REF_ASR_MODEL=large-v3'] if source == MEYEROWITZ else []


def build(manifest, source):
    if source not in SOURCES:
        raise ValueError('unknown course source')
    videos=[]
    for item in manifest['files']:
        if item['source'] != source:
            continue
        rel=PurePosixPath(item['remote_rel'])
        if rel.is_absolute() or '..' in rel.parts:
            raise ValueError('unsafe remote path')
        name=rel.name
        # Keep the file index, since hanjing has duplicate lesson numbers.
        match=re.match(r'(\d+)', name)
        episode=int(match[1]) if match else name
        slug='joel-meyerowitz' if source == MEYEROWITZ else rel.parts[0]
        episode_id=source+'-'+hashlib.sha256(str(rel).encode()).hexdigest()[:12]
        if item['size'] <= 0 or not re.fullmatch('[a-f0-9]{64}',item['sha256']):
            raise ValueError('invalid size/hash')
        count_only=source=='linhaiyin' and bool(re.search('后期|修图|精修|营销|商业推广',name))
        videos.append({'bvid':episode_id,'episode_id':episode_id,'source':source,'course':slug,
                       'episode':episode,'title':name,'remote_rel':str(rel),
                       'source_path':CEPH+'/'+source+'/raw/'+str(rel),
                       'size':item['size'],'sha256':item['sha256'],
                       'duration_seconds':item.get('duration_seconds'),'count_only':count_only})
        if item.get('known_issue'):videos[-1]['known_issue']=item['known_issue']
    return {'schema_version':1,'source':source,'title':TITLES[source],
            'use':'purchased courses; internal reference only','videos':videos}


def submit_code(source, job_id):
    if not job_id.startswith('w4-courses-'):
        raise ValueError('owned job ID must start w4-courses-')
    jobs=request()
    owned=[j for j in jobs if str(j.get('submission_id','')).startswith('w4-courses-') and j['status'] in ('RUNNING','PENDING')]
    if len(owned)>=2:
        raise ValueError('two owned jobs already active')
    code=base64.b64encode(worker_source(source, required=('ECP_CEPH_ROOT',)).encode()).decode()
    return request(body=merge_private_env({'submission_id':job_id,'entrypoint':'python -c '+shlex.quote('import base64;exec(compile(base64.b64decode('+repr(code)+'),"course-job","exec"))'),'entrypoint_num_cpus':1,'entrypoint_num_gpus':0}))


def probe_code(manifests):
    return '''import json,hashlib
from pathlib import Path
videos='''+repr([v for m in manifests for v in m['videos']])+'''
for video in videos:
 path=Path(video['source_path'])
 size=path.stat().st_size if path.is_file() else None
 digest=None
 if size==video['size'] and path.suffix!='.part':
  h=hashlib.sha256()
  with path.open('rb') as stream:
   for chunk in iter(lambda:stream.read(8*1024*1024),b''):h.update(chunk)
  digest=h.hexdigest()
 print('COURSE_ARRIVAL '+json.dumps({'id':video['bvid'],'source':video['source'],'size':size,'sha256':digest,'ready':size==video['size'] and digest==video['sha256']},ensure_ascii=False),flush=True)
print('COURSE_PROBE_DONE',flush=True)
'''


def watch_code(manifests, seconds, source='hanjing', minimum=3):
    if seconds < 300 or seconds > 10800:
        raise ValueError('watch seconds must be 300..10800')
    if source not in SOURCES or minimum < 1:
        raise ValueError('invalid arrival threshold')
    # Each tick verifies atomic arrival, size and SHA-256 on Ray, never locally.
    return """import time,contextlib,io,json
deadline=time.monotonic()+"""+repr(seconds)+"""
probe="""+repr(probe_code(manifests))+"""
source="""+repr(source)+"""
minimum="""+repr(minimum)+"""
sources="""+repr(SOURCES)+"""
while time.monotonic()+300<=deadline:
 time.sleep(300)
 output=io.StringIO()
 with contextlib.redirect_stdout(output):exec(probe)
 rows=[json.loads(line.split(' ',1)[1]) for line in output.getvalue().splitlines() if line.startswith('COURSE_ARRIVAL ')]
 print('COURSE_WATCH '+json.dumps({'utc':time.time(),'ready':{s:sum(r['source']==s and r['ready'] for r in rows) for s in sources}}),flush=True)
 if sum(r['source']==source and r['ready'] for r in rows)>=minimum:
  print(output.getvalue(),end='',flush=True)
  break
else:
 print('COURSE_WATCH_TIMEOUT',flush=True)
"""


def export_code(source, qa=False, ids=None):
    if source not in SOURCES: raise ValueError('unknown source')
    return '''import base64,gzip,hashlib,json
from pathlib import Path
root=Path('''+repr(CEPH+'/'+source)+''')
qa='''+repr(qa)+'''
ids='''+repr(ids)+'''
paths=[]
if qa:
 if not ids:raise ValueError('explicit QA episode IDs required')
 for ident in ids:
  stats_path=root/'topics'/(ident+'.stats.json')
  if not stats_path.is_file():raise ValueError('requested QA episode incomplete')
  stats=json.loads(stats_path.read_text())
  artifacts=stats.get('qa_artifacts',[])
  if stats.get('error') or not artifacts:raise ValueError('requested QA episode incomplete')
  for artifact in artifacts:
   path=Path(artifact['path'])
   if path.parent!=root/'qa' or path.suffix not in ('.html','.jpg'):
    raise ValueError('unsafe QA artifact')
   if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=artifact['sha256']:
    raise ValueError('requested QA artifact incomplete or changed')
   paths.append(path)
for directory in ([] if qa else ['asr','topics']):
 for path in sorted((root/directory).glob('*')):
  if not path.is_file():continue
  if path.suffix not in ('.json','.jsonl'):continue
  if ids and not any(path.name.startswith(i+'.') or path.name.startswith(i+'-sheet-') for i in ids):continue
  paths.append(path)
if not paths: raise ValueError('no export files')
if sum(p.stat().st_size for p in paths)>300*1024*1024:raise ValueError('export exceeds 300 MB')
for path in paths:
 raw=path.read_bytes(); chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for index,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':path.relative_to(root).as_posix(),'index':index,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def refresh_durations(data, source):
    # Upload manifests may omit duration; only verified decoded ASR can fill it.
    for name in (source+'-manifest.json', source+'-arrived.json'):
        path = data/name
        if not path.is_file():continue
        manifest=json.loads(path.read_text())
        for video in manifest['videos']:
            stats_path=data/source/'asr'/(video['bvid']+'.stats.json')
            if not stats_path.is_file():continue
            stats=json.loads(stats_path.read_text())
            if not stats.get('error') and stats.get('source_sha256')==video['sha256']:
                video['duration_seconds']=stats['duration']
        path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['build','probe','watch','arrivals','asr','topics','export','qa','receive','status','jobs'])
    p.add_argument('--upload-manifest',type=Path,default=HERE/'portrait_courses_manifest.json')
    p.add_argument('--data',type=Path,default=DATA)
    p.add_argument('--source',choices=SOURCES)
    p.add_argument('--id')
    p.add_argument('--episodes',nargs='+',help='stable IDs from arrival manifest')
    p.add_argument('--pilot',action='store_true',help='first three arrived hanjing episodes')
    p.add_argument('--wait-seconds',type=int,default=10800)
    p.add_argument('--min-arrivals',type=int,default=3,help='watch exit threshold in selected source')
    a=p.parse_args()
    if a.source == MEYEROWITZ and a.data == DATA:a.data = MEYEROWITZ_DATA
    if not valid_data(a.data,a.source):p.error('--data must stay under the selected course private data root')
    sources = (a.source,) if a.source else SOURCES[:3]
    a.data.mkdir(parents=True,exist_ok=True)
    if a.action=='jobs':
        print(json.dumps([{k:j.get(k) for k in ('submission_id','status','start_time','end_time')} for j in request() if str(j.get('submission_id','')).startswith('w4-courses-')],indent=2));return
    if a.action=='build':
        if a.upload_manifest.exists():
            upload=json.loads(a.upload_manifest.read_text());manifests=[build(upload,s) for s in sources]
        else:
            manifests=[m for m in json.loads((HERE/'portrait_courses_processing_manifest.json').read_text())['courses'] if m['source'] in sources]
            if {m['source'] for m in manifests} != set(sources):raise ValueError('upload manifest required for new course')
        for m in manifests:
            s=m['source'];(a.data/(s+'-manifest.json')).write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
            print(s,len(m['videos']),sum(v.get('duration_seconds') or 0 for v in m['videos']))
        return
    if not a.id or not a.id.startswith('w4-courses-'):p.error('--id w4-courses-* required')
    if a.action=='status':
        job=request(a.id)
        print(json.dumps({k:job.get(k) for k in
                          ('submission_id','status','start_time','end_time','message','error_type')},
                         ensure_ascii=False,indent=2));return
    if a.action=='receive':
        if not a.source:p.error('--source required')
        dest=a.data/a.source
        if request(a.id)['status']!='SUCCEEDED':raise ValueError('export not succeeded')
        logs=request(a.id+'/logs')['logs'];incoming={}
        for line in logs.splitlines():
            if line.startswith('W2_CHUNK '):
                item=json.loads(line[9:]);target=(dest/item['path']).resolve()
                if not target.is_relative_to(dest.resolve()):raise ValueError('export path traversal')
                incoming[target]=item['size']
        budget_root = MEYEROWITZ_DATA if a.source == MEYEROWITZ else DATA
        current=sum(x.stat().st_size for x in budget_root.rglob('*') if x.is_file())
        growth=sum(size-(path.stat().st_size if path.is_file() else 0) for path,size in incoming.items())
        if current+growth>300*1024*1024:raise ValueError('local data budget exhausted')
        print('SHA256_VERIFIED_FILES',receive(logs,dest))
        refresh_durations(a.data,a.source);return
    if a.action in ('probe','watch'):
        stamp=a.data/'last-probe.json'
        if any(str(j.get('submission_id','')).startswith('w4-courses-') and '-watch-' in str(j.get('submission_id','')) and j['status'] in ('RUNNING','PENDING') for j in request()):
            raise ValueError('an owned watcher is already probing arrivals')
        if a.action=='probe' and stamp.exists() and time.time()-json.loads(stamp.read_text())['time']<300:raise ValueError('probe interval must be >=300 seconds')
        manifests=[json.loads((a.data/(s+'-manifest.json')).read_text()) for s in sources]
        result=submit_code(watch_code(manifests,a.wait_seconds,a.source or 'hanjing',a.min_arrivals) if a.action=='watch' else probe_code(manifests),a.id)
        stamp.write_text(json.dumps({'time':time.time(),'id':a.id}));print(result);return
    if a.action=='arrivals':
        if request(a.id)['status']!='SUCCEEDED':raise ValueError('probe not succeeded')
        logs=request(a.id+'/logs')['logs']
        if 'COURSE_PROBE_DONE' not in logs.splitlines():raise ValueError('incomplete probe')
        (a.data/'last-probe.json').write_text(json.dumps({'time':time.time(),'id':a.id}))
        arrivals=[json.loads(line.split(' ',1)[1]) for line in logs.splitlines() if line.startswith('COURSE_ARRIVAL ')]
        for s in sources:
            m=json.loads((a.data/(s+'-manifest.json')).read_text());ready={r['id'] for r in arrivals if r['ready'] and r['source']==s and any(v['bvid']==r['id'] and v['sha256']==r.get('sha256') and v['size']==r.get('size') for v in m['videos'])}
            m['videos']=[v for v in m['videos'] if v['bvid'] in ready];m['probe_id']=a.id
            (a.data/(s+'-arrived.json')).write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n');print(s,len(m['videos']))
        return
    if not a.source:p.error('--source required')
    pilot_path=a.data/(a.source+'-pilot.json')
    if a.action in ('export','qa'):
        ids=a.episodes
        if a.action=='qa':
            if a.pilot:ids=[v['bvid'] for v in json.loads(pilot_path.read_text())['videos']]
            if not ids or len(set(ids))!=3:p.error('QA requires --pilot or exactly three --episodes')
        print(submit_code(export_code(a.source,a.action=='qa',ids),a.id));return
    m=json.loads((pilot_path if a.pilot and pilot_path.exists() else a.data/(a.source+'-arrived.json')).read_text())
    m['videos']=[v for v in m['videos'] if not v['count_only'] and (not a.episodes or v['bvid'] in a.episodes)]
    if a.pilot:
        if a.source!='hanjing':p.error('pilot must be hanjing')
        m['videos']=m['videos'][:3]
        if len(m['videos'])!=3:raise ValueError('need three arrived pilot episodes')
        if a.action=='asr':pilot_path.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
    if not m['videos']:raise ValueError('no arrived selection')
    if a.action=='asr' and '-asr-' not in a.id:p.error('ASR job IDs must contain -asr- for GPU ownership tracking')
    jobs=request();owned=[j for j in jobs if str(j.get('submission_id','')).startswith('w4-courses-') and j['status'] in ('RUNNING','PENDING')]
    if len(owned)>=2 or (a.action=='asr' and any('-asr-' in j['submission_id'] for j in owned)):raise ValueError('owned resource cap')
    selected=a.data/(a.id+'-manifest.json');selected.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
    command=[sys.executable,str(HERE/'submit.py'),'asr' if a.action=='asr' else 'segment','--manifest',str(selected),'--id',a.id,'--env','REF_OUT='+CEPH+'/'+a.source,'--env','REF_SOURCE='+a.source,'--env','REF_LOG_TEXT=0']
    if a.action=='asr':
        for env in asr_env(a.source):command+=['--env',env]
    if a.action=='topics':command+=['--script',str(HERE/'course_topics_job.py')]
    subprocess.run(command,check=True)


if __name__=='__main__':main()
