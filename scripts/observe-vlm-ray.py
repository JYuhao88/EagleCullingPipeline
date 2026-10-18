#!/usr/bin/env python3
"""Submit and collect isolated, single-GPU VLM research jobs (never a model API)."""
import argparse
import base64
from collections import Counter
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shlex
import sys
import time
import urllib.request
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, require_path, setting

ROOT = Path(__file__).resolve().parents[1]
LOCK = Path('/tmp/w29-ray.lock')
PREFIX = 'w34-vlm-'
LINES = ('w34-vlm', 'w35-vlm-moe')
DEFAULT_MODEL = 'Qwen/Qwen3-VL-4B-Instruct'
DEFAULT_REVISION = 'ebb281ec70b05090aa6165b016eac8ec08e71b17'
TERMINAL = ('SUCCEEDED', 'FAILED', 'STOPPED')
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, body=None, data=None, method=None):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=120) as response:
        return json.loads(response.read() or 'null')


def checked_line(line):
    if line not in LINES:
        raise ValueError('unknown VLM research line')
    return line


def checked_job(job, line='w34-vlm'):
    if not re.fullmatch(re.escape(checked_line(line) + '-') + r'[0-9a-f]{12}', job):
        raise ValueError('an explicit own VLM job id is required')
    return job


def checked_output(output, line='w34-vlm'):
    root = (ROOT / 'data/cache' / checked_line(line)).resolve()
    path = Path(output)
    if not path.resolve().is_relative_to(root):
        raise ValueError('output must remain in the selected line cache')
    return path


def requested_gpus(job):
    direct = []
    if 'entrypoint_num_gpus' in job:
        direct.append(job['entrypoint_num_gpus'])
    resources = job.get('entrypoint_resources')
    if isinstance(resources, dict) and 'GPU' in resources:
        direct.append(resources['GPU'])
    if direct:
        if any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in direct):
            return None
        return max(direct)
    metadata = job.get('metadata')
    value = metadata.get('ecp_requested_gpus') if isinstance(metadata, dict) else None
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?', value):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def uses_gpu(job):
    count = requested_gpus(job)
    return count is None or count > 0


def submit_locked(body, wait_seconds=600, line='w34-vlm'):
    requested = requested_gpus({key: value for key, value in body.items() if key != 'metadata'})
    explicit = 'entrypoint_num_gpus' in body or 'GPU' in (body.get('entrypoint_resources') or {})
    if explicit and (requested is None or requested > 2):
        raise ValueError('each project job must request a finite GPU count from zero to two')
    body = {**body, 'metadata': {**(body.get('metadata') or {}),
             'ecp_requested_gpus': str(requested) if requested is not None else 'unknown'}}
    deadline = time.monotonic() + wait_seconds
    prefix = checked_line(line) + '-'
    owner = {'line': line, 'pid': os.getpid(), 'nonce': uuid.uuid4().hex}
    while True:
        try:
            LOCK.mkdir()
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError('shared Ray lock remains occupied')
            time.sleep(10)
            continue
        try:
            (LOCK / 'owner.json').write_text(json.dumps(owner))
            jobs = request('/api/jobs/')
            active = [j for j in jobs if j.get('status') in ('RUNNING', 'PENDING')]
            if any(str(j.get('submission_id', '')).startswith(prefix) for j in active):
                raise RuntimeError('an own VLM job is already active')
            project = [j for j in active if re.match(r'^w(?:[1-9]|[12][0-9]|3[0-9])-',
                                                    str(j.get('submission_id', '')))]
            if len(project) < 3 and sum(uses_gpu(job) for job in project) + int(uses_gpu(body)) <= 2:
                return request('/api/jobs/', body=body)
        finally:
            marker = LOCK / 'owner.json'
            if marker.exists() and json.loads(marker.read_text()) == owner:
                marker.unlink()
                LOCK.rmdir()
        if time.monotonic() >= deadline:
            raise TimeoutError('project admission remains full: maximum three jobs and two GPU jobs')
        time.sleep(10)


