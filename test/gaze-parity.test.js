import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('gaze parity utilities keep exact differences, safe bounded samples and item confidence checks', () => {
  const code = `
import tempfile
from pathlib import Path
import numpy as np
from ml.observe.gaze_parity import difference, normalise, same_items, selected_rows
assert difference(np.array([0,255],dtype=np.uint8), np.array([255,0],dtype=np.uint8))['maximumAbs'] == 255
assert difference([1.,2.], [1.,2.])['exact']
assert difference([1.,2.], [1.,2.001])['different'] == 1
assert np.isclose(np.linalg.norm(normalise(np.ones(512))), 1)
for invalid in [np.zeros(512), np.ones(511), np.full(512,np.nan)]:
    try: normalise(invalid)
    except ValueError: pass
    else: raise AssertionError('invalid CLIP vector')
assert same_items([], []) and not same_items([], [{}])
item={'id':'gaze','text':'看镜头','tone':'neutral','source':'model','confidence':.98}
assert same_items([item], [{**item,'confidence':.98+1e-12}])
assert not same_items([item], [{**item,'confidence':.98+1e-7}])
with tempfile.TemporaryDirectory(prefix='gaze-parity-test-') as folder:
    root=Path(folder).resolve(); (root/'crop.png').write_bytes(b'synthetic-file-only')
    rows=[{'id':('openimages-' if i<8 else 'photo-')+str(i),'features':[0.]*740,'file':'crop.png'} for i in range(12)]
    rows += [{'id':'photo-invalid','features':[0.]*739,'file':'crop.png'},
             {'id':'photo-outside','features':[0.]*740,'file':'../outside.png'}]
    selected, counts=selected_rows(rows, root)
    assert len(selected)==5 and counts=={'public':3,'photo':2}
    assert [r[0]['id'] for r in selected] == [r[0]['id'] for r in selected_rows(list(reversed(rows)),root)[0]]
    assert all(file.is_relative_to(root) for _,_,file in selected)
`;
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('parity Node subprocess emits only local RGB/tensor binaries and numeric frozen-head results without a model', () => {
  const code = `
import json, math, subprocess, tempfile
from pathlib import Path
from PIL import Image
from ml.observe.gaze_parity import node_inputs
repository=Path.cwd().resolve()
with tempfile.TemporaryDirectory(prefix='gaze-parity-node-') as temporary:
    root=Path(temporary).resolve()
    (root/'src').symlink_to(repository/'src',target_is_directory=True)
    (root/'node_modules').symlink_to(repository/'node_modules',target_is_directory=True)
    Image.new('RGB',(384,384),(20,80,120)).save(root/'crop.png')
    head={'version':'synthetic','encoder':{'id':'mediapipe-iris-pose-q2-clip-b32-q','dimensions':740,
          'modelSha256':'a'*64,'clipModelSha256':'b'*64},
          'input':{'type':'face-crop','expansion':1.8,'size':384,'minFaceHeight':.05},
          'attributes':[{'id':'gaze','type':'logistic','weights':[0.]*740,'bias':3.,
                         'normalization':{'mean':[0.]*740,'scale':[1.]*740},'temperature':1.,
                         'showThreshold':.9,'positive':{'text':'看镜头','tone':'neutral'}}]}
    (root/'accept-manifest.json').write_text(json.dumps([{'id':'photo-synthetic','box':[.1,.1,.4,.4]}]))
    rows=[({'id':'photo-synthetic','features':[0.]*740,'file':'crop.png'},'photo',root/'crop.png')]
    version=subprocess.check_output(['node','--version'],text=True).strip()
    result=node_inputs(root,rows,head,root,version)
    assert len(result)==1 and abs(result[0]['probability']-1/(1+math.exp(-3)))<1e-12
    assert result[0]['items'][0]['text']=='看镜头'
    assert (root/'0.rgb').stat().st_size==224*224*3
    assert (root/'0.f32le').stat().st_size==224*224*3*4
    assert 'file' not in result[0] and 'pixels' not in result[0]
`;
  const result = spawnSync(process.env.EAGLE_PYTHON || 'python3', ['-c', code], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
