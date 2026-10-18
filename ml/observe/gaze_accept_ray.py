"""Bounded exact-Node acceptance on public native inputs and cached private runtime crops."""
import concurrent.futures
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

from ml.observe.embed_ray import ceph_image_path
from ml.observe.probe_ray import digest, export, materialize_models, report

NODE = '22.23.3'


def install_native_dependencies(env):
    env = dict(env)
    registry = env.pop('ECP_NPM_REGISTRY', '') or env.get('npm_config_registry', '')
    if registry:
        env['npm_config_registry'] = registry
    else:
        env.pop('npm_config_registry', None)
    attempts = [env]
    proxy_keys = {'http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy'}
    if registry:
        direct = {key: value for key, value in env.items() if key.lower() not in proxy_keys}
        direct.update(npm_config_proxy='', npm_config_https_proxy='')
        attempts = [direct] + ([env] if any(env.get(key) for key in env if key.lower() in proxy_keys) else [])
    command = ['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts',
               '--prefer-offline', '--fetch-retries=1', '--fetch-timeout=120000']
    for index, attempt in enumerate(attempts):
        report({'stage': 'npm-install', 'privateCache': True, 'scripts': False,
                'configuredMirror': bool(registry), 'route': 'direct' if registry and index == 0 else 'configured-proxy'})
        try:
            subprocess.run(command, check=True, env=attempt, timeout=600, capture_output=True, text=True)
            env = attempt
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            report({'stage': 'npm-install-failed', 'attempt': index + 1})
            if index + 1 == len(attempts):
                raise RuntimeError('npm dependency install failed; private npm output withheld') from None
    try:
        subprocess.run(['node', '--input-type=module', '-e',
                        "import sharp from 'sharp'; import ort from 'onnxruntime-node'; "
                        "if (!sharp.versions.vips || !ort.InferenceSession) throw Error('native dependencies unavailable')"],
                       check=True, env=env, timeout=60, capture_output=True, text=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        output = (getattr(error, 'stderr', '') or '')
        if isinstance(output, bytes):
            output = output.decode(errors='replace')
        packages = [name for name in ('sharp', 'onnxruntime-node') if name in output]
        binaries = [name for name in ('onnxruntime_binding.node', 'libonnxruntime.so.1', 'libvips-cpp.so.42',
                                      'libstdc++.so.6', 'libc.so.6') if name in output]
        detail = ', '.join(packages + binaries) or 'sharp / onnxruntime-node'
        raise RuntimeError('Node native dependencies preflight failed: ' + detail +
                           '; install scripts remain disabled; no automatic binary download') from None
    report({'stage': 'native-dependencies-verified'})
    return env


def node_runtime(folder):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
    name = f'node-v{NODE}-linux-{arch}'
    base = f'https://nodejs.org/dist/v{NODE}/'
    cache = Path('inputs/node-dist').resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / (name + '.tar.xz')
    checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.endswith(archive.name))
    if not archive.is_file() or digest(archive) != expected:
        report({'stage': 'node-download', 'version': NODE})
        with urllib.request.urlopen(base + archive.name, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
    if digest(archive) != expected:
        raise ValueError('Node checksum mismatch')
    with tarfile.open(archive) as source:
        source.extractall(folder, filter='data')
    return folder / name / 'bin', expected


def public_source(row):
    # The sampler records a checksum of the unmodified public mirror image. Never use personal originals here.
    image_id = row['id'].removeprefix('openimages-')
    record = ceph_image_path('face/' + image_id + '.jpg').parents[1] / 'records' / (image_id + '.json')
    saved = json.loads(record.read_text())
    if saved['faceBox'] != row['box']:
        raise ValueError('Public face annotation changed')
    target = Path('inputs/public') / (image_id + '.jpg')
    target.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://open-images-dataset.s3.amazonaws.com/{saved['split']}/{image_id}.jpg"
    for attempt in range(3):
        try:
            raw = target.read_bytes() if target.is_file() else b''
            if hashlib.sha256(raw).hexdigest() != saved['sourceSha256']:
                with urllib.request.urlopen(url, timeout=60) as response:
                    raw = response.read(32 * 1024 ** 2 + 1)
            if len(raw) > 32 * 1024 ** 2 or hashlib.sha256(raw).hexdigest() != saved['sourceSha256']:
                raise ValueError('Public source checksum mismatch')
            target.write_bytes(raw)
            return {**row, 'source': str(target), 'sourceSize': dict(zip(('width', 'height'), saved['sourceSize'])),
                    'rotation': (-saved['rotation']) % 360}
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1)


