import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = code => {
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], { cwd: new URL('..', import.meta.url), encoding: 'utf8',
    timeout: 15000, env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
};

test('gaze screening keeps exact gate boundaries and never rounds a failure into a pass', () => run(`
import numpy as np
from ml.observe.gaze_probe import choose_threshold, launch_gate, positive_scores
assert not launch_gate({'statements': 140, 'precision': .9499, 'precisionLow': .9})
assert not launch_gate({'statements': 139, 'precision': 1, 'precisionLow': .9})
assert not launch_gate({'statements': 140, 'precision': .96, 'precisionLow': .8499})
assert launch_gate({'statements': 140, 'precision': .95, 'precisionLow': .85})
assert choose_threshold(np.full(29, .99), np.ones(29)) is None
assert choose_threshold(np.full(50, .99), np.array([1] * 49 + [0])) == .5
assert choose_threshold(np.full(50, .99), np.array([1] * 48 + [0] * 2)) is None
scores = positive_scores(np.ones(140), np.array([1] * 133 + [0] * 7), .99)
assert scores['hits'] == 133 and scores['statements'] == 140 and scores['precision'] == .95
`));

test('iris geometry requires both valid eyes and a nondegenerate head transform', () => run(`
import numpy as np
from ml.observe.gaze_geometry import EYES, geometry_features, pose_from_matrix
from ml.observe.gaze_probe import geometry_terms
points = [{'x': .5, 'y': .5, 'z': 0} for _ in range(478)]
for index, (corners, iris, uppers, lowers) in enumerate(EYES):
    center = .3 + .4 * index
    points[corners[0]] = {'x': center - .1, 'y': .4, 'z': 0}
    points[corners[1]] = {'x': center + .1, 'y': .4, 'z': 0}
    for i, (dx, dy) in zip(iris, [(0, 0), (.025, 0), (0, .025), (-.025, 0), (0, -.025)]):
        points[i] = {'x': center + dx, 'y': .4 + dy, 'z': 0}
    for i in uppers: points[i] = {'x': center, 'y': .37, 'z': 0}
    for i in lowers: points[i] = {'x': center, 'y': .43, 'z': 0}
result = geometry_features(points, np.eye(4))
assert result['poseAvailable'] and len(result['features']) == 19
assert np.isfinite(result['features']).all()
assert max(abs(x) for x in result['irisX']) < 1e-12
expanded = geometry_terms({'x': np.asarray(result['features'])})['x']
assert len(expanded) == 228 and np.isfinite(expanded).all()
assert geometry_features(points[:477], np.eye(4)) is None
assert pose_from_matrix(np.zeros((4, 4))) is None
points[133] = points[33]
assert geometry_features(points, np.eye(4)) is None
`));

test('Ray quota checks happen under the shared lock, release it after submit and reject an active own job', () => run(`
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
s = importlib.util.spec_from_file_location('gaze', 'scripts/observe-gaze-ray.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with TemporaryDirectory() as directory:
    root = Path(directory); m.LOCK = root / 'lock'
    counts = iter([2, 1]); calls = []
    def request(path, body=None):
        assert m.LOCK.is_dir() and (m.LOCK / 'owner.json').exists()
        calls.append(body)
        if body is None:
            return [{'status': 'RUNNING', 'submission_id': 'w' + str(i + 1) + '-fixture'} for i in range(next(counts))]
    m.SHARED.request = request
    with patch.object(m.time, 'sleep') as sleep:
        assert m.quota_submit({'submission_id': 'w33-gaze-0123456789ab'}, root, {}) == 'w33-gaze-0123456789ab'
        assert sleep.call_count == 1
    assert not m.LOCK.exists() and sum(value is not None for value in calls) == 1
    m.SHARED.request = lambda *args: [{'status': 'PENDING', 'submission_id': 'w33-gaze-existing'}]
    try:
        m.quota_submit({'submission_id': 'w33-gaze-0123456789ab'}, root, {})
    except RuntimeError:
        pass
    else:
        raise AssertionError('concurrent own job allowed')
    assert not m.LOCK.exists()
`));

