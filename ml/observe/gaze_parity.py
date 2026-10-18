"""Bounded same-file gaze diagnostics; inference is called only by the Ray worker."""
import hashlib
import json
import math
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

import numpy as np


def difference(left, right):
    left, right = np.asarray(left), np.asarray(right)
    if left.shape != right.shape or not left.size or not np.isfinite(left).all() or not np.isfinite(right).all():
        raise ValueError('Comparable nonempty finite arrays required')
    delta = np.abs(left.astype(np.float64) - right.astype(np.float64))
    return {'elements': int(delta.size), 'different': int(np.count_nonzero(delta)),
            'maximumAbs': float(delta.max()), 'meanAbs': float(delta.mean()), 'exact': bool(np.array_equal(left, right))}


def normalise(vector):
    value = np.asarray(vector, dtype=np.float64)
    if value.shape != (512,) or not np.isfinite(value).all():
        raise ValueError('Expected 512 finite CLIP values')
    norm = float(np.linalg.norm(value))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError('Invalid CLIP norm')
    return value / norm


def selected_rows(records, root):
    root, selected = Path(root).resolve(), []
    counts = {'public': 0, 'photo': 0}
    order = sorted(records, key=lambda row: hashlib.sha256(('gaze-parity|' + str(row.get('id'))).encode()).digest())
    for row in order:
        kind = 'public' if str(row.get('id', '')).startswith('openimages-') else 'photo' if str(row.get('id', '')).startswith('photo-') else None
        value, file = row.get('features'), row.get('file')
        if kind is None or counts[kind] >= (3 if kind == 'public' else 2) or not isinstance(file, str):
            continue
        if not isinstance(value, list) or len(value) != 740 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                                                                 or not math.isfinite(v) for v in value):
            continue
        path = (root / file).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            continue
        selected.append((row, kind, path))
        counts[kind] += 1
    return selected, counts


# The RGB operations and double arithmetic below match ai-tags.clipImageVector.
NODE_INPUTS = r"""
import {readFile,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {observationsFromVector} from './src/core/observation-head.js';
const config=JSON.parse(await readFile(process.argv[1],'utf8'));
const mean=[.48145466,.4578275,.40821073],std=[.26862954,.26130258,.27577711],results=[];
for (const row of config.rows) {
  const {data}=await sharp(row.file).rotate().resize(224,224,{fit:'cover',kernel:'cubic'})
    .toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
  const pixels=224*224,input=new Float32Array(3*pixels);
  for(let i=0;i<pixels;i++) for(let c=0;c<3;c++) input[c*pixels+i]=(data[3*i+c]/255-mean[c])/std[c];
  await writeFile(row.prefix+'.rgb',data);
  const bytes=Buffer.alloc(input.length*4);
  for(let i=0;i<input.length;i++) bytes.writeFloatLE(input[i],i*4);
  await writeFile(row.prefix+'.f32le',bytes);
  const a=config.head.attributes[0]; let logit=a.bias;
  for(let i=0;i<row.features.length;i++) logit+=a.weights[i]*((row.features[i]-a.normalization.mean[i])/a.normalization.scale[i]);
  results.push({probability:1/(1+Math.exp(-logit/a.temperature)),
    items:observationsFromVector(row.features,config.head,{box:row.box})});
}
console.log(JSON.stringify({node:process.version,rows:results}));
"""


def node_inputs(root, samples, head, folder, expected_version):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    bundled = root.parent / f'node-{expected_version}-linux-{arch}' / 'bin/node'
    executable = str(bundled) if bundled.is_file() else shutil.which('node')
    if executable is None:
        raise RuntimeError('Node runtime unavailable')
    manifest = folder / 'inputs.json'
    rows = [{'file': str(file), 'prefix': str(folder / str(i)), 'features': row['features'], 'box': row.get('box', [.1,.1,.4,.4])}
            for i, (row, _kind, file) in enumerate(samples)]
    # Runtime result rows need not repeat the box; recover it from the acceptance manifest.
    boxes = {row['id']: row.get('box') for row in json.loads((root / 'accept-manifest.json').read_text())}
    for item, (row, _kind, _file) in zip(rows, samples):
        item['box'] = boxes.get(row['id'])
    manifest.write_text(json.dumps({'head': head, 'rows': rows}, allow_nan=False))
    completed = subprocess.run([executable, '--input-type=module', '--eval', NODE_INPUTS, str(manifest)],
                               cwd=root, capture_output=True, text=True, timeout=60)
    if completed.returncode:
        raise RuntimeError('Node preprocessing failed')
    data = json.loads(completed.stdout.strip().splitlines()[-1])
    if data.get('node') != expected_version or len(data.get('rows', [])) != len(samples):
        raise ValueError('Node preprocessing identity mismatch')
    return data['rows']


def same_items(actual, expected):
    if not isinstance(actual, list) or not isinstance(expected, list) or len(actual) != len(expected):
        return False
    for a, b in zip(actual, expected):
        if not isinstance(a, dict) or not isinstance(b, dict):
            return False
        for key in ('id', 'text', 'tone', 'source', 'box'):
            if a.get(key) != b.get(key):
                return False
        if not isinstance(a.get('confidence'), (int, float)) or not isinstance(b.get('confidence'), (int, float)):
            return False
        if not math.isfinite(a['confidence']) or not math.isfinite(b['confidence']) or abs(a['confidence'] - b['confidence']) > 1e-10:
            return False
    return True


