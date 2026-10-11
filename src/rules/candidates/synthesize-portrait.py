#!/usr/bin/env python3
"""Rebuild reviewed semantic annotations, locally, without model/network calls.

python3 src/rules/candidates/synthesize-portrait.py --data-root /tmp/w2-rules-data
The codebook and exact paraphrase index are the human-reviewed source of truth.
New/unreviewed text is an error, not automatically classified by keywords.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path

HIGH = {'夯', '顶尖', '人上人'}
LOW = {'NPC', '拉'}
OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def summarize(evs):
    segments = {(e['bvid'], e['segment']) for e in evs}
    episodes = len({e['bvid'] for e in evs})
    return {'episodes': episodes, 'videos': episodes, 'segments': len(segments),
            'positive': len({(e['bvid'], e['segment']) for e in evs if e['kind'] == 'praise'}),
            'negative': len({(e['bvid'], e['segment']) for e in evs if e['kind'] == 'issue'})}


def contrast(evs):
    return {'low': len({(e['bvid'], e['segment']) for e in evs if e['tier'] in LOW}),
            'high': len({(e['bvid'], e['segment']) for e in evs if e['tier'] in HIGH}),
            'unknown': len({(e['bvid'], e['segment']) for e in evs if e['tier'] not in HIGH | LOW}),
            'lowTiers': sorted(LOW), 'highTiers': sorted(HIGH)}


def representatives(evs, limit, polarity='negative'):
    # Prefer the rule's primary polarity and specific paraphrases, spread across
    # episodes. Tier is descriptive metadata, never a substitute for issue/praise.
    primary = 'praise' if polarity == 'positive' else 'issue'
    ordered = sorted(evs, key=lambda e: (e['kind'] != primary, -len(e['paraphrase']),
                                        e['bvid'], e['segment'], e['t']))
    selected, seen = [], set()
    for e in ordered:
        if e['bvid'] not in seen:
            selected.append(e)
            seen.add(e['bvid'])
            if len(selected) == limit:
                return selected
    for e in ordered:
        if e not in selected:
            selected.append(e)
            if len(selected) == limit:
                break
    return selected


def main(data):
    codebook = read(OUT / 'portrait-synthesis-codebook.json')
    labels = {e['paraphrase']: e['assignments'] for e in read(OUT / 'portrait-synthesis-index.json')['entries']}
    definitions = {r['id']: r for r in codebook['rules']}
    topics = {r['id']: r for r in codebook['nonSelection']}
    libraries = [read(ROOT / p) for p in ['src/rules/portrait.json', 'src/rules/general.json',
                                         'src/rules/candidates/xhs-candidates.json']]
    known = {r['id']: r for lib in libraries for r in lib['rules']}
    rows, hashes = {}, []
    for p in sorted((data / 'extracted').glob('*/*.json')):
        row = read(p)
        key = (row['bvid'], row['segment']['index'])
        if key in rows and row != rows[key]:
            raise ValueError(f'conflicting segment cache: {key}')
        rows[key] = row
        hashes.append(hashlib.sha256(p.read_bytes()).hexdigest())
    assert len(rows) == 6651, 'this reviewed index targets the 6651-segment extraction snapshot'
    buckets = collections.defaultdict(dict)
    negative_ids = collections.defaultdict(set)
    units = collections.Counter()
    unique_items, used_labels = set(), set()
    for key, row in sorted(rows.items()):
        for field, kind in [('issues', 'issue'), ('praises', 'praise')]:
            for item in row.get(field, []):
                text = item['text']
                identity = (*key, kind, item['t'], text)
                if identity in unique_items:
                    continue
                unique_items.add(identity)
                if text not in labels:
                    raise ValueError(f'unreviewed paraphrase: {text}')
                used_labels.add(text)
                ids = labels[text]
                category = ('vague' if ids == ['vague'] else 'unresolved' if ids == ['unresolved']
                            else 'nonSelection' if all(i.startswith('NS:') for i in ids) else 'selection')
                units[category] += 1
                if category in {'vague', 'unresolved'}:
                    continue
                frame = row.get('frame')
                if not frame or Path(frame).is_absolute() or '..' in Path(frame).parts:
                    raise ValueError(f'invalid frame: {key}')
                assert len(text) <= 40
                ev = {'bvid': row['bvid'], 'segment': key[1], 't': item['t'],
                      'paraphrase': text, 'text': text, 'tier': row.get('tier'),
                      'frame': frame, 'kind': kind,
                      'polarity': 'negative' if kind == 'issue' else 'positive'}
                for rid in ids:
                    assert rid in known or rid in definitions or rid in topics, rid
                    buckets[rid][identity] = ev
                    if kind == 'issue' and not rid.startswith('NS:'):
                        negative_ids[key].add(rid)
    rules, singleton = [], []
    for rid, definition in definitions.items():
        evs = list(buckets[rid].values())
        if not evs:
            continue
        freq = summarize(evs)
        if freq['episodes'] < 2 and rid != 'P-YD-EYE-CROP':
            singleton.append({'id': rid, 'frequency': freq, 'evidence': representatives(evs, 2)})
            continue
        checker = definition.get('check', {'by': 'teacher', 'evidence': ['wholeImage2048']})
        rule = {**definition, 'severity': 'hint', 'check': checker,
                'status': 'proposed', 'source': 'yidao-critiques', 'frequency': freq,
                'tierContrast': contrast(evs), 'evidence': representatives(evs, 4, definition['polarity'])}
        # Existing line/clipping signals are proxy hints, not aesthetic verdicts.
        # Other criteria need contextual judgment rather than invented signals.
        rule['sources'] = [f"bilibili:{e['bvid']}?t={e['t']}" for e in rule['evidence']]
        if freq['episodes'] == 1:
            rule['inclusionReason'] = '眼部边界裁切是具体且重要的可见硬伤；单期仅作提示，待截图核实。'
        rules.append(rule)
    rules.sort(key=lambda r: (-r['frequency']['episodes'], -r['frequency']['segments'], r['id']))
    kept = known.keys() | {r['id'] for r in rules}
    existing = []
    for rid in sorted(known):
        evs = list(buckets[rid].values())
        if evs:
            existing.append({'id': rid, 'source': 'yidao-critiques', 'frequency': summarize(evs),
                             'tierContrast': contrast(evs), 'evidence': evs,
                             'representatives': representatives(evs, 4)})
    non_selection = []
    for rid, topic in topics.items():
        evs = list(buckets[rid].values())
        if evs:
            non_selection.append({**topic, 'source': 'yidao-critiques', 'frequency': summarize(evs),
                                  'evidence': representatives(evs, 2)})
    non_selection.sort(key=lambda r: (-r['frequency']['episodes'], -r['frequency']['segments'], r['id']))
    # Preserve pre-existing tier-only rows for unextracted segments. Do not infer
    # rule violations from tier, verdict, vague criticism, or positive evidence.
    negatives_path = data / 'negatives.jsonl'
    negatives = {}
    if negatives_path.exists():
        for line in negatives_path.read_text().splitlines():
            n = json.loads(line)
            negatives[(n['bvid'], n['segment'])] = n
    for key, row in rows.items():
        if row.get('issues') or row.get('tier') in LOW or row.get('verdict') == 'bad':
            negatives[key] = {**negatives.get(key, {}), 'bvid': key[0], 'segment': key[1],
                              'tier': row.get('tier'), 'verdict': row.get('verdict'),
                              'labelingStatus': 'extracted', 'overallNegativeSignal': True}
    for key, n in negatives.items():
        ids = sorted(negative_ids[key] & kept)
        n['ruleIds'] = ids
        n['violatedRules'] = ids  # legacy compatibility
        if key not in rows:
            n['labelingStatus'] = 'tier-only-unextracted'
            n['overallNegativeSignal'] = True
    negatives_path.write_text(''.join(json.dumps(n, ensure_ascii=False) + '\n'
                                      for key, n in sorted(negatives.items())))
    total = sum(units.values())
    mapped_assignments = sum(len(e['evidence']) for e in existing)
    synthesis = {'method': 'codex-semantic', 'filteredVague': units['vague'],
                 'nonSelectionCount': units['nonSelection'], 'commentaryItems': total,
                 'filteredVagueRatio': round(units['vague'] / total, 6),
                 'unresolvedConcrete': units['unresolved'], 'selectionCount': units['selection'],
                 'mappedEvidenceAssignments': mapped_assignments,
                 'mappedUniqueItems': len({(e['bvid'], e['segment'], e['t'], e['kind'], e['text'])
                                          for r in existing for e in r['evidence']}),
                 'negativeSamples': len(negatives), 'negativeSamplesExtracted': sum(k in rows for k in negatives),
                 'tieredSegments': sum(bool(r.get('tier')) for r in rows.values()),
                 'episodes': len({k[0] for k in rows}),
                 'excludedSingleEpisode': singleton,
                 'annotationIndex': 'portrait-synthesis-index.json',
                 'codebook': 'portrait-synthesis-codebook.json',
                 'inputDigest': hashlib.sha256(''.join(hashes).encode()).hexdigest(),
                 'evidencePolicy': '候选最多4条、跨期优先；frequency为全量匹配的去重期数/段数；tierContrast为观察段数，非因果或误差率。'}
    versions = {(r['promptVersion'], r['rulesVersion']) for r in rows.values()}
    assert len(versions) == 1
    prompt, version = next(iter(versions))
    write(OUT / 'portrait-v0.2-candidates.json',
          {'contractVersion': 1, 'library': 'portrait', 'version': '0.2.0-candidates',
           'genres': libraries[0]['genres'], 'rules': rules, 'extractionStatus': 'complete',
           'inputSegments': len(rows), 'extractedSegments': len(rows),
           'promptVersion': prompt, 'rulesVersion': version, 'synthesis': synthesis})
    write(OUT / 'existing-evidence.json', {'contractVersion': 1, 'source': 'yidao-critiques', 'rules': existing,
                                          'mappedEvidenceAssignments': mapped_assignments})
    write(OUT / 'portrait-non-selection.json',
          {'contractVersion': 1, 'source': 'yidao-critiques', 'method': 'codex-semantic',
           'nonSelectionCount': units['nonSelection'], 'nonSelection': non_selection})
    print(json.dumps({'candidates': len(rules), 'aspects': dict(collections.Counter(r['aspect'] for r in rules)),
                      'nonSelectionTopics': len(non_selection), **synthesis}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, default=Path('/tmp/w2-rules-data'))
    main(parser.parse_args().data_root)