test('geometry resume skips eye encoders and records all abstentions without stacking an empty array', () => run(`
import os, json
from pathlib import Path
from tempfile import TemporaryDirectory
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import ml.observe.gaze_ray as worker
import ml.observe.gaze_geometry as geometry
previous = Path.cwd()
with TemporaryDirectory() as directory:
    try:
        os.chdir(directory)
        Path('manifest.jsonl').write_text(json.dumps({'id': 'photo-fixture', 'remote': False, 'face': 'fixture.png'}) + '\\n')
        config = {'mode': 'geometry', 'models': {'landmarker': 'fixture'}, 'model_sha256': {}}
        with patch.object(worker, 'materialize_models'), patch.object(worker, 'extract_eyes', side_effect=AssertionError(
                'eyes recomputed')), patch.object(worker, 'export'), patch.object(geometry, 'GeometryExtractor',
                return_value=nullcontext(SimpleNamespace(extract=lambda file: None))):
            worker.run(config)
        features = np.load('output/geometry.npz', allow_pickle=False)
        assert features['features'].shape == (0, 19)
        assert json.loads(Path('output/extraction.json').read_text())['geometryValid'] == 0
        assert not Path('output/clip-eye.npz').exists()
    finally:
        os.chdir(previous)
`));

test('gaze fitting excludes fixed holdout, photos, CelebA and small-face reference rows', () => run(`
from ml.observe.gaze_probe import reference_rows, split_rows, eligible_faces
from ml.observe.train_heads import CHEAP, STRONG, THIRD
def row(i, kind='openimages', height=None):
    return {'id': i, 'set': kind, 'faceHeight': height,
            'votes': {'gaze': {CHEAP: [1, 1, 1], STRONG: [1], THIRD: [1]}}}
oi = {r['id']: r for r in [row('openimages-fit'), row('openimages-hold'), row('celeba-x', 'celeba'), row('photo-x', 'photos', .1)]}
fit, cal = split_rows(oi, {'openimages-hold'})
assert {i for i, _ in fit + cal} == {'openimages-fit'}
p0 = {r['id']: r for r in [row('photo-small', 'photos', .0499), row('photo-ok', 'photos', .05), row('celeba-x', 'celeba', .5)]}
refs = reference_rows(oi, {'openimages-hold': row('openimages-hold')}, p0, {'openimages-hold'})
assert {i for i, _, _ in refs} == {'openimages-hold', 'photo-ok'}
eligible = eligible_faces([{'id': 'boundary-pass', 'faceBox': [0, 0, .1, .05]},
                           {'id': 'boundary-below', 'faceBox': [0, .3, .1, .35]}], p0)
assert 'boundary-pass' in eligible and 'boundary-below' not in eligible
assert 'photo-ok' in eligible and 'photo-small' not in eligible
`));

test('Ray gaze submission accepts only own job ids and metadata-free bounded crops', () => run(`
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image
from PIL.PngImagePlugin import PngInfo
s = importlib.util.spec_from_file_location('gaze', 'scripts/observe-gaze-ray.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
assert m.own('w33-gaze-0123456789ab') == 'w33-gaze-0123456789ab'
for value in ['w32-gaze-0123456789ab', 'w33-gaze-../../x', 'w33-gaze-', 'w33-gaze-0123456789ab/stop']:
    try:
        m.own(value)
    except ValueError:
        pass
    else:
        raise AssertionError(value)
with TemporaryDirectory() as directory:
    root = Path(directory); (root / 'images').mkdir()
    Image.new('RGB', (384, 384)).save(root / 'images/good.png')
    assert m.photo_crop(root, 'images/good.png').name == 'good.png'
    Image.new('RGB', (769, 32)).save(root / 'images/large.jpg')
    image = Image.new('RGB', (32, 32)); exif = image.getexif(); exif[270] = 'fixture metadata'
    image.save(root / 'images/exif.jpg', exif=exif)
    metadata = PngInfo(); metadata.add_text('comment', 'fixture metadata')
    image.save(root / 'images/comment.png', pnginfo=metadata)
    for value in ['../escape.jpg', 'images/large.jpg', 'images/exif.jpg', 'images/comment.png']:
        try:
            m.photo_crop(root, value)
        except ValueError:
            pass
        else:
            raise AssertionError(value)
`));

