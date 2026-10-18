"""Five-fold linear probes; all fitted CelebA coefficients remain cache-only artifacts."""
import json
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ml.observe.metrics import binary_metrics, maximal_coverage, wilson_interval

ATTRIBUTES = ('smile', 'mouth')
RESOLUTIONS = (384, 160, 96)


def classifier(seed):
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=2000, random_state=seed))


def threshold_metrics(labels, probabilities, threshold):
    confidence = np.maximum(probabilities, 1 - probabilities)
    selected = confidence >= threshold
    prediction = probabilities >= 0.5
    count = int(selected.sum())
    correct = int(((prediction == labels) & selected).sum())
    positive = selected & prediction
    positive_count = int(positive.sum())
    positive_correct = int((positive & (labels == 1)).sum())
    return {'confidence_threshold': float(threshold), 'count': count, 'coverage': count / len(labels),
            'selective_accuracy': correct / count if count else None,
            'selective_accuracy_ci95': wilson_interval(correct, count),
            'predicted_positive': positive_count,
            'positive_precision': positive_correct / positive_count if positive_count else None,
            'positive_precision_ci95': wilson_interval(positive_correct, positive_count)}


def evaluate_probe(features, labels, holdout, holdout_labels, output, seed=20261016):
    labels, holdout_labels = np.asarray(labels), np.asarray(holdout_labels)
    if labels.ndim != 2 or labels.shape[1] != 2 or holdout_labels.shape[1:] != (2,):
        raise ValueError('Expected smile and mouth label columns')
    joint = 2 * labels[:, 0] + labels[:, 1]
    folds = list(StratifiedKFold(n_splits=5, shuffle=True, random_state=seed).split(labels, joint))
    if any(set(joint[validation]) != set(joint) for _, validation in folds):
        raise ValueError('Each fold must cover every joint label stratum')
    predictions, heads, rows = {}, {}, []
    fold_ids = np.empty(len(labels), dtype=np.int64)
    for fold_index, (_, validation) in enumerate(folds):
        fold_ids[validation] = fold_index
    for encoder in ('clip', 'dino'):
        matrix = np.asarray(features[encoder], dtype=np.float32)
        held_matrix = np.asarray(holdout[encoder], dtype=np.float32)
        if matrix.shape[:2] != (len(labels), 3) or held_matrix.shape[:2] != (len(holdout_labels), 3):
            raise ValueError('Feature dimensions differ from sample/resolution manifest')
        for resolution_index, resolution in enumerate(RESOLUTIONS):
            x, held_x = matrix[:, resolution_index], held_matrix[:, resolution_index]
            for attribute_index, attribute in enumerate(ATTRIBUTES):
                y, held_y = labels[:, attribute_index], holdout_labels[:, attribute_index]
                probability = np.empty(len(labels), dtype=np.float64)
                fold_metrics = []
                for fold_index, (train, validation) in enumerate(folds):
                    model = classifier(seed + fold_index)
                    model.fit(x[train], y[train])
                    probability[validation] = model.predict_proba(x[validation])[:, 1]
                    fold_metrics.append(binary_metrics(y[validation], probability[validation]))
                model = classifier(seed)
                model.fit(x, y)
                held_probability = model.predict_proba(held_x)[:, 1]
                cv_metrics = binary_metrics(y, probability)
                held_metrics = binary_metrics(held_y, held_probability)
                maximum = maximal_coverage(y, probability, minimum_accuracy=0.9, minimum_count=140)
                held_maximum = maximal_coverage(held_y, held_probability, minimum_accuracy=0.9, minimum_count=140)
                key = encoder + '_' + str(resolution) + '_' + attribute
                predictions[key + '_oof'] = probability
                predictions[key + '_holdout'] = held_probability
                scaler = model.named_steps['standardscaler']
                head = model.named_steps['logisticregression']
                heads[key + '_coef'] = head.coef_[0]
                heads[key + '_intercept'] = head.intercept_
                heads[key + '_scaler_mean'] = scaler.mean_
                heads[key + '_scaler_scale'] = scaler.scale_
                row = {'encoder': encoder, 'resolution': resolution, 'attribute': attribute,
                       'cv': cv_metrics, 'holdout': held_metrics, 'folds': fold_metrics,
                       'cv_max_90_accuracy': maximum, 'holdout_max_90_accuracy': held_maximum,
                       'holdout_at_cv_90_threshold': threshold_metrics(held_y, held_probability,
                                                                    maximum['confidence_threshold']) if maximum else None}
                rows.append(row)
                print('PROBE_REPORT ' + json.dumps({'stage': 'head', 'encoder': encoder, 'resolution': resolution,
                      'attribute': attribute, 'cv_accuracy': cv_metrics['accuracy'], 'cv_auroc': cv_metrics['auroc'],
                      'holdout_accuracy': held_metrics['accuracy'], 'holdout_auroc': held_metrics['auroc']}), flush=True)
    output = Path(output)
    np.savez_compressed(output / 'probe-predictions.npz', **predictions, labels=labels,
                        holdout_labels=holdout_labels, fold_ids=fold_ids)
    np.savez_compressed(output / 'probe-heads.npz', **heads)
    return {'protocol': {'n': len(labels), 'holdout_n': len(holdout_labels), 'folds': 5, 'seed': seed,
                         'stratification': 'Smiling x Mouth_Slightly_Open', 'classifier': 'standard scaler + logistic regression',
                         'regularization_C': 0.1, 'max_iter': 2000, 'hyperparameter_search': False,
                         'confidence': 'max(p, 1-p)',
                         'selective_accuracy': 'correct spoken labels / all spoken labels; positive PPV also reported',
                         'max_90_accuracy': 'descriptive confidence curve with at least 140 selected samples',
                         'weights': 'probe-heads.npz; CelebA research-only, never distribute or deploy'}, 'rows': rows}
