#!/usr/bin/env python3
"""Build metadata-only manifests for the two internal research sources."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build_wulin(candidates, details=None):
    matches = [c for c in candidates['candidates'] if str(c.get('mid')) == '474457011']
    if len(matches) != 1:
        raise ValueError('expected one Wulin account (mid=474457011)')
    details = details or {}
    videos = []
    seen = set()
    for item in matches[0]['videos']:
        bvid = item['bvid']
        if bvid in seen:
            raise ValueError(f'duplicate bvid: {bvid}')
        seen.add(bvid)
        info = details.get(bvid, {})
        if 'data' in info:
            info = info['data']
        videos.append({'bvid': bvid, 'title': info.get('title', item['title']),
                       'duration': info.get('duration', item['duration_seconds']),
                       'duration_seconds': info.get('duration', item['duration_seconds']),
                       'pubdate': info.get('pubdate', item.get('pubdate')),
                       'url': item.get('url', f'https://www.bilibili.com/video/{bvid}')})
    return {'schema_version': 1, 'source': 'wulin', 'use': 'private internal research only',
            'publication_date_note': 'pubdate is Unix seconds; null means absent from candidates, fill from downloaded info.json',
            'publication_dates_missing': sum(v['pubdate'] is None for v in videos),
            'video_count': len(videos), 'duration_seconds': sum(v['duration'] for v in videos), 'videos': videos}


def build_wuxiaolong(manifest):
    videos = []
    seen = set()
    for item in manifest['episodes']:
        if item['relevance'] != 'high':
            continue
        course_id = hashlib.sha256(item['course'].encode()).hexdigest()[:10]
        episode_id = f'wuxiaolong-{course_id}-{int(item["episode"]):02d}'
        if episode_id in seen:
            raise ValueError(f'duplicate episode: {episode_id}')
        seen.add(episode_id)
        videos.append({'bvid': episode_id, 'episode_id': episode_id, 'course': item['course'],
                       'episode': item['episode'], 'title': item['title'],
                       'duration': item['duration_seconds'], 'duration_seconds': item['duration_seconds'],
                       'source_path': item['ceph_path'], 'sha256': item['sha256'], 'relevance': 'high'})
    return {'schema_version': 1, 'source': 'wuxiaolong', 'use': 'purchased courses; private internal research only',
            'selection': 'relevance=high; filename-based classification', 'video_count': len(videos),
            'duration_seconds': sum(v['duration'] for v in videos), 'videos': videos}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidates', type=Path, default=HERE/'genre_sources_candidates.json')
    parser.add_argument('--courses', type=Path, default=HERE/'wuxiaolong_manifest.json')
    parser.add_argument('--wulin-details', type=Path, help='directory containing <bvid>/info.json or <bvid>.json')
    parser.add_argument('--output-dir', type=Path, default=HERE)
    args = parser.parse_args()
    candidates = json.loads(args.candidates.read_text())
    details = {}
    if args.wulin_details:
        for path in sorted(args.wulin_details.glob('*/info.json')) + sorted(args.wulin_details.glob('*.json')):
            info = json.loads(path.read_text())
            value = info.get('data', info)
            bvid = value.get('bvid', path.parent.name if path.name == 'info.json' else path.stem)
            details[bvid] = info
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, result in [('wulin_critique_manifest.json', build_wulin(candidates, details)),
                             ('wuxiaolong_asr_manifest.json', build_wuxiaolong(json.loads(args.courses.read_text())))]:
        (args.output_dir/filename).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(filename, result['video_count'], result['duration_seconds'])


if __name__ == '__main__':
    main()
