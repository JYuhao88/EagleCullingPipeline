#!/usr/bin/env python3
"""CPU-only genre text/QA export, gzip+base64 chunks verified by SHA-256.

Text mode exports critiques/topics and summary metadata, never image files.
QA mode exports only three explicitly selected HTML contact sheets.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, require_path, merge_private_env
import os
import argparse
import base64
import json
from pathlib import Path
import shlex
from submit import request
from transfer_rules import receive

CEPH = require_path('ECP_CEPH_ROOT') + '/references'


def export_source(source, qa_ids=None):
    if source not in ('wulin', 'wuxiaolong'):
        raise ValueError('unknown source')
    if qa_ids is not None and (source != 'wulin' or len(qa_ids) != 3):
        raise ValueError('QA requires exactly three wulin bvids')
    return '''import base64,gzip,hashlib,json
from pathlib import Path
root=Path(''' + repr(CEPH + '/' + source) + ''')
qa_ids=''' + repr(qa_ids) + '''
paths=[]
if qa_ids is not None:
 paths=[root/'qa'/(b+'.html') for b in qa_ids]
else:
 for directory in ''' + repr(['critiques'] if source == 'wulin' else ['topics']) + ''':
  paths.extend(sorted((root/directory).glob('*.jsonl')))
  paths.extend(sorted((root/directory).glob('*.json')))
 for name in ('pipeline-report.json','fetch-report.json','manifest.json','topics-report.json','asr/run-report.json','segments/run-report.json'):
  if (root/name).is_file(): paths.append(root/name)
 if root.name=='wulin':
  manifest=json.loads((root/'manifest.json').read_text())
  for video in manifest['videos']:
   info=json.loads((root/'raw'/video['bvid']/'info.json').read_text())
   video.update(title=info['title'],pubdate=info['pubdate'],duration=info['duration'],duration_seconds=info['duration'],page_count=len(info.get('pages',[])))
  manifest['publication_dates_missing']=0
  manifest['duration_seconds']=sum(v['duration'] for v in manifest['videos'])
  target=root/'manifest-enriched.json';target.write_text(json.dumps(manifest,ensure_ascii=False,indent=2));paths.append(target)
if not paths: raise ValueError('no export files')
for path in paths:
 raw=path.read_bytes();name=str(path.relative_to(root));chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for i,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['export','qa','receive'])
    p.add_argument('--source', choices=['wulin','wuxiaolong'], required=True)
    p.add_argument('--id', required=True)
    p.add_argument('--bvids', nargs=3)
    p.add_argument('--dest', type=Path)
    a = p.parse_args()
    dest = a.dest or Path('/tmp/w3-genres-data')/a.source
    if a.action == 'receive':
        print('SHA256_VERIFIED_FILES', receive(request(a.id+'/logs')['logs'],dest)); return
    if a.action == 'qa' and not a.bvids: p.error('QA needs --bvids (three IDs)')
    source = export_source(a.source, a.bvids if a.action == 'qa' else None)
    code = base64.b64encode(worker_source(source, required=('ECP_CEPH_ROOT',)).encode()).decode()
    body = {'submission_id':a.id, 'entrypoint':'python -c '+shlex.quote('import base64;exec(compile(base64.b64decode('+repr(code)+'),"genre-transfer","exec"))'),
            'entrypoint_num_cpus':1,'entrypoint_num_gpus':0}
    merge_private_env(body)
    print(json.dumps(request(body=body)))

if __name__ == '__main__': main()
