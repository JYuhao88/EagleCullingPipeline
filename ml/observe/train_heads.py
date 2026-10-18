#!/usr/bin/env python3
"""Train local observation heads on teacher labels and check the student and launch gates.

Training rows are Open Images face crops where gemini-3.8-flash and gpt-6-sol gave the same non-abstaining answer,
minus the fixed 10% holdout. Calibration (temperature, show threshold) uses a hashed 15% of the rest. Acceptance
uses cached runtime Node CLIP features by default, or explicit model-bound ORT NPZ features for research encoders:

- student gate on held-out Open Images: agreement with the two-teacher label, ECE <= 0.05;
- student gate on CelebA truth: positive precision within 5 points of the two-teacher precision;
- launch gate on three-family references (Shantou photos and the Open Images holdout): positive precision >= 0.90
  (>= 0.95 without public truth) with the Wilson lower bound >= 0.85 and at least 140 positive statements.

Only attributes passing every gate are written to the head; the full report goes next to the inputs.
"""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np

CHEAP, STRONG, THIRD = 'gemini-3.8-flash', 'gpt-6-sol', 'claude-opus-5-5'
DEFAULT_ENCODER = 'clip-b32-q'
DEFAULT_DIMENSIONS = 512
CLIP_SHA = '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'
# Shown text, tone and launch precision per attribute; attributes without public truth need more.
# margin: calibration precision above launch; smile's teacher drifts toward slight smiles on photos.
ATTRIBUTES = {
    'smile': {'text': '在笑', 'tone': 'good', 'launch': 0.90, 'margin': 0.07},
    'mouth': {'text': '嘴张开', 'tone': 'neutral', 'launch': 0.90, 'margin': 0.03},
    'gaze': {'text': '看镜头', 'tone': 'neutral', 'launch': 0.95, 'margin': 0.03},
}
MIN_STATEMENTS = 140
# Open Images sampling dropped faces under 5% of the frame height, so smaller faces are out of distribution.
MIN_FACE_HEIGHT = 0.05


def bucket(value, salt):
    return int(hashlib.sha256((salt + '|' + value).encode()).hexdigest()[:8], 16) % 100


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def first(votes, model, ask=0):
    answers = votes.get(model) or []
    return answers[ask] if ask < len(answers) else None


def two_teacher(votes):
    """flash's first ask and gpt agree on a non-abstaining answer."""
    a, b = first(votes, CHEAP), first(votes, STRONG)
    return a if a is not None and a == b else None


def panel(votes):
    """flash majority of three asks, gpt and claude all give the same non-abstaining answer."""
    cheap = [v for v in (votes.get(CHEAP) or []) if v is not None]
    ones = sum(cheap)
    majority = 1 if ones >= 2 else 0 if len(cheap) - ones >= 2 else None
    group = [majority, first(votes, STRONG), first(votes, THIRD)]
    return group[0] if None not in group and len(set(group)) == 1 else None


def wilson_low(hits, n, z=1.96):
    if not n:
        return 0.0
    p, z2 = hits / n, z * z
    return (p + z2 / (2 * n) - z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n)


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


def fit_temperature(logits, labels):
    """1-D golden-section search on log T minimising the calibration-set negative log likelihood."""
    def nll(log_t):
        p = np.clip(sigmoid(logits / math.exp(log_t)), 1e-7, 1 - 1e-7)
        return -np.mean(labels * np.log(p) + (1 - labels) * np.log(1 - p))
    lo, hi, ratio = -3.0, 3.0, (math.sqrt(5) - 1) / 2
    for _ in range(80):
        a, b = hi - ratio * (hi - lo), lo + ratio * (hi - lo)
        lo, hi = (lo, b) if nll(a) < nll(b) else (a, hi)
    return math.exp((lo + hi) / 2)


def ece(probabilities, labels, bins=10):
    edges, total = np.linspace(0, 1, bins + 1), 0.0
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (probabilities >= low) & ((probabilities < high) | (high == 1))
        if mask.any():
            total += mask.mean() * abs(probabilities[mask].mean() - labels[mask].mean())
    return float(total)


def positive_scores(probabilities, labels, threshold):
    said = probabilities >= threshold
    hits = int((labels[said] == 1).sum())
    n = int(said.sum())
    return {'statements': n, 'coverage': round(n / max(1, len(labels)), 3),
            'precision': round(hits / n, 3) if n else None, 'precisionLow': round(wilson_low(hits, n), 3),
            'recall': round(hits / max(1, int((labels == 1).sum())), 3)}


