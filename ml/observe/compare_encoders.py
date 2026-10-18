"""Compare frozen observation heads; reference-selected frontiers are descriptive only."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy as np

from ml.observe.train_heads import (ATTRIBUTES, CHEAP, THIRD, MIN_FACE_HEIGHT, MIN_STATEMENTS, load_node, panel,
                                    positive_scores, probabilities_for, read_jsonl, wilson_low)


GAZE_COUNTS = {'hits': 77, 'statements': 81, 'rows': 631, 'positives': 302}
BASELINE_COUNTS = {'smile': (647, 288), 'mouth': (668, 352), 'gaze': (631, 302)}


def reference_hash(rows):
    return hashlib.sha256(json.dumps(sorted(rows), separators=(',', ':')).encode()).hexdigest()


def reference_pools(oi_labels, p0_labels, panel_labels, holdout, features):
    pools = {}
    for key in ATTRIBUTES:
        refs = [(i, panel(row['votes'].get(key, {})), 'photos') for i, row in p0_labels.items()
                if row['set'] == 'photos' and i in features and (row.get('faceHeight') or 0) >= MIN_FACE_HEIGHT]
        for i in holdout:
            if i in features and i in panel_labels and i in oi_labels:
                votes = {**oi_labels[i]['votes'].get(key, {})}
                extra = panel_labels[i]['votes'].get(key, {})
                cheap = list(votes.get(CHEAP) or [None])[:1] + list((extra.get(CHEAP) or [None, None, None])[1:3])
                votes.update({CHEAP: cheap, THIRD: extra.get(THIRD)})
                refs.append((i, panel(votes), 'openimages'))
        pools[key] = sorted((i, y, source) for i, y, source in refs if y is not None)
    return pools


def metrics_from_counts(hits, statements, rows, positives):
    return {'hits': hits, 'statements': statements, 'rows': rows, 'positives': positives,
            'coverage': statements / rows if rows else 0.0,
            'precision': hits / statements if statements else None,
            'precisionLow': wilson_low(hits, statements), 'recall': hits / positives if positives else 0.0}


def frozen_metrics(probabilities, labels, threshold):
    said = probabilities >= threshold
    return metrics_from_counts(int((labels[said] == 1).sum()), int(said.sum()), len(labels), int(labels.sum()))


def descriptive_frontier(probabilities, labels, target):
    """Maximise empirical coverage at the target precision, retaining whole probability ties."""
    order = np.argsort(-probabilities, kind='stable')
    p, y = probabilities[order], labels[order]
    hits, positives, best = 0, int(y.sum()), None
    for index, (probability, label) in enumerate(zip(p, y)):
        if probability < 0.5:
            break
        hits += int(label)
        if index + 1 < len(p) and p[index + 1] == probability:
            continue
        statements = index + 1
        if hits * target['statements'] >= target['hits'] * statements:
            best = {'threshold': float(probability), **metrics_from_counts(hits, statements, len(y), positives)}
    return best


def validate_reference_scores(entry, refs):
    scores = entry.get('launchReferenceScores')
    if not isinstance(scores, dict):
        raise ValueError('missing launchReferenceScores for a frozen threshold')
    ids, labels, sources = (scores.get(name) for name in ('ids', 'labels', 'sources'))
    probabilities = scores.get('probabilities')
    if not all(isinstance(values, list) for values in (ids, labels, sources, probabilities)):
        raise ValueError('reference arrays must be lists')
    if not all(len(values) == len(refs) for values in (ids, labels, sources, probabilities)):
        raise ValueError('reference array length mismatch')
    if (not all(isinstance(i, str) for i in ids) or len(set(ids)) != len(ids)
            or not all(type(y) is int and y in (0, 1) for y in labels)
            or not all(source in ('photos', 'openimages') for source in sources)):
        raise ValueError('invalid reference ids, labels or sources')
    actual = list(zip(ids, labels, sources))
    expected_hash = reference_hash(refs)
    if (sorted(actual) != sorted(refs) or reference_hash(actual) != expected_hash
            or scores.get('referenceHash') != expected_hash):
        raise ValueError('reference population or hash mismatch')
    p, y = np.asarray(probabilities, dtype=np.float64), np.asarray(labels, dtype=np.int64)
    if p.ndim != 1 or not np.isfinite(p).all() or np.any((p < 0) | (p > 1)):
        raise ValueError('invalid reference probabilities')
    threshold = entry.get('showThreshold')
    if type(threshold) not in (int, float) or not 0.5 <= threshold <= 1:
        raise ValueError('invalid frozen threshold')
    frozen = frozen_metrics(p, y, threshold)
    if any(type(scores.get(key)) is not int or scores[key] != frozen[key]
           for key in ('hits', 'statements', 'rows', 'positives')):
        raise ValueError('exact frozen counts mismatch')
    if entry.get('launch', {}).get('all') != positive_scores(p, y, threshold):
        raise ValueError('rounded frozen launch metrics mismatch')
    return p, y, frozen


def passes_original_gates(entry, key):
    required = ('ece', 'launch') if key == 'gaze' else ('ece', 'celebaWithin5', 'launch')
    gates = entry.get('gates', {})
    return (entry.get('passed') is True and set(required) <= gates.keys()
            and all(value is True for value in gates.values()))


def validate_gate_flags(entry, key):
    gates = {}
    threshold = entry.get('showThreshold')
    if threshold is not None:
        holdout = entry.get('holdoutTeacher')
        if holdout:
            gates['ece'] = bool(holdout['ece'] <= 0.05)
        if key in ('smile', 'mouth'):
            celeba = entry['celeba']
            gates['celebaWithin5'] = bool((celeba['student']['precision'] or 0) >= celeba['teacherPrecision'] - 0.05)
        launch = entry.get('launch', {}).get('all')
        gates['launch'] = bool(launch and launch['statements'] >= MIN_STATEMENTS
                               and launch['precision'] >= ATTRIBUTES[key]['launch'] and launch['precisionLow'] >= 0.85)
    passed = threshold is not None and all(gates.values()) and {'ece', 'launch'} <= gates.keys()
    actual = entry.get('gates')
    if (not isinstance(actual, dict) or actual.keys() != gates.keys()
            or any(actual[name] is not value for name, value in gates.items()) or entry.get('passed') is not passed):
        raise ValueError(f'{key} gate flags contradict the frozen report metrics')


def validate_model_sidecars(path, encoder, precision):
    for source in ('oi', 'panel', 'p0'):
        sidecar = path.parent / precision / (source + '.json')
        try:
            metadata = json.loads(sidecar.read_text())
        except (OSError, ValueError) as error:
            raise ValueError(f'missing or invalid {precision}/{source}.json feature sidecar') from error
        if (not isinstance(metadata, dict) or metadata.get('encoder') != encoder['id'] or metadata.get('precision') != precision
                or type(metadata.get('dimensions')) is not int or metadata['dimensions'] != encoder['dimensions']
                or metadata.get('modelSha256') != encoder['modelSha256']):
            raise ValueError(f'{precision}/{source}.json feature identity differs from the training report')


def coverage_win(frozen, baseline):
    return bool(frozen['statements'] and baseline['statements']
                and frozen['hits'] * baseline['statements'] >= baseline['hits'] * frozen['statements']
                and frozen['statements'] * baseline['rows'] > baseline['statements'] * frozen['rows'])


def runtime_eligibility(attributes):
    retained = all(attributes[key]['passesOriginalGates'] for key in ('smile', 'mouth'))
    improved = [key for key in ('smile', 'mouth') if attributes[key]['coverageWinAtNoLowerPrecision']]
    extra = attributes['gaze']['passesOriginalGates']
    return {'eligibleForRuntimeCheck': retained and (bool(improved) or extra),
            'retainsSmileAndMouthGates': retained, 'coverageWins': improved, 'extraGazePasses': extra}


def build_baseline(report, head, features, pools):
    attributes = {}
    heads = {entry['id']: entry for entry in head['attributes']}
    for key, refs in pools.items():
        labels = np.array([y for _, y, _ in refs])
        if (len(refs), int(labels.sum())) != BASELINE_COUNTS[key]:
            raise ValueError(f'baseline {key} reference population changed')
        historical = report['attributes'][key]
        validate_gate_flags(historical, key)
        if key in heads:
            learned = heads[key]
            norm = learned['normalization']
            p = probabilities_for(features, [i for i, _, _ in refs], np.array(norm['mean']), np.array(norm['scale']),
                                  np.array(learned['weights']), learned['bias'], learned['temperature'])
            threshold = learned['showThreshold']
            frozen = frozen_metrics(p, labels, threshold)
            if threshold != historical['showThreshold'] or positive_scores(p, labels, threshold) != historical['launch']['all']:
                raise ValueError(f'published {key} head no longer reproduces the baseline launch point')
            frontier = descriptive_frontier(p, labels, frozen)
            origin = 'published head on cached Node features; frozen linear reevaluation'
        else:
            if key != 'gaze':
                raise ValueError(f'published baseline head is missing {key}')
            frozen = metrics_from_counts(**GAZE_COUNTS)
            threshold = historical['showThreshold']
            rounded = {name: (round(value, 3) if isinstance(value, float) else value)
                       for name, value in frozen.items() if name in historical['launch']['all']}
            if rounded != historical['launch']['all']:
                raise ValueError('historical gaze point differs from the verified exact counts')
            frontier, origin = None, 'historical frozen point; non-shipping gaze weights were not retained'
        attributes[key] = {'showThreshold': threshold, 'frozen': frozen, 'referenceHash': reference_hash(refs),
                           'gates': historical['gates'], 'passesOriginalGates': passes_original_gates(historical, key),
                           'holdoutTeacher': historical.get('holdoutTeacher'), 'celeba': historical.get('celeba'),
                           'descriptiveEqualPrecision': frontier, 'origin': origin}
    return {'encoder': head['encoder'], 'version': head['version'], 'attributes': attributes}


def compare_report(report, baseline, historical, pools):
    attributes = {}
    for key, refs in pools.items():
        entry = report['attributes'][key]
        validate_gate_flags(entry, key)
        previous = historical['attributes'][key]
        if any(entry.get(field) != previous[field] for field in ('trainRows', 'calibrationRows')):
            raise ValueError(f'{key} training/calibration population changed')
        target = baseline['attributes'][key]['frozen']
        result = {'showThreshold': entry.get('showThreshold'), 'gates': entry.get('gates', {}),
                  'passesOriginalGates': passes_original_gates(entry, key),
                  'holdoutTeacher': entry.get('holdoutTeacher'), 'celeba': entry.get('celeba'),
                  'referenceHash': reference_hash(refs), 'coverageWinAtNoLowerPrecision': False,
                  'frozen': None, 'descriptiveEqualPrecision': None,
                  'targetPrecision': target['precision']}
        if entry.get('showThreshold') is not None:
            p, y, frozen = validate_reference_scores(entry, refs)
            result.update(frozen=frozen, descriptiveEqualPrecision=descriptive_frontier(p, y, target),
                          coverageWinAtNoLowerPrecision=coverage_win(frozen, target))
        elif result['passesOriginalGates']:
            raise ValueError(f'{key} cannot pass without a frozen threshold')
        attributes[key] = result
    return {'encoder': report['encoder'], 'attributes': attributes, **runtime_eligibility(attributes)}


def compare(cache, candidate_root, head_path):
    cache, candidate_root = Path(cache), Path(candidate_root)
    historical = json.loads((cache / 'heads-report.json').read_text())
    head = json.loads(Path(head_path).read_text())
    encoder = head['encoder']
    features = load_node(cache / 'p0/node-clip-face.json', encoder['id'], encoder['dimensions'], encoder['modelSha256'])
    features.update(load_node(cache / 'p1-panel/node-clip-face.json', encoder['id'], encoder['dimensions'],
                              encoder['modelSha256']))
    oi_labels = {row['id']: row for row in read_jsonl(cache / 'p1-oi/labels.jsonl')}
    p0_labels = {row['id']: row for row in read_jsonl(cache / 'p0/labels.jsonl')}
    panel_labels = {row['id']: row for row in read_jsonl(cache / 'p1-panel/labels.jsonl')}
    holdout = {row['id'] for row in read_jsonl(cache / 'p1-panel/items.jsonl')}
    pools = reference_pools(oi_labels, p0_labels, panel_labels, holdout, features)
    baseline = build_baseline(historical, head, features, pools)
    candidates = []
    for path in sorted(candidate_root.glob('*/training-fp*.json')):
        name = str(path.relative_to(candidate_root))
        try:
            match = re.fullmatch(r'training-(fp32|fp16)\.json', path.name)
            if not match:
                raise ValueError('invalid training report filename')
            report = json.loads(path.read_text())
            encoder = report['encoder']
            if (encoder['id'] != path.parent.name or not re.fullmatch(r'[0-9a-f]{64}', encoder['modelSha256'])
                    or type(encoder['dimensions']) is not int or encoder['dimensions'] <= 0):
                raise ValueError('training report encoder identity mismatch')
            validate_model_sidecars(path, encoder, match[1])
            candidates.append({'report': name, 'precision': match[1], 'validated': True,
                               **compare_report(report, baseline, historical, pools)})
        except (ValueError, KeyError, TypeError) as error:
            candidates.append({'report': name, 'validated': False, 'eligibleForRuntimeCheck': False,
                               'validationError': str(error)})
    return {'protocol': {'acceptance': 'original frozen thresholds and original gates; no threshold changes',
                         'frontier': 'descriptive reference-selected maximum at baseline precision, thresholds >= 0.5; '
                                     'grouped ties; never a deployment threshold',
                         'eligibility': 'smile/mouth original gates pass, plus extra gaze pass or more frozen coverage '
                                        'for smile/mouth at no lower actual precision',
                         'baselinePrecision': 'exact hits/statements; no comparison using rounded precision'},
            'status': 'compared' if candidates else 'no-reports', 'reportsFound': len(candidates),
            'baseline': baseline, 'candidates': candidates,
            'eligibleForRuntimeCheck': [c['report'] for c in candidates if c['eligibleForRuntimeCheck']]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', default='data/cache/observe')
    parser.add_argument('--candidate-root', default='data/cache/w33-encoder')
    parser.add_argument('--head', default='src/core/observation-heads/clip-face-v1.json')
    parser.add_argument('--output', default=None)
    args = parser.parse_args()
    summary = compare(args.cache, args.candidate_root, args.head)
    output = Path(args.output or str(Path(args.candidate_root) / 'comparison.json'))
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: summary[key] for key in ('status', 'reportsFound', 'eligibleForRuntimeCheck')}))
    if any(not entry['validated'] for entry in summary['candidates']):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
