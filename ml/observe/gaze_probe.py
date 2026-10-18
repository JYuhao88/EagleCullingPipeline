#!/usr/bin/env python3
"""Screen gaze feature candidates with frozen splits; never export a runtime head.

Run feature extraction and fitting on a research worker. A passing screen still needs
the exact Node runtime input and encoder path, plus a separate parity check.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from ml.observe.gaze_geometry import geometry_terms_vector
from ml.observe.train_heads import (CHEAP, THIRD, MIN_FACE_HEIGHT, MIN_STATEMENTS,
                                    bucket, choose_c, ece, fit_temperature, panel,
                                    read_jsonl, sigmoid, standardise, train,
                                    two_teacher, wilson_low)

LAUNCH_PRECISION = 0.95
CALIBRATION_PRECISION = LAUNCH_PRECISION + 0.03


def positive_scores(probabilities, labels, threshold):
    said = np.asarray(probabilities) >= threshold
    labels = np.asarray(labels)
    n, hits = int(said.sum()), int((labels[said] == 1).sum())
    return {'statements': n, 'hits': hits, 'rows': len(labels),
            'coverage': n / len(labels) if len(labels) else 0.0,
            'precision': hits / n if n else None, 'precisionLow': wilson_low(hits, n),
            'recall': hits / max(1, int((labels == 1).sum()))}


def choose_threshold(probabilities, labels):
    for step in range(50, 100):
        threshold = step / 100
        scores = positive_scores(probabilities, labels, threshold)
        if scores['statements'] >= 30 and scores['precision'] >= CALIBRATION_PRECISION:
            return threshold
    return None


def launch_gate(scores):
    return bool(scores and scores['statements'] >= MIN_STATEMENTS
                and scores['precision'] is not None and scores['precision'] >= LAUNCH_PRECISION
                and scores['precisionLow'] >= 0.85)


def label_rows(source):
    rows = read_jsonl(source) if isinstance(source, (str, Path)) else list(source)
    result = {row['id']: row for row in rows}
    if len(result) != len(rows):
        raise ValueError('duplicate label ids')
    return result


def split_rows(oi, holdout):
    rows = [(i, two_teacher(row.get('votes', {}).get('gaze', {}))) for i, row in sorted(oi.items())
            if i.startswith('openimages-') and row.get('set') == 'openimages' and i not in holdout]
    rows = [(i, y) for i, y in rows if y is not None]
    return ([(i, y) for i, y in rows if bucket(i, 'calibration') >= 15],
            [(i, y) for i, y in rows if bucket(i, 'calibration') < 15])


def reference_rows(oi, panel_labels, p0, holdout):
    refs = [(i, panel(row.get('votes', {}).get('gaze', {})), 'photos')
            for i, row in sorted(p0.items()) if row.get('set') == 'photos'
            and (row.get('faceHeight') or 0) >= MIN_FACE_HEIGHT]
    for i in sorted(holdout):
        if i not in oi or i not in panel_labels or oi[i].get('set') != 'openimages':
            continue
        votes = dict(oi[i].get('votes', {}).get('gaze', {}))
        extra = panel_labels[i].get('votes', {}).get('gaze', {})
        cheap = list(votes.get(CHEAP) or [None])[:1] + list((extra.get(CHEAP) or [None, None, None])[1:3])
        votes.update({CHEAP: cheap, THIRD: extra.get(THIRD)})
        refs.append((i, panel(votes), 'openimages'))
    refs = [(i, y, group) for i, y, group in refs if y is not None]
    if len({i for i, _, _ in refs}) != len(refs):
        raise ValueError('duplicate reference ids')
    return refs


def feature_hash(features):
    digest = hashlib.sha256()
    dimensions = None
    for i, feature in sorted(features.items()):
        value = np.asarray(feature, dtype='<f8')
        if value.ndim != 1 or not value.size or not np.isfinite(value).all():
            raise ValueError('features must be nonempty finite vectors')
        if dimensions is not None and value.size != dimensions:
            raise ValueError('inconsistent feature dimensions')
        dimensions = value.size
        digest.update(i.encode() + b'\0' + value.tobytes())
    return digest.hexdigest(), dimensions


def rows_hash(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def research_model(name, mean, scale, weights, bias, temperature, c, threshold):
    arrays = [np.asarray(value, dtype=np.float64) for value in (mean, scale, weights)]
    scalars = np.asarray([bias, temperature, c, threshold], dtype=np.float64)
    if (any(value.ndim != 1 or not value.size or not np.isfinite(value).all() for value in arrays)
            or len({value.size for value in arrays}) != 1 or not np.isfinite(scalars).all()
            or (arrays[1] <= 0).any() or temperature <= 0 or c <= 0):
        raise ValueError('research model parameters must be finite with matching dimensions and positive scales')
    return {'researchOnly': True, 'name': name, 'mean': arrays[0].tolist(), 'scale': arrays[1].tolist(),
            'weights': arrays[2].tolist(), 'bias': float(bias), 'temperature': float(temperature),
            'C': float(c), 'threshold': float(threshold)}


def evaluate_candidates(features, oi_labels, panel_labels, p0_labels, holdout_ids, *, models=None):
    """Return screening metrics for name -> {full id: vector}; labels are paths or rows.

    No fitting uses panel, photo, or fixed-holdout labels. Missing features are counted
    per split rather than borrowing another candidate's vectors. The optional models
    mapping collects finite research parameters for candidates with a calibration threshold.
    """
    oi, extra, p0 = (label_rows(source) for source in (oi_labels, panel_labels, p0_labels))
    holdout = set(holdout_ids)
    fit_rows, cal_rows = split_rows(oi, holdout)
    hold_rows = [(i, two_teacher(oi[i].get('votes', {}).get('gaze', {}))) for i in sorted(holdout)
                 if i in oi and oi[i].get('set') == 'openimages']
    hold_rows = [(i, y) for i, y in hold_rows if y is not None]
    refs = reference_rows(oi, extra, p0, holdout)
    if {i for i, _ in fit_rows + cal_rows} & {i for i, _, _ in refs}:
        raise ValueError('training/calibration ids overlap launch references')
    report = {'screenOnly': True, 'shipped': False, 'candidates': {}, 'selectedCandidate': None,
              'requirements': {'precision': LAUNCH_PRECISION, 'precisionLow': 0.85,
                               'statements': MIN_STATEMENTS, 'ece': 0.05,
                               'calibrationPrecision': CALIBRATION_PRECISION, 'calibrationStatements': 30,
                               'minFaceHeight': MIN_FACE_HEIGHT},
              'inputs': {'oiLabelsSha256': rows_hash(oi), 'panelLabelsSha256': rows_hash(extra),
                         'p0LabelsSha256': rows_hash(p0), 'holdoutIdsSha256': rows_hash(sorted(holdout))},
              'split': {'train': len(fit_rows), 'calibration': len(cal_rows), 'holdout': len(hold_rows),
                        'references': len(refs), 'calibrationSalt': 'calibration', 'calibrationBuckets': [0, 14]}}
    for name, vectors in features.items():
        digest, dimensions = feature_hash(vectors)
        fit = [(i, y) for i, y in fit_rows if i in vectors]
        cal = [(i, y) for i, y in cal_rows if i in vectors]
        hold = [(i, y) for i, y in hold_rows if i in vectors]
        reference = [(i, y, group) for i, y, group in refs if i in vectors]
        entry = {'featuresSha256': digest, 'dimensions': dimensions, 'featureRows': len(vectors),
                 'trainRows': len(fit), 'calibrationRows': len(cal), 'showThreshold': None,
                 'missingFeatures': {'train': len(fit_rows) - len(fit), 'calibration': len(cal_rows) - len(cal),
                                     'holdout': len(hold_rows) - len(hold), 'references': len(refs) - len(reference)},
                 'gates': {'calibration': False, 'ece': False, 'launch': False}, 'metricPassed': False}
        report['candidates'][name] = entry
        y_fit, y_cal = np.array([y for _, y in fit]), np.array([y for _, y in cal])
        if not fit or min(int((y_fit == y).sum()) for y in (0, 1)) < 5 or not cal:
            entry['reason'] = 'insufficient training classes for five-fold CV or empty calibration'
            continue
        x_fit = np.stack([vectors[i] for i, _ in fit]).astype(np.float64)
        mean, scale = standardise(x_fit)
        c, c_scores = choose_c((x_fit - mean) / scale, y_fit)
        weights, bias = train((x_fit - mean) / scale, y_fit, c)

        def logits(rows):
            x = np.stack([vectors[row[0]] for row in rows]).astype(np.float64)
            return ((x - mean) / scale) @ weights + bias

        temperature = fit_temperature(logits(cal), y_cal)
        p_cal = sigmoid(logits(cal) / temperature)
        threshold = choose_threshold(p_cal, y_cal)
        entry.update({'C': c, 'cvLogLoss': c_scores, 'temperature': temperature,
                      'showThreshold': threshold, 'eceCalibration': ece(p_cal, y_cal),
                      'calibrationAt099': positive_scores(p_cal, y_cal, 0.99)})
        sweep = [{'threshold': step / 100, **positive_scores(p_cal, y_cal, step / 100)}
                 for step in range(50, 100)]
        eligible = [scores for scores in sweep if scores['statements'] >= 30]
        entry['bestCalibrationAtLeast30'] = min(eligible, key=lambda scores: (-scores['precision'],
                                                                            -scores['statements'], scores['threshold'])) if eligible else None
        if threshold is None:
            entry['reason'] = 'no calibration threshold reaches 0.98 precision with 30 statements'
            continue
        if models is not None:
            models[name] = research_model(name, mean, scale, weights, bias, temperature, c, threshold)
        entry['calibration'] = positive_scores(p_cal, y_cal, threshold)
        entry['gates']['calibration'] = True
        if hold:
            probabilities = sigmoid(logits(hold) / temperature)
            labels = np.array([y for _, y in hold])
            entry['holdoutTeacher'] = {**positive_scores(probabilities, labels, threshold),
                                       'ece': ece(probabilities, labels),
                                       'accuracy': float(((probabilities >= 0.5) == labels).mean())}
            entry['gates']['ece'] = bool(entry['holdoutTeacher']['ece'] <= 0.05)
        for group in ('photos', 'openimages', 'all'):
            subset = reference if group == 'all' else [row for row in reference if row[2] == group]
            if subset:
                probabilities = sigmoid(logits(subset) / temperature)
                entry.setdefault('launch', {})[group] = positive_scores(probabilities,
                                                                       np.array([row[1] for row in subset]), threshold)
        entry['gates']['launch'] = launch_gate(entry.get('launch', {}).get('all'))
        entry['metricPassed'] = all(entry['gates'].values())
    calibrated = [(name, entry) for name, entry in report['candidates'].items() if entry['showThreshold'] is not None]
    if calibrated:
        report['selectedCandidate'] = min(calibrated, key=lambda item: (-item[1]['calibration']['statements'],
                                                                       item[1]['eceCalibration'], item[0]))[0]
    report['selection'] = 'most calibration statements, then lowest calibration ECE, then name; no holdout selection'
    return report


def load_features(path):
    with np.load(path, allow_pickle=False) as data:
        ids, vectors = data['ids'], data['features']
        if len(ids) != len(vectors) or len(set(map(str, ids))) != len(ids):
            raise ValueError('feature ids must be unique and match vector count')
        return {str(i): row for i, row in zip(ids, vectors)}


def concatenate(left, right):
    return {i: np.concatenate((left[i], right[i])) for i in sorted(left.keys() & right.keys())}


def geometry_terms(features):
    return {i: geometry_terms_vector(vector) for i, vector in features.items()}


def eligible_faces(oi_items, p0):
    eligible = {i for i, row in p0.items() if row.get('set') == 'photos'
                and MIN_FACE_HEIGHT <= (row.get('faceHeight') or 0) <= 1}
    for row in oi_items:
        box = row.get('faceBox')
        if (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (float, int))
                and math.isfinite(v) and 0 <= v <= 1 for v in box)
                and box[2] > box[0] and box[3] - box[1] >= MIN_FACE_HEIGHT):
            eligible.add(row['id'])
    return eligible


def run(root, output):
    root, output = Path(root), Path(output)
    inputs = root / 'inputs'
    eyes = {kind: load_features(output / (kind + '-eye.npz')) for kind in ('clip', 'dino')}
    face = {kind: {'openimages-' + i: value for i, value in load_features(inputs / (kind + '-face.npz')).items()}
            for kind in ('clip', 'dino')}
    photos = label_rows(inputs / 'p0-labels.jsonl')
    with np.load(inputs / 'p0-face.npz', allow_pickle=False) as data:
        for kind in ('clip', 'dino'):
            for i, view, vector in zip(data['ids'], data['views'], data[kind]):
                i = str(i)
                if str(view) == 'face' and i in photos and photos[i].get('set') == 'photos':
                    norm = np.linalg.norm(vector.astype(np.float64))
                    if np.isfinite(norm) and norm > 0:
                        face[kind][i] = vector.astype(np.float64) / norm
    geometry = load_features(output / 'geometry.npz')
    features = {'clip-eye': eyes['clip'], 'dino-eye': eyes['dino'],
                'clip-eye-face': concatenate(eyes['clip'], face['clip']),
                'dino-eye-face': concatenate(eyes['dino'], face['dino']),
                'iris-geometry': geometry, 'iris-geometry-clip-face': concatenate(geometry, face['clip'])}
    nonlinear = geometry_terms(geometry)
    features.update({'iris-geometry-terms': nonlinear,
                     'iris-geometry-terms-clip-face': concatenate(nonlinear, face['clip'])})
    oi_items = read_jsonl(inputs / 'oi-items.jsonl')
    eligible = eligible_faces(oi_items, photos)
    features = {name: {i: value for i, value in vectors.items() if i in eligible}
                for name, vectors in features.items()}
    models = {}
    report = evaluate_candidates(features, inputs / 'oi-labels.jsonl', inputs / 'panel-labels.jsonl',
                                 inputs / 'p0-labels.jsonl',
                                 [row['id'] for row in read_jsonl(inputs / 'holdout-items.jsonl')], models=models)
    report['inputs']['oiItemsSha256'] = rows_hash(oi_items)
    report['faceHeightExcludedOpenImages'] = sum(row['id'] not in eligible for row in oi_items)
    selected = report['selectedCandidate']
    model = models[selected] if selected is not None else {'researchOnly': True, 'name': None, 'reason': 'no calibrated candidate'}
    (output / 'research-model.json').write_text(json.dumps(model, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    (output / 'gaze-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    print(json.dumps({'stage': 'gaze-screen', 'selectedCandidate': report['selectedCandidate'],
                      'candidates': {name: {'metricPassed': entry['metricPassed'], 'gates': entry['gates'],
                                             'showThreshold': entry['showThreshold'],
                                             'calibration': entry.get('calibration'),
                                             'launch': entry.get('launch', {}).get('all'),
                                             'holdoutTeacher': entry.get('holdoutTeacher'), 'reason': entry.get('reason')}
                                     for name, entry in report['candidates'].items()}}, ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--feature', action='append', required=True, metavar='NAME=PATH')
    parser.add_argument('--oi-labels', required=True)
    parser.add_argument('--panel-labels', required=True)
    parser.add_argument('--p0-labels', required=True)
    parser.add_argument('--holdout-items', required=True)
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    features = {}
    for item in args.feature:
        name, path = item.split('=', 1)
        if not name or name in features:
            parser.error('feature names must be nonempty and unique')
        features[name] = load_features(path)
    report = evaluate_candidates(features, args.oi_labels, args.panel_labels, args.p0_labels,
                                 [row['id'] for row in read_jsonl(args.holdout_items)])
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(report['candidates'], indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
