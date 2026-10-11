#!/usr/bin/env python3
"""CPU-only PDF arrival checks, OCR submission and selected chapter transfers.

No upload operations. Local receipts/raw text stay under /tmp/w4-pbooks.
Only jobs recorded by this runner count toward its concurrency limit (2).
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[3]))
from ml.common.private_env import worker_source, setting, require_path, merge_private_env
import os
import argparse
import base64
import json
from pathlib import Path
import shlex
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from submit import request
from transfer_rules import receive

CEPH = require_path('ECP_CEPH_ROOT') + '/references'
LOCAL = Path('/tmp/w4-pbooks')
SLUGS = ['posing', 'photographic-techniques-7', 'kelby-landscape',
         'kelby-natural-portrait', 'nyip-upper', 'nyip-lower', 'street-52']
NAMES = ['拍照姿势', '摄影技艺教程第7版', '斯科特 凯尔比的 风光摄影手册',
         '斯科特·凯尔比的自然光人像摄影手册', '美国纽约摄影学院摄影教材（上册）',
         '美国纽约摄影学院摄影教材（下册）', '街头摄影  52个任务清单']


def selection(manifest):
    files = json.loads(Path(manifest).read_text())['files']
    result = []
    for slug, name in zip(SLUGS, NAMES):
        found = [f for f in files if f.get('source') == 'photo-books' and Path(f['remote_rel']).name.startswith(name)]
        if len(found) != 1:
            raise ValueError('Expected one manifest entry for ' + name)
        f = found[0]
        p = Path(f['remote_rel'])
        if p.is_absolute() or '..' in p.parts or p.suffix.lower() != '.pdf':
            raise ValueError('Unsafe remote PDF path')
        result.append({k: f[k] for k in ('remote_rel', 'size', 'sha256', 'source')} | {'slug': slug})
    extra = [f for f in files if f.get('source') in ('photo-books', 'photo-books-extra') and '摄影必修课' in Path(f['remote_rel']).name]
    if len(extra) > 1: raise ValueError('Ambiguous extra book manifest entry')
    if extra:
        f = extra[0]; remote = Path(f['remote_rel'])
        if remote.is_absolute() or '..' in remote.parts or remote.suffix.lower() != '.pdf':
            raise ValueError('Unsafe extra PDF path')
        result.append({k: f[k] for k in ('remote_rel', 'size', 'sha256', 'source')} | {'slug':'photography-required-course'})
    return result


def submit(source, stage, deps=None, gpus=0):
    if gpus not in (0, 1): raise ValueError("GPU budget is at most one")
    LOCAL.mkdir(parents=True, exist_ok=True)
    ledger = LOCAL / 'ray-jobs.json'
    jobs = json.loads(ledger.read_text()) if ledger.exists() else []
    states = [(j, request(j)) for j in jobs]
    active = [j for j, info in states if info['status'] in ('RUNNING', 'PENDING')]
    if gpus and any(info['status'] in ('RUNNING', 'PENDING') and
                    (info.get('runtime_env') or {}).get('env_vars', {}).get('PBOOK_USE_CUDA') == '1'
                    for _, info in states):
        raise ValueError('One own GPU job already active')
    if len(active) >= 2:
        raise ValueError('Two own jobs already active: ' + ', '.join(active))
    job = 'w4-pbooks-' + stage + '-' + uuid.uuid4().hex[:12]
    code = base64.b64encode(worker_source(source, required=('ECP_CEPH_ROOT',)).encode()).decode()
    body = {'submission_id': job, 'entrypoint': 'python -c ' + shlex.quote(
        'import base64;exec(compile(base64.b64decode(' + repr(code) + '),"photo-books-ray","exec"))'),
        'entrypoint_num_cpus': 2, 'entrypoint_num_gpus': gpus}
    if deps:
        proxy = setting('ECP_HTTP_PROXY', '')
        body['runtime_env'] = {'pip': deps, 'env_vars': {'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy,
            'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2', 'PBOOK_USE_CUDA':str(gpus)}}
    # Record before submission, so an ambiguous HTTP response cannot orphan a job.
    ledger.write_text(json.dumps(jobs + [job], indent=2))
    merge_private_env(body)
    print(json.dumps(request(body=body)))
    return job


def check_source(files):
    return '''import json, hashlib\nfrom pathlib import Path\nroot=Path(''' + repr(CEPH) + ''')
files=''' + repr(files) + '''
for f in files:
 p=root/f['source']/'raw'/f['remote_rel']; r={'slug':f['slug'],'exists':p.is_file(),'ready':False}
 if p.is_file():
  r['size']=p.stat().st_size; h=hashlib.sha256()
  with p.open('rb') as s:
   for b in iter(lambda:s.read(8*1024*1024),b''): h.update(b)
  r['sha256']=h.hexdigest();r['ready']=r['size']==f['size'] and r['sha256']==f['sha256']
 print('PBOOK_READY '+json.dumps(r,ensure_ascii=False),flush=True)
for p in (root/'photo-books-extra'/'raw'/'photography-books').rglob('*摄影必修课*.pdf'):
 print('PBOOK_EXTRA '+json.dumps({'remote_rel':str(p.relative_to(root)),'size':p.stat().st_size},ensure_ascii=False),flush=True)
'''


def export_source(slug, chapters):
    if slug not in SLUGS + ['photography-required-course']:
        raise ValueError('Unknown slug')
    names = ['toc.json', 'quality.json'] + ['chapters/' + f'{n:02d}.txt' for n in chapters]
    return '''import base64,gzip,hashlib,json\nfrom pathlib import Path\nroot=Path(''' + repr(CEPH + '/photo-books/text/' + slug) + ''')
for name in ''' + repr(names) + ''':
 p=root/name
 if not p.is_file():
  if name=='quality.json':continue
  raise ValueError('Missing selected file: '+name)
 raw=p.read_bytes();chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for i,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def batch_source(files, slugs):
    if not slugs or len(set(slugs)) != len(slugs): raise ValueError('Unique nonempty slugs required')
    selected = [next((f for f in files if f['slug'] == slug), None) for slug in slugs]
    if any(f is None for f in selected): raise ValueError('Slug missing from manifest')
    module = Path(__file__).with_name('ocr_pdf_job.py').read_text()
    return "import base64,gzip,hashlib,json,re\nfrom pathlib import Path\n" + \
        "import types,sys\nmodule=types.ModuleType('pbooks_batch_module');sys.modules['pbooks_batch_module']=module;scope=module.__dict__\nexec(compile(" + repr(module) + ", 'ocr_pdf_job.py', 'exec'), scope)\n" + \
        "root=Path(" + repr(CEPH) + ")\nfiles=" + repr(selected) + "\n" + r"""
