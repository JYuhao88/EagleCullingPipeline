import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const load = `import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('submit', 'scripts/observe-vlm-ray.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

test('critique admission isolates W36 GPU jobs and retains the shared GPU quota', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp); m.LOCK = Path(tmp)/'lock'
 own = 'w36-vlm-critique-'+'0'*12
 assert m.checked_job(own, 'w36-vlm-critique') == own
 m.request = lambda path, body=None: [{'submission_id':'w35-vlm-moe-'+'1'*12,'status':'RUNNING'}] if body is None else {'ok':True}
 assert m.submit_locked({},line='w36-vlm-critique') == {'ok':True}
 assert not m.LOCK.exists()
 for active in [own,'w36-aihub-'+'1'*12]:
  m.request = lambda *a, **k: [{'submission_id':active,'status':'PENDING'}]
  try: m.submit_locked({},line='w36-vlm-critique')
  except RuntimeError: pass
  else: raise AssertionError('W36 overlap admitted')
 for foreign in ['w35-vlm-moe-'+'0'*12,'w34-vlm-'+'0'*12]:
  try: m.checked_job(foreign,'w36-vlm-critique')
  except ValueError: pass
  else: raise AssertionError('foreign job action accepted')
 assert not m.LOCK.exists()
`);
});

test('critique config hashes the editable prompt, uses two fixed seeds and reuses cached weights', () => {
  python(load + `
from ml.observe.critique import load_prompt
real_root = m.ROOT
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 prepared = Path(tmp)/'prepared'; prepared.mkdir()
 (prepared/'manifest.jsonl').write_text('{}')
 output = Path(tmp)/'data/cache/w36-vlm-critique/model'
 captured = {}
 m.package = lambda prepared, config: captured.update(config=config) or b'bounded synthetic package'
 m.submit_locked = lambda body, **kw: captured.update(body=body,line=kw['line']) or {'ok':True}
 m.request = lambda *a, **kw: {}
 m.setting = lambda *a, **kw: ''
 m.require_path = lambda *a: '/shared'
 prompt_path = real_root/'ml/observe/prompts/critique-v1.md'
 args = m.arguments(['submit','--line','w36-vlm-critique','--task','critique',
  '--cache-line','w35-vlm-moe','--model','example/model','--revision','f'*40,
  '--license','Apache-2.0','--prepared',str(prepared),'--output',str(output),
  '--critique-prompt',str(prompt_path)])
 m.submit(args)
 cfg = captured['config']; env = captured['body']['runtime_env']['env_vars']
 artifact = load_prompt(prompt_path)
 assert cfg['task'] == 'critique' and cfg['asks'] == 2
 assert cfg['seeds'] == [36001,36002] and cfg['temperature'] == 0
 assert cfg['max_new_tokens'] == artifact['generation']['max_new_tokens']
 assert cfg['variants'] == ['A','B'] and cfg['prompt_sha256'] == artifact['sha256']
 assert cfg['local_files_only'] is True and cfg['cache_line'] == 'w35-vlm-moe'
 assert env['HF_HOME'] == '/tmp/w35-vlm-moe-hf-cache'
 assert captured['body']['entrypoint_num_gpus'] == 1 and captured['line'] == 'w36-vlm-critique'
 assert captured['body']['metadata'] == {'ecp_job_kind':'vlm','ecp_requested_gpus':'1'}
 assert 'questions_sha256' not in cfg
 args.asks = 3
 try: m.submit(args)
 except ValueError: pass
 else: raise AssertionError('third critique ask admitted')
 assert m.arguments(['submit','--task','critique','--allow-download']).local_files_only is False
 assert m.arguments(['submit']).asks == 3
 assert m.arguments(['submit']).local_files_only is False
`);
});

