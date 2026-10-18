"""Frozen-parameter acceptance on the observation runtime's gaze features.

This module writes research evidence only. A passing report never installs a head.
"""
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np

from ml.observe.gaze_probe import (CALIBRATION_PRECISION, eligible_faces, feature_hash,
                                   label_rows, launch_gate, positive_scores, reference_rows,
                                   research_model, rows_hash, split_rows)
from ml.observe.train_heads import MIN_FACE_HEIGHT, ece, fit_temperature, read_jsonl, two_teacher

DIMENSIONS = 740
ENCODER = 'mediapipe-iris-pose-q2-clip-b32-q'


def research_head(params, config):
    model = research_model(params['name'], params['mean'], params['scale'], params['weights'],
                           params['bias'], params['temperature'], params['C'], params['threshold'])
    if len(model['weights']) != DIMENSIONS or not 0.5 < model['threshold'] <= 1:
        raise ValueError('gaze head requires 740 dimensions and a valid display threshold')
    hashes = config['model_sha256']
    if any(not isinstance(hashes.get(key), str) or not re.fullmatch('[a-f0-9]{64}', hashes[key])
           for key in ('landmarker', 'clip')):
        raise ValueError('gaze head requires both model SHA-256 digests')
    return {'version': 'gaze-iris-q2-clip-v1',
            'encoder': {'id': ENCODER, 'dimensions': DIMENSIONS, 'modelSha256': hashes['landmarker'],
                        'clipModelSha256': hashes['clip']},
            'input': {'type': 'face-crop', 'expansion': 1.8, 'size': 384, 'minFaceHeight': MIN_FACE_HEIGHT},
            'attributes': [{'id': 'gaze', 'type': 'logistic', 'weights': model['weights'], 'bias': model['bias'],
                            'normalization': {'mean': model['mean'], 'scale': model['scale']},
                            'temperature': model['temperature'], 'showThreshold': model['threshold'],
                            'positive': {'text': '看镜头', 'tone': 'neutral'}}]}


def logit_for(vector, params):
    # Match the runtime's ordered JS double accumulation, including the initial bias.
    logit = float(params['bias'])
    for value, mean, scale, weight in zip(vector, params['mean'], params['scale'], params['weights']):
        logit += float(weight) * ((float(value) - float(mean)) / float(scale))
    if not math.isfinite(logit):
        raise ValueError('nonfinite gaze logit')
    return logit


def probability(vector, params):
    value = logit_for(vector, params) / float(params['temperature'])
    try:
        return 1 / (1 + math.exp(-value))
    except OverflowError:
        return 0.0


def runtime_vector(feature):
    value = np.asarray(feature, dtype=np.float64)
    if (not isinstance(feature, list) or value.shape != (DIMENSIONS,)
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in feature)
            or not np.isfinite(value).all()):
        raise ValueError('invalid vector')
    return value


