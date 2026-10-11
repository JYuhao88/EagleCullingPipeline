#!/usr/bin/env python3
"""Two order-swapped visual labels per subject; no user labels or Eagle writes."""
import argparse
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.common import file_lock as fcntl
import hashlib
import json
import math
import subprocess
import time
from pathlib import Path

from PIL import Image, ImageDraw

VERSION = 'joint-crop-teacher@1'
JOINTS = ('wrist', 'elbow', 'knee', 'ankle', 'neck', 'hairline')
EDGES = ('top', 'bottom', 'left', 'right')
PROVIDER = ('model_providers.codex-lb={name="openai",'
            'base_url="http://127.0.0.1:2456/backend-api/codex",'
            'wire_api="responses",supports_websockets=true,requires_openai_auth=true}')
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': list(JOINTS),
    'properties': {joint: {
        'type': 'object', 'additionalProperties': False,
        'required': ['status', 'edges', 'confidence', 'reason'],
        'properties': {
            'status': {'type': 'string', 'enum': ['crop', 'safe', 'uncertain']},
            'edges': {'type': 'array', 'items': {'type': 'string', 'enum': list(EDGES)}},
            'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
            'reason': {'type': 'string'},
        },
    } for joint in JOINTS},
}


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def prompt(swapped=False):
    options = 'safe / crop / uncertain' if swapped else 'crop / safe / uncertain'
    return f'''只根据附图做视觉标注，不调用工具、不读文件。左图是干净代理图，右图是同一图的定位辅助。
绿色框指定主体，青色数字为 COCO WholeBody 关键点索引；橙色线为原画面四边。
框和点是模型预测，会误检或把画外下肢压到下沿，不能当成真值；没有清晰主体时全部 uncertain。
固定问题：主体是否在腕(wrist)、肘(elbow)、膝(knee)、踝(ankle)、脖颈(neck)、
发际线(hairline)处被画框裁切？每种关节分别选择 {options}，给出裁切边和 0–1 置信度及可见证据。
crop 表示画框实际切在该关节附近，普通大腿中段、上臂中段或躯干裁切不算。
safe 需要能可靠定位并排除该关节切点；关节画外无法定位、遮挡、太小、模糊等选 uncertain。
左右任一侧裁在关节即可 crop；不确定一侧且无明确 crop 则 uncertain。
只检查画框裁切，不判断美感、留白、好坏或是否该保留。edges 仅 crop 时填写 top/bottom/left/right。
必须分别回答六类关节，不把脚或手指裁切自动等同踝或腕，发际线不等于发梢。按给定 JSON schema 输出。'''