test('research parameter collection preserves screening and calibration-only selection without exporting a head', () => run(`
from unittest.mock import patch
import numpy as np
from ml.observe import gaze_probe as probe
from ml.observe.train_heads import CHEAP, STRONG
rows = []
for index in range(500):
    item = 'openimages-' + str(index)
    label = 1 if probe.bucket(item, 'calibration') < 15 else index % 2
    rows.append({'id': item, 'set': 'openimages', 'votes': {'gaze': {CHEAP: [label], STRONG: [label]}}})
vectors = {row['id']: np.array([index + 1.0]) for index, row in enumerate(rows)}
models = {}
with patch.object(probe, 'choose_c', return_value=(.1, {})), patch.object(probe, 'train', return_value=(np.array([0.]), 10.)), patch.object(
        probe, 'fit_temperature', return_value=1.):
    plain = probe.evaluate_candidates({'eye': vectors}, rows, [], [], [])
    collected = probe.evaluate_candidates({'eye': vectors}, rows, [], [], [], models=models)
assert plain == collected and collected['selectedCandidate'] == 'eye'
model = models['eye']
assert model['researchOnly'] and model['name'] == 'eye'
assert {'mean', 'scale', 'weights', 'bias', 'temperature', 'C', 'threshold'} <= model.keys()
assert model['weights'] == [0.] and model['bias'] == 10. and model['threshold'] == .5
assert 'encoder' not in model and 'attributes' not in model and not collected['shipped']
with patch.object(probe, 'choose_c', return_value=(.1, {})), patch.object(
        probe, 'train', return_value=(np.array([0.]), -10.)), patch.object(probe, 'fit_temperature', return_value=1.):
    empty = {}; report = probe.evaluate_candidates({'eye': vectors}, rows, [], [], [], models=empty)
assert empty == {} and report['selectedCandidate'] is None
for mean, scale, weights, bias, temperature, c in [([np.nan], [1], [0], 1, 1, 1), ([0], [0], [0], 1, 1, 1),
                                                   ([0], [1], [0], np.inf, 1, 1), ([0], [1], [0], 1, 0, 1)]:
    try:
        probe.research_model('fixture', mean, scale, weights, bias, temperature, c, .9)
    except ValueError:
        pass
    else:
        raise AssertionError('invalid parameters exported')
`));

test('gaze fit wrapper uses canonical geometry terms and saves only selected finite research parameters', () => run(`
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from ml.observe import gaze_probe as probe
from ml.observe.gaze_geometry import geometry_terms_vector
name = 'iris-geometry-terms-clip-face'
with TemporaryDirectory() as directory:
    root = Path(directory); inputs = root / 'inputs'; output = root / 'output'
    inputs.mkdir(); output.mkdir()
    item = 'openimages-fixture'
    for kind, size in [('clip', 512), ('dino', 384)]:
        np.savez(inputs / (kind + '-face.npz'), ids=['fixture'], features=np.ones((1, size)))
        np.savez(output / (kind + '-eye.npz'), ids=[item], features=np.ones((1, size)))
    raw = np.asarray(np.arange(19) / 100, dtype=np.float32)
    np.savez(output / 'geometry.npz', ids=[item], features=raw[None])
    np.savez(inputs / 'p0-face.npz', ids=np.array([], dtype='U1'), views=np.array([], dtype='U1'),
             clip=np.empty((0, 512)), dino=np.empty((0, 384)))
    for file in ['oi-labels.jsonl', 'panel-labels.jsonl', 'p0-labels.jsonl', 'holdout-items.jsonl']:
        (inputs / file).write_text('')
    (inputs / 'oi-items.jsonl').write_text(json.dumps({'id': item, 'faceBox': [0, 0, .1, .1]}) + '\\n')
    def evaluate(features, *args, models=None):
        np.testing.assert_array_equal(features[name][item][:228], geometry_terms_vector(raw))
        assert len(features[name][item]) == 740
        models[name] = probe.research_model(name, np.zeros(740), np.ones(740), np.zeros(740), 1, 1, .1, .91)
        return {'inputs': {}, 'selectedCandidate': name, 'candidates': {}}
    with patch.object(probe, 'evaluate_candidates', side_effect=evaluate):
        report = probe.run(root, output)
    exported = json.loads((output / 'research-model.json').read_text())
    assert exported['researchOnly'] and exported['name'] == name and exported['threshold'] == .91
    assert exported['weights'] == [0.] * 740 and 'attributes' not in exported
    assert json.loads((output / 'gaze-report.json').read_text()) == report
`));

