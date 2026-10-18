"""Train-only CV and held-out AVA reporting for a small embedding aesthetic head."""
import argparse
import base64
import hashlib
import gzip
import json
import time
from pathlib import Path

import numpy as np
from scipy.stats import pearsonr, spearmanr
import sklearn
from sklearn.linear_model import Ridge
from sklearn.model_selection import GridSearchCV, KFold, cross_val_score
from sklearn.metrics import make_scorer
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def correlations(prediction, target):
    return {'srcc': float(spearmanr(prediction, target).statistic),
            'plcc': float(pearsonr(prediction, target).statistic)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--matrix', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--parity-report', type=Path, required=True)
    args = parser.parse_args()
    parity = json.loads(args.parity_report.read_text())
    if parity.get('n') != 20 or parity.get('cosine_min', 0) < 0.999 or not parity.get('pass') \
            or parity.get('modelSha256') != '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea':
        raise ValueError('Require the local ONNX parity gate before fitting')
    data = np.load(args.matrix, allow_pickle=False)
    train, test = data['split'] == 'train', data['split'] == 'generic_test'
    if not 19500 <= train.sum() <= 20000 or test.sum() != 5000:
        raise ValueError('Require approximately 20000 train and exactly 5000 disjoint generic_test rows')
    if len(set(data['ids'][train])) != train.sum() or len(set(data['ids'][test])) != 5000:
        raise ValueError('Duplicate AVA IDs within a split')
    if set(data['ids'][train]) & set(data['ids'][test]):
        raise ValueError('Train/test ID overlap')
    x, y = data['x'].astype(float), data['y'].astype(float) * 9 + 1
    if x.shape[1] != 384 or not np.isfinite(x).all() or not np.isfinite(y).all():
        raise ValueError('Invalid embedding matrix')
    if not np.allclose(np.linalg.norm(x, axis=1), 1, atol=1e-5):
        raise ValueError('Embedding matrix must already be L2 normalized')
    cv = KFold(n_splits=5, shuffle=True, random_state=26)
    ridge = GridSearchCV(make_pipeline(StandardScaler(), Ridge()),
                         {'ridge__alpha': [0.1, 1, 10, 100, 1000, 10000]},
                         scoring='neg_mean_squared_error', cv=cv, n_jobs=1)
    started = time.perf_counter()
    ridge.fit(x[train], y[train])
    mlp = make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(8,), alpha=1,
                        max_iter=150, early_stopping=True, validation_fraction=0.15,
                        random_state=26, batch_size=256, n_iter_no_change=12))
    mlp.fit(x[train], y[train])
    scorer = make_scorer(lambda target, prediction: float(spearmanr(target, prediction).statistic))
    comparison_cv = KFold(n_splits=3, shuffle=True, random_state=26)
    cv_scores = {name: cross_val_score(estimator, x[train], y[train], scoring=scorer,
                                     cv=comparison_cv, n_jobs=1).tolist()
                 for name, estimator in [('ridge', ridge.best_estimator_), ('mlp8', mlp)]}
    selected = 'mlp8' if np.mean(cv_scores['mlp8']) > np.mean(cv_scores['ridge']) + 0.02 else 'ridge'
    predictions = {'ridge': ridge.predict(x[test]), 'mlp8': mlp.predict(x[test])}
    report = {'train_n': int(train.sum()), 'generic_test_n': int(test.sum()),
              'alpha': ridge.best_params_['ridge__alpha'], 'cv': '5-fold train-only standardization; negative MSE',
              'seed': 26, 'teacher_ava_mos': correlations(y[test], data['mos'][test]),
              'architecture_cv_srcc': cv_scores, 'selected': selected,
              'seconds': time.perf_counter() - started, 'sklearn': sklearn.__version__, 'numpy': np.__version__,
              'mlp_epochs': mlp.named_steps['mlpregressor'].n_iter_, 'metrics': {}}
    for name, prediction in predictions.items():
        report['metrics'][name] = {'teacher': correlations(prediction, y[test]),
                                  'ava_mos': correlations(prediction, data['mos'][test])}
    scaler = ridge.best_estimator_.named_steps['standardscaler']
    regressor = ridge.best_estimator_.named_steps['ridge']
    weights = regressor.coef_ / scaler.scale_
    bias = regressor.intercept_ - np.dot(weights, scaler.mean_)
    head = {'version': 'dinov2-ava-topiq-ridge-v1',
            'embedding': {'version': 'dinov2-small-mean-patch-224-v1', 'dimensions': 384,
                          'modelSha256': '83141175ec78b4ff9a2bb58a4c7c264ba0054d1c2e122e5a8114b79a8d4179ea',
                          'pooling': 'mean-patch-excluding-cls-l2',
                          'image': {'shortEdge': 256, 'crop': [224, 224], 'kernel': 'lanczos3',
                                    'coverCenterRounding': 'ceil', 'jpegFastShrinkOnLoad': True,
                                    'embeddedIcc': 'sRGB', 'exifTranspose': False, 'rescale': 1 / 255,
                                    'mean': [0.485, 0.456, 0.406], 'std': [0.229, 0.224, 0.225]},
                          'preprocess': 'sharp JPEG fastShrinkOnLoad; ICC to sRGB; Lanczos3 cover256 ceil-center224; '
                                        '/255 ImageNet mean/std'},
            'weights': [float(f'{value:.8g}') for value in weights], 'bias': float(f'{bias:.10g}'),
            'normalization': {'mean': [0] * 384, 'scale': [1] * 384,
                              'note': 'Train standardization folded into coefficients; input already L2 normalized'},
            'output': {'offset': 1, 'scale': 9},
            'provenance': {'dataset': 'AVA', 'trainCount': int(train.sum()), 'genericTestCount': 5000, 'seed': 26,
                           'teacher': 'TOPIQ-IAA fixed512 ONNX; AVA raw MOS 1..10',
                           'teacherSha256': '1507e13834b375822b426adcf9984c1d2293d91270c887ff524bde7e32aed1ad',
                           'alpha': report['alpha'], 'parityCosineMin': parity['cosine_min'],
                           'trainIdsSha256': hashlib.sha256('\n'.join(data['ids'][train]).encode()).hexdigest(),
                           'testIdsSha256': hashlib.sha256('\n'.join(data['ids'][test]).encode()).hexdigest(),
                           'purpose': 'reference-only; excluded from decisions'}}
    if selected == 'mlp8':
        scaler = mlp.named_steps['standardscaler']
        regressor = mlp.named_steps['mlpregressor']
        first = regressor.coefs_[0] / scaler.scale_[:, None]
        hidden_bias = regressor.intercepts_[0] - scaler.mean_ @ first
        scales = np.maximum(np.abs(first).max(axis=0), 1e-12) / 127
        quantized = np.rint(first / scales).astype(np.int8).T.copy()
        output_weights = regressor.coefs_[1][:, 0]
        output_bias = float(regressor.intercepts_[1][0])
        quantized_prediction = np.maximum(x[test] @ (quantized.T.astype(float) * scales) + hidden_bias, 0) \
            @ output_weights + output_bias
        original_srcc = report['metrics']['mlp8']['teacher']['srcc']
        quantized_srcc = correlations(quantized_prediction, y[test])['srcc']
        bits = 8
        if original_srcc - quantized_srcc > 0.002:
            bits = 16
            scales = np.maximum(np.abs(first).max(axis=0), 1e-12) / 32767
            quantized = np.rint(first / scales).astype('<i2').T.copy()
            quantized_prediction = np.maximum(x[test] @ (quantized.T.astype(float) * scales) + hidden_bias, 0) \
                @ output_weights + output_bias
            quantized_srcc = correlations(quantized_prediction, y[test])['srcc']
            if original_srcc - quantized_srcc > 0.002:
                raise ValueError('Quantized MLP loses too much precision; do not export')
        report['metrics']['exported'] = {'teacher': correlations(quantized_prediction, y[test]),
                                         'ava_mos': correlations(quantized_prediction, data['mos'][test])}
        report['quantization_mean_abs_raw'] = float(np.abs(quantized_prediction - predictions['mlp8']).mean())
        payload = quantized.tobytes() if bits == 8 else gzip.compress(quantized.tobytes(), compresslevel=9, mtime=0)
        report['quantization_bits'] = bits
        head.update({'version': f'dinov2-ava-topiq-mlp8-int{bits}-v1', 'type': f'mlp-int{bits}',
                     'weights': base64.b64encode(payload).decode(),
                     'bias': [float(f'{value:.9g}') for value in hidden_bias],
                     'outputWeights': [float(f'{value:.9g}') for value in output_weights],
                     'outputBias': output_bias,
                     'quantization': {'dtype': 'int8' if bits == 8 else 'int16le', 'layout': 'hidden-input',
                                      'encoding': 'base64' if bits == 8 else 'gzip-base64',
                                      'scales': [float(f'{value:.9g}') for value in scales]}})
        head['provenance'].update({'architectureSelection': '3-fold train-only SRCC gain >0.02',
                                   'ridgeComparisonAlpha': report['alpha'], 'alpha': 1, 'hiddenUnits': 8,
                                   'earlyStoppingValidationFraction': 0.15, 'maxEpochs': 150})
    else:
        head['type'] = 'ridge'
        report['metrics']['exported'] = report['metrics']['ridge']
    args.output.write_text(json.dumps(head, separators=(',', ':')) + '\n')
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
