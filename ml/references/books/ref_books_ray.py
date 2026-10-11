#!/usr/bin/env python3
"""Reference-book Ray checks/extraction and explicit-page exports.

Adapted from w4-pbooks/ml/references/books/photo_books_ray.py (2026-10-10).
No uploads; full text stays on Ceph. Local transfers default to /tmp/w4-refbooks.
Only the own-job ledger is queried; at most two active jobs and one GPU.
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
import re
import shlex
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from submit import request
from transfer_rules import receive

CEPH = require_path('ECP_CEPH_ROOT') + '/references'
LOCAL = Path('/tmp/w4-refbooks')
BOOKS = {
 # The supplied filename is misleading: the actual title is Magnum Streetwise.
 'magnum-streetwise': 'Magnum Contact Sheets 此时此地 玛格南街头摄影经典.pdf',
 'decisive-moment': '49.布列松《决定性瞬间》.pdf',
 'hurn-jay': 'On-Being-a-Photographer_Hurn-Jay_3rd-ed.pdf',
 'why-focus-sample': 'Why-It-Does-Not-Have-To-Be-In-Focus_Prestel-sample.pdf',
 'posing-sample': 'Picture-Perfect-Posing_Pearson-sample.pdf',
 'photographers-eye-press': 'The-Photographers-Eye_1966_MOMA-press-release.pdf',
 'photographers-eye-excerpt': 'The-Photographers-Eye_Szarkowski-intro-excerpt.txt',
 'photographers-eye-zh': '摄影之眼.pdf',
}
BOOK_SOURCES = {'photographers-eye-zh': 'ref-books-extra'}
MATERIALS_BOOKS = {
 'adler-posing': 'books/02-姿势/Lindsay Adler/The Posing Series/Lindsay Adler - The Photographer’s Guide to POSING Techniques to Flatter Everyone.pdf',
 'adler-pitfalls': 'books/02-姿势/Lindsay Adler/The Posing Series/Posing-Pitfalls-Checklist-Lindsay-Adler-Photography.pdf',
 'adler-pocket': 'books/02-姿势/Lindsay Adler/The Posing Series/Posing-Pocket-Checklist-Lindsay-Adler.pdf',
 'adler-hands': 'books/02-姿势/Lindsay Adler/Posing Hands/Lindsay-Adler-Posing-Hands.pdf',
 'adler-couples': 'books/02-姿势/Lindsay Adler/Couples Posing Guide/Couples-Posing-Guide-Lindsay-Adler-Photography.pdf',
 'adler-teens': 'books/02-姿势/Lindsay Adler/Tweens Teens Seniors Posing Guide/Tweens-Teens-Seniors-Posing-Guide-Lindsay-Adler.pdf',
 'adler-50-poses': 'books/02-姿势/Lindsay Adler/50个美术摄影摆姿势实例的详细说明.pdf',
 'valenzuela-posing-zh': 'books/02-姿势/拍出绝世美姿 摄影师与模特的完美摆姿技巧解密.pdf',
 'valenzuela-practice-zh': 'books/03-综合技法/拍出绝世佳作 世界顶级摄影师私藏技法解密.pdf',
 'adler-boudoir': 'books/02-姿势/Lindsay Adler/Boudoir Posing Guide/Lindsay Adler - Boudoir Posing Guide.pdf',
}
BOOK_SOURCES.update({slug: 'materials-books' for slug in MATERIALS_BOOKS})
SLUGS = list(BOOKS) + list(MATERIALS_BOOKS)
OCR_SLUGS = {'magnum-streetwise', 'decisive-moment', 'photographers-eye-zh'} | set(MATERIALS_BOOKS)
DEPS = ['pypdf==6.1.1', 'PyMuPDF==1.26.5', 'rapidocr==3.10.0', 'onnxruntime==1.31.0', 'numpy<3']


def selection(manifest, slugs=None, collection='ref-books', audit=False):
    files = json.loads(Path(manifest).read_text())['files']
    if collection not in ('ref-books', 'materials-books'):
        raise ValueError('Unknown collection')
    chosen = list(slugs) if slugs is not None else list(MATERIALS_BOOKS if collection == 'materials-books' else BOOKS)
    if not chosen or len(set(chosen)) != len(chosen) or any(s not in SLUGS for s in chosen):
        raise ValueError('Unique valid slugs required')
    selected = []
    for slug in chosen:
        name = MATERIALS_BOOKS.get(slug) or 'reference-books/' + BOOKS[slug]
        source = BOOK_SOURCES.get(slug, 'ref-books')
        found = [f for f in files if f.get('source') == source and f['remote_rel'] == name]
        if len(found) != 1:
            raise ValueError('Expected one manifest entry for ' + name)
        selected.append(dict(found[0], slug=slug))
    if audit and collection == 'materials-books':
        # Include the EPUB and machine translations in the arrival audit only.
        selected_paths = {f['remote_rel'] for f in selected}
        for f in files:
            if f.get('source') == collection and f['remote_rel'] not in selected_paths:
                selected.append(dict(f, slug='materials-audit-' + f['sha256'][:12]))
        if len(selected) != 15:
            raise ValueError('Expected all 15 materials-books files')
    result = []
    for f in selected:
        rel = Path(f['remote_rel'])
        if rel.is_absolute() or '..' in rel.parts or (f['source'] == 'materials-books' and not f['remote_rel'].startswith('books/')):
            raise ValueError('Unsafe reference-book path')
        if type(f['size']) is not int or f['size'] <= 0 or not re.fullmatch('[0-9a-f]{64}', f['sha256']):
            raise ValueError('Invalid size/SHA256')
        result.append({k: f[k] for k in ('remote_rel', 'size', 'sha256', 'source', 'slug')})
    return result


def text_collection(slug):
    return 'materials-books' if slug in MATERIALS_BOOKS else 'reference-books'


def own_jobs():
    path = LOCAL / 'ray-jobs.json'
    return json.loads(path.read_text()) if path.exists() else []


def submit(source, stage, deps=None, gpus=0, cpus=2):
    if gpus not in (0, 1):
        raise ValueError('GPU budget is at most one')
    LOCAL.mkdir(parents=True, exist_ok=True)
    jobs = own_jobs()
    active = []
    for job in jobs:
        info = request(job)
        if info['status'] in ('RUNNING', 'PENDING'):
            active.append((job, info))
    if len(active) >= 2:
        raise ValueError('Two own jobs already active')
    gpu_path = LOCAL / 'gpu-jobs.json'
    gpu_jobs = json.loads(gpu_path.read_text()) if gpu_path.exists() else []
    if gpus and any(j in gpu_jobs or (i.get('entrypoint_num_gpus') or 0) > 0 or
                    (i.get('runtime_env') or {}).get('env_vars', {}).get('REFBOOK_USE_CUDA') == '1'
                    for j, i in active):
        raise ValueError('One own GPU job already active')
    job = ('w4-posebooks-' if LOCAL.name == 'w4-posebooks' else 'w4-refbooks-') + stage + '-' + uuid.uuid4().hex[:12]
    code = base64.b64encode(worker_source(source, required=('ECP_CEPH_ROOT',)).encode()).decode()
    body = {'submission_id': job, 'entrypoint': 'python -c ' + shlex.quote(
        'import base64;exec(compile(base64.b64decode(' + repr(code) + '),"ref-books-ray","exec"))'),
        'entrypoint_num_cpus': cpus, 'entrypoint_num_gpus': gpus,
        'runtime_env': {'env_vars': {'REFBOOK_USE_CUDA': str(gpus), 'OMP_NUM_THREADS': '2',
                                    'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}}}
    if deps:
        body['runtime_env']['pip'] = deps
        body['runtime_env']['env_vars'].update(HTTP_PROXY=setting('ECP_HTTP_PROXY', ''), HTTPS_PROXY=setting('ECP_HTTP_PROXY', ''))
    # Persist before HTTP: ambiguous responses never orphan an untracked job.
    (LOCAL / 'ray-jobs.json').write_text(json.dumps(jobs + [job], indent=2))
    if gpus:
        gpu_path.write_text(json.dumps(gpu_jobs + [job], indent=2))
    merge_private_env(body)
    print(json.dumps(request(body=body)))
    return job


def remote_prefix(files):
    return '''import json,hashlib\nfrom pathlib import Path\nroot=Path(''' + repr(CEPH) + ''')
files=''' + repr(files) + '''
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for chunk in iter(lambda:stream.read(8*1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def audited(f):
 p=root/f['source']/'raw'/f['remote_rel']
 if not p.is_file() or p.stat().st_size!=f['size'] or digest(p)!=f['sha256']:
  raise ValueError('Final file size/SHA mismatch: '+f['slug'])
 return p
'''


def check_source(files):
    return remote_prefix(files) + '''for f in files:
 p=root/f['source']/'raw'/f['remote_rel'];r={'slug':f['slug'],'exists':p.is_file(),'ready':False}
 if p.is_file():
  r.update(size=p.stat().st_size,sha256=digest(p))
  r['ready']=r['size']==f['size'] and r['sha256']==f['sha256']
 print('REFBOOK_READY '+json.dumps(r,ensure_ascii=False),flush=True)
'''


def load_module(filename, module_name):
    source = Path(__file__).with_name(filename).read_text()
    return ('import types,sys\n' + module_name + '=types.ModuleType(' + repr(module_name) + ');sys.modules[' +
            repr(module_name) + ']=' + module_name + '\nexec(compile(' + repr(source) + ',' + repr(filename) +
            ',"exec"),' + module_name + '.__dict__)\n')


def batch_source(files, slugs, pages=None, workers=1):
    if type(workers) is not int or not 1 <= workers <= 8:
        raise ValueError("OCR workers must be 1-8")
    if not slugs or len(set(slugs)) != len(slugs) or any(s not in SLUGS for s in slugs):
        raise ValueError('Unique valid slugs required')
    selected = [next(f for f in files if f['slug'] == s) for s in slugs]
    code = remote_prefix(selected) + load_module('extract_book.py', 'extractor') + load_module('ocr_ref_pdf_job.py', 'ocr')
    return code + 'ocr_slugs=' + repr(OCR_SLUGS) + '\npage_selection=' + repr(pages) + '\nworkers=' + repr(workers) + '''
for f in files:
 source=audited(f);text_root=root/('materials-books' if f['source']=='materials-books' else 'reference-books')/'text';dest=text_root/f['slug']
 if source.suffix=='.txt':
  text=source.read_text(encoding='utf-8');dest.mkdir(parents=True,exist_ok=True)
  (dest/'chapters').mkdir(exist_ok=True)
  (dest/'chapters'/'01.txt').write_text(text,encoding='utf-8')
  toc={'slug':f['slug'],'format':'excerpt','pages':1,'complete':True,'chapters':[{'number':1,'page':1,'file':'chapters/01.txt','title':'Intro excerpt'}]}
  quality=[{'page':1,'text_layer':True,'ocr_used':False,'chars':len(text),'empty':not bool(text.strip())}]
 elif f['slug'] in ocr_slugs:
  dest,toc,quality=ocr.extract_pdf(source,f['slug'],text_root,pages=page_selection,workers=workers,force_ocr=f['slug']=='magnum-streetwise',text_layer_first=f['source']=='materials-books')
 else:
  # Direct text-layer extraction; preserve every page, including sparse captions.
  dest,toc=extractor.extract_book(source,f['slug'],text_root)
  quality=[]
  for c in toc['chapters']:
   text=(dest/c['file']).read_text(encoding='utf-8').partition('\\n')[2].strip()
   quality.append({'page':c['page'],'text_layer':bool(text),'ocr_used':False,'chars':len(text),'empty':not bool(text)})
  toc.update(pages=len(quality),complete=True)
 toc['source_sha256']=f['sha256']
 (dest/'toc.json').write_text(json.dumps(toc,ensure_ascii=False,indent=2),encoding='utf-8')
 (dest/'quality.json').write_text(json.dumps({'complete':toc['complete'],'source_sha256':f['sha256'],'pages':quality},ensure_ascii=False,indent=2),encoding='utf-8')
 print('REFBOOK_COMPLETE '+json.dumps({'slug':f['slug'],'pages':toc['pages'],'complete':toc['complete'],'ocr_pages':sum(q['ocr_used'] for q in quality),'empty_pages':[q['page'] for q in quality if q['empty']]},ensure_ascii=False),flush=True)
'''


def page_numbers(value):
    from ocr_ref_pdf_job import _parse_pages
    return sorted(_parse_pages(value) or [])


def export_source(slug, pages):
    if slug not in SLUGS or not pages or any(type(p) is not int or p < 1 for p in pages):
        raise ValueError('Export requires a valid slug and explicit positive pages')
    return remote_prefix([]) + "dest=root/" + repr(text_collection(slug)) + "/'text'/" + repr(slug) + '\npages=' + repr(sorted(set(pages))) + '''
toc=json.loads((dest/'toc.json').read_text());quality=json.loads((dest/'quality.json').read_text())
if any(p>toc['pages'] for p in pages):raise ValueError('Page outside book')
outputs=[('toc.json',(dest/'toc.json').read_bytes()),('quality.json',(dest/'quality.json').read_bytes())]
for page in pages:
 cache=dest/'.pages'/f'{page:04d}.json'
 if cache.is_file():text=json.loads(cache.read_text())['text']
 else:
  chapter=next((c for c in toc['chapters'] if c.get('page')==page and 'pages' not in c),None)
  if chapter is None:raise ValueError('Requested page was not extracted')
  text=(dest/chapter['file']).read_text()
 outputs.append((f'pages/{page:04d}.txt',text.encode()))
''' + transfer_source()


def transfer_source():
    return '''import base64,gzip
for name,raw in outputs:
 chunks=[raw[i:i+16384] for i in range(0,len(raw),16384)] or [b'']
 for i,chunk in enumerate(chunks):
  print('W2_CHUNK '+json.dumps({'path':name,'index':i,'count':len(chunks),'size':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'chunk_sha256':hashlib.sha256(chunk).hexdigest(),'data':base64.b64encode(gzip.compress(chunk)).decode()}),flush=True)
print('W2_TRANSFER_DONE',flush=True)
'''


def image_source(files, slug, pages):
    if slug not in SLUGS or not pages or any(type(p) is not int or p<1 for p in pages):
        raise ValueError('Explicit valid image pages required')
    f = next(f for f in files if f['slug'] == slug)
    if not f['remote_rel'].endswith('.pdf'):raise ValueError('Images require PDF')
    return remote_prefix([f]) + 'pages=' + repr(sorted(set(pages))) + '''
import fitz
outputs=[]
with fitz.open(str(audited(files[0]))) as pdf:
 for page in pages:
  if page>len(pdf):raise ValueError('Page outside PDF')
  outputs.append((f'images/{page:04d}.png',pdf[page-1].get_pixmap(matrix=fitz.Matrix(1.5,1.5),alpha=False).tobytes('png')))
''' + transfer_source()


def main():
    global LOCAL
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['check','extract','batch','export','images','receive','status'])
    p.add_argument('--collection', choices=['ref-books','materials-books'], default='ref-books')
    p.add_argument('--manifest');p.add_argument('--slug',choices=SLUGS);p.add_argument('--slugs',nargs='+',choices=SLUGS)
    p.add_argument('--pages');p.add_argument('--id');p.add_argument('--gpu',action='store_true')
    p.add_argument('--workers',type=int,default=1,help='CPU OCR workers 1-8; GPU forces one')
    p.add_argument('--local-dir',default=str(LOCAL),help='Local own-job ledger and selected-page receive directory')
    a=p.parse_args();LOCAL=Path(a.local_dir).expanduser().resolve();LOCAL.mkdir(parents=True,exist_ok=True)
    if a.action=='status':
        for job in own_jobs():
            info=request(job);print(json.dumps({k:info.get(k) for k in ('submission_id','status','driver_exit_code')}))
    elif a.action=='receive':
        if a.id not in own_jobs():p.error('receive only accepts own ledger job IDs')
        if request(a.id)['status'] != 'SUCCEEDED':
            raise ValueError('Receive requires a successful completed job')
        print('SHA256_VERIFIED_FILES',receive(request(a.id+'/logs')['logs'],LOCAL/a.slug if a.slug else LOCAL))
    elif a.action=='export':
        if not a.slug or not a.pages:p.error('export needs --slug and explicit --pages')
        submit(export_source(a.slug,page_numbers(a.pages)),'export')
    else:
        if not a.manifest:p.error('action needs --manifest')
        files=selection(a.manifest, collection=a.collection, audit=a.action=='check')
        if a.action=='check':
            stamp=LOCAL/'last-check.json';now=time.time()
            if stamp.exists() and now-json.loads(stamp.read_text())['time']<300:raise ValueError('Arrival polls must be at least five minutes apart')
            job=submit(check_source(files),'check');stamp.write_text(json.dumps({'time':now,'job':job}))
        elif a.action=='images':
            if not a.slug or not a.pages:p.error('images needs explicit --slug and --pages')
            submit(image_source(files,a.slug,page_numbers(a.pages)),'images',['PyMuPDF==1.26.5'])
        else:
            slugs=a.slugs if a.action=='batch' else [a.slug]
            if not slugs or None in slugs:p.error('extract needs --slug; batch needs --slugs')
            deps=DEPS.copy()
            if a.gpu:deps[3]='onnxruntime-gpu[cuda,cudnn]==1.23.2'
            workers=1 if a.gpu else a.workers
            submit(batch_source(files,slugs,a.pages,workers),a.action,deps,int(a.gpu),cpus=max(2,workers*2))


if __name__=='__main__':main()
