import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = code => {
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
};

test('acceptance head keeps the frozen model and requires the preselected research candidate', () => run(`
import importlib.util
s = importlib.util.spec_from_file_location('accept', 'scripts/observe-gaze-accept-ray.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
params = dict(researchOnly=True, name='iris-geometry-terms-clip-face', mean=[0.] * 740,
              scale=[1.] * 740, weights=[.01] * 740, bias=-.5, temperature=1.1, C=.03, threshold=.91)
head = m.runtime_head(params, {'landmarker':'a'*64, 'clip':'b'*64})
a = head['attributes'][0]
assert a['weights'] == params['weights'] and a['normalization']['mean'] == params['mean']
assert a['showThreshold'] == .91 and a['temperature'] == 1.1 and a['positive']['text'] == '看镜头'
assert head['encoder']['dimensions'] == 740 and head['input']['minFaceHeight'] == .05
for change in ({'researchOnly':False}, {'name':'different-candidate'}):
    try: m.runtime_head({**params, **change}, {'landmarker':'a'*64, 'clip':'b'*64})
    except ValueError: pass
    else: raise AssertionError('unfrozen candidate was accepted')
`));

test('public native inputs verify original bytes and annotation before production cropping', () => run(`
import hashlib, io, json, os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from ml.observe.gaze_accept_ray import public_source
with TemporaryDirectory() as folder:
    previous = Path.cwd(); os.chdir(folder)
    try:
        root = Path(folder); (root/'records').mkdir()
        raw = b'public source bytes'; image = '0123456789abcdef'
        box = [.1,.2,.5,.8]; row = {'id':'openimages-'+image, 'box':box}
        record = {'faceBox':box,'sourceSha256':hashlib.sha256(raw).hexdigest(),
                  'sourceSize':[300,400],'rotation':90,'split':'validation'}
        path = root/'records'/(image+'.json'); path.write_text(json.dumps(record))
        with patch('ml.observe.gaze_accept_ray.ceph_image_path', return_value=root/'face'/(image+'.jpg')), \\
             patch('ml.observe.gaze_accept_ray.urllib.request.urlopen', side_effect=lambda *a,**k:io.BytesIO(raw)), \\
             patch('ml.observe.gaze_accept_ray.time.sleep'):
            saved = public_source(row)
            assert saved['rotation'] == 270 and saved['sourceSize'] == {'width':300,'height':400}
            assert Path(saved['source']).read_bytes() == raw
            for change in ({'faceBox':[.1,.2,.6,.8]}, {'sourceSha256':'0'*64}):
                path.write_text(json.dumps({**record,**change}))
                try: public_source(row)
                except ValueError: pass
                else: raise AssertionError('changed source or annotation accepted')
    finally: os.chdir(previous)
`));

test('Ray acceptance source allowlist imports the complete runtime from an isolated ESM bundle', () => run(`
import importlib.util, json, shutil, subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
spec = importlib.util.spec_from_file_location('accept', 'scripts/observe-gaze-accept-ray.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
sources = worker.runtime_sources()
plugins = {'src/plugin/image-formats.js', 'src/plugin/display-url.js'}
assert len(sources) == len(set(sources)) and plugins <= set(sources)
assert all((Path(source).parent.as_posix() == 'src/core' and source.endswith('.js')) or source in plugins
           for source in sources)
with TemporaryDirectory() as directory:
    root = Path(directory)
    for source in sources:
        target = root / source; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(worker.ROOT / source, target)
    (root / 'package.json').write_text(json.dumps({'private': True, 'type': 'module'}))
    (root / 'node_modules').symlink_to((worker.ROOT / 'node_modules').resolve(), target_is_directory=True)
    copied = {source.relative_to(root).as_posix() for source in root.rglob('*') if source.is_file()}
    assert copied == set(sources) | {'package.json'}
    assert not any((root / path).exists() for path in ['config', 'models', 'data', 'python_worker'])
    modules = ['observation-runtime', 'observation-head', 'gaze-geometry', 'ai-tags', 'embeddings']
    script = 'for (const name of ' + json.dumps(modules) + ") await import('./src/core/' + name + '.js');"
    result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=root,
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    (root / 'src/plugin/image-formats.js').unlink()
    missing = subprocess.run(['node', '--input-type=module', '-e', script], cwd=root,
                             capture_output=True, text=True, timeout=10)
    assert missing.returncode != 0 and 'ERR_MODULE_NOT_FOUND' in missing.stderr
    assert 'image-formats.js' in missing.stderr
`));