def choose_threshold(probabilities, labels, target):
    """Smallest show threshold whose positive precision on the calibration rows reaches the target."""
    for threshold in np.arange(0.5, 0.995, 0.01):
        scores = positive_scores(probabilities, labels, threshold)
        if scores['statements'] >= 30 and scores['precision'] is not None and scores['precision'] >= target:
            return round(float(threshold), 2)
    return None


def _feature_ids(values, prefix=''):
    result = []
    for value in values:
        value = str(value)
        result.append(value if not prefix or value.startswith(prefix) else prefix + value)
    if not result or any(not value for value in result) or len(set(result)) != len(result):
        raise SystemExit('feature ids must be non-empty and unique')
    return result


def validate_feature_metadata(path, encoder_id, dimensions, model_sha256):
    metadata_path = Path(path).with_suffix('.json')
    if not metadata_path.exists():
        raise SystemExit(f'feature metadata sidecar missing: {metadata_path}')
    try:
        data = json.loads(metadata_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f'cannot read feature metadata {metadata_path}: {error}') from error
    encoder = data.get('encoder')
    metadata_id = encoder.get('id') if isinstance(encoder, dict) else encoder
    metadata_id = data.get('encoderId', data.get('encoder_id', metadata_id))
    metadata_dimensions = encoder.get('dimensions') if isinstance(encoder, dict) else None
    metadata_dimensions = data.get('dimensions', metadata_dimensions)
    if isinstance(metadata_dimensions, dict):
        metadata_dimensions = metadata_dimensions.get(encoder_id)
        if metadata_dimensions is None and metadata_id:
            metadata_dimensions = data['dimensions'].get(metadata_id)
    metadata_sha = encoder.get('modelSha256') if isinstance(encoder, dict) else None
    metadata_sha = data.get('modelSha256', data.get('model_sha256', metadata_sha))
    if isinstance(metadata_sha, dict):
        metadata_sha = metadata_sha.get(encoder_id)
        if metadata_sha is None and metadata_id:
            metadata_sha = data.get('modelSha256', data.get('model_sha256')).get(metadata_id)
    try:
        metadata_dimensions = int(metadata_dimensions)
    except (TypeError, ValueError):
        metadata_dimensions = -1
    if metadata_id != encoder_id or metadata_dimensions != dimensions or metadata_sha != model_sha256:
        raise SystemExit(f'feature metadata mismatch for {path}: expected encoder={encoder_id}, '
                         f'dimensions={dimensions}, modelSha256={model_sha256}')
    return metadata_path


def load_npz(path, prefix='', dimensions=None, encoder_id=None, model_sha256=None, require_metadata=False):
    path = Path(path)
    if require_metadata:
        validate_feature_metadata(path, encoder_id, dimensions, model_sha256)
    try:
        data = np.load(path, allow_pickle=False)
        ids, features = data['ids'], data['features']
    except (OSError, KeyError, ValueError) as error:
        raise SystemExit(f'invalid feature NPZ {path}: {error}') from error
    if features.ndim != 2 or (dimensions is not None and features.shape[1] != dimensions):
        raise SystemExit(f'feature dimensions mismatch for {path}: got {features.shape}, expected (*, {dimensions})')
    if len(ids) != len(features) or not np.isfinite(features).all():
        raise SystemExit(f'feature rows are invalid for {path}')
    names = _feature_ids(ids, prefix)
    return {name: row for name, row in zip(names, features)}


def load_node(path, encoder_id=DEFAULT_ENCODER, dimensions=DEFAULT_DIMENSIONS, model_sha256=CLIP_SHA):
    data = json.loads(Path(path).read_text())
    if data.get('encoder') != encoder_id or data.get('modelSha256') != model_sha256:
        raise SystemExit(f'Node features use a different {encoder_id} model')
    ids, features = data.get('ids'), data.get('features')
    if not isinstance(ids, list) or not isinstance(features, list) or len(ids) != len(features):
        raise SystemExit(f'invalid Node feature rows: {path}')
    values = np.asarray(features)
    if values.ndim != 2 or values.shape[1] != dimensions or not np.isfinite(values).all():
        raise SystemExit(f'Node feature dimensions mismatch for {path}: got {values.shape}, expected (*, {dimensions})')
    names = _feature_ids(ids)
    return {i: np.asarray(row, dtype=np.float64) for i, row in zip(names, values)}


