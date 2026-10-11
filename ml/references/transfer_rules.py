#!/usr/bin/env python3
"""Submit CPU OCR / text export / selected-frame export; receive sha256-checked log chunks.
Uses only Jobs API; no cluster access to this computer. No GPU allocation.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, setting, require_path, merge_private_env
import os
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import shlex
from submit import request

ROOT=require_path('ECP_CEPH_ROOT') + '/references/yidao'


def receive(logs, destination):
    root=Path(destination).resolve(); root.mkdir(parents=True,exist_ok=True)
    files={}
    for line in logs.splitlines():
        if not line.startswith('W2_CHUNK '): continue
        item=json.loads(line[9:]); name=item['path']; target=(root/name).resolve()
        if not target.is_relative_to(root): raise ValueError('export path traversal')
        chunk=gzip.decompress(base64.b64decode(item['data']))
        if hashlib.sha256(chunk).hexdigest()!=item['chunk_sha256']: raise ValueError('chunk checksum')
        entry=files.setdefault(name,{'parts':{},'sha':item['sha256'],'size':item['size'],'count':item['count']})
        if (entry['sha']!=item['sha256'] or entry['size']!=item['size'] or entry['count']!=item['count']
                or item['index'] in entry['parts']): raise ValueError('duplicate/inconsistent chunk')
        entry['parts'][item['index']]=chunk
    if 'W2_TRANSFER_DONE' not in logs.splitlines(): raise ValueError('incomplete transfer')
    for name,entry in files.items():
        if set(entry['parts'])!=set(range(entry['count'])): raise ValueError('missing chunks')
        raw=b''.join(entry['parts'][i] for i in range(entry['count']))
        if len(raw)!=entry['size'] or hashlib.sha256(raw).hexdigest()!=entry['sha']: raise ValueError('file checksum')
        target=root/name; target.parent.mkdir(parents=True,exist_ok=True)
        part=target.with_suffix(target.suffix+'.part'); part.write_bytes(raw); part.replace(target)
    return len(files)


def export_source(frames=None):
    return '''import base64,gzip,hashlib,json,io
from pathlib import Path
root=Path('''+repr(ROOT)+''')
files=[]
frames='''+repr(frames)+'''
if frames is None:
 stats=[]
 for metadata in sorted((root/'critiques-v2').glob('*.ocr-meta.json')):
  value=json.loads(metadata.read_text())
  output=metadata.with_name(metadata.name.replace('.ocr-meta.json','.jsonl'))
  if hashlib.sha256(output.read_bytes()).hexdigest()!=value['output_sha256']:raise ValueError('OCR file checksum')
  stats.append(value['stats'])
 total=sum(s['segments'] for s in stats);tiered=sum(s['tiered'] for s in stats)
 coverage={'videos':stats,'successfulVideos':len(stats),'segments':total,'tiered':tiered,
           'coverage':tiered/total if total else 0,'frameErrors':sum(len(s['errors']) for s in stats)}
 (root/'critiques-v2'/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2))
 files=[(str(p.relative_to(root)),p.read_bytes()) for p in sorted((root/'critiques-v2').glob('*')) if p.suffix in ('.jsonl','.json')]
else:
 from PIL import Image
 for name in frames:
  path=(root/name).resolve()
  if not path.is_relative_to((root/'frames').resolve()):raise ValueError(name)
  with Image.open(path) as im:
   im.thumbnail((480,480)); stream=io.BytesIO();im.convert('RGB').save(stream,format='JPEG',quality=82)
  files.append((str(Path(name).relative_to('frames')),stream.getvalue()))
for name,raw in files:
 chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for i,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['ocr','export','frames','receive']);p.add_argument('--id',required=True)
    p.add_argument('--workers',type=int,choices=range(1,9),default=1);p.add_argument('--bvids');p.add_argument('--dest',default='/tmp/w2-rules-data');p.add_argument('--candidates',type=Path)
    a=p.parse_args()
    if a.action=='receive':
        print('SHA256_VERIFIED_FILES',receive(request(a.id+'/logs')['logs'],a.dest));return
    deps=[];env={'OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2'}
    if a.action=='ocr':
        source=Path(__file__).with_name('tier_ocr_job.py').read_text();deps=['rapidocr==3.10.0','onnxruntime==1.31.0','pillow']
        env['REF_WORKERS']=str(a.workers)
        if a.bvids:env['REF_BVIDS']=a.bvids
    else:
        frames=None
        if a.action=='frames':
            rules=json.loads(a.candidates.read_text())['rules']
            frames=sorted({e['frame'] for r in rules for e in r.get('representatives',r.get('evidence',[])[:4])[:4] if e.get('frame')})
            deps=['pillow']
        source=export_source(frames)
    proxy=setting('ECP_HTTP_PROXY', '')
    env.update({'HTTP_PROXY':proxy,'HTTPS_PROXY':proxy,'http_proxy':proxy,'https_proxy':proxy})
    code=base64.b64encode(worker_source(source, required=('ECP_CEPH_ROOT',)).encode()).decode()
    body={'submission_id':a.id,'entrypoint':'python -c '+shlex.quote('import base64;exec(compile(base64.b64decode('+repr(code)+'),"w2-job","exec"))'),'entrypoint_num_cpus':a.workers*2 if a.action=='ocr' else 1,'entrypoint_num_gpus':0,'runtime_env':{'env_vars':env}}
    if deps:body['runtime_env']['pip']=deps
    merge_private_env(body)
    print(json.dumps(request(body=body)))

if __name__=='__main__': main()
