#!/usr/bin/env python3
"""Submit pinned llama-server VLM research on Ray using the existing W35 admission and privacy checks."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LINE = 'w35-vlm-moe'
spec = importlib.util.spec_from_file_location('observe_vlm_ray_submit', ROOT / 'scripts/observe-vlm-ray.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def checked_revision(revision):
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('pin a complete model or llama.cpp commit revision')
    return revision


def checked_model(model):
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', model):
        raise ValueError('model must be an explicit public repository id')
    return model


def checked_file(name):
    if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+\.gguf', name)
            or Path(name).is_absolute() or '..' in Path(name).parts):
        raise ValueError('GGUF assets must be explicit safe relative .gguf file names')
    return name


def configuration(args):
    checked_revision(args.llama_revision)
    if args.llama_repo != 'ggml-org/llama.cpp':
        raise ValueError('only the official pinned llama.cpp repository is supported')
    if (not 60 <= args.timeout <= 43200 or not 60 <= args.build_timeout_s <= 3600
            or not 10 <= args.server_start_timeout_s <= 300):
        raise ValueError('job/build/server timeouts exceed the bounded research limits')
    if args.asks != 3 or args.limit_per_set < 0 or not 0 <= args.n_cpu_moe <= 40:
        raise ValueError('asks must be 3 and sample/offload bounds must be valid')
    if type(args.replicas) is not int or args.replicas not in (1, 2):
        raise ValueError('replicas must be 1 or 2 independent GPU workers')
    config = {'mode': 'evaluate' if args.action == 'submit' else 'build', 'backend': 'llama-server',
              'line': LINE, 'cache': args.cache, 'llama_repo': args.llama_repo,
              'llama_revision': args.llama_revision, 'llama_license': 'MIT', 'asks': 3,
              'limit_per_set': args.limit_per_set, 'max_new_tokens': 256, 'seed': 20261017,
              'prompt_format': args.prompt_format, 'compression': args.compression, 'context_size': 4096, 'n_gpu_layers': 99,
              'batch_size': 512, 'ubatch_size': 128, 'threads': 2, 'parallel': 1, 'replicas': args.replicas,
              'cache_prompt': False, 'n_cpu_moe': args.n_cpu_moe,
              'build_timeout_s': args.build_timeout_s, 'server_start_timeout_s': args.server_start_timeout_s,
              'hub': args.hub, 'model_files': [], 'mmproj_file': None, 'file_sha256': {}}
    for entry in args.file_sha256:
        name, separator, digest = entry.partition('=')
        checked_file(name)
        if not separator or not re.fullmatch(r'[0-9a-f]{64}', digest) or name in config['file_sha256']:
            raise ValueError('each GGUF asset needs one complete lowercase SHA-256')
        config['file_sha256'][name] = digest
    if config['mode'] == 'evaluate':
        config.update(model=checked_model(args.model), revision=checked_revision(args.revision),
                      model_files=[checked_file(name) for name in args.model_files],
                      mmproj_file=checked_file(args.mmproj_file))
        if not config['model_files'] or len(set(config['model_files'])) != len(config['model_files']):
            raise ValueError('at least one unique language GGUF asset is required')
        if config['mmproj_file'] in config['model_files']:
            raise ValueError('language weights and vision projector must be distinct')
        if not args.license or not args.license.strip() or len(args.license) > 512:
            raise ValueError('record the reviewed model license explicitly')
        config['license'] = args.license
        if args.mmproj_model is not None or args.mmproj_revision is not None:
            config.update(mmproj_model=checked_model(args.mmproj_model),
                          mmproj_revision=checked_revision(args.mmproj_revision))
        else:
            config.update(mmproj_model=config['model'], mmproj_revision=config['revision'])
    assets = set(config['model_files']) | ({config['mmproj_file']} if config['mmproj_file'] else set())
    if set(config['file_sha256']) != assets:
        raise ValueError('SHA-256 entries must cover every language and projector asset exactly')
    return config


def package(prepared, config):
    stream = io.BytesIO(native.package(prepared, config))
    with zipfile.ZipFile(stream, 'a', compression=zipfile.ZIP_STORED) as archive:
        worker = 'ml/observe/vlm_eval_gguf_ray.py'
        archive.write(ROOT / worker, worker)
    if stream.getbuffer().nbytes > 90 * 1024 ** 2:
        raise ValueError('package exceeds bounded upload size')
    return stream.getvalue()


def submit(args):
    config = configuration(args)
    output = native.checked_output(args.output, LINE)
    if (output / 'job.json').exists():
        raise FileExistsError('choose a new result directory for each Ray attempt')
    prepared = Path(args.prepared)
    config['source_sha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                               for name in ('ml/observe/vlm_eval.py', 'ml/observe/vlm_eval_ray.py',
                                            'ml/observe/vlm_eval_gguf_ray.py', 'scripts/observe-vlm-prepare.mjs',
                                            'scripts/observe-vlm-ray.py', 'scripts/observe-vlm-gguf-ray.py')
                               if (ROOT / name).exists()}
    config['manifest_sha256'] = hashlib.sha256((prepared / 'manifest.jsonl').read_bytes()).hexdigest()
    config['questions_sha256'] = hashlib.sha256((prepared / 'questions.json').read_bytes()).hexdigest()
    payload = package(prepared, config)
    name = '_ray_pkg_' + hashlib.sha256(payload).hexdigest()[:16] + '.zip'
    storage_root = native.require_path('ECP_CEPH_ROOT')
    env = {'ECP_RAY_WORKER': '1', 'ECP_CEPH_ROOT': storage_root,
           'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2',
           'HF_ENDPOINT': args.hub, 'HF_HOME': (str(Path(storage_root) / 'research/w35-vlm-moe/gguf-cache')
                                            if args.cache == 'shared' else '/tmp/w35-vlm-moe-gguf-hf-cache'),
           'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1', 'DO_NOT_TRACK': '1'}
    proxy = native.setting('ECP_HTTP_PROXY', '')
    if proxy:
        env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy)
    job = LINE + '-' + uuid.uuid4().hex[:12]
    body = {'submission_id': job,
            'entrypoint': f'timeout --signal=TERM --kill-after=20s {args.timeout}s python -m ml.observe.vlm_eval_gguf_ray',
            'entrypoint_num_cpus': 2 * args.replicas, 'entrypoint_num_gpus': args.replicas,
            'entrypoint_memory': 24 * args.replicas * 1024 ** 3,
            'runtime_env': {'working_dir': 'gcs://' + name, 'env_vars': env,
                            'pip': ['huggingface-hub==2.2.0', 'Pillow==11.3.0']}}
    output.mkdir(parents=True, exist_ok=True)
    (output / 'job.json').write_text(json.dumps({'job': job, 'config': config, 'phase': 'submitting'}, indent=2) + '\n')
    native.request('/api/packages/gcs/' + name, data=payload, method='PUT')
    response = native.submit_locked(body, line=LINE)
    (output / 'job.json').write_text(json.dumps({'job': job, 'config': config, 'phase': 'submitted',
                                               'response': response}, indent=2) + '\n')
    print(json.dumps({'job': job, 'output': str(output)}), flush=True)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('probe', 'build', 'submit', 'status', 'collect', 'watch', 'stop'))
    parser.add_argument('job', nargs='?')
    parser.add_argument('--line', choices=(LINE,), default=LINE)
    parser.add_argument('--output', default='data/cache/w35-vlm-moe/gguf-probe')
    parser.add_argument('--prepared', default='data/cache/w34-vlm/prepared')
    parser.add_argument('--model')
    parser.add_argument('--revision')
    parser.add_argument('--model-file', '--model-files', dest='model_files', nargs='+', default=[])
    parser.add_argument('--mmproj-file')
    parser.add_argument('--mmproj-model')
    parser.add_argument('--mmproj-revision')
    parser.add_argument('--license')
    parser.add_argument('--file-sha256', action='append', default=[])
    parser.add_argument('--llama-repo', choices=('ggml-org/llama.cpp',), default='ggml-org/llama.cpp')
    parser.add_argument('--llama-revision')
    parser.add_argument('--cache', choices=('local', 'shared'), default='shared')
    parser.add_argument('--hub', choices=('https://huggingface.co', 'https://hf-mirror.com'), default='https://huggingface.co')
    parser.add_argument('--prompt-format', choices=('plain', 'schema'), default='schema')
    parser.add_argument('--asks', type=int, default=3)
    parser.add_argument('--compression', type=int, choices=(4, 16))
    parser.add_argument('--limit-per-set', type=int, default=0)
    parser.add_argument('--n-cpu-moe', type=int, default=0)
    parser.add_argument('--replicas', type=int, choices=(1, 2), default=1)
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--build-timeout-s', type=int, default=1800)
    parser.add_argument('--server-start-timeout-s', type=int, default=300)
    parser.add_argument('--poll', type=int, choices=range(30, 61), default=45)
    return parser.parse_args(argv)


def main():
    args = arguments()
    native.checked_output(args.output, LINE)
    if args.action in ('probe', 'build', 'submit'):
        submit(args)
    else:
        job = native.checked_job(args.job or '', LINE)
        if args.action == 'collect':
            native.collect(job, args.output, LINE)
        elif args.action == 'watch':
            raise SystemExit(native.watch(job, args.output, args.poll, LINE))
        elif args.action == 'stop':
            print(json.dumps(native.request('/api/jobs/' + job + '/stop', body={})))
        else:
            state = native.request('/api/jobs/' + job)
            print(json.dumps({key: state.get(key) for key in ('submission_id', 'status')}))


if __name__ == '__main__':
    main()