test('frozen runtime acceptance enforces calibration, launch, ECE and Python/Node display parity', () => run(`
import copy, json, math
from pathlib import Path
from tempfile import TemporaryDirectory
from ml.observe.gaze_accept import evaluate_runtime, probability, research_head
from ml.observe.gaze_probe import bucket
from ml.observe.train_heads import CHEAP, STRONG, THIRD
params = {'name': 'iris-geometry-terms-clip-face', 'researchOnly': True,
          'mean': [0.] * 740, 'scale': [1.] * 740, 'weights': [1.] + [0.] * 739,
          'bias': 0., 'temperature': 1., 'C': .1, 'threshold': .91}
config = {'model_sha256': {'landmarker': 'a' * 64, 'clip': 'b' * 64}}
head = research_head(params, config)
assert head['attributes'][0]['weights'] == params['weights']
assert head['encoder']['dimensions'] == 740 and head['encoder']['clipModelSha256'] == 'b' * 64
assert head['input'] == {'type': 'face-crop', 'expansion': 1.8, 'size': 384, 'minFaceHeight': .05}
cal = [f'openimages-{i}' for i in range(1000) if bucket(f'openimages-{i}', 'calibration') < 15][:31]
hold = ['openimages-hold']
def label(i, kind):
    return {'id': i, 'set': kind, 'faceHeight': .1,
            'votes': {'gaze': {CHEAP: [1, 1, 1], STRONG: [1], THIRD: [1]}}}
def dumps(path, rows):
    path.write_text(''.join(json.dumps(row, allow_nan=False) + '\\n' for row in rows))
vector = [math.log(99)] + [0.] * 739
p = probability(vector, params)
item = {'id': 'gaze', 'text': '看镜头', 'tone': 'neutral', 'source': 'model', 'confidence': p}
photos = [f'photo-{i}' for i in range(140)]
with TemporaryDirectory() as directory:
    root = Path(directory); inputs = root / 'inputs'; output = root / 'output'
    inputs.mkdir(); output.mkdir()
    (root / 'gaze-config.json').write_text(json.dumps(config))
    (output / 'research-model.json').write_text(json.dumps(params))
    dumps(inputs / 'oi-labels.jsonl', [label(i, 'openimages') for i in cal + hold])
    dumps(inputs / 'panel-labels.jsonl', [label(i, 'openimages') for i in hold])
    dumps(inputs / 'p0-labels.jsonl', [label(i, 'photos') for i in photos])
    dumps(inputs / 'holdout-items.jsonl', [{'id': i} for i in hold])
    dumps(inputs / 'oi-items.jsonl', [{'id': i, 'faceBox': [0, 0, .1, .1]} for i in cal + hold])
    records = [{'id': i, 'features': vector, 'items': [item]} for i in cal + hold + photos]
    dumps(output / 'runtime-features.jsonl', records)
    report = evaluate_runtime(root, output)
    assert report['passed'] and all(report['gates'].values())
    assert report['launch']['all']['statements'] == 141 and report['calibration']['statements'] == 31
    assert report['parity']['mismatchCount'] == 0 and report['parity']['maximumConfidenceError'] == 0
    assert report['researchOnly'] and not report['shipped']
    assert len(report['inputs']['featuresSha256']) == 64 and len(report['inputs']['researchModelSha256']) == 64
    assert not (output / 'head.json').exists()
    json.loads((output / 'runtime-acceptance.json').read_text(), parse_constant=lambda value: (_ for _ in ()).throw(AssertionError(value)))
    changed = copy.deepcopy(records); changed[0]['items'][0]['confidence'] -= 1e-7
    dumps(output / 'runtime-features.jsonl', changed)
    assert not evaluate_runtime(root, output)['gates']['parity']
    changed = copy.deepcopy(records)
    for index in (0, 1): changed[index]['features'] = [0.] * 740; changed[index]['items'] = []
    dumps(output / 'runtime-features.jsonl', changed)
    report = evaluate_runtime(root, output)
    assert report['gates']['parity'] and not report['gates']['calibration'] and report['threshold'] == .91
    changed = copy.deepcopy(records); changed[-1]['features'] = None; changed[-1]['items'] = []
    dumps(output / 'runtime-features.jsonl', changed)
    report = evaluate_runtime(root, output)
    assert report['missingFeatures']['references'] == 1 and report['nullFeatureRows'] == 1
    assert report['gates']['parity']
    changed[-1]['features'] = [1.]
    dumps(output / 'runtime-features.jsonl', changed)
    report = evaluate_runtime(root, output)
    assert not report['gates']['featureValidity'] and report['invalidFeatureIds'] == [photos[-1]]
    dumps(output / 'runtime-features.jsonl', records[1:])
    report = evaluate_runtime(root, output)
    assert not report['gates']['completeRuntimeRows'] and report['missingRuntimeIds'] == [cal[0]]
`));