def validate(value):
    if not isinstance(value, dict) or set(value) != set(JOINTS):
        raise ValueError('Teacher must answer exactly six joints')
    for joint, label in value.items():
        if not isinstance(label, dict) or set(label) != {'status', 'edges', 'confidence', 'reason'}:
            raise ValueError(f'Invalid label: {joint}')
        confidence = label['confidence']
        if (isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise ValueError('Invalid confidence')
        edges = label['edges']
        if (label['status'] not in ('crop', 'safe', 'uncertain') or not isinstance(edges, list)
                or any(edge not in EDGES for edge in edges) or len(set(edges)) != len(edges)
                or not isinstance(label['reason'], str)):
            raise ValueError('Invalid status/edges/reason')
        if bool(edges) != (label['status'] == 'crop'):
            raise ValueError('Only crop must specify edges')
    return value


def reconcile(first, second, minimum=.7):
    validate(first)
    validate(second)
    labels = {}
    for joint in JOINTS:
        a, b = first[joint], second[joint]
        agreed = (a['status'] == b['status'] and set(a['edges']) == set(b['edges'])
                  and min(a['confidence'], b['confidence']) >= minimum
                  and a['status'] != 'uncertain')
        labels[joint] = {'status': a['status'] if agreed else 'uncertain',
                         'edges': sorted(a['edges']) if agreed else [],
                         'confidence': min(a['confidence'], b['confidence']),
                         'agreed': agreed}
    states = [label['status'] for label in labels.values()]
    overall = 'uncertain' if 'uncertain' in states else 'crop' if 'crop' in states else 'safe'
    return {'overall': overall, 'joints': labels}


def render(sample, persons, output):
    with Image.open(sample['previewPath']) as source:
        image = source.convert('RGB')
    image.thumbnail((1024, 1024))
    w, h = image.size
    canvas = Image.new('RGB', (2*w + 36, h + 64), '#222222')
    canvas.paste(image, (8, 40))
    canvas.paste(image, (w + 28, 40))
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 12), 'Clean proxy', fill='white')
    draw.text((w + 28, 12), 'Main subject + predicted keypoints (not ground truth)', fill='white')
    for origin in (8, w + 28):
        draw.rectangle((origin, 40, origin+w-1, 40+h-1), outline='orange', width=3)
    main = [person for person in persons if person.get('isMain')]
    indices = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 31, 44, 45]
    for person in main:
        box = person['box']
        for origin in (8, w + 28):
            draw.rectangle((origin+box[0]*w, 40+box[1]*h, origin+box[2]*w, 40+box[3]*h),
                           outline='#00ff55', width=2)
        points = person.get('keypoints', {}).get('points', [])
        for index in indices:
            if index >= len(points):
                continue
            x, y, score = points[index][:3]
            if not all(math.isfinite(v) for v in (x, y, score)) or score <= 0:
                continue
            x, y = w+28 + max(0, min(1, x))*w, 40 + max(0, min(1, y))*h
            color = '#00ffff' if score >= .3 else '#999999'
            draw.ellipse((x-3, y-3, x+3, y+3), fill=color)
            draw.text((x+4, y-10), str(index), fill=color)
    canvas.save(output)


def cache_key(sample, persons, image, model):
    metadata = {'unitId': sample['unitId'], 'persons': persons, 'version': VERSION,
                'prompts': [prompt(), prompt(True)], 'schema': SCHEMA, 'model': model, 'provider': PROVIDER}
    return hashlib.sha256(json.dumps(metadata, sort_keys=True).encode() + image.read_bytes()).hexdigest()


def command(image, schema, output, model, codex='codex'):
    prefix = ([] if os.name == 'nt' else ['nice', '-n', '10'])
    executable = [sys.executable, codex] if str(codex).endswith('.py') else [codex]
    return prefix + executable + ['exec', '-c', 'model_provider="codex-lb"',
            '-c', PROVIDER, '--sandbox', 'read-only', '--ephemeral', '-m', model,
            '--output-schema', str(schema), '-o', str(output), '-i', str(image), '-']


