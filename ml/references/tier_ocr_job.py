#!/usr/bin/env python3
"""CPU-only RapidOCR tier recognition. Originals remain untouched; resume by input/model hash.
REF_OUT is the Ceph root, REF_BVIDS optional comma-separated subset.
Conservative: a tier ladder with several labels is ambiguous, never a selected tier.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
from concurrent.futures import ThreadPoolExecutor
import threading
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import time

ROOT = require_path('ECP_CEPH_ROOT') + '/references/yidao'
VERSION = 'rapidocr-3.10.0-tier-v2'
ALIASES = {'夯':'夯', '顶尖':'顶尖', '顶级':'顶尖', '人上人':'人上人', 'NPC':'NPC', '拉':'拉'}


def recognize(items, width, height):
    """OCR boxes: [polygon, text, confidence]. Return only unambiguous spatial labels."""
    right, title = [], []
    for box, text, confidence in items or []:
        if confidence < .75:
            continue
        compact = re.sub(r'\s+', '', text).upper()
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        if compact in ALIASES and min(xs) >= width * .65:
            right.append(ALIASES[compact])
        # Explicit submission title cards; do not infer from arbitrary prose mentioning a tier.
        if ('投稿' in compact or '路人' in compact) and max(ys)-min(ys) >= height * .035:
            found = {value for key, value in ALIASES.items() if key in compact}
            if len(found) == 1:
                title.extend(found)
    if len(set(right)) == 1:
        return right[0], 'ocr-label'
    if not right and len(set(title)) == 1:
        return title[0], 'ocr-titlecard'
    return None, None


def majority(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        # Missing identities must never join unrelated photos; compare panels stay separate.
        key = row.get('photo_id') if row.get('kind') != 'compare' else None
        groups[key or ('segment', row['segment']['index'])].append(row)
    for group in groups.values():
        votes = collections.Counter(r['tier'] for r in group if r['tier'])
        if not votes:
            continue
        ranked = votes.most_common()
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            for row in group:
                row['tier'] = row['tierSource'] = None
            continue
        winner = ranked[0][0]
        source = next(r['tierSource'] for r in group if r['tier'] == winner)
        for row in group:
            row['tier'], row['tierSource'] = winner, source
            row['tierVotes'] = dict(votes)


LOCAL = threading.local()

def process_file(path):
    from rapidocr import RapidOCR
    from PIL import Image
    if not hasattr(LOCAL, 'engine'):
        LOCAL.engine = RapidOCR(params={'EngineConfig.onnxruntime.intra_op_num_threads': 2, 'EngineConfig.onnxruntime.inter_op_num_threads': 1})
    engine = LOCAL.engine
    root = Path(os.environ.get('REF_OUT', ROOT))
    target = root / 'critiques-v2'
    output = target/path.name
    metadata = output.with_suffix('.ocr-meta.json')
    signature = hashlib.sha256(path.read_bytes()+VERSION.encode()).hexdigest()
    if output.exists() and metadata.exists() and json.loads(metadata.read_text()).get('input_sha256') == signature:
        previous = json.loads(metadata.read_text())
        if (not previous['stats'].get('errors') and
                previous.get('output_sha256') == hashlib.sha256(output.read_bytes()).hexdigest()):
            return previous['stats']
    started = time.monotonic()
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    errors = []
    for row in rows:
        frame = (root/row['frame']).resolve()
        if not frame.is_relative_to((root/'frames').resolve()):
            raise ValueError('frame traversal')
        if row['segment']['index'] % 25 == 0:
            print('OCR_PROGRESS '+path.stem+' '+str(row['segment']['index']),flush=True)
        row['tier'] = row['tierSource'] = None
        row['ocrText'] = []
        try:
            with Image.open(frame) as image:
                width, height = image.size
            ocr = engine(str(frame))
            result = list(zip(ocr.boxes.tolist(), ocr.txts, ocr.scores)) if ocr.boxes is not None else []
            row['ocrText'] = [{'text':t, 'confidence':float(c), 'box':box} for box,t,c in result or []]
            row['tier'], row['tierSource'] = recognize(result, width, height)
        except Exception as error:
            errors.append({'segment':row['segment']['index'],'error':str(error)})
    majority(rows)
    raw = ''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
    temporary = output.with_suffix('.part'); temporary.write_text(raw); temporary.replace(output)
    stats = {'bvid':path.stem,'segments':len(rows),'tiered':sum(r['tier'] is not None for r in rows),
             'tiers':dict(collections.Counter(r['tier'] for r in rows if r['tier'])),
             'errors':errors, 'seconds':time.monotonic()-started}
    stats['coverage'] = stats['tiered']/len(rows) if rows else 0
    metadata.write_text(json.dumps({'input_sha256':signature,'output_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'version':VERSION,'stats':stats},ensure_ascii=False))
    print('OCR_VIDEO '+json.dumps(stats,ensure_ascii=False),flush=True)
    return stats

def main():
    root = Path(os.environ.get('REF_OUT', ROOT))
    target = root / 'critiques-v2'
    target.mkdir(exist_ok=True)
    selected = set(filter(None, os.environ.get('REF_BVIDS','').split(',')))
    paths = [p for p in sorted((root/'critiques').glob('*.jsonl')) if not selected or p.stem in selected]
    workers = int(os.environ.get('REF_WORKERS', '1'))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        report = list(pool.map(process_file, paths))
    summary = {'version':VERSION,'videos':report,'segments':sum(s['segments'] for s in report),'tiered':sum(s['tiered'] for s in report), 'cpus':workers*2,'gpus':0}
    summary['coverage'] = summary['tiered']/summary['segments'] if summary['segments'] else 0
    (target/os.environ.get('REF_REPORT','coverage.json')).write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print('OCR_DONE '+json.dumps({k:v for k,v in summary.items() if k != 'videos'}),flush=True)
    if any(s['errors'] for s in report):
        raise SystemExit('OCR frame failures: see coverage.json')

if __name__ == '__main__': main()
