#!/usr/bin/env python3
"""Run prepared AIHub requests on Ray, for hosts whose local network may not reach AIHub.

submit <work dir>  package requests.jsonl, the worker and the key file; submit one CPU-only job
status <job id>    job state
collect <job id> <work dir>  write results.jsonl from the job's result lines
The key is read from ECP_AIHUB_URL / ECP_AIHUB_KEY at submit time and travels only inside the package.
"""
import argparse
import hashlib
import io
import json
import math
import os
import re
import time
import sys
import subprocess
import urllib.request
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ml.common.private_env import dashboard_url, setting  # noqa: E402
from ml.common.ray_admission import admission  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
ROOT = Path(__file__).resolve().parents[1]
PREFIX = 'w28-aihub-'
LOCK = Path('/tmp/w29-ray.lock')
LINES = ('w28-aihub', 'w36-vlm-critique')


def request(path, body=None, method=None, data=None, timeout=120):
    payload = data if data is not None else None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(dashboard_url() + path, data=payload, method=method,
                                 headers={'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=timeout) as response:
        text = response.read()
        return json.loads(text) if text else None


def checked_line(line):
    if line not in LINES:
        raise ValueError('unsupported AIHub line')
    return line


def checked_job(job, line='w28-aihub'):
    if not re.fullmatch(re.escape(checked_line(line) + '-') + r'[0-9a-f]{12}', job):
        raise ValueError('explicit own AIHub job id required')
    return job


def submit_locked(body, line='w28-aihub', wait_seconds=600, before_submit=None):
    checked_line(line)
    if body.get('entrypoint_num_gpus', 0) != 0:
        raise ValueError('teacher jobs must request zero GPUs')
    deadline = time.monotonic() + wait_seconds
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
            active = [job for job in request('/api/jobs/') if job.get('status') in ('RUNNING', 'PENDING')]
            if admission(active, line, 'teacher'):
                if before_submit is not None:
                    before_submit()
                return request('/api/jobs/', body)
        finally:
            marker = LOCK / 'owner.json'
            if marker.exists() and json.loads(marker.read_text()) == owner:
                marker.unlink()
                LOCK.rmdir()
        if time.monotonic() >= deadline:
            raise TimeoutError('project teacher or total job quota remains occupied')
        time.sleep(10)


def checked_work(work, line):
    work = Path(work)
    if line == 'w36-vlm-critique' and not work.resolve().is_relative_to((ROOT / 'data/cache' / line).resolve()):
        raise ValueError('W36 AIHub work must remain in its line cache')
    return work


def validate_w36_batch(work, config):
    cap = float(os.environ.get('ECP_AIHUB_BUDGET_RMB', '0'))
    if not config.get('strictBudget') or config.get('inputTokenReserve', 0) < 16000:
        raise ValueError('W36 requires the authorized cap and conservative strict budget')
    if config.get('transportPolicy') != 'single-request-v1':
        raise ValueError('W36 requires the single-request-v1 transport policy before packaging')
    rate_keys = ('rateLimitPolicy', 'rateLimitRetries', 'rateLimitBackoffSeconds', 'rateLimitBackoffMaxSeconds')
    if any(key in config for key in rate_keys):
        retries, delay, maximum = (config.get('rateLimitRetries', 0), config.get('rateLimitBackoffSeconds', 2),
                                   config.get('rateLimitBackoffMaxSeconds', 30))
        if (config.get('rateLimitPolicy') != 'unprocessed-429-v1' or type(retries) is not int or not 0 <= retries <= 6
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in (delay, maximum))
                or not 1 <= delay <= 30 or not delay <= maximum <= 60):
            raise ValueError('invalid bounded HTTP429 retry policy before packaging')
    metadata = json.loads((work / 'judge-batch.json').read_text())
    cache = ROOT / 'data/cache/w36-vlm-critique'
    preregistration = (cache / 'preregistration.json').read_bytes()
    if hashlib.sha256(preregistration).hexdigest() != metadata.get('preregistrationSha256'):
        raise ValueError('W36 preregistration checksum mismatch')
    if metadata.get('resumePlanFile'):
        audit_process = subprocess.run(['node', str(ROOT / 'scripts/observe-critique-judge.mjs'), 'audit-resume',
                                        '--cache', str(cache), '--resume-plan', str(cache / metadata['resumePlanFile']),
                                        '--batch', str(work)], capture_output=True, text=True, check=False)
        if audit_process.returncode:
            raise ValueError('W36 incremental resume campaign audit failed before packaging')
        audit = json.loads(audit_process.stdout)
        if not audit.get('maySubmit') or not 0 < audit.get('candidateMaximumCny', 0) <= audit['remainingBudgetCny'] + 1e-9:
            raise ValueError('W36 resume batch exceeds campaign authorization')
        return
    if not 0 < cap <= 1200:
        raise ValueError('W36 requires the authorized legacy budget cap')
    audit_process = subprocess.run(['node', str(ROOT / 'scripts/observe-critique-judge.mjs'), 'audit',
                                    '--cache', str(cache), '--total', str(metadata['plannedCritiques'])],
                                   capture_output=True, text=True, check=False)
    if audit_process.returncode:
        raise ValueError('W36 cumulative receipt audit failed')
    audit = json.loads(audit_process.stdout)
    budget = config.get('budgetCny', 0)
    if not 0 < budget <= cap - audit['spentCny'] - audit['outstandingCny'] + 1e-9:
        raise ValueError('W36 batch budget exceeds remaining line authorization')
    phase = metadata.get('phase')
    if phase == 'pilot':
        if audit['pilot']['photos'] or not 1 <= len(metadata.get('selectedPhotos', [])) <= 20:
            raise ValueError('W36 pilot must be the first submitted batch with at most 20 photos')
    elif phase == 'full':
        if not audit['mayProceedFull']:
            raise ValueError('W36 paid pilot projection does not permit full judging')
    else:
        raise ValueError('unknown W36 judge phase')
    if (work / 'job.json').exists():
        raise ValueError('W36 judge batch was already submitted; collect it before retrying')


def submit_recorded(work, body, package_name, line='w28-aihub', validate=None):
    job = checked_job(body['submission_id'], line)
    file = Path(work) / 'job.json'
    record = {'job': job, 'package': package_name, 'phase': 'submitting'}
    if file.exists():
        raise FileExistsError('explicit submission receipt already exists')

    def before_submit():
        if validate is not None:
            validate()
        with file.open('x') as handle:
            json.dump(record, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())

    result = submit_locked(body, line=line, before_submit=before_submit)
    record.update(phase='submitted', response=result)
    temporary = file.with_name('.job-' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x') as handle:
            json.dump(record, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)
    return result


def package(work):
    url, key = os.environ.get('ECP_AIHUB_URL'), os.environ.get('ECP_AIHUB_KEY')
    if not url or not key:
        raise SystemExit('Missing AIHub environment')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(ROOT / 'scripts/aihub-ray-worker.py', 'worker.py')
        archive.write(work / 'requests.jsonl', 'requests.jsonl')
        if (work / 'config.json').exists():
            archive.write(work / 'config.json', 'config.json')
        for image in sorted((work / 'images').glob('*.jpg')):
            archive.write(image, 'images/' + image.name, compress_type=zipfile.ZIP_STORED)
        archive.writestr('secret.json', json.dumps({'url': url, 'key': key}))
    return buffer.getvalue()


def job_environment(config):
    proxy = setting('ECP_HTTP_PROXY', '')
    values = {'HTTPS_PROXY': proxy, 'HTTP_PROXY': proxy, 'NO_PROXY': 'localhost,127.0.0.1',
              'CUDA_VISIBLE_DEVICES': '', 'ECP_RAY_WORKER': '1'}
    if 'imageRoot' in config:
        root = setting('ECP_CEPH_ROOT', required=True)
        if not Path(root).is_absolute():
            raise ValueError('ECP_CEPH_ROOT must be an absolute path when imageRoot is set')
        values['ECP_CEPH_ROOT'] = root
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['submit', 'status', 'collect'])
    parser.add_argument('--line', choices=LINES, default='w28-aihub')
    parser.add_argument('target')
    parser.add_argument('work', nargs='?')
    args = parser.parse_args()
    if args.action == 'submit':
        work = checked_work(args.target, args.line)
        config = json.loads((work / 'config.json').read_text()) if (work / 'config.json').exists() else {}
        environment = job_environment(config)
        if args.line == 'w36-vlm-critique':
            validate_w36_batch(work, config)
        content = package(work)
        name = '_ray_pkg_' + hashlib.sha256(content).hexdigest()[:16] + '.zip'
        request('/api/packages/gcs/' + name, method='PUT', data=content, timeout=180)
        job = args.line + '-' + uuid.uuid4().hex[:12]
        seconds = int(min(6 * 3600, max(60, config.get('timeoutSeconds', 1800))))
        entry = 'timeout --signal=TERM --kill-after=15s %ds python worker.py' % seconds
        body = {'submission_id': job, 'entrypoint': entry,
                'entrypoint_num_cpus': 1, 'entrypoint_num_gpus': 0, 'entrypoint_memory': 1024 ** 3,
                'runtime_env': {'working_dir': 'gcs://' + name, 'env_vars': environment},
                'metadata': {'ecp_job_kind': 'teacher', 'ecp_requested_gpus': '0'}}
        submit_recorded(work, body, name, line=args.line,
                        validate=(lambda: validate_w36_batch(work, config)) if args.line == 'w36-vlm-critique' else None)
        print(json.dumps({'job': job}))
        return
    checked_job(args.target, args.line)
    state = request('/api/jobs/' + args.target)
    if args.action == 'status':
        print(json.dumps({k: state.get(k) for k in ('submission_id', 'status', 'message')}))
        return
    logs = request('/api/jobs/' + args.target + '/logs')['logs']
    rows = [line.removeprefix('MN_RESULT ') for line in logs.splitlines() if line.startswith('MN_RESULT ')]
    checked_work(args.work, args.line).joinpath('results.jsonl').write_text(''.join(row + '\n' for row in rows))
    done = [json.loads(line.removeprefix('MN_DONE ')) for line in logs.splitlines() if line.startswith('MN_DONE ')]
    print(json.dumps({'job': args.target, 'status': state.get('status'), 'results': len(rows),
                      'done': done[-1] if done else None}))


if __name__ == '__main__':
    main()