def package(prepared, config):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name in ('ml/__init__.py', 'ml/observe/__init__.py', 'ml/observe/vlm_eval.py',
                     'ml/observe/vlm_eval_ray.py'):
            source = ROOT / name
            if source.exists():
                archive.write(source, name)
            elif name.endswith('vlm_eval.py'):
                continue
            elif name.endswith('__init__.py'):
                archive.writestr(name, '')
            else:
                raise FileNotFoundError(name)
        archive.writestr('vlm-config.json', json.dumps(config))
        archive.write(prepared / 'manifest.jsonl', 'manifest.jsonl')
        archive.write(prepared / 'questions.json', 'questions.json')
        rows = [json.loads(line) for line in (prepared / 'manifest.jsonl').read_text().splitlines() if line]
        images = {p for row in rows if row.get('storage') == 'package' for p in row['images'].values()}
        for name in sorted(images):
            source = (prepared / name).resolve()
            if not source.is_relative_to(prepared.resolve()) or not name.endswith('.jpg'):
                raise ValueError('unsafe packaged image path')
            validate_image(source)
            archive.write(source, name)
    if stream.tell() > 90 * 1024 ** 2:
        raise ValueError('package exceeds bounded upload size')
    return stream.getvalue()


def validate_image(source):
    from PIL import Image
    with Image.open(source) as image:
        if (image.format != 'JPEG' or max(image.size) > 768 or image.getexif()
                or any(image.info.get(k) for k in ('exif', 'icc_profile', 'xmp', 'photoshop', 'comment'))
                or any(marker in ('APP1', 'APP2', 'APP13', 'COM') for marker, _ in image.applist)):
            raise ValueError('packaged image is not a sanitized JPEG within 768 pixels')
        image.verify()


PROBE = '''import importlib.util,json,subprocess,urllib.request,os
result={'gpu':subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv,noheader'],capture_output=True,text=True).stdout.strip(),'modules':{},'hubs':{}}
for name in ['torch','transformers','accelerate','bitsandbytes','PIL','huggingface_hub']:
 result['modules'][name]=importlib.util.find_spec(name) is not None
for endpoint in ['https://huggingface.co','https://hf-mirror.com']:
 try:
  with urllib.request.urlopen(endpoint+'/Qwen/Qwen2.5-VL-3B-Instruct/resolve/main/config.json',timeout=20) as r: result['hubs'][endpoint]={'status':r.status,'bytes':len(r.read())}
 except Exception as e: result['hubs'][endpoint]={'error':type(e).__name__}
print('VLM_PROBE '+json.dumps(result),flush=True)
'''