test('critique packaging carries prompt and helper but sends only the sanitized full image', () => {
  python(load + `
import io, zipfile, hashlib
from PIL import Image
with tempfile.TemporaryDirectory() as tmp:
 prepared = Path(tmp)
 Image.new('RGB',(64,32)).save(prepared/'full.jpg',format='JPEG')
 (prepared/'manifest.jsonl').write_text(json.dumps({'id':'synthetic','set':'photos','storage':'package',
  'images':{'full':'full.jpg','face':'private-face-does-not-exist.jpg'}})+'\\n')
 prompt_path = m.ROOT/'ml/observe/prompts/critique-v1.md'
 cfg = {'task':'critique','critique_prompt':str(prompt_path),
  'prompt_sha256':hashlib.sha256(prompt_path.read_bytes()).hexdigest()}
 raw = m.package(prepared,cfg)
 with zipfile.ZipFile(io.BytesIO(raw)) as archive:
  names = archive.namelist()
  assert 'ml/observe/critique.py' in names and 'ml/observe/prompts/critique-v1.md' in names
  assert 'full.jpg' in names and 'questions.json' not in names
  assert 'private-face-does-not-exist.jpg' not in names
 cfg['prompt_sha256'] = '0'*64
 try: m.package(prepared,cfg)
 except ValueError: pass
 else: raise AssertionError('prompt changed after hashing accepted')
`);
});

test('critique selection preserves photos, caps Open Images and only augments existing facts', () => {
  python(`from ml.observe.vlm_eval_ray import critique_rows, critique_variants
rows = [{'id':str(i),'set':subset,'images':{'full':'view.jpg'}}
 for subset, size in [('celeba',10),('photos',291),('openimages',250)] for i in range(size)]
rows += [{'id':'pair','kind':'group','set':'photos','images':{'left':'left.jpg','right':'right.jpg'}}]
selected = critique_rows(rows)
assert len(selected) == 491 and sum(x['set']=='photos' for x in selected) == 291
assert len(critique_rows(rows, 3)) == 6
assert critique_variants({'set':'photos'}, {}) == ['A','B']
assert critique_variants({'set':'openimages'}, {}) == ['A']
assert critique_variants({'set':'openimages','specialist_facts':[{'id':'smile','text':'在笑'}]}, {}) == ['A','B']
for row in [{'set':'photos','images':{'face':'face.jpg'}},
 {'set':'photos','images':{'full':'view.jpg'},'specialist_facts':{}}]:
 try: critique_rows([row])
 except ValueError: pass
 else: raise AssertionError('invalid critique input accepted')
`);
});

test('critique result rows bind prompt/model/variant/seed and preserve invalid output for audit', () => {
  python(`import json
from ml.observe.critique import load_prompt
from ml.observe.vlm_eval_ray import critique_prediction, critique_report
artifact = load_prompt()
config = {'model':'example/model','revision':'f'*40,'seeds':[36001,36002],
 'variants':['A','B'],'prompt_sha256':artifact['sha256']}
item = {'id':'synthetic','set':'photos','specialist_facts':[{'id':'smile','text':'在笑','source':'model'}]}
content = json.dumps({'summary':'笑容自然','strengths':[{'text':'笑容自然'}],
 'issues':[{'category':'composition/crop','text':'右侧留白偏多'}],
 'edits':[{'action':'crop/straighten','direction':'裁去右侧少量空白','reason':'突出人物'}],
 'verdict':'可修后保留'},ensure_ascii=False)
a = critique_prediction(item,0,'A',content,artifact,config)
b = critique_prediction(item,1,'A',content,artifact,config)
assert a['key'] != b['key'] and a['seed'] != b['seed']
assert a['critique'] is not None and len(a['statements']) == 4
assert a['prompt_sha256'] == artifact['sha256'] and a['model_revision'] == 'f'*40
assert a['specialist_facts'] == item['specialist_facts'] and a['image_id'] == item['id']
invalid = critique_prediction(item,0,'B','not JSON',artifact,config)
assert invalid['parse_error'] == 'invalid_critique_json' and invalid['content'] == 'not JSON'
assert invalid['critique'] is None and invalid['statements'] == []
report = critique_report([item],[a,b,invalid],config)
assert report['status'] == 'awaiting_three_family_judges'
assert report['variants']['A']['valid_json_calls'] == 2
assert report['variants']['B']['invalid_json_calls'] == 1
assert report['variants']['A']['stability']['issues']['n'] == 1
assert report['variants']['A']['stability']['issues']['jaccard'] == 1
assert report['variants']['B']['stability']['issues']['missingOrInvalid'] == 1
`);
});