test('runtime calibration fits once on eligible hashed calibration features and preserves every coefficient', () => run(`
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from ml.observe import gaze_accept as accept
from ml.observe.gaze_probe import bucket
from ml.observe.train_heads import CHEAP, STRONG
params = {'name': 'iris-geometry-terms-clip-face', 'researchOnly': True,
          'mean': [0.] * 740, 'scale': [1.] * 740, 'weights': [1.0000000000000002] + [0.] * 739,
          'bias': 0., 'temperature': 1., 'C': .1, 'threshold': .91}
config = {'model_sha256': {'landmarker': 'a' * 64, 'clip': 'b' * 64}}
cal = [f'openimages-{i}' for i in range(1000) if bucket(f'openimages-{i}', 'calibration') < 15][:40]
fit = [f'openimages-{i}' for i in range(1000) if bucket(f'openimages-{i}', 'calibration') >= 15][:5]
hold = ['openimages-hold']
def dumps(path, rows):
    path.write_text(''.join(json.dumps(row) + '\\n' for row in rows))
with TemporaryDirectory() as directory:
    root = Path(directory); inputs = root / 'inputs'; output = root / 'output'
    inputs.mkdir(); output.mkdir()
    (root / 'gaze-config.json').write_text(json.dumps(config))
    original = json.dumps(params).encode(); (output / 'research-model.json').write_bytes(original)
    dumps(inputs / 'oi-labels.jsonl', [{'id': i, 'set': 'openimages',
                                        'votes': {'gaze': {CHEAP: [int(i in cal)], STRONG: [int(i in cal)]}}}
                                       for i in cal + fit + hold])
    dumps(inputs / 'holdout-items.jsonl', [{'id': i} for i in hold])
    dumps(inputs / 'oi-items.jsonl', [{'id': i, 'faceBox': [0, 0, .1, .01 if i == cal[-1] else .1]} for i in cal + fit + hold])
    dumps(output / 'runtime-features.jsonl', [{'id': i, 'features': [10.] + [0.] * 739, 'items': []} for i in cal + fit + hold])
    def temperature(logits, labels):
        assert len(labels) == 39 and (labels == 1).all()
        np.testing.assert_array_equal(logits, np.full(39, 10. * params['weights'][0]))
        return 2.
    with patch.object(accept, 'fit_temperature', side_effect=temperature) as fit_temperature:
        metadata = accept.calibrate_runtime(root, output)
        assert fit_temperature.call_count == 1
        try:
            accept.calibrate_runtime(root, output)
        except ValueError:
            pass
        else:
            raise AssertionError('runtime calibration fitted twice')
        assert fit_temperature.call_count == 1
    updated = json.loads((output / 'research-model.json').read_text())
    assert updated == json.loads((output / 'runtime-model.json').read_text())
    assert (output / 'screening-model.json').read_bytes() == original
    for key in ['C', 'mean', 'scale', 'weights', 'bias', 'name']:
        assert updated[key] == params[key]
    assert updated['temperature'] == 2. and updated['threshold'] == .51
    assert metadata['thresholdFound'] and metadata['featureRows'] == 39
    assert json.loads((root / 'accept-heads/gaze.json').read_text()) == accept.research_head(updated, config)
    assert accept.research_head(updated, config)['version'] == 'gaze-iris-q2-clip-v1'
`));

