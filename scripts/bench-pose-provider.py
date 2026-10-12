"""Bounded local provider probe. Run under the shared heavy-work lock, nice 15.

Writes private predictions only below data/cache/pose-provider; never touches originals.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor


def probe_cache_directory():
    # Provider experiments must never write into another worktree's cache namespace.
    return Path('data/cache/pose-provider')


def worker(files, face=False):
    started = time.perf_counter()
    load = {}
    def memory_guard():
        while True:
            peak_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if peak_bytes > int(os.environ['PROBE_RSS_BYTES']):
                print(json.dumps({'probeStopped': 'memory-budget', 'seconds': time.perf_counter()-started,
                                  'sessionsSeconds': load, 'peakMiB': peak_bytes / 1024**2}),
                      file=sys.stderr, flush=True)
                os._exit(75)
            time.sleep(.1)
    threading.Thread(target=memory_guard, daemon=True).start()
    sys.path.insert(0, str(Path('python_worker').resolve()))
    if face:
        import face_worker as fw
        options = fw.vision.FaceLandmarkerOptions(
            base_options=fw.python.BaseOptions(model_asset_path='models/mediapipe/face_landmarker.task'),
            running_mode=fw.vision.RunningMode.IMAGE, num_faces=10, output_face_blendshapes=True,
            min_face_detection_confidence=.5, min_face_presence_confidence=.5, min_tracking_confidence=.5)
        before = time.perf_counter()
        imported = before - started
        detector = fw.vision.FaceLandmarker.create_from_options(options)
        load = {'face': time.perf_counter() - before}
        ready = time.perf_counter() - started
        detector.close()
        predictions = []
    else:
        import pose_worker as pw
        imported = time.perf_counter() - started
        load = {}
        original = pw.session
        def timed(model):
            before = time.perf_counter()
            value = original(model)
            load['detector' if 'yolox' in model else 'pose'] = time.perf_counter() - before
            return value
        pw.session = timed
        detector, pose, mode = pw.load_models()
        ready = time.perf_counter() - started
        predictions = []
        failures = []
        for i, file in enumerate(files):
            before = time.perf_counter()
            try:
                result = pw.analyze({'id': str(i), 'filePath': file}, detector, pose, mode)
            except Exception as exc:
                failures.append({'index': i, 'seconds': time.perf_counter()-before, 'error': str(exc)})
                before_fallback = time.perf_counter()
                detector.session.set_providers(['CPUExecutionProvider'])
                pose.session.set_providers(['CPUExecutionProvider'])
                load['cpuFallback'] = time.perf_counter()-before_fallback
                result = pw.analyze({'id': str(i), 'filePath': file}, detector, pose, mode)
            predictions.append(result)
            result['requestSeconds'] = time.perf_counter()-before
    return {'sessionsSeconds': load, 'readySeconds': ready, 'importSeconds': imported,
            'elapsedSeconds': time.perf_counter()-started,
            'peakMiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024**2),
            'failures': failures if not face else [], 'predictions': predictions}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', default='CPUExecutionProvider')
    parser.add_argument('--workers', type=int, choices=(1, 2), default=1)
    parser.add_argument('--label', required=True)
    parser.add_argument('--child', action='store_true')
    parser.add_argument('--face', action='store_true')
    args = parser.parse_args()
    if args.child:
        result = worker(json.loads(sys.stdin.read()), args.face)
        print(json.dumps(result), flush=True)
        return
    print(json.dumps({'probeStart': args.label, 'provider': args.provider, 'workers': args.workers}), flush=True)
    root = probe_cache_directory()
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / 'probe-inputs.json'
    if not manifest.exists():
        files = sorted(Path('data/cache/previews').glob('*.jpg'))[:10]
        if len(files) != 10:
            raise RuntimeError('Need ten existing previews')
        manifest.write_text(json.dumps([str(p) for p in files]))
    files = json.loads(manifest.read_text())
    env = dict(os.environ, EAGLE_POSE_PROVIDER=args.provider, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
               PROBE_RSS_BYTES=str(3 * 1024**3 // args.workers))
    processes = []
    started = time.perf_counter()
    def run(index):
        command = [sys.executable, __file__, '--child', '--label', args.label]
        if args.face:
            command.append('--face')
        p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env=env)
        processes.append(p)
        try:
            out, err = p.communicate(json.dumps(files[index::args.workers]), timeout=180)
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()
            err += '\nProbe stopped after 180 seconds; own worker terminated.\n'
        (root / f'{args.label}-{index}.stderr').write_text(err)
        if p.returncode:
            stopped = {}
            for line in err.splitlines():
                try:
                    event = json.loads(line)
                    if event.get('probeStopped'):
                        stopped = event
                except (ValueError, AttributeError):
                    pass
            return {'exitCode': p.returncode, 'elapsedSeconds': time.perf_counter()-started,
                    'peakMiB': None, 'predictions': [], 'failures': [{'error': 'See private stderr'}],
                    'stopped': stopped}
        return json.loads(out)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(run, i) for i in range(args.workers)]
        results = [f.result() for f in futures]
    report = {'provider': args.provider, 'workers': args.workers,
              'wallSeconds': time.perf_counter()-started,
              'sumWorkerPeakMiB': sum(r['peakMiB'] or 0 for r in results) if all(r['peakMiB'] for r in results) else None,
              'inputSha256': [hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in files], 'results': results}
    (root / f'{args.label}.json').write_text(json.dumps(report))
    summary = {k: v for k, v in report.items() if k not in ('results', 'inputSha256')}
    summary['results'] = [{k:v for k,v in r.items() if k not in ('predictions', 'failures')} for r in results]
    summary['failureCounts'] = [len(r['failures']) for r in results]
    summary['inferenceMs'] = [[p['timingMs']['total'] for p in r['predictions']] for r in results]
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    main()
