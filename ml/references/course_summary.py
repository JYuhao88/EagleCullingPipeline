#!/usr/bin/env python3
"""Audit received course text hashes and summarize completed episode counts."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from asr_job import valid
from courses import SOURCES


def summary(data, source):
    data=Path(data);root=data/source
    manifest=json.loads((data/(source+'-manifest.json')).read_text())
    arrived_path=data/(source+'-arrived.json')
    arrived=json.loads(arrived_path.read_text()) if arrived_path.exists() else {'videos':[]}
    asr=[];topics=[];errors=[]
    for video in manifest['videos']:
        ident=video['bvid'];path=root/'asr'/(ident+'.jsonl');side=root/'asr'/(ident+'.stats.json')
        if not path.exists() and not side.exists():continue
        try:
            stats=json.loads(side.read_text());rows=[json.loads(l) for l in path.read_text().splitlines() if l.strip()]
            if stats.get('error') or stats['source_sha256']!=video['sha256'] or not valid(rows,stats['duration']):
                raise ValueError('ASR source or timestamp contract')
            if stats['sentences']!=len(rows):raise ValueError('ASR sentence count')
            asr.append({'id':ident,'episode':video['episode'],'duration':stats['duration'],'sentences':len(rows),
                        'source_sha256':stats['source_sha256']})
            topic_path=root/'topics'/(ident+'.jsonl');side=root/'topics'/(ident+'.stats.json')
            if not topic_path.exists() and not side.exists():continue
            stats=json.loads(side.read_text());segments=[json.loads(l) for l in topic_path.read_text().splitlines() if l.strip()]
            if stats.get('error') or stats['video_sha256']!=video['sha256']:raise ValueError('topic source contract')
            if stats['asr_input_sha256']!=hashlib.sha256(path.read_bytes()).hexdigest():raise ValueError('ASR hash')
            if stats['topics_sha256']!=hashlib.sha256(topic_path.read_bytes()).hexdigest():raise ValueError('topics hash')
            indices=[sentence['index'] for segment in segments for sentence in segment['sentences']]
            if sorted(indices)!=list(range(len(rows))):raise ValueError('sentence coverage')
            if stats['topic_segments']!=len(segments):raise ValueError('topic count')
            if stats['frames']!=sum(len(s['frames']) for s in segments):raise ValueError('frame count')
            if any(not 1<=len(s['frames'])<=3 for s in segments):raise ValueError('frame sampling contract')
            topics.append(stats)
        except (ValueError,KeyError,OSError) as error:
            errors.append({'id':ident,'error':str(error)})
    counts=Counter()
    for stats in topics:counts.update(stats['topics'])
    return {'source':source,'manifest_episodes':len(manifest['videos']),
            'manifest_duration_seconds':sum(v.get('duration_seconds') or 0 for v in manifest['videos']),
            'arrived_episodes':len(arrived['videos']),'probe_id':arrived.get('probe_id'),
            'count_only_arrived':sum(v['count_only'] for v in arrived['videos']),
            'asr_episodes':len(asr),'asr_duration_seconds':sum(v['duration'] for v in asr),
            'asr_sentences':sum(v['sentences'] for v in asr),'topics_episodes':len(topics),
            'topic_segments':sum(v['topic_segments'] for v in topics),'frames':sum(v['frames'] for v in topics),
            'topics':dict(counts),'completed':asr,'errors':errors}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,default=Path('/tmp/w4-courses-data'))
    p.add_argument('--source',choices=SOURCES)
    a=p.parse_args();result=[summary(a.data,s) for s in ((a.source,) if a.source else SOURCES[:3])]
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if any(r['errors'] for r in result):raise SystemExit(1)


if __name__=='__main__':main()