def run():
    origin = Path.cwd().resolve()
    config = json.loads(Path('accept-config.json').read_text())
    materialize_models(config)
    for kind, expected in config['model_sha256'].items():
        if digest(config['models'][kind]) != expected:
            raise ValueError('Model checksum mismatch')
    for name, expected in config['runtime_source_sha256'].items():
        if digest(name) != expected:
            raise ValueError('Runtime source checksum mismatch')
    rows = json.loads(Path('accept-manifest.json').read_text())
    public = [row for row in rows if row['id'].startswith('openimages-')]
    with tempfile.TemporaryDirectory(prefix='gaze-node-') as temporary:
        folder = Path(temporary)
        binaries, sha = node_runtime(folder)
        report({'stage': 'node-verified', 'version': NODE, 'sha256': sha})
        # Ray working_dir uses source symlinks; one physical root keeps Node ESM package resolution local.
        work = folder / 'code'
        shutil.copytree(origin, work, ignore=shutil.ignore_patterns('node_modules', '__pycache__', 'npm-cache', 'node-dist'))
        os.chdir(work)
        env = dict(os.environ, PATH=str(binaries) + ':' + os.environ['PATH'], EAGLE_PYTHON=sys.executable,
                   ONNXRUNTIME_NODE_INSTALL='skip', UV_THREADPOOL_SIZE='2', SHARP_IGNORE_GLOBAL_LIBVIPS='1',
                   npm_config_cache=str(origin / 'inputs/npm-cache'),
                   npm_config_proxy=os.environ.get('HTTP_PROXY', ''),
                   npm_config_https_proxy=os.environ.get('HTTPS_PROXY', ''))
        env = install_native_dependencies(env)
        subprocess.run(['node', '--input-type=module', '-e',
                        "await import('./src/core/observation-runtime.js'); "
                        "await import('./src/core/observation-head.js'); "
                        "await import('./src/core/gaze-geometry.js'); "
                        "await import('./src/core/ai-tags.js')"], check=True, env=env, timeout=60)
        report({'stage': 'runtime-modules-verified'})
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            prepared = []
            for index, row in enumerate(pool.map(public_source, public), 1):
                prepared.append(row)
                if index % 200 == 0 or index == len(public):
                    report({'stage': 'verified-public-source', 'completed': index, 'total': len(public)})
        by_id = {row['id']: row for row in prepared}
        Path('accept-manifest.json').write_text(json.dumps([by_id.get(row['id'], row) for row in rows]))
        subprocess.run(['node', 'scripts/observe-gaze-accept.mjs'], check=True, env=env, timeout=3600)
        from ml.observe.gaze_accept import evaluate_runtime, calibrate_runtime
        from ml.observe.gaze_parity import parity
        output = Path('output')
        calibration = calibrate_runtime(Path.cwd(), output)
        subprocess.run(['node', 'scripts/observe-gaze-accept.mjs', '--score-only'], check=True, env=env, timeout=120)
        result = evaluate_runtime(Path.cwd(), output)
        result['runtimeCalibration'] = calibration
        result['featureParity'] = parity(Path.cwd(), output)
        result['gates']['featureParity'] = result['featureParity']['passed']
        result['passed'] = all(result['gates'].values())
        result['runtimeSourceSha256'] = config['runtime_source_sha256']
        result['node'] = json.loads((output / 'node-versions.json').read_text())
        result['node']['distributionSha256'] = sha
        result['pythonVersions'] = {key: importlib.metadata.version(key) for key in
                                    ('mediapipe', 'numpy', 'Pillow', 'onnxruntime', 'pyvips')}
        (output / 'runtime-acceptance.json').write_text(json.dumps(result, indent=2, allow_nan=False) + '\n')
        export(output / 'runtime-acceptance.json')
        export(output / 'runtime-model.json')
        # Numerical features only; never export source photos/crops through the log collector.
        numeric = output / 'runtime-vectors.jsonl'
        numeric.write_text('\n'.join(json.dumps({k: v for k, v in json.loads(line).items() if k != 'file'})
                                      for line in (output / 'runtime-features.jsonl').read_text().splitlines()) + '\n')
        export(numeric)
        report({'stage': 'runtime-complete', 'passed': result['passed'], 'launch': result.get('launch'),
                'calibration': result.get('calibration'), 'holdoutTeacher': result.get('holdoutTeacher')})


if __name__ == '__main__':
    run()
