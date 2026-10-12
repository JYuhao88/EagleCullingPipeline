#!/usr/bin/env python3
"""Foreground CPU/CoreML pose comparison; CoreML must be run outside the sandbox."""
import argparse, json, os, subprocess, sys, tempfile
from pathlib import Path

def run(files, provider, options=None, model=None, detector=None, det_size=None):
    env = dict(os.environ, EAGLE_POSE_PROVIDER=provider, OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
    for key, value in (('EAGLE_POSE_MODEL', model), ('EAGLE_POSE_DETECTOR', detector), ('EAGLE_POSE_DET_SIZE', det_size)):
        if value: env[key] = str(value)
    if options: env['EAGLE_POSE_COREML_OPTIONS'] = json.dumps(options, separators=(',', ':'))
    payload = ''.join(json.dumps({'id': str(i), 'filePath': str(f)}) + '\n' for i, f in enumerate(files))
    p = subprocess.run([sys.executable, 'python_worker/pose_worker.py'], input=payload, text=True,
                       capture_output=True, env=env, check=False)
    if p.returncode: raise RuntimeError(f'{provider} worker exit {p.returncode}: {p.stderr[-2000:]}')
    rows = []
    for line in p.stdout.splitlines():
        try: rows.append(json.loads(line))
        except json.JSONDecodeError: continue
    if len(rows) != len(files): raise RuntimeError(f'{provider} returned {len(rows)} of {len(files)} rows; stderr={p.stderr[-1000:]}')
    for row, file in zip(rows, files): row['filePath'] = str(file)
    return rows, p.stderr

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--manifest', help='JSON array of paths, or bench manifest with images[].path')
    ap.add_argument('--coreml-units', default='CPUAndGPU', choices=('ALL','CPUAndGPU','CPUAndNeuralEngine'))
    ap.add_argument('--right-provider', default='CoreMLExecutionProvider')
    ap.add_argument('--left-model'); ap.add_argument('--left-detector'); ap.add_argument('--left-det-size', default='640')
    ap.add_argument('--right-model'); ap.add_argument('--right-detector'); ap.add_argument('--right-det-size', default='640')
    ap.add_argument('--output', default='data/cache/w23-quant/provider-compare.json')
    args = ap.parse_args()
    files = [Path(f) for f in args.files]
    if args.manifest:
        manifest = json.loads(Path(args.manifest).read_text())
        files = [Path(f) for f in manifest] if isinstance(manifest, list) else [Path('data/cache/bench/syn') / r['path'] for r in manifest['images']]
    opts = {'ModelFormat':'MLProgram', 'MLComputeUnits':args.coreml_units,
            'RequireStaticInputShapes':True, 'ModelCacheDirectory':'data/cache/pose-coreml'}
    with tempfile.TemporaryDirectory(prefix='w23-provider-compare-', dir='/tmp') as td:
        left, left_err = run(files, 'CPUExecutionProvider', model=args.left_model, detector=args.left_detector, det_size=args.left_det_size)
        right, right_err = run(files, args.right_provider, opts if args.right_provider == 'CoreMLExecutionProvider' else None,
                               model=args.right_model, detector=args.right_detector, det_size=args.right_det_size)
        left_path, right_path = Path(td)/'cpu.json', Path(td)/'coreml.json'
        left_path.write_text(json.dumps(left)); right_path.write_text(json.dumps(right))
        derived = Path(args.output).with_suffix('.derived.json'); derived.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['node', 'scripts/compare-pose-providers-derived.mjs', str(left_path), str(right_path), str(derived)], check=True)
        stats = {'images':len(files), 'coremlUnits':args.coreml_units, 'derived':json.loads(derived.read_text()),
                 'providers':[[r.get('provider'), r.get('providers')] for r in right], 'cpuStderr':left_err[-2000:], 'coremlStderr':right_err[-4000:]}
        persons = keypoints = 0; max_coord = max_conf = 0.0; persons_same = True
        stats['rows'] = []
        for a,b in zip(left,right):
            if not a.get('available') or not b.get('available'):
                raise RuntimeError(f'Unavailable pose on image {a.get("id")}: {a.get("error")}, {b.get("error")}')
            row_delta = []; row_conf = []
            same = len(a.get('persons',[])) == len(b.get('persons',[])) and [p.get('isMain') for p in a.get('persons',[])] == [p.get('isMain') for p in b.get('persons',[])]
            persons_same &= same
            for pa,pb in zip(a.get('persons',[]), b.get('persons',[])):
                persons += 1
                for xa,xb in zip(pa.get('keypoints',{}).get('points',[]), pb.get('keypoints',{}).get('points',[])):
                    keypoints += 1; max_coord=max(max_coord,abs(xa[0]-xb[0]),abs(xa[1]-xb[1])); max_conf=max(max_conf,abs(xa[2]-xb[2]))
                    row_delta.extend([abs(xa[0]-xb[0]), abs(xa[1]-xb[1])]); row_conf.append(abs(xa[2]-xb[2]))
            stats['rows'].append({'id':a['id'], 'subjectsSame':same, 'cpuPersons':len(a['persons']), 'coremlPersons':len(b['persons']),
                                  'maxCoordinateDelta':max(row_delta,default=None), 'meanCoordinateDelta':sum(row_delta)/len(row_delta) if row_delta else None,
                                  'maxConfidenceDelta':max(row_conf,default=None), 'cpuTimingMs':a.get('timingMs'), 'coremlTimingMs':b.get('timingMs')})
        stats.update({'personsCompared':persons,'keypointsCompared':keypoints,'maxCoordinateDelta':max_coord,'maxConfidenceDelta':max_conf,'subjectsSame':persons_same})
        Path(args.output).write_text(json.dumps(stats, ensure_ascii=False, indent=2))
        print(json.dumps({k:stats[k] for k in ('images','personsCompared','keypointsCompared','maxCoordinateDelta','maxConfidenceDelta','subjectsSame','derived')} , ensure_ascii=False))
if __name__ == '__main__': main()
