#!/usr/bin/env python3
"""Cold benchmark on one CPU Ray job; collect only verified analysis caches.

Infrastructure is resolved by private_env; assets are split into bounded Ray
packages. No previous analysis cache or private configuration is uploaded.
"""
import argparse
import base64
import gzip
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ml.common.private_env import dashboard_url, merge_private_env

PREFIX = 'w11-raybench-'
LOCAL = Path(tempfile.gettempdir()) / 'w11-raybench'
BASELINE = 'data/cache/bench/reports/2026-10-11T03-11-11-048Z/report.json'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BENCH_ENV = {'EAGLE_PYTHON': 'python_worker/.venv/bin/python',
             'EAGLE_POSE_PROVIDER': 'CPUExecutionProvider', 'EAGLE_SHARP_CONCURRENCY': '1'}
SIGNATURE_ENV = ('EAGLE_PYTHON', 'PYTHONPATH', 'EAGLE_POSE_MODE',
                 'EAGLE_POSE_PROVIDER', 'EAGLE_POSE_MODEL', 'EAGLE_POSE_DETECTOR')
MODELS = ('models/scorer/topiq_nr_512.onnx', 'models/scorer/topiq_nr_512.onnx.data',
          'models/mediapipe/face_landmarker.task',
          'models/pose/rtmw-dw-x-l_simcc-cocktail14_270e-256x192_20231122.onnx',
          'models/pose/yolox_m_8xb8-300e_humanart-c2c7a14a.onnx')


def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def env():
    result = dict(os.environ)
    for key in SIGNATURE_ENV:
        result.pop(key, None)
    result.update(BENCH_ENV)
    return result


def signature():
    command = ['node', '--input-type=module', '-e',
               "import {analysisSignature} from './scripts/bench.mjs'; console.log(await analysisSignature()); process.exit(0)"]
    return subprocess.check_output(command, cwd=ROOT, env=env(), text=True).strip()


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=180) as response:
        return json.load(response)


def upload(file):
    name = '_ray_pkg_' + digest(file)[:16] + '.zip'
    req = urllib.request.Request(dashboard_url() + '/api/packages/gcs/' + name,
                                 data=file.read_bytes(), method='PUT')
    with OPENER.open(req, timeout=180) as response:
        response.read()
    return 'gcs://' + name


def source_files():
    files = [p for base in ('src/core', 'src/rules', 'ml/bench')
             for p in (ROOT / base).rglob('*')
             if p.is_file() and p.suffix in ('.js', '.mjs', '.json')]
    files += [ROOT / name for name in ('scripts/bench.mjs', 'scripts/bench-ray.py',
              'python_worker/face_worker.py', 'python_worker/pose_worker.py', 'python_worker/pose_runtime.py',
              'ml/common/private_env.py', 'test/fixtures/bench-syn-manifest.json',
              'test/fixtures/bench-triage-manifest.json')]
    return files


def validate_cache(artifact, expected):
    if artifact['signature'] != expected['signature']:
        raise ValueError('Analysis signature mismatch; refusing collection')
    if artifact['models'] != expected['models'] or artifact['sources'] != expected['sources']:
        raise ValueError('Model/code SHA-256 mismatch; refusing collection')
    manifest = json.loads((ROOT / 'test/fixtures/bench-syn-manifest.json').read_text())
    keys = {hashlib.sha256((image['sha256'] + ':' + expected['signature']).encode()).hexdigest()
            for image in manifest['images']}
    if set(artifact['caches']) != keys:
        raise ValueError('Incomplete or unexpected cache keys')
    for key, raw in artifact['caches'].items():
        if hashlib.sha256(raw.encode()).hexdigest() != artifact['cacheSha256'][key]:
            raise ValueError('Cache checksum mismatch')
        row = json.loads(raw)
        if row['warnings'] or row['scorer']['model'] != 'topiq-nr-onnx' or row['metrics']['faces'] is None:
            raise ValueError('Unavailable model output; refusing collection')
        if 'signals' not in row:
            raise ValueError('Missing pose signals; refusing collection')
    return artifact['caches']