def run(args):
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    # Exclusive process lock prevents parallel resumes from overspending the call budget.
    with (output / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return run_locked(args, output)


def run_locked(args, output):
    source = Path(args.input)
    samples = json.loads((source / 'labels-template.json').read_text())
    results = {row['unitId']: row for row in json.loads((source / 'all-results.json').read_text())['results']}
    poses = {row['id']: row for row in json.loads((source / 'raw-poses.json').read_text())}
    if len({sample['unitId'] for sample in samples}) != len(samples):
        raise ValueError('Duplicate sample IDs')
    schema = output / 'schema.json'
    write_json(schema, SCHEMA)
    ledger_path = output / 'calls.json'
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else []
    labels = []
    blocked = None
    for sample in samples:
        if args.limit and len(labels) >= args.limit:
            break
        uid = sample['unitId']
        if uid not in results or uid not in poses:
            raise ValueError(f'Missing saved result/pose: {uid}')
        persons = poses[uid].get('persons', [])
        directory = output / hashlib.sha256(uid.encode()).hexdigest()[:20]
        directory.mkdir(exist_ok=True)
        image = directory / 'annotation.jpg'
        render(sample, persons, image)
        key = cache_key(sample, persons, image, args.model)
        write_json(directory / 'sample.json', {'unitId': uid, 'name': sample['name'], 'cacheKey': key,
                                               'image': str(image), 'mainPersons': len([p for p in persons if p.get('isMain')])})
        answers = []
        for swapped in (False, True):
            cached = directory / f'answer-{int(swapped)}.json'
            prompt_path = directory / f'prompt-{int(swapped)}.txt'
            prompt_path.write_text(prompt(swapped) + '\n')
            if cached.exists():
                saved = json.loads(cached.read_text())
                if saved.get('cacheKey') == key:
                    answers.append(validate(saved['answer']))
                    continue
            if args.prepare_only:
                continue
            if len(ledger) >= min(150, args.max_calls):
                blocked = 'Call budget exhausted'
                break
            raw = directory / f'raw-{int(swapped)}.json'
            raw.unlink(missing_ok=True)
            attempt = {'unitId': uid, 'swapped': swapped, 'cacheKey': key, 'startedAt': time.time(),
                       'status': 'started', 'elapsedSeconds': None, 'model': args.model}
            ledger.append(attempt)
            write_json(ledger_path, ledger)  # Reserve before launching, including failed/interrupted attempts.
            start = time.monotonic()
            try:
                completed = subprocess.run(command(image, schema, raw, args.model, args.codex),
                                           input=prompt(swapped), text=True, capture_output=True,
                                           timeout=args.timeout)
                (directory / f'exec-{int(swapped)}.log').write_text(completed.stdout + '\n' + completed.stderr)
                attempt['returnCode'] = completed.returncode
                if completed.returncode:
                    raise RuntimeError(f'codex exec failed ({completed.returncode}); see {directory}/exec-{int(swapped)}.log')
                answer = validate(json.loads(raw.read_text()))
                write_json(cached, {'cacheKey': key, 'answer': answer})
                answers.append(answer)
                attempt['status'] = 'completed'
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                attempt['status'] = 'failed'
                attempt['error'] = str(error)
                blocked = str(error)
            finally:
                attempt['elapsedSeconds'] = round(time.monotonic() - start, 3)
                write_json(ledger_path, ledger)
            if blocked:
                break
        if len(answers) == 2:
            labels.append({'unitId': uid, 'name': sample['name'], 'cacheKey': key,
                           **reconcile(*answers, minimum=args.min_confidence)})
        elif args.prepare_only:
            labels.append({'unitId': uid, 'status': 'prepared', 'image': str(image), 'cacheKey': key})
        if blocked:
            break
    write_json(output / ('prepared.json' if args.prepare_only else 'labels.json'), labels)
    summary = {'version': VERSION, 'inputSamples': len(samples), 'outputSamples': len(labels),
               'prepareOnly': args.prepare_only, 'complete': not args.prepare_only and len(labels) == len(samples),
               'calls': len(ledger),
               'completedCalls': sum(row['status'] == 'completed' for row in ledger),
               'elapsedCallSeconds': round(sum(row.get('elapsedSeconds') or 0 for row in ledger), 3),
               'distribution': {state: sum(row.get('overall') == state for row in labels)
                                for state in ('crop', 'safe', 'uncertain')},
               'minimumConfidence': args.min_confidence, 'blocked': blocked,
               'rawCoordinates': 'W1 snapshot has clamped coordinates; outside distances cannot be recovered'}
    write_json(output / ('prepare-summary.json' if args.prepare_only else 'summary.json'), summary)
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if blocked else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', default='/tmp/w1-pose-qa')
    parser.add_argument('--out', default='/tmp/w2-measure/teacher')
    parser.add_argument('--model', default='gpt-6.1-sol')
    parser.add_argument('--codex', default='codex')
    parser.add_argument('--max-calls', type=int, default=150)
    parser.add_argument('--timeout', type=float, default=420)
    parser.add_argument('--min-confidence', type=float, default=.7)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if not 0 <= args.min_confidence <= 1 or args.max_calls < 1 or args.limit < 0 or args.timeout <= 0:
        parser.error('Invalid confidence/budget/limit/timeout')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