def submit(args):
    line = checked_line(args.line)
    if args.model != DEFAULT_MODEL and args.revision == DEFAULT_REVISION:
        raise ValueError('changing the model requires an explicit matching revision')
    if not re.fullmatch('[0-9a-f]{40}', args.revision):
        raise ValueError('pin a complete model commit revision')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:rc\d+|\.post\d+)?', args.transformers_version):
        raise ValueError('pin an exact transformers release version')
    if not 1 <= args.vram_limit_gib <= 192:
        raise ValueError('VRAM limit must be 1..192 GiB')
    if args.action != 'probe' and (line == 'w35-vlm-moe' or args.family != 'qwen-vl') and not args.license:
        raise ValueError('record the reviewed model license explicitly')
    if args.license is not None and (not args.license.strip() or len(args.license) > 512):
        raise ValueError('license descriptor must be nonempty and at most 512 characters')
    output = checked_output(args.output, line)
    output.mkdir(parents=True, exist_ok=True)
    job = line + '-' + uuid.uuid4().hex[:12]
    proxy = setting('ECP_HTTP_PROXY', '')
    env = {'ECP_RAY_WORKER': '1', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2',
           'MKL_NUM_THREADS': '2', 'TOKENIZERS_PARALLELISM': 'false',
           'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'DO_NOT_TRACK': '1'}
    if proxy:
        env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy)
    runtime = {'env_vars': env}
    model_config = {'model': args.model, 'revision': args.revision, 'hub': args.hub, 'cache': args.cache,
                    'family': args.family, 'trust_remote_code': args.trust_remote_code,
                    'code_revision': args.revision if args.trust_remote_code else None,
                    'license': args.license or 'Apache-2.0', 'compression': args.compression,
                    'transformers_version': args.transformers_version, 'line': line}
    hf_home = ('/tmp/' + line + '-hf-cache' if args.cache == 'local' else
               str(Path(require_path('ECP_CEPH_ROOT')) / 'research' / line / 'hf-cache'))
    config = None
    if args.action == 'probe':
        entrypoint = 'timeout 100s python -c ' + shlex.quote(PROBE)
    elif args.action == 'download':
        env.update(HF_ENDPOINT=args.hub, HF_HOME=hf_home)
        config = model_config
        patterns = ['*.json', '*.safetensors', '*.txt', '*.model', '*.jinja', 'LICENSE*']
        if args.trust_remote_code:
            patterns.append('*.py')
        code = ('from huggingface_hub import snapshot_download\nimport json,time\n'
                't=time.monotonic()\n'
                f'p=snapshot_download({args.model!r},revision={args.revision!r},token=False,max_workers=2,\n'
                f' allow_patterns={patterns!r})\n'
                "print('VLM_DOWNLOAD '+json.dumps({'elapsed_s':time.monotonic()-t,'complete':True}),flush=True)\n")
        entrypoint = 'timeout 1800s python -c ' + shlex.quote(code)
    else:
        if not 60 <= args.timeout <= 21600 or args.asks != 3:
            raise ValueError('timeout must be 60..21600 and asks must be 3')
        env.update(ECP_CEPH_ROOT=require_path('ECP_CEPH_ROOT'), HF_ENDPOINT=args.hub, HF_HOME=hf_home)
        config = {**model_config, 'quantization': args.quantization, 'asks': args.asks,
                  'limit_per_set': args.limit_per_set, 'max_new_tokens': 256, 'seed': 20261017,
                  'vram_limit_gib': args.vram_limit_gib,
                  'prompt_format': args.prompt_format}
        config['source_sha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                   for name in ('ml/observe/vlm_eval.py', 'ml/observe/vlm_eval_ray.py',
                                                'scripts/observe-vlm-prepare.mjs', 'scripts/observe-vlm-ray.py')
                                   if (ROOT / name).exists()}
        config['manifest_sha256'] = hashlib.sha256((Path(args.prepared) / 'manifest.jsonl').read_bytes()).hexdigest()
        config['questions_sha256'] = hashlib.sha256((Path(args.prepared) / 'questions.json').read_bytes()).hexdigest()
        payload = package(Path(args.prepared), config)
        name = '_ray_pkg_' + hashlib.sha256(payload).hexdigest()[:16] + '.zip'
        request('/api/packages/gcs/' + name, data=payload, method='PUT')
        runtime.update(working_dir='gcs://' + name,
                       pip=['transformers==' + args.transformers_version, 'accelerate==1.10.1', 'bitsandbytes==0.50.2',
                            'Pillow==11.3.0', 'qwen-vl-utils==0.0.14', 'numpy==2.2.6'])
        if args.quantization == 'native':
            runtime['pip'].append('compressed-tensors==0.18.0')
        entrypoint = f'timeout --signal=TERM --kill-after=20s {args.timeout}s python -m ml.observe.vlm_eval_ray'
    body = {'submission_id': job, 'entrypoint': entrypoint, 'entrypoint_num_cpus': 2,
            'entrypoint_num_gpus': 1, 'entrypoint_memory': 24 * 1024 ** 3, 'runtime_env': runtime}
    (output / 'job.json').write_text(json.dumps({'job': job, 'config': config, 'phase': 'submitting'}, indent=2) + '\n')
    response = submit_locked(body, line=line)
    (output / 'job.json').write_text(json.dumps({'job': job, 'config': config, 'phase': 'submitted',
                                               'response': response}, indent=2) + '\n')
    print(json.dumps({'job': job, 'output': str(output)}), flush=True)


def collect(job, output, line='w34-vlm'):
    checked_job(job, line)
    output = checked_output(output, line)
    output.mkdir(parents=True, exist_ok=True)
    state = request('/api/jobs/' + job)
    logs = request('/api/jobs/' + job + '/logs')['logs']
    (output / 'job.log').write_text(logs)
    records = {}
    lines = logs.splitlines()
    if state.get('status') not in TERMINAL and not logs.endswith(('\n', '\r')):
        lines = lines[:-1]
    for line in lines:
        if not line.startswith('VLM_ARTIFACT '):
            continue
        row = json.loads(line.removeprefix('VLM_ARTIFACT '))
        name = row['name']
        if name not in ('predictions.jsonl', 'report.json', 'performance.json', 'failure.json'):
            raise ValueError('unknown artifact name')
        rec = records.setdefault(name, {'count': row['count'], 'sha256': row['sha256'], 'parts': {}})
        if rec['count'] != row['count'] or rec['sha256'] != row['sha256']:
            raise ValueError('inconsistent artifact chunks')
        rec['parts'][row['index']] = row['data']
    written = []
    for name, rec in records.items():
        if set(rec['parts']) != set(range(rec['count'])):
            if state.get('status') not in TERMINAL:
                continue
            raise ValueError('incomplete artifact')
        raw = base64.b64decode(''.join(rec['parts'][i] for i in range(rec['count'])), validate=True)
        if hashlib.sha256(raw).hexdigest() != rec['sha256']:
            raise ValueError('artifact checksum mismatch')
        (output / name).write_bytes(raw)
        written.append(name)
    if 'predictions.jsonl' not in records:
        predictions = [json.loads(line.removeprefix('VLM_ROW ')) for line in lines
                       if line.startswith('VLM_ROW ')]
        if predictions:
            (output / 'predictions.jsonl').write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n'
                                                            for row in predictions))
    probes = [json.loads(line.removeprefix('VLM_PROBE ')) for line in lines if line.startswith('VLM_PROBE ')]
    if probes:
        (output / 'probe.json').write_text(json.dumps(probes[-1], indent=2) + '\n')
    downloads = [json.loads(line.removeprefix('VLM_DOWNLOAD ')) for line in lines
                 if line.startswith('VLM_DOWNLOAD ')]
    if downloads:
        (output / 'download.json').write_text(json.dumps(downloads[-1], indent=2) + '\n')
    (output / 'collection.json').write_text(json.dumps({'job': job, 'status': state.get('status'),
                                                       'artifacts': written,
                                                       'pending': sorted(set(records) - set(written))}, indent=2) + '\n')
    print(json.dumps({'job': job, 'status': state.get('status'), 'artifacts': written, 'probe': probes[-1:]}))
    return state