test('a missing runtime calibration threshold retains diagnostic threshold and blocks acceptance', () => run(`
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from ml.observe import gaze_accept as accept
from ml.observe.gaze_probe import bucket
from ml.observe.train_heads import CHEAP, STRONG
params = {'name': 'iris-geometry-terms-clip-face', 'researchOnly': True,
          'mean': [0.] * 740, 'scale': [1.] * 740, 'weights': [1.] + [0.] * 739,
          'bias': 0., 'temperature': 1., 'C': .1, 'threshold': .91}
cal = [f'openimages-{i}' for i in range(1000) if bucket(f'openimages-{i}', 'calibration') < 15][:29]
def dumps(path, rows):
    path.write_text(''.join(json.dumps(row) + '\\n' for row in rows))
with TemporaryDirectory() as directory:
    root = Path(directory); inputs = root / 'inputs'; output = root / 'output'
    inputs.mkdir(); output.mkdir()
    (root / 'gaze-config.json').write_text(json.dumps({'model_sha256': {'landmarker': 'a' * 64, 'clip': 'b' * 64}}))
    (output / 'research-model.json').write_text(json.dumps(params))
    dumps(inputs / 'oi-labels.jsonl', [{'id': i, 'set': 'openimages', 'votes': {'gaze': {CHEAP: [1], STRONG: [1]}}} for i in cal])
    dumps(inputs / 'oi-items.jsonl', [{'id': i, 'faceBox': [0, 0, .1, .1]} for i in cal])
    dumps(inputs / 'holdout-items.jsonl', [])
    vector = [10.] + [0.] * 739
    dumps(output / 'runtime-features.jsonl', [{'id': i, 'features': vector, 'items': []} for i in cal])
    with patch.object(accept, 'fit_temperature', return_value=2.):
        metadata = accept.calibrate_runtime(root, output)
    assert not metadata['thresholdFound'] and metadata['threshold'] == .91
    updated = json.loads((output / 'research-model.json').read_text())
    item = {'id': 'gaze', 'text': '看镜头', 'tone': 'neutral', 'source': 'model', 'confidence': accept.probability(vector, updated)}
    dumps(output / 'runtime-features.jsonl', [{'id': i, 'features': vector, 'items': [item]} for i in cal])
    dumps(inputs / 'panel-labels.jsonl', []); dumps(inputs / 'p0-labels.jsonl', [])
    report = accept.evaluate_runtime(root, output)
    assert not report['passed'] and not report['gates']['runtimeCalibration'] and not report['gates']['calibration']
    assert report['gates']['parity'] and report['runtimeCalibration']['thresholdFound'] is False
`));