def standardise(features):
    mean = features.mean(axis=0)
    scale = np.maximum(features.std(axis=0), 1e-6)
    return mean, scale


def train(x, y, c):
    from sklearn.linear_model import LogisticRegression
    model = LogisticRegression(C=c, max_iter=4000)
    model.fit(x, y)
    return model.coef_[0], float(model.intercept_[0])


def choose_c(x, y):
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_score
    scores = {c: cross_val_score(LogisticRegression(C=c, max_iter=4000), x, y, cv=5, scoring='neg_log_loss').mean()
              for c in (0.003, 0.01, 0.03, 0.1, 0.3, 1.0)}
    return max(scores, key=scores.get), {str(k): round(v, 4) for k, v in scores.items()}


def probabilities_for(features, ids, mean, scale, weights, bias, temperature):
    x = (np.stack([features[i] for i in ids]) - mean) / scale
    return sigmoid((x @ weights + bias) / temperature)


def run(args):
    encoder_id = getattr(args, 'encoder_id', None) or DEFAULT_ENCODER
    dimensions_arg = getattr(args, 'encoder_dimensions', None)
    dimensions = DEFAULT_DIMENSIONS if dimensions_arg is None else int(dimensions_arg)
    model_sha256 = getattr(args, 'model_sha256', None) or CLIP_SHA
    candidate = encoder_id != DEFAULT_ENCODER
    if (not encoder_id or dimensions < 1 or not isinstance(model_sha256, str)
            or not re.fullmatch(r'[0-9a-f]{64}', model_sha256)):
        raise SystemExit('encoder id, positive dimensions and model SHA-256 are required')
    oi_labels = {row['id']: row for row in read_jsonl(args.oi_labels)}
    holdout = {row['id'] for row in read_jsonl(args.holdout_items)}
    panel_labels = {row['id']: row for row in read_jsonl(args.panel_labels)} if args.panel_labels else {}
    p0_labels = {row['id']: row for row in read_jsonl(args.p0_labels)}
    for required, label in ((oi_labels, 'Open Images labels'), (holdout, 'holdout labels'), (p0_labels, 'p0 labels')):
        if not required:
            raise SystemExit(f'{label} are empty')
    oi_features = load_npz(args.oi_features, 'openimages-', dimensions=dimensions,
                           encoder_id=encoder_id, model_sha256=model_sha256, require_metadata=candidate)
    feature_paths = (getattr(args, 'p0_features', None), getattr(args, 'holdout_features', None))
    if candidate and not all(feature_paths):
        raise SystemExit('candidate encoders require --p0-features and --holdout-features')
    if any(feature_paths) and not all(feature_paths):
        raise SystemExit('--p0-features and --holdout-features must be supplied together')
    if all(feature_paths):
        p0_features = load_npz(feature_paths[0], dimensions=dimensions, encoder_id=encoder_id,
                               model_sha256=model_sha256, require_metadata=candidate)
        holdout_features = load_npz(feature_paths[1], dimensions=dimensions, encoder_id=encoder_id,
                                    model_sha256=model_sha256, require_metadata=candidate)
        expected_oi = set(oi_labels)
        expected_holdout = holdout
        expected_p0 = {row['id'] for row in p0_labels.values()
                       if row['set'] == 'celeba' or row.get('faceHeight') is not None}
        for name, features, expected in (('Open Images', oi_features, expected_oi),
                                         ('holdout', holdout_features, expected_holdout), ('p0', p0_features, expected_p0)):
            missing = expected - set(features)
            if missing:
                raise SystemExit(f'{name} features missing {len(missing)} labelled ids')
        node = {**p0_features, **holdout_features}
    else:
        node = load_node(args.p0_node, encoder_id, dimensions, model_sha256)
        node.update(load_node(args.holdout_node, encoder_id, dimensions, model_sha256) if args.holdout_node else {})
    report, head_attributes = {'inputs': vars(args),
                               'encoder': {'id': encoder_id, 'dimensions': dimensions, 'modelSha256': model_sha256},
                               'attributes': {}}, []
    for key, spec in ATTRIBUTES.items():
        rows = [(i, two_teacher(row['votes'].get(key, {}))) for i, row in oi_labels.items()
                if i in oi_features and i not in holdout]
        rows = [(i, y) for i, y in rows if y is not None]
        fit_rows = [(i, y) for i, y in rows if bucket(i, 'calibration') >= 15]
        cal_rows = [(i, y) for i, y in rows if bucket(i, 'calibration') < 15]
        x_fit = np.stack([oi_features[i] for i, _ in fit_rows]).astype(np.float64)
        y_fit = np.array([y for _, y in fit_rows])
        mean, scale = standardise(x_fit)
        c, c_scores = choose_c((x_fit - mean) / scale, y_fit)
        weights, bias = train((x_fit - mean) / scale, y_fit, c)
        cal_ids, y_cal = [i for i, _ in cal_rows], np.array([y for _, y in cal_rows])
        raw = (np.stack([oi_features[i] for i in cal_ids]) - mean) / scale @ weights + bias
        temperature = fit_temperature(raw, y_cal)
        p_cal = sigmoid(raw / temperature)
        threshold = choose_threshold(p_cal, y_cal, spec['launch'] + spec['margin'])
        entry = {'trainRows': len(fit_rows), 'calibrationRows': len(cal_rows), 'positiveRate': round(float(y_fit.mean()), 3),
                 'C': c, 'cvLogLoss': c_scores, 'temperature': round(temperature, 4), 'showThreshold': threshold,
                 'calibration': positive_scores(p_cal, y_cal, threshold or 0.99), 'eceCalibration': round(ece(p_cal, y_cal), 4)}
        hold = [(i, two_teacher(oi_labels[i]['votes'].get(key, {}))) for i in holdout if i in node and i in oi_labels]
        hold = [(i, y) for i, y in hold if y is not None]
        if hold:
            p = probabilities_for(node, [i for i, _ in hold], mean, scale, weights, bias, temperature)
            y = np.array([y for _, y in hold])
            entry['holdoutTeacher'] = {'ece': round(ece(p, y), 4),
                                       'accuracy': round(float(((p >= 0.5) == y).mean()), 3)}
            if threshold is not None:
                entry['holdoutTeacher'].update(positive_scores(p, y, threshold))
        gates = {}
        if threshold is not None:
            # Student gate on held-out encoder features against the two-teacher label.
            if hold:
                gates['ece'] = bool(entry['holdoutTeacher']['ece'] <= 0.05)
            # Student gate on CelebA truth, where it exists: compare with the two-teacher precision.
            truth_key = key if key in ('smile', 'mouth') else None
            if truth_key:
                celeba = [i for i, row in p0_labels.items() if row['set'] == 'celeba' and i in node]
                y = np.array([1 if p0_labels[i]['truth'][truth_key] else 0 for i in celeba])
                p = probabilities_for(node, celeba, mean, scale, weights, bias, temperature)
                teacher = [(two_teacher(p0_labels[i]['votes'].get(key, {})), t) for i, t in zip(celeba, y)]
                said = [t for v, t in teacher if v == 1]
                entry['celeba'] = {'student': positive_scores(p, y, threshold),
                                   'teacherPrecision': round(sum(said) / max(1, len(said)), 3), 'teacherStatements': len(said)}
                gates['celebaWithin5'] = bool((entry['celeba']['student']['precision'] or 0) >= entry['celeba']['teacherPrecision'] - 0.05)
            # Launch gate on three-family references: Shantou photos plus the Open Images holdout.
            refs = []
            for i, row in p0_labels.items():
                if row['set'] == 'photos' and i in node and (row.get('faceHeight') or 0) >= MIN_FACE_HEIGHT:
                    refs.append((i, panel(row['votes'].get(key, {})), 'photos'))
            for i in holdout:
                if i in node and i in panel_labels and i in oi_labels:
                    votes = {**oi_labels[i]['votes'].get(key, {})}
                    extra = panel_labels[i]['votes'].get(key, {})
                    cheap = list(votes.get(CHEAP) or [None])[:1] + list((extra.get(CHEAP) or [None, None, None])[1:3])
                    votes.update({CHEAP: cheap, THIRD: extra.get(THIRD)})
                    refs.append((i, panel(votes), 'openimages'))
            refs = [(i, y, s) for i, y, s in refs if y is not None]
            groups = [(name, [r for r in refs if r[2] == name]) for name in ('photos', 'openimages')] + [('all', refs)]
            for name, subset in groups:
                if subset:
                    p = probabilities_for(node, [i for i, _, _ in subset], mean, scale, weights, bias, temperature)
                    labels = np.array([y for _, y, _ in subset])
                    entry.setdefault('launch', {})[name] = positive_scores(p, labels, threshold)
                    if name == 'all':
                        said = p >= threshold
                        entry['launchReferenceScores'] = {'probabilities': p.tolist(), 'labels': labels.tolist(),
                                                          'ids': [i for i, _, _ in subset],
                                                          'sources': [source for _, _, source in subset],
                                                          'referenceHash': hashlib.sha256(json.dumps(sorted(subset),
                                                              separators=(',', ':')).encode()).hexdigest(),
                                                          'hits': int((labels[said] == 1).sum()),
                                                          'statements': int(said.sum()), 'rows': len(labels),
                                                          'positives': int((labels == 1).sum())}
            launch = entry.get('launch', {}).get('all')
            gates['launch'] = bool(launch and launch['statements'] >= MIN_STATEMENTS and launch['precision'] >= spec['launch']
                                   and launch['precisionLow'] >= 0.85)
        entry['gates'] = gates
        entry['passed'] = threshold is not None and all(gates.values()) and {'ece', 'launch'} <= gates.keys()
        report['attributes'][key] = entry
        if entry['passed']:
            head_attributes.append({'id': key, 'type': 'logistic', 'weights': [round(float(w), 7) for w in weights],
                                    'bias': round(bias, 7), 'normalization': {'mean': [round(float(m), 7) for m in mean],
                                                                              'scale': [round(float(s), 7) for s in scale]},
                                    'temperature': round(temperature, 6), 'showThreshold': threshold,
                                    'positive': {'text': spec['text'], 'tone': spec['tone']}})
    Path(args.report).write_text(json.dumps(report, indent=2, ensure_ascii=False))
    if head_attributes and args.head:
        head = {'version': args.version, 'encoder': {'id': encoder_id, 'dimensions': dimensions, 'modelSha256': model_sha256},
                'input': {'type': 'face-crop', 'expansion': 1.8, 'size': 384, 'minFaceHeight': MIN_FACE_HEIGHT},
                'attributes': head_attributes}
        Path(args.head).write_text(json.dumps(head, separators=(',', ':'), ensure_ascii=False) + '\n')
    print(json.dumps({key: {'passed': e['passed'], 'gates': e['gates'], 'threshold': e['showThreshold'],
                            'launch': e.get('launch', {}).get('all'), 'celeba': e.get('celeba'),
                            'holdout': e.get('holdoutTeacher')} for key, e in report['attributes'].items()},
                     indent=1, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    cache = 'data/cache/observe'
    parser.add_argument('--oi-labels', default=cache + '/p1-oi/labels.jsonl')
    parser.add_argument('--oi-features', default='data/cache/observe-oi/embeddings/clip-face.npz')
    parser.add_argument('--p0-features', default=None, help='candidate encoder p0 NPZ (ids/features)')
    parser.add_argument('--holdout-features', default=None, help='candidate encoder holdout NPZ (ids/features)')
    parser.add_argument('--holdout-items', default=cache + '/p1-panel/items.jsonl')
    parser.add_argument('--panel-labels', default=cache + '/p1-panel/labels.jsonl')
    parser.add_argument('--holdout-node', default=cache + '/p1-panel/node-clip-face.json')
    parser.add_argument('--p0-labels', default=cache + '/p0/labels.jsonl')
    parser.add_argument('--p0-node', default=cache + '/p0/node-clip-face.json')
    parser.add_argument('--encoder-id', default=DEFAULT_ENCODER)
    parser.add_argument('--encoder-dimensions', type=int, default=None)
    parser.add_argument('--model-sha256', default=None)
    parser.add_argument('--report', default=None)
    parser.add_argument('--head', default=None, help='write passing attributes here (src/core/observation-heads/...)')
    parser.add_argument('--version', default='clip-face-v1')
    args = parser.parse_args()
    if args.encoder_id == DEFAULT_ENCODER:
        args.encoder_dimensions = DEFAULT_DIMENSIONS if args.encoder_dimensions is None else args.encoder_dimensions
        args.model_sha256 = CLIP_SHA if args.model_sha256 is None else args.model_sha256
        args.report = cache + '/heads-report.json' if args.report is None else args.report
    else:
        missing = [name for name, value in (('--encoder-dimensions', args.encoder_dimensions),
                                             ('--model-sha256', args.model_sha256), ('--report', args.report),
                                             ('--head', args.head), ('--p0-features', args.p0_features),
                                             ('--holdout-features', args.holdout_features)) if value is None]
        if missing:
            parser.error('candidate encoder requires ' + ', '.join(missing))
    run(args)


if __name__ == '__main__':
    main()