def watch(job, output, poll, line='w34-vlm'):
    output = checked_output(output, line)
    while True:
        state = collect(job, output, line)
        file = output / 'predictions.jsonl'
        rows = [json.loads(line) for line in file.read_text().splitlines() if line] if file.exists() else []
        counts = Counter(row['id'] for row in rows)
        progress = {'job': job, 'status': state.get('status'), 'calls': len(rows),
                    'complete_items': sum(n == 3 for n in counts.values()),
                    'errors': sum(bool(row.get('error')) for row in rows)}
        (output / 'progress.json').write_text(json.dumps(progress, indent=2) + '\n')
        print(json.dumps(progress), flush=True)
        if state.get('status') in TERMINAL:
            return 0 if state.get('status') == 'SUCCEEDED' else 1
        time.sleep(poll)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('probe', 'download', 'submit', 'status', 'collect', 'watch', 'stop'))
    parser.add_argument('job', nargs='?')
    parser.add_argument('--line', choices=LINES, default='w34-vlm')
    parser.add_argument('--output')
    parser.add_argument('--prepared', default='data/cache/w34-vlm/prepared')
    parser.add_argument('--model', default=DEFAULT_MODEL)
    parser.add_argument('--revision', default=DEFAULT_REVISION)
    parser.add_argument('--family', choices=('qwen-vl', 'minicpm', 'qwen3_5_moe'), default='qwen-vl')
    parser.add_argument('--trust-remote-code', action='store_true')
    parser.add_argument('--license')
    parser.add_argument('--compression', type=int, choices=(4, 16), default=4)
    parser.add_argument('--transformers-version', default='4.57.1')
    parser.add_argument('--vram-limit-gib', type=float, default=12)
    parser.add_argument('--hub', choices=('https://huggingface.co', 'https://hf-mirror.com'), default='https://huggingface.co')
    parser.add_argument('--cache', choices=('local', 'shared'), default='local')
    parser.add_argument('--quantization', choices=('none', 'bnb4', 'native'), default='none')
    parser.add_argument('--prompt-format', choices=('plain', 'schema'), default='plain')
    parser.add_argument('--asks', type=int, default=3)
    parser.add_argument('--limit-per-set', type=int, default=0)
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--poll', type=int, choices=range(30, 61), default=45)
    args = parser.parse_args(argv)
    args.output = args.output or 'data/cache/' + args.line + '/probe'
    return args


def main():
    args = arguments()
    checked_output(args.output, args.line)
    if args.action in ('probe', 'download', 'submit'):
        submit(args)
    elif args.action == 'collect':
        collect(checked_job(args.job or '', args.line), args.output, args.line)
    elif args.action == 'watch':
        raise SystemExit(watch(checked_job(args.job or '', args.line), args.output, args.poll, args.line))
    elif args.action == 'stop':
        print(json.dumps(request('/api/jobs/' + checked_job(args.job or '', args.line) + '/stop', body={})))
    else:
        state = request('/api/jobs/' + checked_job(args.job or '', args.line))
        print(json.dumps({k: state.get(k) for k in ('submission_id', 'status')}))


if __name__ == '__main__':
    main()
