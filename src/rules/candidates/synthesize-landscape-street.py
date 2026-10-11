#!/usr/bin/env python3
"""Rebuild Wu Lin reviewed annotations without model or network calls.

python3 src/rules/candidates/synthesize-landscape-street.py --data-root /tmp/w3-genres-data/wulin
Exact paraphrases in the reviewed index are authoritative; unseen text fails.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
SOURCE = 'wulin-critiques'

def read(path):
    return json.loads(path.read_text())

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def summarize(evs):
    return dict(episodes=len({e['bvid'] for e in evs}), videos=len({e['bvid'] for e in evs}),
                segments=len({(e['bvid'], e['segment']) for e in evs}),
                positive=len({(e['bvid'], e['segment']) for e in evs if e['kind']=='praise'}),
                negative=len({(e['bvid'], e['segment']) for e in evs if e['kind']=='issue'}))

def representatives(evs, limit=4):
    # Spread episodes, include both observed polarities when available, prefer
    # locally available QA frames. No verdict-to-violation inference.
    result=[]; seen=set()
    ordered=sorted(evs,key=lambda e:(not e.get('localFrameAvailable'),e['bvid'],e['segment'],e['t'],e['text']))
    for kind in ('issue','praise'):
        match=next((e for e in ordered if e['kind']==kind and e['bvid'] not in seen),None)
        if match: result.append(match);seen.add(match['bvid'])
    for e in ordered:
        if len(result)>=limit: break
        if e['bvid'] not in seen: result.append(e);seen.add(e['bvid'])
    for e in ordered:
        if len(result)>=limit: break
        if e not in result: result.append(e)
    return [{k:v for k,v in e.items() if k!='localFrameAvailable'} for e in result]

def synthesize(data, out=OUT, minimum_episodes=3):
    book=read(out/'landscape-street-synthesis-codebook.json')
    entries=read(out/'landscape-street-synthesis-index.json')['entries']
    labels={e['paraphrase']:e['assignments'] for e in entries}
    if len(labels)!=len(entries): raise ValueError('duplicate paraphrase')
    defs={r['id']:r for r in book['rules']}
    topics={r['id']:r for r in book['nonSelection']}
    observations={r['id']:r for r in book.get('observations',[])}
    known={r['id'] for lib in ('landscape','street','general') for r in read(ROOT/f'src/rules/{lib}.json')['rules']}
    rows={}; hashes=[]
    for p in sorted((data/'extracted').glob('*/*.json')):
        raw=p.read_bytes();row=json.loads(raw);key=(row['bvid'],row['segment']['index'])
        if key in rows:
            if row!=rows[key]: raise ValueError(f'conflicting segment: {key}')
            continue
        rows[key]=row;hashes.append([str(p.relative_to(data/'extracted')),hashlib.sha256(raw).hexdigest()])
    if not rows: raise ValueError('empty extraction')
    import re
    qa=set()
    for p in (data/'qa').glob('BV*.html'):
        # Only locate embedded thumbnail IDs; never copy QA transcript text.
        qa.update((p.stem,int(n)) for n in re.findall(r'<b>#(\d+) ',p.read_text()))
    buckets=collections.defaultdict(list);counts=collections.Counter();seen=set()
    for key,row in sorted(rows.items()):
        for field,kind in (('issues','issue'),('praises','praise')):
            for item in row.get(field,[]):
                text=item['text'];t=item['t'];identity=(*key,kind,t,text,item.get('ruleId'))
                if identity in seen:continue
                seen.add(identity)
                if not isinstance(text,str) or not 0<len(text)<=40: raise ValueError('paraphrase must be 1..40 characters')
                if not isinstance(t,(int,float)) or not math.isfinite(t) or t<0: raise ValueError('invalid timestamp')
                if not row['segment']['start']<=t<=row['segment']['end']:raise ValueError(f'timestamp outside segment: {key}')
                frame=row['frame']
                if not re.fullmatch(r'frames/BV[A-Za-z0-9]+/\d{4}\.jpg',frame) or frame.split('/')[1]!=key[0] or int(Path(frame).stem)!=key[1]:raise ValueError(f'invalid frame: {frame}')
                mapped=item.get('ruleId')
                if mapped:
                    if mapped not in known:raise ValueError(f'unknown mapped rule: {mapped}')
                    ids=[mapped];category='mapped'
                else:
                    if text not in labels:raise ValueError(f'unreviewed paraphrase: {text}')
                    ids=labels[text]
                    if not ids:raise ValueError('empty assignment')
                    category='unresolved' if ids==['unresolved'] else 'vague' if ids==['vague'] else 'nonSelection' if all(i in topics for i in ids) else 'observation' if all(i in observations for i in ids) else 'selection'
                counts[category]+=1
                if category in ('unresolved','vague'):continue
                ev=dict(bvid=key[0],segment=key[1],t=t,paraphrase=text,text=text,frame=frame,tier=row.get('tier'),
                        kind=kind,polarity='negative' if kind=='issue' else 'positive',localFrameAvailable=key in qa)
                for rid in ids:
                    if rid not in known|defs.keys()|topics.keys()|observations.keys():raise ValueError(f'unknown assignment: {rid}')
                    buckets[rid].append(ev)
    cross=book.get('crossEvidence',[])
    candidates=[];excluded=[]
    for rid,d in defs.items():
        evs=buckets[rid];freq=summarize(evs)
        if freq['episodes']<minimum_episodes:
            excluded.append(dict(id=rid,frequency=freq,reason='fewer than 3 reviewed unmapped episodes'));continue
        rule={**d,'status':'proposed','severity':'hint','source':SOURCE,'check':{'by':'teacher','evidence':['wholeImage2048']},
              'frequency':freq,'supportEpisodes':freq['episodes'],'supportSegments':freq['segments'],
              'evidence':representatives(evs),'crossEvidence':[c for c in cross if rid in c.get('candidateIds',[])]}
        rule['sources']=[f"bilibili:{e['bvid']}?t={e['t']}" for e in rule['evidence']]
        candidates.append(rule)
    candidates.sort(key=lambda r:(-r['supportEpisodes'],-r['supportSegments'],r['id']))
    existing=[]
    for rid in sorted(known):
        evs=buckets[rid]
        if evs:existing.append(dict(id=rid,source=SOURCE,frequency=summarize(evs),evidence=[{k:v for k,v in e.items() if k!='localFrameAvailable'} for e in evs],representatives=representatives(evs)))
    non=[{**d,'source':SOURCE,'frequency':summarize(buckets[rid]),'commentaryItems':len(buckets[rid])} for rid,d in topics.items() if buckets[rid]]
    stats=dict(method='codex-semantic',episodes=len({k[0] for k in rows}),segments=len(rows),commentaryItems=sum(counts.values()),
               counts=dict(counts),mappedEvidenceAssignments=sum(len(r['evidence']) for r in existing),
               excludedBelowThreshold=excluded,topOpinions=[dict(id=r['id'],title=r['title'],episodes=r['supportEpisodes'],segments=r['supportSegments']) for r in candidates],
               inputDigest=hashlib.sha256(json.dumps(hashes,separators=(',',':')).encode()).hexdigest(),
               observationTopics=[{**d,'frequency':summarize(buckets[rid]),'commentaryItems':len(buckets[rid])} for rid,d in observations.items()],
               annotationIndex='landscape-street-synthesis-index.json',codebook='landscape-street-synthesis-codebook.json',
               evidencePolicy='候选最多4条，正反例及跨期优先；段数为(bvid,segment)去重，非独立照片数或因果支持。未归类转述明确待复核。')
    write(out/'landscape-street-v0.2-candidates.json',dict(contractVersion=1,library='landscape-street',version='0.2.0-candidates',genres=['landscape','nature','architecture','street','documentary'],rules=candidates,extractionStatus='complete',inputSegments=len(rows),extractedSegments=len(rows),synthesis=stats))
    write(out/'wulin-evidence.json',dict(contractVersion=1,source=SOURCE,rules=existing,mappedEvidenceAssignments=stats['mappedEvidenceAssignments'],crossEvidence=cross))
    write(out/'landscape-street-non-selection.json',dict(contractVersion=1,source=SOURCE,method='codex-semantic',nonSelectionCount=counts['nonSelection'],nonSelection=non))
    return stats

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root',type=Path,default=Path('/tmp/w3-genres-data/wulin'))
    parser.add_argument('--output-dir',type=Path,default=OUT)
    args=parser.parse_args()
    print(json.dumps(synthesize(args.data_root,args.output_dir),ensure_ascii=False))