def calibrate_runtime(root, output):
    """Fit temperature/threshold once on the frozen hashed Node calibration rows only."""
    root, output = Path(root), Path(output)
    marker = output / 'runtime-calibration.json'
    if marker.exists():
        raise ValueError('runtime calibration is already frozen for this output directory')
    inputs, model_path = root / 'inputs', output / 'research-model.json'
    original = model_path.read_bytes()
    params = json.loads(original)
    config = json.loads((root / 'gaze-config.json').read_text())
    research_head(params, config)
    oi = label_rows(inputs / 'oi-labels.jsonl')
    holdout = {row['id'] for row in read_jsonl(inputs / 'holdout-items.jsonl')}
    eligible = eligible_faces(read_jsonl(inputs / 'oi-items.jsonl'), {})
    _, cal = split_rows(oi, holdout)
    cal = [(i, y) for i, y in cal if i in eligible]
    records = label_rows(output / 'runtime-features.jsonl')
    vectors, labels, logits, invalid = {}, [], [], []
    for i, y in cal:
        feature = records.get(i, {}).get('features')
        if feature is None:
            continue
        try:
            value = runtime_vector(feature)
            logit = logit_for(value, params)
        except (TypeError, ValueError, OverflowError):
            invalid.append(i)
            continue
        vectors[i] = value
        logits.append(logit)
        labels.append(y)
    temperature = fit_temperature(np.asarray(logits), np.asarray(labels)) if logits else params['temperature']
    updated = {**params, 'temperature': float(temperature)}
    probabilities = np.asarray([probability(vector, updated) for vector in vectors.values()])
    labels = np.asarray(labels)
    threshold = None
    # The head contract requires a threshold strictly above 0.5.
    for step in range(51, 100):
        scores = positive_scores(probabilities, labels, step / 100)
        if scores['statements'] >= 30 and scores['precision'] >= CALIBRATION_PRECISION:
            threshold = step / 100
            break
    updated['threshold'] = threshold if threshold is not None else params['threshold']
    metadata = {'protocol': 'node-hashed-calibration-temperature-threshold-v1', 'researchOnly': True,
                'coefficientParametersFrozen': True, 'temperatureFit': bool(logits),
                'thresholdFound': threshold is not None, 'temperature': updated['temperature'],
                'threshold': updated['threshold'], 'previousTemperature': params['temperature'],
                'previousThreshold': params['threshold'], 'thresholdGrid': {'start': .51, 'end': .99, 'step': .01},
                'targetPrecision': CALIBRATION_PRECISION, 'minimumStatements': 30,
                'eligibleRows': len(cal), 'featureRows': len(vectors),
                'missingFeatures': len(cal) - len(vectors), 'invalidFeatureIds': invalid,
                'calibrationFeatureSha256': feature_hash(vectors)[0],
                'calibrationLabelsSha256': rows_hash(cal),
                'screeningModelSha256': hashlib.sha256(original).hexdigest(),
                'calibration': positive_scores(probabilities, labels, updated['threshold']),
                'eceCalibration': ece(probabilities, labels) if len(labels) else None}
    updated['runtimeCalibration'] = metadata
    head = research_head(updated, config)
    screening = output / 'screening-model.json'
    if screening.exists() and screening.read_bytes() != original:
        raise ValueError('screening model already exists with different parameters')
    screening.write_bytes(original)
    payload = json.dumps(updated, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    model_path.write_text(payload)
    (output / 'runtime-model.json').write_text(payload)
    (root / 'accept-heads').mkdir(exist_ok=True)
    (root / 'accept-heads/gaze.json').write_text(json.dumps(head, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    marker.write_text(json.dumps(metadata, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    return metadata


def display_parity(records, probabilities, eligible, threshold):
    mismatches, maximum_error, stated, checked = [], 0.0, 0, 0
    for i, row in records.items():
        items = row.get('items')
        p = probabilities.get(i)
        expected = i in eligible and p is not None and p >= 0.5 and p >= threshold
        reason = None
        if not isinstance(items, list):
            reason = 'items must be a list'
        elif len(items) != int(expected):
            reason = 'statement presence differs'
        elif expected:
            stated += 1
            item = items[0]
            confidence = item.get('confidence') if isinstance(item, dict) else None
            if (not isinstance(item, dict) or item.get('id') != 'gaze' or item.get('text') != '看镜头'
                    or item.get('tone') != 'neutral' or item.get('source') != 'model'
                    or isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                    or not math.isfinite(confidence)):
                reason = 'invalid gaze statement'
            else:
                checked += 1
                error = abs(confidence - p)
                maximum_error = max(maximum_error, error)
                if error > 1e-10:
                    reason = 'confidence differs'
        if reason:
            mismatches.append({'id': i, 'reason': reason})
    return {'rows': len(records), 'stated': stated, 'confidenceChecks': checked,
            'maximumConfidenceError': maximum_error, 'mismatchCount': len(mismatches),
            'mismatches': mismatches, 'passed': not mismatches}


def evaluate_runtime(root, output):
    root, output = Path(root), Path(output)
    inputs = root / 'inputs'
    model_path, features_path = output / 'research-model.json', output / 'runtime-features.jsonl'
    params = json.loads(model_path.read_text())
    config = json.loads((root / 'gaze-config.json').read_text())
    head = research_head(params, config)
    oi, extra, p0 = (label_rows(inputs / name) for name in
                     ('oi-labels.jsonl', 'panel-labels.jsonl', 'p0-labels.jsonl'))
    holdout = {row['id'] for row in read_jsonl(inputs / 'holdout-items.jsonl')}
    oi_items = read_jsonl(inputs / 'oi-items.jsonl')
    eligible = eligible_faces(oi_items, p0)
    fit, cal = split_rows(oi, holdout)
    cal = [(i, y) for i, y in cal if i in eligible]
    hold = [(i, two_teacher(oi[i].get('votes', {}).get('gaze', {}))) for i in sorted(holdout)
            if i in eligible and i in oi and oi[i].get('set') == 'openimages']
    hold = [(i, y) for i, y in hold if y is not None]
    refs = [(i, y, group) for i, y, group in reference_rows(oi, extra, p0, holdout) if i in eligible]
    if {i for i, _ in fit + cal} & {i for i, _, _ in refs}:
        raise ValueError('training/calibration ids overlap launch references')
    records = label_rows(features_path)
    vectors, invalid = {}, []
    probabilities = {}
    for i, row in records.items():
        feature = row.get('features')
        if feature is None:
            continue
        try:
            value = runtime_vector(feature)
            probabilities[i] = probability(value, params)
            vectors[i] = value
        except (TypeError, ValueError, OverflowError):
            invalid.append(i)
    digest, _ = feature_hash(vectors)
    parity = display_parity(records, probabilities, eligible, params['threshold'])
    required = {row[0] for row in cal + hold + refs}
    missing_rows = sorted(required - records.keys())
    report = {'researchOnly': True, 'shipped': False, 'name': params['name'], 'frozenParameters': True,
              'threshold': params['threshold'], 'temperature': params['temperature'], 'C': params['C'],
              'inputs': {'featuresSha256': digest,
                         'runtimeRowsSha256': hashlib.sha256(features_path.read_bytes()).hexdigest(),
                         'researchModelSha256': hashlib.sha256(model_path.read_bytes()).hexdigest(),
                         'headSha256': rows_hash(head), 'oiLabelsSha256': rows_hash(oi),
                         'panelLabelsSha256': rows_hash(extra), 'p0LabelsSha256': rows_hash(p0),
                         'holdoutIdsSha256': rows_hash(sorted(holdout)), 'oiItemsSha256': rows_hash(oi_items)},
              'featureRows': len(vectors), 'nullFeatureRows': sum(row.get('features') is None for row in records.values()),
              'invalidFeatureIds': invalid, 'missingRuntimeIds': missing_rows, 'parity': parity,
              'missingFeatures': {name: sum(row[0] not in vectors for row in subset)
                                  for name, subset in [('calibration', cal), ('holdout', hold), ('references', refs)]},
              'gates': {'featureValidity': not invalid, 'completeRuntimeRows': not missing_rows,
                        'parity': parity['passed'], 'calibration': False, 'ece': False, 'launch': False}}

    def scores(rows):
        subset = [row for row in rows if row[0] in vectors]
        p = np.asarray([probabilities[row[0]] for row in subset])
        y = np.asarray([row[1] for row in subset])
        result = positive_scores(p, y, params['threshold'])
        result['eligibleRows'] = len(rows)
        return result, p, y

    calibration, p_cal, y_cal = scores(cal)
    report['calibration'] = calibration
    report['eceCalibration'] = ece(p_cal, y_cal) if len(y_cal) else None
    report['gates']['calibration'] = (calibration['statements'] >= 30 and calibration['precision'] is not None
                                      and calibration['precision'] >= CALIBRATION_PRECISION)
    if 'runtimeCalibration' in params:
        report['runtimeCalibration'] = params['runtimeCalibration']
        report['gates']['runtimeCalibration'] = bool(params['runtimeCalibration'].get('thresholdFound'))
        report['gates']['calibration'] &= report['gates']['runtimeCalibration']
    holdout_scores, p_hold, y_hold = scores(hold)
    report['holdoutTeacher'] = {**holdout_scores, 'ece': ece(p_hold, y_hold) if len(y_hold) else None}
    report['gates']['ece'] = bool(len(y_hold) and report['holdoutTeacher']['ece'] <= 0.05)
    for group in ('photos', 'openimages', 'all'):
        subset = refs if group == 'all' else [row for row in refs if row[2] == group]
        report.setdefault('launch', {})[group] = scores(subset)[0]
    report['gates']['launch'] = launch_gate(report['launch']['all'])
    report['passed'] = all(report['gates'].values())
    (output / 'runtime-acceptance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    return report


__all__ = ['research_head', 'calibrate_runtime', 'evaluate_runtime']