def submit(reuse=None):
    jobs = request('/api/jobs/')
    if any(str(j.get('submission_id', '')).startswith(PREFIX) and j['status'] in ('RUNNING', 'PENDING') for j in jobs):
        raise RuntimeError('Own job already active')
    files = source_files()
    manifest = json.loads((ROOT / 'test/fixtures/bench-syn-manifest.json').read_text())
    assets = [ROOT / f for f in MODELS]
    for image in manifest['images']:
        file = ROOT / 'data/cache/bench/syn' / image['path']
        if not file.resolve().is_relative_to((ROOT / 'data/cache/bench/syn').resolve()):
            raise ValueError('Unsafe image path')
        if digest(file) != image['sha256']:
            raise ValueError('Image checksum mismatch')
        assets.append(file)
    # Query the local interpreter, without loading or running any vision model.
    pins = json.loads(subprocess.check_output([str(ROOT / BENCH_ENV['EAGLE_PYTHON']), '-c',
        "import importlib.metadata as m,json; print(json.dumps({n:m.version(n) for n in ['mediapipe','numpy','Pillow','onnxruntime','rtmlib','opencv-contrib-python']}))"], text=True))
    expected = {'signature': signature(), 'models': {f: digest(ROOT / f) for f in MODELS},
                'sources': {str(f.relative_to(ROOT)): digest(f) for f in files}, 'python': pins,
                'node': subprocess.check_output(['node', '-p', 'process.version'], text=True).strip().lstrip('v'),
                'npm': json.loads(subprocess.check_output(['node', '-e',
                  "console.log(JSON.stringify(Object.fromEntries(['sharp','onnxruntime-node'].map(n=>[n,require(n+'/package.json').version]))))"], text=True))}
    job = PREFIX + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='bench-package-') as folder:
        folder = Path(folder)
        archive = folder / 'assets.tar'
        with tarfile.open(archive, 'w') as tar:
            for file in assets:
                tar.add(file, arcname=str(file.relative_to(ROOT)), recursive=False)
        modules = []
        if reuse:
            if not reuse.startswith(PREFIX) or not reuse[len(PREFIX):].isalnum():
                raise ValueError('Only own asset packages may be reused')
            previous = json.loads((LOCAL / (reuse + '.json')).read_text())
            state = request('/api/jobs/' + reuse)
            if state['status'] in ('RUNNING', 'PENDING') or digest(archive) != previous['assetSha256']:
                raise ValueError('Asset reuse requires terminal job and identical archive SHA-256')
            modules = state['runtime_env']['py_modules']
        with archive.open('rb') as stream:
            index = 0
            while chunk := stream.read(64 * 1024 ** 2):
                if reuse:
                    index += 1
                    continue
                module = 'bench_asset_' + str(index)
                zipped = folder / (module + '.zip')
                with zipfile.ZipFile(zipped, 'w', zipfile.ZIP_STORED) as z:
                    z.writestr(module + '/__init__.py', '')
                    z.writestr(module + '/chunk', chunk)
                modules.append(upload(zipped))
                print('uploaded asset chunk', index, flush=True)
                index += 1
        expected['assetChunks'] = index
        expected['assetSha256'] = digest(archive)
        code = folder / 'code.zip'
        with zipfile.ZipFile(code, 'w', zipfile.ZIP_DEFLATED) as z:
            for file in files:
                z.write(file, file.relative_to(ROOT))
            z.write(ROOT / BASELINE, BASELINE)
            z.writestr('bench-identity.json', json.dumps(expected))
            z.writestr('package.json', json.dumps({'type': 'module', 'private': True, 'dependencies': expected['npm']}))
        body = {'submission_id': job,
                'entrypoint': 'timeout --signal=TERM --kill-after=15s 7200s python scripts/bench-ray.py worker',
                'entrypoint_num_cpus': 2, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 8 * 1024 ** 3,
                'runtime_env': {'working_dir': upload(code), 'py_modules': modules,
                                'env_vars': {'CUDA_VISIBLE_DEVICES': '', 'OMP_NUM_THREADS': '2',
                                             'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}}}
        merge_private_env(body)
        result = request('/api/jobs/', body)
    (LOCAL / (job + '.json')).write_text(json.dumps(expected))
    print(json.dumps(result))


def worker():
    global ROOT
    os.nice(15)
    os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:2])
    with tempfile.TemporaryDirectory(prefix='bench-worker-') as temporary:
        tmp = Path(temporary)
        work = tmp / 'code'
        shutil.copytree(ROOT, work)
        identity = json.loads((work / 'bench-identity.json').read_text())
        archive = tmp / 'assets.tar'
        with archive.open('wb') as output:
            for i in range(identity['assetChunks']):
                module = importlib.import_module('bench_asset_' + str(i))
                with (Path(module.__file__).parent / 'chunk').open('rb') as source:
                    shutil.copyfileobj(source, output)
        if digest(archive) != identity['assetSha256']:
            raise ValueError('Asset archive checksum mismatch')
        with tarfile.open(archive) as tar:
            tar.extractall(work, filter='data')
        ROOT = work
        os.chdir(work)
        for group in ('sources', 'models'):
            if any(digest(work / f) != sha for f, sha in identity[group].items()):
                raise ValueError(group + ' checksum mismatch')
        version = identity['node']
        arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[os.uname().machine]
        name = 'node-v' + version + '-linux-' + arch
        base = 'https://nodejs.org/dist/v' + version + '/'
        node_tar = tmp / (name + '.tar.xz')
        urllib.request.urlretrieve(base + node_tar.name, node_tar)
        sums = urllib.request.urlopen(base + 'SHASUMS256.txt').read().decode()
        sha = next(line.split()[0] for line in sums.splitlines() if line.endswith(node_tar.name))
        if digest(node_tar) != sha:
            raise ValueError('Node checksum mismatch')
        with tarfile.open(node_tar) as tar:
            tar.extractall(tmp, filter='data')
        child_env = env()
        child_env.update(PATH=str(tmp / name / 'bin') + ':' + os.environ['PATH'],
                         ONNXRUNTIME_NODE_INSTALL='skip', NODE_OPTIONS='--max-old-space-size=2048')
        os.environ['PATH'] = child_env['PATH']
        subprocess.run(['npm', 'install', '--no-audit', '--no-fund'], env=child_env, check=True)
        subprocess.run([sys.executable, '-m', 'venv', BENCH_ENV['EAGLE_PYTHON'].removesuffix('/bin/python')], check=True)
        python = str(work / BENCH_ENV['EAGLE_PYTHON'])
        subprocess.run([python, '-m', 'pip', 'install', *[n + '==' + v for n, v in identity['python'].items()]], env=child_env, check=True)
        # Same OpenCV release/algorithms, without GUI linkage on the headless worker.
        subprocess.run([python, '-m', 'pip', 'uninstall', '-y', 'opencv-python', 'opencv-contrib-python'], env=child_env, check=True)
        subprocess.run([python, '-m', 'pip', 'install', '--no-deps',
                        'opencv-contrib-python-headless==' + identity['python']['opencv-contrib-python']], env=child_env, check=True)
        # MediaPipe also links EGL/GLES even when the inference delegate is CPU.
        # Extract public conda-forge runtime libraries into this job only.
        subprocess.run([python, '-m', 'pip', 'install', 'zstandard'], env=child_env, check=True)
        libraries = tmp / 'graphics-runtime'
        libraries.mkdir()
        extract = """import sys,zipfile,tarfile,zstandard
with zipfile.ZipFile(sys.argv[1]) as z:
 for name in z.namelist():
  if name.startswith('pkg-') and name.endswith('.tar.zst'):
   with z.open(name) as compressed, zstandard.ZstdDecompressor().stream_reader(compressed) as stream:
    with tarfile.open(fileobj=stream,mode='r|') as tar: tar.extractall(sys.argv[2],filter='data')
"""
        library_hashes = {}
        for package in ('libglvnd', 'libegl', 'libgles'):
            metadata = json.load(urllib.request.urlopen('https://api.anaconda.org/package/conda-forge/' + package))
            candidates = [f for f in metadata['files'] if f['basename'].startswith('linux-64/') and f['basename'].endswith('.conda')]
            selected = max(candidates, key=lambda f: f.get('upload_time', ''))
            target = tmp / Path(selected['basename']).name
            urllib.request.urlretrieve('https:' + selected['download_url'] if selected['download_url'].startswith('//') else selected['download_url'], target)
            expected_sha = selected.get('sha256') or selected.get('attrs', {}).get('sha256')
            if not expected_sha or digest(target) != expected_sha:
                raise ValueError('Graphics runtime checksum mismatch')
            library_hashes[package] = expected_sha
            subprocess.run([python, '-c', extract, str(target), str(libraries)], check=True)
        child_env['LD_LIBRARY_PATH'] = str(libraries / 'lib') + ':' + child_env.get('LD_LIBRARY_PATH', '')
        print('W11_RUNTIME_LIBRARIES ' + json.dumps(library_hashes), flush=True)
        if signature() != identity['signature']:
            raise ValueError('Worker signature mismatch')
        preflight = """import {detectFaces} from './src/core/faces.js';
import {detectPose} from './src/core/pose.js';
import {readFile} from 'node:fs/promises';
const m=JSON.parse(await readFile('test/fixtures/bench-syn-manifest.json'));
const filePath='data/cache/bench/syn/'+m.images[0].path;
const faces=await detectFaces([filePath]);
const poses=await detectPose([{id:'preflight',filePath,faces:faces[0].faceDetails}],{size:1});
console.log('W11_PREFLIGHT '+JSON.stringify({faceWarning:faces[0].warning,poseError:poses[0].error}));
process.exit(faces[0].warning||!poses[0].available?1:0);"""
        subprocess.run(['node', '--input-type=module', '-e', preflight], env=child_env, check=True)
        subprocess.run(['node', 'scripts/bench.mjs', '--compare', BASELINE], env=child_env, check=True)
        caches = {p.stem: p.read_text() for p in (work / 'data/cache/bench/analysis').glob('*.json')}
        artifact = {k: identity[k] for k in ('signature', 'models', 'sources')}
        artifact.update(caches=caches, cacheSha256={k: hashlib.sha256(v.encode()).hexdigest() for k,v in caches.items()})
        warnings = sorted({warning for raw in caches.values() for warning in json.loads(raw)['warnings']})
        print('W11_WARNINGS ' + json.dumps(warnings), flush=True)
        validate_cache(artifact, identity)
        data = base64.b64encode(gzip.compress(json.dumps(artifact).encode())).decode()
        # Bounded log records avoid dashboard line truncation.
        for i in range(0, len(data), 16000):
            print('W11_CACHE ' + data[i:i+16000], flush=True)
        print('W11_COMPLETE ' + hashlib.sha256(data.encode()).hexdigest(), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['submit','status','collect','stop','audit','worker'])
    parser.add_argument('--id')
    parser.add_argument('--reuse-assets', help='Reuse identical packages from an own terminal job')
    args = parser.parse_args()
    if args.action == 'worker':
        worker(); return
    LOCAL.mkdir(exist_ok=True)
    if args.action == 'submit':
        submit(args.reuse_assets); return
    if args.action == 'audit':
        print(json.dumps([{k:j.get(k) for k in ('submission_id','status')} for j in request('/api/jobs/')
                          if str(j.get('submission_id','')).startswith(PREFIX)])); return
    if not args.id or not args.id.startswith(PREFIX) or not args.id[len(PREFIX):].isalnum():
        parser.error('Explicit own job ID required')
    path = '/api/jobs/' + args.id
    if args.action == 'stop':
        print(json.dumps(request(path + '/stop', {}, 'POST'))); return
    state = request(path)
    print(json.dumps({k:state.get(k) for k in ('submission_id','status','start_time','end_time')}))
    if args.action == 'status':
        logs = request(path + '/logs')['logs']
        (LOCAL / (args.id + '.log')).write_text(logs)
        print('log lines:', len(logs.splitlines()))
        print('\n'.join(line for line in logs.splitlines()[-6:] if not line.startswith('W11_CACHE ')))
        return
    if state['status'] != 'SUCCEEDED':
        raise ValueError('Collection requires SUCCEEDED job')
    expected = json.loads((LOCAL / (args.id + '.json')).read_text())
    if signature() != expected['signature'] or any(digest(ROOT / f) != sha for f,sha in expected['sources'].items()):
        raise ValueError('Local code/signature changed since submission')
    if any(digest(ROOT / f) != sha for f,sha in expected['models'].items()):
        raise ValueError('Local models changed since submission')
    logs = request(path + '/logs')['logs']
    encoded = ''.join(line.removeprefix('W11_CACHE ') for line in logs.splitlines() if line.startswith('W11_CACHE '))
    complete = [line.removeprefix('W11_COMPLETE ') for line in logs.splitlines() if line.startswith('W11_COMPLETE ')]
    if complete != [hashlib.sha256(encoded.encode()).hexdigest()]:
        raise ValueError('Incomplete artifact transport')
    artifact = json.loads(gzip.decompress(base64.b64decode(encoded, validate=True)))
    caches = validate_cache(artifact, expected)
    directory = ROOT / 'data/cache/bench/analysis'
    directory.mkdir(parents=True, exist_ok=True)
    for key, raw in caches.items():
        temporary = directory / (key + '.tmp')
        temporary.write_text(raw)
        temporary.replace(directory / (key + '.json'))
    (LOCAL / (args.id + '-verified.json')).write_text(json.dumps({**expected, 'cacheCount':len(caches), 'cacheSha256':artifact['cacheSha256']}))
    print(json.dumps({'verifiedCaches':len(caches), 'signature':expected['signature']}))


if __name__ == '__main__':
    main()
