#!/usr/bin/env python3
"""CPU-only timestamped lecture topic extraction; never opens video files.

REF_OUT selects the course root. REF_MANIFEST selects exactly the high-relevance
ASR manifest (JSON string); --manifest can instead supply a local JSON file.
JSONL contains internal research transcription and must remain outside Git.
"""
from __future__ import annotations
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

TOPICS = {
    'landscape': ('风光', '山水', '风景', '地平线', '天气', '日出', '日落'),
    'street': ('街拍', '街头', '街道', '决定性瞬间'),
    'documentary': ('纪实', '记录', '社会', '新闻摄影', '故事', '叙事'),
    'composition': ('构图', '框架', '画面', '层次', '前景', '背景', '线条', '主体'),
    'light': ('光线', '光影', '逆光', '侧光', '阳光', '阴影', '曝光', '色温'),
    'viewing': ('观看', '看见', '观察', '视角', '视觉', '凝视', '观看方式'),
}


def extract_topics(rows, context_sentences=1, max_gap=20, max_seconds=180):
    if context_sentences < 0 or max_gap < 0 or max_seconds <= 0:
        raise ValueError('context/max_gap must be nonnegative and max_seconds positive')
    for i, row in enumerate(rows):
        if not isinstance(row.get('text'), str) or not 0 <= row['start'] < row['end']:
            raise ValueError(f'invalid ASR sentence {i}')
        if i and row['start'] < rows[i-1]['start']:
            raise ValueError('ASR sentences must be ordered')
    paragraphs = []
    for topic, words in TOPICS.items():
        matches = [i for i, row in enumerate(rows) if any(word in row['text'] for word in words)]
        windows = []
        for i in matches:
            lo, hi = max(0, i-context_sentences), min(len(rows)-1, i+context_sentences)
            # Do not carry context across long lecture pauses.
            for index in range(i, lo, -1):
                if rows[index]['start']-rows[index-1]['end'] > max_gap:
                    lo = index
                    break
            for index in range(i+1, hi+1):
                if rows[index]['start']-rows[index-1]['end'] > max_gap:
                    hi = index-1
                    break
            if (windows and lo <= windows[-1][1]+1
                    and rows[lo]['start']-rows[windows[-1][1]]['end'] <= max_gap
                    and rows[hi]['end']-rows[windows[-1][0]]['start'] <= max_seconds):
                windows[-1][1] = max(hi, windows[-1][1])
                windows[-1][2].append(i)
            else:
                windows.append([lo, hi, [i]])
        for lo, hi, hits in windows:
            paragraphs.append({'start': rows[lo]['start'], 'end': rows[hi]['end'], 'topic': topic,
                               'sentence_start': lo, 'sentence_end': hi,
                               'sentence_range_convention': 'zero-based inclusive',
                               'matched_sentence_indices': hits,
                               'keywords': [w for w in words if any(w in rows[i]['text'] for i in hits)],
                               'sentences': [dict(index=i, **rows[i]) for i in range(lo, hi+1)]})
    return sorted(paragraphs, key=lambda r: (r['start'], r['end'], r['topic']))


def covered_seconds(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return sum(b-a for a, b in merged)


def atomic(path, value, lines=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix+'.part')
    temp.write_text(''.join(json.dumps(row, ensure_ascii=False)+'\n' for row in value) if lines else json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(os.environ.get('REF_OUT', require_path('ECP_CEPH_ROOT') + '/references/wuxiaolong')))
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--context-sentences', type=int, default=1)
    parser.add_argument('--max-gap', type=float, default=20)
    parser.add_argument('--max-seconds', type=float, default=180)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text() if args.manifest else os.environ['REF_MANIFEST'])
    boot = time.monotonic()
    results = []
    for video in manifest['videos']:
        bvid = video['bvid']
        started = time.monotonic()
        try:
            rows = [json.loads(line) for line in (args.root/'asr'/f'{bvid}.jsonl').read_text().splitlines() if line.strip()]
            if not rows:
                raise ValueError('empty ASR input')
            paragraphs = extract_topics(rows, args.context_sentences, args.max_gap, args.max_seconds)
            for paragraph in paragraphs:
                paragraph.update(source='wuxiaolong', episode_id=bvid, course=video.get('course'),
                                 episode=video.get('episode'), title=video['title'])
            covered = {s['index'] for p in paragraphs for s in p['sentences']}
            duration = float(video.get('duration', video.get('duration_seconds', rows[-1]['end'])))
            stats = {'episode_id': bvid, 'duration': duration, 'sentences': len(rows), 'topic_segments': len(paragraphs),
                     'asr_input_sha256': hashlib.sha256((args.root/'asr'/f'{bvid}.jsonl').read_bytes()).hexdigest(),
                     'code_sha256': os.environ.get('REF_CODE_SHA256'),
                     'covered_sentences': len(covered), 'sentence_coverage': len(covered)/len(rows),
                     'topic_seconds': covered_seconds([(p['start'], p['end']) for p in paragraphs]),
                     'topics': {topic: sum(p['topic'] == topic for p in paragraphs) for topic in TOPICS},
                     'seconds': round(time.monotonic()-started, 3), 'error': None}
            stats['duration_coverage'] = stats['topic_seconds']/duration if duration else 0
            atomic(args.root/'topics'/f'{bvid}.jsonl', paragraphs, lines=True)
            atomic(args.root/'topics'/f'{bvid}.stats.json', stats)
            (args.root/'topics'/f'{bvid}.error.json').unlink(missing_ok=True)
        except Exception as error:
            stats = {'episode_id': bvid, 'error': str(error)}
            atomic(args.root/'topics'/f'{bvid}.error.json', stats)
        results.append(stats)
        print('TOPICS', json.dumps(stats, ensure_ascii=False), flush=True)
    report = {'videos': len(results), 'failed': [r for r in results if r.get('error')],
              'seconds': round(time.monotonic()-boot, 3), 'resource': {'num_gpus': 0, 'num_cpus': 1},
              'method': 'keyword windows; topics may overlap; time coverage is interval union',
              'parameters': {'context_sentences': args.context_sentences, 'max_gap': args.max_gap, 'max_seconds': args.max_seconds},
              'results': results}
    atomic(args.root/'topics'/'run-report.json', report)
    print('SUMMARY', json.dumps({k: v for k, v in report.items() if k != 'results'}, ensure_ascii=False), flush=True)
    if report['failed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
