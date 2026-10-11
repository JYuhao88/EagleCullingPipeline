#!/usr/bin/env python3
"""CPU-only temporary Node runtime and sequential synthetic scale runs."""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[1]))
from ml.common.private_env import require_path
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

NODE = '22.14.0'
CEPH = Path(require_path('ECP_CEPH_ROOT') + '/stress')


def download(url, target):
    urllib.request.urlretrieve(url, target)


def run(command, env, timeout=300):
    subprocess.run(command, env=env, check=True, timeout=timeout)


def main():
    def terminate(signum, frame):
        raise TimeoutError('Ray worker terminated')
    signal.signal(signal.SIGTERM, terminate)
    job = os.environ['STRESS_JOB_ID']
    env = dict(os.environ, UV_THREADPOOL_SIZE='2', OMP_NUM_THREADS='2', ONNXRUNTIME_NODE_INSTALL='skip',
               OPENBLAS_NUM_THREADS='2', EAGLE_SHARP_CONCURRENCY='1')
    cpus = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, cpus[:2])
    os.nice(15)
    with tempfile.TemporaryDirectory(prefix='w6-node-') as temporary:
        tmp = Path(temporary)
        (tmp / 'synthetic').mkdir()
        env['TMPDIR'] = str(tmp / 'synthetic')
        arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
        name = f'node-v{NODE}-linux-{arch}'
        base = f'https://nodejs.org/dist/v{NODE}/'
        archive = tmp / (name + '.tar.xz')
        download(base + archive.name, archive)
        checksums = tmp / 'SHASUMS256.txt'
        download(base + checksums.name, checksums)
        expected = next(line.split()[0] for line in checksums.read_text().splitlines() if line.endswith(archive.name))
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise ValueError('Node checksum mismatch')
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                if not (tmp / member.name).resolve().is_relative_to(tmp):
                    raise ValueError('Unsafe Node archive')
            source.extractall(tmp, filter='data')
        # Ray exposes working_dir through links; Node ESM resolves real paths.
        # Copy code into one job-local tree so npm and imports share a root.
        work = tmp / 'code'
        shutil.copytree(Path.cwd(), work, ignore=shutil.ignore_patterns('node_modules', '.git', 'data', 'models'))
        os.chdir(work)
        env['PATH'] = str(tmp / name / 'bin') + ':' + env['PATH']
        run(['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts=false'], env)
        env['PATH'] = str(Path('node_modules/.bin').resolve()) + ':' + env['PATH']
        run(['exiftool', '-ver'], env)
        destination = CEPH / job
        destination.mkdir(parents=True, exist_ok=True)
        cpu = next(line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines()
                   if line.startswith('model name'))
        host = {'cpu': cpu, 'logicalCores': len(cpus), 'affinity': cpus[:2], 'reservedCpus': 2,
                'reservedMemoryGiB': 8, 'gpu': 0, 'nodeVersion': NODE, 'nodeSha256': expected}
        for units in (10000, 50000, 100000):
            output = tmp / f'{units}.json'
            command = ['node', '--max-old-space-size=2048', 'scripts/stress-results.mjs', '--units', str(units),
                       '--output', str(output)]
            process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, start_new_session=True)
            started = time.monotonic()
            peak = 0
            try:
                while process.poll() is None:
                    # Include descendants (EXIF reader) in the sampled memory budget.
                    group_rss = 0
                    for entry in Path('/proc').iterdir():
                        if not entry.name.isdigit():
                            continue
                        try:
                            if os.getpgid(int(entry.name)) == process.pid:
                                fields = (entry / 'statm').read_text().split()
                                group_rss += int(fields[1]) * os.sysconf('SC_PAGE_SIZE')
                        except (OSError, ValueError, ProcessLookupError):
                            pass
                    peak = max(peak, group_rss)
                    if peak > 3 * 1024 ** 3 or time.monotonic() - started > 1200:
                        raise RuntimeError('memory or 1200s stage timeout exceeded')
                    time.sleep(.2)
                if process.returncode:
                    raise RuntimeError(f'Node exited {process.returncode}')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
            report = json.loads(output.read_text())
            report.update(rayJobId=job, rayHost=host, processGroupPeakMiB=peak / 1048576)
            result = json.dumps(report)
            (destination / output.name).write_text(result + '\n')
            print('W6_RESULT ' + result, flush=True)
        print('W6_COMPLETE', flush=True)


if __name__ == '__main__':
    main()
