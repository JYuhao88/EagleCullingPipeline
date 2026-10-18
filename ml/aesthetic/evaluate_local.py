"""Read-only within-group human agreement and local teacher transfer metrics."""
import argparse
import base64
import gzip
import itertools
import json
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr, pearsonr


def predict(row, head):
    embedding = row.get('embedding')
    version = row.get('embeddingVersion') or 'dinov2-small-mean-patch-224-v1'
    if embedding is None or len(embedding) != 384 or version != head['embedding']['version']:
        return None
    x = (np.array(embedding) - head['normalization']['mean']) / head['normalization']['scale']
    if head.get('type') in ['mlp-int8', 'mlp-int16']:
        payload = base64.b64decode(head['weights'])
        if head['type'] == 'mlp-int16':
            payload = gzip.decompress(payload)
        dtype = '<i2' if head['type'] == 'mlp-int16' else np.int8
        weights = np.frombuffer(payload, dtype=dtype).reshape(len(head['bias']), 384)
        hidden = np.maximum((weights.astype(float) * np.array(head['quantization']['scales'])[:, None]) @ x
                            + head['bias'], 0)
        raw = np.dot(hidden, head['outputWeights']) + head['outputBias']
    else:
        raw = np.dot(x, head['weights']) + head['bias']
    return float(np.clip((raw - head['output']['offset']) / head['output']['scale'], 0, 1))


def agreement(results, decisions, groups, scores):
    pairs = []
    seen = set()
    group_ids = set()
    ties = 0
    for group in groups:
        members = [identifier for identifier in group['unitIds'] if identifier in decisions and identifier in results]
        for left, right in itertools.combinations(members, 2):
            key = tuple(sorted([left, right]))
            if key in seen:
                continue
            human = decisions[left] - decisions[right]
            if not human or scores.get(left) is None or scores.get(right) is None:
                continue
            seen.add(key)
            group_ids.add(group['id'])
            difference = scores[left] - scores[right]
            ties += int(difference == 0)
            pairs.append(0.5 if difference == 0 else float(difference * human > 0))
    return {'pairs': len(pairs), 'agreement': float(np.mean(pairs)) if pairs else None,
            'groups': len(group_ids), 'model_ties': ties, 'ties_credit': 0.5, 'human_ties': 'excluded'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--decisions', type=Path, required=True)
    parser.add_argument('--head', type=Path, required=True)
    parser.add_argument('--teacher', type=Path)
    parser.add_argument('--js-scores', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.results.read_text())
    head = json.loads(args.head.read_text())
    results = {row['unitId']: row for row in data['results']}
    levels = {'selected': 2, 'candidate': 1, 'rejected': 0}
    decisions = {}
    for row in json.loads(args.decisions.read_text()):
        if row.get('source') == 'human' and row.get('action') in levels:
            decisions[row['unitId']] = levels[row['action']]
    scores = {identifier: predict(row, head) for identifier, row in results.items()}
    js_difference = None
    if args.js_scores:
        js = {row['unitId']: row['aesthetic'] for row in json.loads(args.js_scores.read_text())['scores']}
        differences = [abs(value - js[identifier]) for identifier, value in scores.items()
                       if value is not None and identifier in js]
        if len(differences) != sum(value is not None for value in scores.values()):
            raise ValueError('JS/Python head coverage mismatch')
        js_difference = max(differences)
        if js_difference > 1e-7:
            raise ValueError('JS/Python head predictions differ')
        scores = js
    common = {identifier for identifier, value in scores.items() if value is not None}
    ranking_scores = {row['unitId']: row.get('score') for group in data['groups'] for row in group.get('ranking', [])}
    report = {'n': len(results), 'scored_n': len(common), 'human_n': len(decisions),
              'head': agreement(results, decisions, data['groups'], scores),
              'score': agreement(results, decisions, data['groups'],
                                 {identifier: ranking_scores.get(identifier, row.get('score'))
                                  for identifier, row in results.items() if identifier in common}),
              'raw_result_score': agreement(results, decisions, data['groups'],
                                 {identifier: row.get('score') for identifier, row in results.items() if identifier in common}),
              'score_source': 'groups[].ranking[].score; fallback results[].score',
              'js_max_abs_difference': js_difference}
    if args.teacher:
        rows = [row for row in json.loads(args.teacher.read_text())['rows'] if scores.get(row['unitId']) is not None]
        prediction = [scores[row['unitId']] for row in rows]
        target = [row['teacher_raw'] for row in rows]
        report['teacher'] = {'n': len(rows), 'srcc': float(spearmanr(prediction, target).statistic),
                             'plcc': float(pearsonr(prediction, target).statistic)}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