pattern = re.compile('构图|曝光|用光|光线|光影|人像|肖像|人物|选择|编辑|评|影调|景深|焦点|清晰|背景|线条|主体|色彩|瞬间|动感|平衡|画面|前景|形式|视觉|快门|眼睛|动作|姿态|姿势|表情|阴影|光斑|天空|地平线|取景|裁剪|景观|风景|反光|构成|造型|层次|精选|景深合成|锐化|高光|模糊|倒影|引导|分离|轮廓|对比|饱和|偏色|噪点|噪声|选片')
for f in files:
 source=root/f['source']/'raw'/f['remote_rel']
 if not source.is_file() or source.stat().st_size!=f['size'] or scope['_digest'](source)!=f['sha256']:
  raise ValueError('Final input failed SHA/size audit: '+f['slug'])
 dest,toc,quality=scope['extract_pdf'](source,f['slug'],root/'photo-books'/'text')
 chapters=[c for c in toc['chapters'] if c['number']<=2 or f['slug'] in ('posing','street-52') or pattern.search(c['title'])]
 print('PBOOK_COMPLETE '+json.dumps({'slug':f['slug'],'pages':toc['pages'],'chapters':len(toc['chapters']),
  'selected_chapters':[c['number'] for c in chapters],'ocr_pages':sum(q['ocr_used'] for q in quality),
  'empty_pages':[q['page'] for q in quality if q['empty']],
  'low_confidence_pages':[q['page'] for q in quality if q['confidence'] is not None and q['confidence']<.85]},ensure_ascii=False),flush=True)
 names=['toc.json','quality.json']+[c['file'] for c in chapters]
 for name in names:
  raw=(dest/name).read_bytes();chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
  for i,chunk in enumerate(chunks):
   print('W2_CHUNK '+json.dumps({'path':f['slug']+'/'+name,'index':i,'count':len(chunks),'size':len(raw),
    'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),
    'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
 print('W2_TRANSFER_DONE',flush=True)
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['check', 'ocr', 'export', 'receive', 'status', 'batch'])
    p.add_argument('--manifest')
    p.add_argument('--slug', choices=SLUGS + ['photography-required-course'])
    p.add_argument('--pages', help='Pilot page selection, e.g. 1-20')
    p.add_argument('--chapters', nargs='*', type=int, default=[])
    p.add_argument('--id')
    p.add_argument('--slugs', nargs='+')
    p.add_argument('--gpu', action='store_true', help='One GPU for batch OCR; CPU remains default')
    a = p.parse_args()
    LOCAL.mkdir(parents=True, exist_ok=True)
    if a.action == 'status':
        ledger = LOCAL / 'ray-jobs.json'
        for job in json.loads(ledger.read_text()) if ledger.exists() else []:
            v = request(job); print(json.dumps({k: v.get(k) for k in ('submission_id','status','driver_exit_code')}))
    elif a.action == 'receive':
        if not a.id: p.error('receive needs --id')
        print('SHA256_VERIFIED_FILES', receive(request(a.id + '/logs')['logs'], LOCAL / a.slug if a.slug else LOCAL))
    elif a.action == 'export':
        if not a.slug or any(n < 1 for n in a.chapters): p.error('export needs valid slug/chapter numbers')
        submit(export_source(a.slug, a.chapters), 'export')
    else:
        if not a.manifest: p.error('check/ocr needs --manifest (extra book needs an updated manifest with checksum)')
        files = selection(a.manifest)
        if a.action == 'batch':
            submit(batch_source(files, a.slugs), 'batch', ['pypdf==6.1.1','PyMuPDF==1.26.5','rapidocr==3.10.0', 'onnxruntime-gpu[cuda,cudnn]==1.23.2' if a.gpu else 'onnxruntime==1.31.0','numpy<3'], gpus=int(a.gpu))
        elif a.action == 'check':
            stamp = LOCAL / 'last-check.json'
            now = time.time()
            if stamp.exists() and now - json.loads(stamp.read_text())['time'] < 300:
                raise ValueError('Arrival polls must be at least five minutes apart')
            job = submit(check_source(files), 'check'); stamp.write_text(json.dumps({'time':now,'job':job}))
        else:
            found = [f for f in files if f['slug'] == a.slug]
            if not found: p.error('ocr needs a slug present in manifest')
            f = found[0]
            # The extraction job independently verifies the immutable final input.
            source = Path(__file__).with_name('ocr_pdf_job.py').read_text()
            args = [CEPH + '/' + f['source'] + '/raw/' + f['remote_rel'], '--slug', a.slug, '--output-dir', CEPH + '/photo-books/text']
            if a.pages: args += ['--pages', a.pages]
            remote = Path(f['remote_rel'])
            if remote.is_absolute() or '..' in remote.parts or remote.suffix != '.pdf':
                raise ValueError('Unsafe extra PDF path')
            prefix = '''import hashlib,sys\nfrom pathlib import Path\nf=''' + repr(f) + '''
p=Path(''' + repr(CEPH) + ''')/f['source']/'raw'/f['remote_rel']
if not p.is_file() or p.suffix!='.pdf' or p.stat().st_size!=f['size']:raise ValueError('Final PDF unavailable/size mismatch')
h=hashlib.sha256()
with p.open('rb') as s:
 for b in iter(lambda:s.read(8*1024*1024),b''):h.update(b)
if h.hexdigest()!=f['sha256']:raise ValueError('Final PDF SHA mismatch')
sys.argv=['ocr_pdf_job.py']+''' + repr(args) + '\n'
            submit(prefix + '\nexec(compile(' + repr(source) + ', \"ocr_pdf_job.py\", \"exec\"))', 'ocr', ['pypdf==6.1.1','PyMuPDF==1.26.5','rapidocr==3.10.0','onnxruntime==1.31.0','numpy<3'])


if __name__ == '__main__':
    main()
