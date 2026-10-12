"""Bounded macOS real-unit probe, with simultaneous descendant RSS sampling."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python_worker'))
from memory_guard import rss_bytes


def child_pids(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib')
    values = (ctypes.c_int * 1024)()
    size = lib.proc_listpids(6, pid, values, ctypes.sizeof(values))
    return [p for p in values[:max(0, size // 4)] if p > 0]


def descendants(pid):
    result = {pid}
    pending = [pid]
    while pending:
        for child in child_pids(pending.pop()):
            if child not in result:
                result.add(child); pending.append(child)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('old','normal','turbo'), required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--run', default='run-1791546991006')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise RuntimeError('Simultaneous descendant RSS sampler is macOS-only')
    if not all(c in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in args.label) or not args.label:
        raise ValueError('Use a lowercase ASCII label')
    directory = ROOT / 'data/cache/w23-threads/e2e' / args.label
    if directory.exists():
        raise RuntimeError('Cold label already exists')
    directory.mkdir(parents=True)
    env = dict(os.environ, EAGLE_POSE_THREADS='1' if args.mode == 'old' else '3', EAGLE_PERFORMANCE_MODE='normal',
               MPLCONFIGDIR=str(ROOT / 'data/cache/w23-threads/mpl'), EAGLE_POSE_PROVIDER='CPUExecutionProvider')
    command = ['nice','-n','15','node','--max-old-space-size=2048','scripts/bench-performance.mjs',args.mode,args.label,args.run]
    peak = 0; node_peak = 0; samples = 0; max_processes = 0
    started = time.monotonic()
    with (directory/'run.log').open('w') as log:
        child = subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while child.poll() is None:
                if time.monotonic()-started > 560:
                    os.killpg(child.pid,signal.SIGKILL); child.wait(); raise TimeoutError('Stopped before ten-minute lock limit')
                current = 0
                pids = descendants(child.pid); max_processes = max(max_processes,len(pids))
                for pid in pids:
                    try:
                        value = rss_bytes(pid); current += value
                        if pid == child.pid: node_peak = max(node_peak,value)
                    except OSError:
                        pass  # A process may exit between enumeration and sampling.
                peak=max(peak,current);samples+=1;time.sleep(.1)
            if child.returncode:
                raise RuntimeError(f'Local pipeline exited {child.returncode}; see private run.log')
        finally:
            # Also reap any stay-open exiftool children left after Node exits.
            try: os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            child.wait()
    report={'mode':args.mode,'label':args.label,'peakAggregateRssMiB':peak/1024**2,
            'peakNodeRssMiB':node_peak/1024**2,'rssSamples':samples,'targetSampleIntervalMs':100,'maxTrackedProcesses':max_processes,
            'meanSamplingPeriodMs':(time.monotonic()-started)*1000/max(1,samples),
            'launcherWallSeconds':time.monotonic()-started}
    (directory/'memory.json').write_text(json.dumps(report));print(json.dumps(report),flush=True)


if __name__ == '__main__':
    main()
