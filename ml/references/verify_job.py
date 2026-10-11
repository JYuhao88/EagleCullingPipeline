#!/usr/bin/env python3
"""Completion audit; optionally export QA via Ray logs.

REF_MANIFEST, REF_OUT, REF_EXPORT=1. Runs with eight I/O threads and eight reserved CPUs without extra packages.
Verifies all ASR/segments/critiques, frame JPEG signatures, intervals, raw inventory.
REF_AUDIT_WRITE=1 appends audit evidence to pipeline-report.json; raw remains read-only.
"""
import sys as _private_sys
from pathlib import Path as _PrivatePath
if 'ml.common.private_env' not in _private_sys.modules:
    _private_sys.path.insert(0, str(_PrivatePath(__file__).resolve().parents[2]))
from ml.common.private_env import require_path
import base64
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT=Path(os.environ.get('REF_OUT',require_path('ECP_CEPH_ROOT') + '/references/yidao'))


def verify_video(video):
    b=video['bvid']; files=0; raw_bytes=0; inventory=[]
    try:
        asr=[json.loads(l) for l in (ROOT/'asr'/f'{b}.jsonl').read_text().splitlines() if l]
        seg=json.loads((ROOT/'segments'/f'{b}.json').read_text())
        critique_path=ROOT/'critiques'/f'{b}.jsonl'
        crit=[json.loads(l) for l in critique_path.read_text().splitlines() if l]
        metadata=json.loads(critique_path.with_suffix('.meta.json').read_text())
        if hashlib.sha256(critique_path.read_bytes()).hexdigest()!=metadata['output_sha256']: raise ValueError('critique checksum mismatch')
        if any(c.get('source')!=os.environ.get('REF_SOURCE','yidao') or c.get('bvid')!=b for c in crit): raise ValueError('critique source mismatch')
        if not seg: raise ValueError('empty segments')
        asr_stats=json.loads((ROOT/'asr'/f'{b}.stats.json').read_text())
        if abs(float(seg[-1]['end'])-float(asr_stats['duration']))>2: raise ValueError('incomplete decoded video duration')
        segment_stats=json.loads((ROOT/'segments'/f'{b}.stats.json').read_text())
        if os.environ.get('REF_SOURCE')=='wulin' and segment_stats.get('identity_version')!='wulin-central-sift@1': raise ValueError('obsolete Wulin identity version')
        if os.environ.get('REF_SOURCE')=='wulin' and segment_stats.get('host_negative_templates', 0): raise ValueError('obsolete Wulin host exclusion')
        if not asr: raise ValueError('empty ASR')
        if any(not 0<=s['start']<s['end'] or not s['text'] for s in asr): raise ValueError('invalid ASR')
        if len(crit)!=sum(s['kind']!='other' for s in seg): raise ValueError('critique count mismatch')
        if any(c['contractVersion']!=1 or c['tier'] is not None or c['verdict'] is not None or c['issues'] or c['praises'] or c['topics'] for c in crit): raise ValueError('contract mismatch')
        previous_end=0.
        for s in seg:
            if not previous_end-.01<=s['start']<s['end']: raise ValueError('invalid or overlapping segments')
            previous_end=s['end']
            frame=(ROOT/s['frame']).resolve()
            if not frame.is_relative_to((ROOT/'frames').resolve()): raise ValueError('invalid frame path')
            with frame.open('rb') as f:
                if f.read(2)!=b'\xff\xd8': raise ValueError('invalid JPEG')
            files+=1
        for name in ('audio.m4s',os.environ.get('REF_VIDEO_NAME','video.m4s'),'info.json'):
            p=ROOT/'raw'/b/name; stat=p.stat();raw_bytes+=stat.st_size
            inventory.append(f'{b}/{name}:{stat.st_size}:{stat.st_mtime_ns}\n')
        print('VERIFIED',b,len(asr),len(seg),len(crit),flush=True)
        return {'bvid':b,'files':files,'raw_bytes':raw_bytes,'inventory':inventory}
    except Exception as e:
        print('ERROR',b,str(e),flush=True)
        return {'bvid':b,'error':str(e),'files':files,'raw_bytes':raw_bytes,'inventory':inventory}

def main():
    started=time.monotonic()
    report=json.loads((ROOT/'pipeline-report.json').read_text())
    manifest=json.loads(os.environ['REF_MANIFEST'])
    errors=[]; files=0; raw_bytes=0; raw_sha=hashlib.sha256()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures=[pool.submit(verify_video, video) for video in manifest['videos']]
        results=[future.result() for future in as_completed(futures)]
    for result in sorted(results,key=lambda r:r['bvid']):
        files += result['files']; raw_bytes += result['raw_bytes']
        if result.get('error'): errors.append({'bvid':result['bvid'],'error':result['error']})
        for record in result['inventory']: raw_sha.update(record.encode())
    audit={'wall_seconds':round(time.monotonic()-started,3),'resource':{'cpus':8,'gpus':0,'io_threads':8},'expected':len(manifest['videos']),'verified':len(manifest['videos'])-len(errors),'errors':errors,'jpeg_files_checked':files,'raw_bytes':raw_bytes,'raw_inventory_sha256':raw_sha.hexdigest()}
    print('AUDIT',json.dumps(audit),flush=True)
    if os.environ.get('REF_AUDIT_WRITE')=='1':
        report['verification']=audit
        target=ROOT/'pipeline-report.json';tmp=target.with_suffix('.part');tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2));tmp.replace(target)
    if report['failed_videos'] or report['successful_videos']!=len(manifest['videos']): errors.append({'report':'incomplete'})
    if os.environ.get('REF_EXPORT')=='1':
        for relative in ['pipeline-report.json']+report['qa_files']:
            encoded=base64.b64encode((ROOT/relative).read_bytes()).decode()
            for i in range(0,len(encoded),32000):print('EXPORT '+json.dumps({'path':relative,'data':encoded[i:i+32000]}),flush=True)
    if errors: raise SystemExit(1)

if __name__=='__main__':main()
