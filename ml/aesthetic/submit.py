"""Code-only Ray submission and sanitized artifact retrieval."""
import argparse
import base64
import hashlib
import json
import os
import shlex
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.common.private_env import jobs_url, merge_private_env, setting, worker_source


def request(suffix='', body=None):
    req = urllib.request.Request(jobs_url() + suffix, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.load(opener.open(req, timeout=45))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['parity', 'extract', 'stream', 'resume', 'approve', 'teacher', 'status', 'fetch', 'stop'])
    parser.add_argument('--id', required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--parity-report', type=Path)
    parser.add_argument('--cpu', action='store_true', help='Run the parity gate without a GPU')
    args = parser.parse_args()
    if args.action in ['status', 'stop']:
        data = request(args.id + ('/stop' if args.action == 'stop' else ''), {} if args.action == 'stop' else None)
        print(json.dumps({k: data.get(k) for k in ['submission_id', 'status', 'driver_exit_code', 'stopped']}))
        return
    if args.action == 'fetch':
        if args.output is None:
            parser.error('--output required')
        args.output.mkdir(parents=True, exist_ok=True)
        chunks = {}
        logs = request(args.id + '/logs')['logs']
        for line in logs.splitlines():
            if line.startswith('REPORT '):
                print(line)
            if line.startswith('ARTIFACT '):
                item = json.loads(line[9:])
                if Path(item['name']).name != item['name']:
                    raise ValueError('Invalid artifact name')
                chunks.setdefault(item['name'], []).append(item)
        for name, rows in chunks.items():
            rows.sort(key=lambda x: x['index'])
            if [x['index'] for x in rows] != list(range(rows[0]['count'])):
                raise ValueError('Incomplete artifact')
            data = base64.b64decode(''.join(x['data'] for x in rows))
            if hashlib.sha256(data).hexdigest() != rows[0]['sha256']:
                raise ValueError('Artifact checksum mismatch')
            (args.output / name).write_bytes(data)
            print(json.dumps({'saved': name, 'bytes': len(data), 'sha256': rows[0]['sha256']}))
        if not chunks:
            print('No artifacts available')
        return
    active = [j for j in request() if j['status'] in ['PENDING', 'RUNNING'] and str(j.get('submission_id') or '').startswith('w26-aes-')]
    if len(active) >= 2:
        raise RuntimeError('At most two aesthetic jobs may be active')
    root = Path(__file__).resolve().parents[2]
    files = {name: (root / name).read_text() for name in [
        'ml/aesthetic/ray_job.py', 'python_worker/embedding_worker.py',
        'python_worker/dinov2-preprocessor.json', 'python_worker/model-manifest.json']}
    bootstrap = 'import json, pathlib, tempfile, os\n'
    bootstrap += 'bundle=json.loads(' + repr(json.dumps(files)) + ')\n'
    bootstrap += "base=pathlib.Path(tempfile.mkdtemp());os.chdir(base)\n"
    bootstrap += 'for name, text in bundle.items():\n p=base/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)\n'
    bootstrap += worker_source(files['ml/aesthetic/ray_job.py'], required=('ECP_CEPH_ROOT',))
    encoded = base64.b64encode(bootstrap.encode()).decode()
    proxy = setting('ECP_HTTP_PROXY', '')
    env = {'AES_STAGE': args.action, 'AES_CPU': '1' if args.cpu else '0',
           'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'VIPS_CONCURRENCY': '1',
           'HTTP_PROXY': proxy, 'HTTPS_PROXY': proxy, 'PYTHONUNBUFFERED': '1'}
    if args.action == 'approve':
        if args.parity_report is None:
            parser.error('--parity-report required')
        report = json.loads(args.parity_report.read_text())
        env['AES_PARITY_REPORT'] = json.dumps({k: report[k] for k in ['n', 'cosine_min', 'pass']})
    body = {'submission_id': args.id,
            'entrypoint': 'python -c ' + shlex.quote('import base64;exec(base64.b64decode(' + repr(encoded) + '))'),
            'entrypoint_num_cpus': 64 if args.cpu and args.action in ['extract', 'stream', 'resume'] else 2,
            'entrypoint_num_gpus': 0 if args.cpu or args.action in ['approve', 'teacher'] else 1,
            'runtime_env': {'env_vars': env, 'pip': ['onnxruntime-gpu==1.23.2', 'pyvips', 'pyvips-binary', 'pillow',
                                                   'numpy', 'scipy', 'scikit-learn']}}
    merge_private_env(body)
    body['runtime_env']['env_vars'] = {key: value for key, value in body['runtime_env']['env_vars'].items()
                                       if not key.startswith('ECP_') or key in ['ECP_CEPH_ROOT', 'ECP_RAY_WORKER']}
    print(json.dumps(request(body=body)))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({'interrupted': True}), file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(json.dumps({'error': type(error).__name__,
                          **({'status_code': error.code} if isinstance(error, urllib.error.HTTPError) else {})}), file=sys.stderr)
        sys.exit(1)
