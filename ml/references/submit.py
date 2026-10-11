#!/usr/bin/env python3
"""Submit self-contained reference jobs; query status/logs and download log exports."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import worker_source, setting, require_path, jobs_url, merge_private_env
import argparse
import base64
import json
import hashlib
import os
import shlex
from pathlib import Path
import urllib.request

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path='', body=None):
    if body and 'entrypoint' in body:
        merge_private_env(body)
    req = urllib.request.Request(jobs_url() + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(OPENER.open(req, timeout=60))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('stage', choices=['fetch', 'topics', 'asr', 'segment', 'align', 'verify', 'inspect', 'status', 'logs', 'list', 'stop'])
    p.add_argument('--id')
    p.add_argument('--manifest', type=Path)
    p.add_argument('--bvids', help='comma separated pilot subset')
    p.add_argument('--env', action='append', default=[])
    p.add_argument('--export-dir', type=Path)
    p.add_argument('--script', type=Path)
    p.add_argument('--tail', type=int, default=0, help='only print last N log lines')
    a = p.parse_args()
    if a.stage == 'list':
        print(json.dumps([{k:j.get(k) for k in ('submission_id','status','start_time')} for j in request() if j['status'] in ('RUNNING','PENDING') or str(j.get('submission_id','')).startswith('w1-refs-')], indent=2)); return
    if a.stage in ('status','logs','stop'):
        if not a.id: p.error('--id required')
        suffix = {'status':'','logs':'/logs','stop':'/stop'}[a.stage]
        result = request(a.id + suffix, {} if a.stage == 'stop' else None)
        if a.stage == 'logs':
            logs = result['logs']
            if a.export_dir:
                a.export_dir.mkdir(parents=True, exist_ok=True)
                chunks = {}
                for line in logs.splitlines():
                    if 'EXPORT {' in line:
                        item=json.loads(line.split('EXPORT ',1)[1]); name=item['path']; data=item['data']
                        target=a.export_dir / name
                        if not target.resolve().is_relative_to(a.export_dir.resolve()): raise ValueError(name)
                        chunks.setdefault(name,[]).append(data)
                for name, data in chunks.items():
                    target=a.export_dir / name; target.parent.mkdir(parents=True,exist_ok=True)
                    target.write_bytes(base64.b64decode(''.join(data))); print('SAVED',target)
            else: print('\n'.join(logs.splitlines()[-a.tail:]) if a.tail else logs)
        else:
            if a.stage=='status': result={k:result.get(k) for k in ('submission_id','status','message','start_time','end_time','driver_exit_code')}
            print(json.dumps(result,ensure_ascii=False,indent=2))
        return
    require_path('ECP_CEPH_ROOT')
    root=Path(__file__).resolve().parent
    manifest=json.loads((a.manifest or root/'yidao_portrait_critique_manifest.json').read_text())
    if a.bvids:
        selected=set(a.bvids.split(',')); manifest['videos']=[v for v in manifest['videos'] if v['bvid'] in selected]
        if len(manifest['videos']) != len(selected): p.error('unknown bvid')
    proxy=setting('ECP_HTTP_PROXY', '')
    env={'HTTP_PROXY':proxy,'HTTPS_PROXY':proxy,'http_proxy':proxy,'https_proxy':proxy,'NO_PROXY':os.environ.get('NO_PROXY', 'localhost,127.0.0.1'),'no_proxy':os.environ.get('NO_PROXY', 'localhost,127.0.0.1'),'HF_HOME':os.environ.get('HF_HOME', 'data/model-cache'),'REF_MANIFEST':json.dumps(manifest,ensure_ascii=False),'OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2'}
    env.update(dict(x.split('=',1) for x in a.env))
    script=a.script or root/('fetch_bilibili.py' if a.stage == 'fetch' else a.stage+'_job.py')
    source=worker_source(script.read_text(), required=('ECP_CEPH_ROOT',)).encode()
    env['REF_CODE_SHA256']=hashlib.sha256(source).hexdigest()
    code=base64.b64encode(source).decode()
    entry='python -c "import base64;exec(compile(base64.b64decode(\''+code+'\'),\''+script.name+'\',\'exec\'))"'
    pip={'fetch':[], 'topics':[], 'asr':['funasr==1.3.1','modelscope','imageio-ffmpeg','soundfile','torchaudio','torch','numpy>=2,<3','transformers<5'], 'segment':['imageio-ffmpeg','pillow','numpy','opencv-python-headless'], 'align':['pillow'], 'inspect':[], 'verify':[]}[a.stage]
    if a.stage=='asr' and env.get('REF_ASR_BACKEND')=='whisper':
        # CTranslate2 requires CUDA 12/cuDNN 9 even on CUDA 13 Ray hosts.
        pip=['faster-whisper','imageio-ffmpeg','soundfile','nvidia-cublas-cu12','nvidia-cudnn-cu12']
        inner='import base64;exec(compile(base64.b64decode('+repr(code)+'),'+repr(script.name)+',"exec"))'
        bootstrap=('import os,sys;from pathlib import Path;'
                   'libs=[str(Path(p)/"nvidia"/name/"lib") for p in sys.path for name in ("cublas","cudnn") if (Path(p)/"nvidia"/name/"lib").is_dir()];'
                   'os.environ["LD_LIBRARY_PATH"]=":".join(libs+[os.environ.get("LD_LIBRARY_PATH","")]);'
                   'os.execv(sys.executable,[sys.executable,"-c",'+repr(inner)+'])')
        entry='python -c '+shlex.quote(bootstrap)
    body={'entrypoint':entry,'entrypoint_num_cpus':(2 if a.stage=='asr' else 8 if a.stage=='verify' else 1),'entrypoint_num_gpus':1 if a.stage=='asr' else 0,'runtime_env':{'env_vars':env}}
    if pip: body['runtime_env']['pip']=pip
    if a.id: body['submission_id']=a.id
    merge_private_env(body)
    print(json.dumps(request(body=body)))

if __name__=='__main__': main()