def parity(root, output):
    """Return numeric same-file diagnostics without exporting images, IDs or file paths."""
    from ml.observe.embed import Encoder, clip_pixels, clip_preprocess, model_sha256
    from ml.observe.gaze_accept import probability
    from ml.observe.gaze_geometry import GeometryExtractor, geometry_terms_vector

    root = Path(root).resolve()
    output = (root / output).resolve()
    records = [json.loads(line) for line in (output / 'runtime-features.jsonl').read_text().splitlines() if line.strip()]
    samples, counts = selected_rows(records, root)
    result = {'requested': {'public': 3, 'photo': 2}, 'counts': counts, 'rows': [], 'passed': False,
              'scope': 'exact geometry, RGB/tensor and head evaluation on Node vectors; cross-runtime CLIP drift is reported separately'}
    if counts != result['requested']:
        result['error'] = 'insufficient valid same-file samples'
        return result
    config_path = root / 'accept-config.json'
    if not config_path.is_file():
        config_path = root / 'gaze-config.json'
    config = json.loads(config_path.read_text())
    head = json.loads((root / 'accept-heads/gaze.json').read_text())
    attribute = head['attributes'][0]
    if attribute['type'] != 'logistic' or not isinstance(attribute['weights'], list) or len(attribute['weights']) != 740:
        raise ValueError('Parity requires the full frozen logistic head')
    params = json.loads((output / 'research-model.json').read_text())
    if (any(params[key] != attribute[key] for key in ('weights', 'bias', 'temperature'))
            or any(params[key] != attribute['normalization'][key] for key in ('mean', 'scale'))
            or params['threshold'] != attribute['showThreshold']):
        raise ValueError('Parity head differs from frozen research parameters')
    models = {kind: (root / config['models'][kind]).resolve() for kind in ('clip', 'landmarker')}
    for kind, file in models.items():
        if model_sha256(file) != config['model_sha256'][kind]:
            raise ValueError('Parity model checksum mismatch')
    expected_node = json.loads((output / 'node-versions.json').read_text())['node']
    encoder = Encoder('clip', models['clip'], threads=2)
    with tempfile.TemporaryDirectory(prefix='gaze-parity-', dir=output) as temporary, GeometryExtractor(models['landmarker']) as geometry:
        folder = Path(temporary)
        nodes = node_inputs(root, samples, head, folder, expected_node)
        for index, ((row, kind, file), node) in enumerate(zip(samples, nodes)):
            raw = geometry.extract(file)
            if raw is None:
                result['rows'].append({'sample': index, 'kind': kind, 'error': 'geometry abstained on repeated input'})
                continue
            node_vector = np.asarray(row['features'], dtype=np.float64)
            terms = geometry_terms_vector(raw)
            clip = normalise(encoder.embed(file))
            python_vector = np.concatenate((terms, clip))
            p_same, p_python = probability(node_vector, params), probability(python_vector, params)
            node_pixels = np.fromfile(folder / (str(index) + '.rgb'), dtype=np.uint8).reshape(224,224,3)
            node_tensor = np.fromfile(folder / (str(index) + '.f32le'), dtype='<f4').reshape(1,3,224,224)
            cosine = float(np.dot(clip, node_vector[228:]) / np.linalg.norm(node_vector[228:]))
            expected_statement = p_same >= attribute['showThreshold']
            python_statement = p_python >= attribute['showThreshold']
            node_statement = isinstance(row.get('items'), list) and len(row['items']) == 1
            confidence_error = abs(row['items'][0]['confidence'] - p_same) if node_statement else 0.0
            result['rows'].append({'sample': index, 'kind': kind, 'cropSha256': model_sha256(file),
                'geometry': difference(terms, node_vector[:228]), 'raw19': difference(raw, node_vector[:19]),
                'clip': {**difference(clip, node_vector[228:]), 'cosine': cosine},
                'rgb224': difference(clip_pixels(file), node_pixels),
                'tensor224': difference(clip_preprocess(file), node_tensor),
                'head': {'pythonOnNodeProbability': p_same, 'nodeProbability': node['probability'],
                         'sameVectorProbabilityError': abs(p_same-node['probability']),
                         'pythonFeaturesProbability': p_python, 'pythonFeaturesProbabilityError': abs(p_same-p_python),
                         'nodeStatement': node_statement,
                         'sameVectorStatement': expected_statement, 'pythonFeaturesStatement': python_statement,
                         'sameVectorItemsMatch': same_items(row.get('items'), node.get('items')),
                         'sameVectorStatementMatches': node_statement == expected_statement,
                         'sameVectorConfidenceError': confidence_error,
                         'pythonFeaturesStatementMatches': python_statement == expected_statement}})
    rows = result['rows']
    result['gates'] = {'sampleCount': len(rows) == 5, 'geometry': all(row.get('geometry', {}).get('exact', False) for row in rows),
                       'pixels': all(row.get('rgb224', {}).get('exact', False) for row in rows),
                       'tensor': all(row.get('tensor224', {}).get('exact', False) for row in rows),
                       'head': all(row.get('head', {}).get('sameVectorItemsMatch', False)
                                   and row['head']['sameVectorStatementMatches']
                                   and row['head']['sameVectorProbabilityError'] <= 1e-10
                                   and row['head']['sameVectorConfidenceError'] <= 1e-10 for row in rows)}
    result['crossRuntimeClip'] = {'minimumCosine': min((row['clip']['cosine'] for row in rows if 'clip' in row), default=None),
                                 'maximumAbs': max((row['clip']['maximumAbs'] for row in rows if 'clip' in row), default=None),
                                 'statementDifferences': sum(not row['head']['pythonFeaturesStatementMatches'] for row in rows if 'head' in row)}
    result['passed'] = all(result['gates'].values())
    return result


__all__ = ['parity']
