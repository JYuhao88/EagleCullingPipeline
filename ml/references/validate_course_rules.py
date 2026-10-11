#!/usr/bin/env python3
"""Check short, located course claims; never infer claims from topic counts."""
import argparse
import json
import math
from pathlib import Path


def validate(evidence, candidates, known_ids, manifests):
    if evidence.get('contractVersion')!=1 or candidates.get('contractVersion')!=1:
        raise ValueError('contract version')
    courses={c['slug']:c for c in evidence['courses']}
    videos=[(m['source'],v) for m in manifests for v in m['videos']]
    candidate_ids={r['id'] for r in candidates['rules']}
    if len(candidate_ids)!=len(candidates['rules']):raise ValueError('duplicate candidate IDs')
    if candidate_ids & known_ids:raise ValueError('candidate repeats an existing rule')
    all_ids=known_ids|candidate_ids

    def located(item):
        if item.get('courseSlug') not in courses:raise ValueError('unknown course')
        locator=item['locator']
        course=courses[item['courseSlug']]
        if locator['source']!=course['source']:raise ValueError('course/source mismatch')
        matching=[v for s,v in videos if s==locator['source'] and v['episode']==locator['episode']
                  and (not locator.get('course') or v['course']==locator['course'])
                  and ('page' in locator)==('pages' in v)]
        if locator.get('episodeId'):
            matching=[v for v in matching if locator['episodeId']==v.get('bvid')]
            if not matching:raise ValueError('episodeId does not match located episode')
        if len(matching)!=1:raise ValueError('missing or ambiguous episode; include locator.course')
        if matching[0]['count_only']:raise ValueError('count-only episode used as evidence')
        if 'pages' in matching[0]:
            page=locator.get('page')
            if type(page) is not int or not 1<=page<=matching[0]['pages']:
                raise ValueError('page locator outside document')
            if 'start' in locator or 'end' in locator:
                raise ValueError('page locator cannot include time range')
        else:
            if 'page' in locator:raise ValueError('page locator requires PDF document')
            if not all(type(locator.get(k)) in (int,float) and math.isfinite(locator[k]) for k in ('start','end')):
                raise ValueError('nonfinite locator')
            if not 0<=locator['start']<locator['end']:raise ValueError('invalid locator')
            if locator['end']>matching[0]['duration_seconds']+2:raise ValueError('locator exceeds duration')
        return (locator['source'],matching[0]['course'],locator['episode'],matching[0].get('bvid'))

    def claim(item):
        if item.get('kind') not in ('source','exception','counterpoint'):raise ValueError('invalid evidence kind')
        text=item.get('paraphrase')
        if not isinstance(text,str) or not 1<=len(text.strip())<=40:raise ValueError('paraphrase must be 1..40 characters')
        if item.get('ruleId') not in all_ids:raise ValueError('unknown rule ID')
        primary=located(item)
        supports=item.get('supports',[])
        distinct={primary}
        for support in supports:
            distinct.add(located({'courseSlug':item['courseSlug'],**support}))
        count=item.get('supportCount',1)
        if count!=len(distinct):raise ValueError('supportCount must equal distinct located episodes')

    for item in evidence['evidence']:claim(item)
    for rule in candidates['rules']:
        if rule.get('status')!='proposed' or rule.get('severity')!='hint':raise ValueError('candidate status/severity')
        if rule.get('source') not in {'course:'+slug for slug in courses}:raise ValueError('candidate source')
        if not 1<=len(rule.get('evidence',[]))<=4:raise ValueError('candidate must have 1..4 evidence items')
        for item in rule['evidence']:claim({'ruleId':rule['id'],**item})
    return {'evidence':len(evidence['evidence']),'candidates':len(candidates['rules'])}


def load_manifests(data, extra_paths=()):
    paths=[]
    for path in data.glob('*-manifest.json'):
        doc=json.loads(path.read_text())
        if doc.get('source') and path.name==doc['source']+'-manifest.json' and 'videos' in doc:
            paths.append(path)
    material=Path('/tmp/w4-mastercourses/materials-course-texts-manifest.json')
    durable=Path(__file__).with_name('courses_texts')/'processing-manifest.json'
    if material.is_file():paths.append(material)
    elif durable.is_file():paths.append(durable)
    paths.extend(extra_paths)
    manifests=[json.loads(path.read_text()) for path in dict.fromkeys(path.resolve() for path in paths)]
    existing=Path(__file__).with_name('portrait_courses_processing_manifest.json')
    if existing.is_file():
        seen={m['source'] for m in manifests}
        manifests.extend(m for m in json.loads(existing.read_text())['courses'] if m['source'] not in seen)
    meyerowitz=Path(__file__).with_name('meyerowitz_processing_manifest.json')
    if meyerowitz.is_file() and 'materials-courses-meyerowitz' not in {m['source'] for m in manifests}:
        manifests.append(json.loads(meyerowitz.read_text()))
    return manifests


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,default=Path('/tmp/w4-courses-data'))
    p.add_argument('--manifest',type=Path,action='append',default=[],help='Additional course manifest (repeatable)')
    a=p.parse_args();root=Path(__file__).resolve().parents[2]
    rules=root/'src/rules';known=set()
    for path in list(rules.glob('*.json'))+[rules/'candidates'/name for name in
               ('portrait-v0.2-candidates.json','book-candidates.json','paper-candidates.json','wulin-candidates.json','landscape-street-v0.2-candidates.json','xhs-candidates.json')]:
        if path.is_file():known.update(r['id'] for r in json.loads(path.read_text()).get('rules',[]))
    manifests=load_manifests(a.data,a.manifest)
    print(validate(json.loads((rules/'candidates/course-evidence.json').read_text()),
                   json.loads((rules/'candidates/course-candidates.json').read_text()),known,manifests))


if __name__=='__main__':main()
