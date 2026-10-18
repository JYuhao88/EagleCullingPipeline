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

test('VLM admission releases the shared lock immediately after submit and rejects own overlap', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK = Path(tmp) / 'lock'
 calls = []
 def request(path, body=None):
  calls.append(path)
  assert m.LOCK.exists()
  owner = json.loads((m.LOCK / 'owner.json').read_text())
  assert owner['line'] == 'w34-vlm' and owner['pid'] > 0
  return [] if body is None else {'submitted': True}
 m.request = request
 assert m.submit_locked({'submission_id':'w34-vlm-000000000000'}) == {'submitted':True}
 assert not m.LOCK.exists() and calls == ['/api/jobs/', '/api/jobs/']
 m.request = lambda *a, **k: [{'submission_id':'w34-vlm-111111111111','status':'RUNNING'}]
 try: m.submit_locked({})
 except RuntimeError: pass
 else: raise AssertionError('own overlap admitted')
 assert not m.LOCK.exists()
`);
});

test('VLM admission counts all project lines and cleans up on submission failure', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK = Path(tmp) / 'lock'
 m.request = lambda *a, **k: [{'submission_id':'w1-a','status':'RUNNING'}, {'submission_id':'w39-b','status':'PENDING'}]
 try: m.submit_locked({}, wait_seconds=0)
 except TimeoutError: pass
 else: raise AssertionError('project limit exceeded')
 assert not m.LOCK.exists()
 def fail(path, body=None):
  if body is not None: raise OSError('synthetic submit failure')
  return []
 m.request = fail
 try: m.submit_locked({'submission_id':'w34-vlm-000000000000'})
 except OSError: pass
 else: raise AssertionError('failure swallowed')
 assert not m.LOCK.exists()
`);
});

test('VLM W35 admission has a separate owner and rejects cross-line job actions and outputs', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 m.LOCK = Path(tmp)/'lock'
 def request(path, body=None):
  assert json.loads((m.LOCK/'owner.json').read_text())['line'] == 'w35-vlm-moe'
  return [{'submission_id':'w34-vlm-000000000000','status':'RUNNING'}] if body is None else {'submitted':True}
 m.request = request
 assert m.submit_locked({}, line='w35-vlm-moe') == {'submitted':True}
 assert not m.LOCK.exists()
 m.request = lambda *a, **k: [{'submission_id':'w35-vlm-moe-111111111111','status':'PENDING'}]
 try: m.submit_locked({}, line='w35-vlm-moe')
 except RuntimeError: pass
 else: raise AssertionError('own W35 overlap admitted')
 assert not m.LOCK.exists()
 own = 'w35-vlm-moe-'+'0'*12
 assert m.checked_job(own, 'w35-vlm-moe') == own
 for job, line in [(own,'w34-vlm'), ('w34-vlm-'+'0'*12,'w35-vlm-moe'), (own,'w36')]:
  try: m.checked_job(job,line)
  except ValueError: pass
  else: raise AssertionError('foreign job accepted')
 out = Path(tmp)/'data/cache/w35-vlm-moe/model'
 assert m.checked_output(out,'w35-vlm-moe') == out
 escape = Path(tmp)/'data/cache/w35-vlm-moe/escape'
 escape.parent.mkdir(parents=True)
 escape.symlink_to(Path(tmp))
 for path in [Path(tmp)/'data/cache/w34-vlm/model', out/'../../w34-vlm/model', escape/'model']:
  try: m.checked_output(path,'w35-vlm-moe')
  except ValueError: pass
  else: raise AssertionError('foreign output accepted')
`);
});

test('VLM admission distinguishes requested GPU resources from CPU jobs and treats unknowns conservatively', () => {
  python(load + `
for job in [{}, {'entrypoint_num_gpus':None}, {'entrypoint_num_gpus':True},
            {'entrypoint_num_gpus':-1}, {'entrypoint_num_gpus':float('nan')},
            {'metadata':'malformed'}, {'metadata':{'ecp_requested_gpus':'unknown'}}, {'metadata':{'ecp_requested_gpus':'NaN'}},
            {'entrypoint_num_gpus':None,'metadata':{'ecp_requested_gpus':'0'}}]:
 assert m.uses_gpu(job), job
assert not m.uses_gpu({'entrypoint_num_gpus':0})
assert not m.uses_gpu({'metadata':{'ecp_requested_gpus':'0'}})
assert m.uses_gpu({'entrypoint_num_gpus':0,'entrypoint_resources':{'GPU':1}})
assert m.uses_gpu({'metadata':{'ecp_requested_gpus':'0.5'}})
with tempfile.TemporaryDirectory() as tmp:
 m.LOCK = Path(tmp)/'lock'; submitted = []
 gpu = {'submission_id':'w36-gpu','status':'RUNNING','metadata':{'ecp_requested_gpus':'2'}}
 cpu = {'submission_id':'w36-cpu','status':'RUNNING','metadata':{'ecp_requested_gpus':'0'}}
 active = [gpu,cpu]
 def request(path,body=None):
  assert m.LOCK.exists()
  if body is None: return active
  submitted.append(body); return {'submitted':True}
 m.request = request
 assert m.submit_locked({'entrypoint_num_gpus':2,'metadata':{'ecp_requested_gpus':'0'}},line='w35-vlm-moe') == {'submitted':True}
 assert submitted[-1]['metadata']['ecp_requested_gpus'] == '2' and not m.LOCK.exists()
 active = [gpu,{'submission_id':'w1-unknown','status':'PENDING'}]
 try: m.submit_locked({'entrypoint_num_gpus':1},wait_seconds=0,line='w35-vlm-moe')
 except TimeoutError: pass
 else: raise AssertionError('unknown job was treated as CPU')
 active = [cpu,dict(cpu,submission_id='w1-cpu'),dict(cpu,submission_id='w39-cpu')]
 try: m.submit_locked({'entrypoint_num_gpus':1},wait_seconds=0,line='w35-vlm-moe')
 except TimeoutError: pass
 else: raise AssertionError('total job cap exceeded')
 active = [gpu,dict(gpu,submission_id='w39-gpu')]
 assert m.submit_locked({'entrypoint_num_gpus':0},wait_seconds=0,line='w35-vlm-moe') == {'submitted':True}
 assert submitted[-1]['metadata']['ecp_requested_gpus'] == '0'
 for value in (3,-1,float('nan'),float('inf'),True,None):
  try: m.submit_locked({'entrypoint_num_gpus':value},line='w35-vlm-moe')
  except ValueError: pass
  else: raise AssertionError('invalid GPU request accepted')
 assert not m.LOCK.exists()
`);
});

test('VLM W35 configuration pins loader code and pip without forwarding unrelated environment', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 prepared = Path(tmp)/'prepared'; prepared.mkdir()
 (prepared/'manifest.jsonl').write_text('{}')
 (prepared/'questions.json').write_text('{}')
 output = Path(tmp)/'data/cache/w35-vlm-moe/model'
 captured = {}
 def package(prepared, config):
  captured['config'] = config
  return b'synthetic bounded package'
 def submit(body, **kw):
  captured.update(body=body, lock_line=kw['line'])
  return {'submitted':True}
 m.package = package
 m.submit_locked = submit
 m.request = lambda *a, **kw: {}
 m.setting = lambda *a, **kw: ''
 m.require_path = lambda *a: '/shared'
 m.os.environ['UNRELATED_CREDENTIAL'] = 'synthetic-private-value'
 args = m.arguments(['submit','--line','w35-vlm-moe','--model','example/model',
   '--revision','f'*40,'--family','minicpm','--license','Apache-2.0',
   '--trust-remote-code','--compression','16','--transformers-version','5.18.0',
   '--vram-limit-gib','90','--quantization','native','--prepared',str(prepared),'--output',str(output)])
 m.submit(args)
 config = captured['config']; body = captured['body']
 assert captured['lock_line'] == 'w35-vlm-moe'
 assert body['submission_id'].startswith('w35-vlm-moe-')
 assert body['entrypoint_num_gpus'] == 1
 assert body['runtime_env']['pip'][0] == 'transformers==5.18.0'
 assert 'compressed-tensors==0.18.0' in body['runtime_env']['pip']
 assert body['runtime_env']['env_vars']['HF_HOME'] == '/tmp/w35-vlm-moe-hf-cache'
 assert 'UNRELATED_CREDENTIAL' not in body['runtime_env']['env_vars']
 assert 'synthetic-private-value' not in json.dumps(body)
 assert config['revision'] == config['code_revision'] == 'f'*40 and config['trust_remote_code'] is True
 assert config['license'] == 'Apache-2.0' and config['family'] == 'minicpm'
 assert config['compression'] == 16 and config['vram_limit_gib'] == 90 and config['quantization'] == 'native'
 assert config['asks'] == 3 and config['seed'] == 20261017 and config['max_new_tokens'] == 256
 assert json.loads((output/'job.json').read_text())['config'] == config
 for key, value in [('revision','main'),('transformers_version','>=5.18.0'),('license',None)]:
  previous = getattr(args,key); setattr(args,key,value)
  try: m.submit(args)
  except ValueError: pass
  else: raise AssertionError('unpinned or undocumented model accepted')
  setattr(args,key,previous)
 defaults = m.arguments(['submit'])
 assert defaults.line == 'w34-vlm' and defaults.family == 'qwen-vl'
 assert defaults.output == 'data/cache/w34-vlm/probe' and defaults.vram_limit_gib == 12
 assert defaults.transformers_version == '4.57.1' and defaults.trust_remote_code is False
`);
});

test('VLM download only includes remote Python code when the full revision is trusted', () => {
  python(load + `
import shlex
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 captured = []
 m.setting = lambda *a, **kw: ''
 m.submit_locked = lambda body, **kw: captured.append(body) or {'submitted':True}
 args = m.arguments(['download','--line','w35-vlm-moe','--model','example/model','--revision','f'*40,
   '--family','minicpm','--license','Apache-2.0','--output',str(Path(tmp)/'data/cache/w35-vlm-moe/download')])
 m.submit(args)
 assert '*.py' not in shlex.split(captured[-1]['entrypoint'])[-1]
 args.trust_remote_code = True
 m.submit(args)
 assert '*.py' in shlex.split(captured[-1]['entrypoint'])[-1]
 args.revision = 'main'
 try: m.submit(args)
 except ValueError: pass
 else: raise AssertionError('unpinned remote code accepted')
`);
});

test('VLM artifact collection checks checksums and permits only known file names', () => {
  python(load + `
import hashlib, base64
raw = b'{}'
part = {'name':'report.json','index':0,'count':1,'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 out = Path(tmp)/'data/cache/w34-vlm/out'
 m.request = lambda path: {'logs':'VLM_ARTIFACT '+json.dumps(part)} if path.endswith('/logs') else {'status':'SUCCEEDED'}
 m.collect('w34-vlm-000000000000', out)
 assert (out/'report.json').read_bytes() == raw
 part['sha256'] = '0' * 64
 try: m.collect('w34-vlm-000000000000', out)
 except ValueError: pass
 else: raise AssertionError('bad checksum accepted')
 part['name'] = '../escape.json'
 try: m.collect('w34-vlm-000000000000', out)
 except ValueError: pass
 else: raise AssertionError('unsafe name accepted')
`);
});

test('VLM packaging rejects oversize, metadata-bearing and invalid images before upload', () => {
  python(load + `
from PIL import Image
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp)
 for name in ['ml/__init__.py','ml/observe/__init__.py','ml/observe/vlm_eval.py','ml/observe/vlm_eval_ray.py']:
  p = root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('')
 m.ROOT = root
 prepared = root/'prepared'; prepared.mkdir()
 (prepared/'questions.json').write_text('{}')
 (prepared/'manifest.jsonl').write_text(json.dumps({'storage':'package','images':{'full':'image.jpg'}})+'\\n')
 file = prepared/'image.jpg'
 Image.new('RGB',(768,384)).save(file,format='JPEG')
 assert len(m.package(prepared, {})) > 0
 Image.new('RGB',(769,384)).save(file,format='JPEG')
 try: m.package(prepared, {})
 except ValueError: pass
 else: raise AssertionError('oversize image accepted')
 exif = Image.Exif(); exif[270] = 'synthetic metadata'
 Image.new('RGB',(32,32)).save(file,format='JPEG',exif=exif)
 try: m.package(prepared, {})
 except ValueError: pass
 else: raise AssertionError('metadata image accepted')
 file.write_bytes(b'not a JPEG')
 try: m.package(prepared, {})
 except (ValueError, OSError): pass
 else: raise AssertionError('invalid JPEG accepted')
`);
});

test('VLM live collection waits for complete artifacts and rejects terminal truncation', () => {
  python(load + `
import hashlib, base64
raw = b'{}'
part = {'name':'report.json','index':0,'count':2,'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}
with tempfile.TemporaryDirectory() as tmp:
 m.ROOT = Path(tmp)
 out = Path(tmp)/'data/cache/w34-vlm/out'
 status = 'RUNNING'
 log = 'VLM_ARTIFACT '+json.dumps(part)+'\\nVLM_ROW {"id":'
 m.request = lambda path: {'logs':log} if path.endswith('/logs') else {'status':status}
 assert m.collect('w34-vlm-000000000000', out)['status'] == 'RUNNING'
 assert not (out/'report.json').exists()
 assert json.loads((out/'collection.json').read_text())['artifacts'] == []
 status = 'SUCCEEDED'
 log = 'VLM_ARTIFACT '+json.dumps(part)+'\\n'
 try: m.collect('w34-vlm-000000000000', out)
 except ValueError: pass
 else: raise AssertionError('terminal truncation accepted')
`);
});

test('VLM worker caps the sample per dataset and preserves fixed comparison options', () => {
  python(`from ml.observe.vlm_eval_ray import prompt, select_rows, image_path
rows = [{'id':str(i),'set':s} for s in ['celeba','photos','openimages'] for i in range(3)]
assert len(select_rows(rows, 2)) == 6
assert len(select_rows(rows, 0)) == 9
item = {'id':'pair','kind':'group'}
for ask in range(3):
 p = prompt(item, ask, {}, 1)
 assert all(x in p for x in ['左图','右图','相当','看不清'])
try: image_path({'images':{'full':'../escape.jpg'}}, 'full')
except ValueError: pass
else: raise AssertionError('unsafe image path accepted')
`);
});

test('VLM worker accepts Ray content-store links only for already validated package assets', () => {
  python(`import tempfile, os
from pathlib import Path
from ml.observe.vlm_eval_ray import image_path
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp)
 (root/'content').mkdir(); (root/'package').mkdir()
 target = root/'content'/'view.jpg'; target.write_bytes(b'validated package fixture')
 (root/'package'/'view.jpg').symlink_to(target)
 previous = Path.cwd()
 try:
  os.chdir(root/'package')
  assert image_path({'storage':'package','images':{'full':'view.jpg'}}, 'full') == target.resolve()
  try: image_path({'storage':'package','images':{'full':'../content/view.jpg'}}, 'full')
  except ValueError: pass
  else: raise AssertionError('path traversal accepted')
 finally: os.chdir(previous)
`);
});

test('VLM worker rechecks JPEG format, size and metadata on both packaged and remote inputs', () => {
  python(`import tempfile, io
from pathlib import Path
from PIL import Image
from ml.observe.vlm_eval_ray import checked_image
with tempfile.TemporaryDirectory() as tmp:
 file = Path(tmp)/'image.jpg'
 Image.new('RGB',(768,384)).save(file,format='JPEG')
 clean = file.read_bytes()
 assert checked_image(file).size == (768,384)
 def rejected():
  try: checked_image(file)
  except ValueError: pass
  else: raise AssertionError('unsafe remote or packaged image accepted')
 Image.new('RGB',(769,384)).save(file,format='JPEG'); rejected()
 Image.new('RGB',(32,32)).save(file,format='PNG'); rejected()
 for marker in [b'\\xff\\xe1',b'\\xff\\xe2',b'\\xff\\xed',b'\\xff\\xfe']:
  payload = b'synthetic metadata'
  file.write_bytes(clean[:2]+marker+(len(payload)+2).to_bytes(2,'big')+payload+clean[2:])
  rejected()
`);
});

test('VLM bitsandbytes selection keeps the CUDA major and never chooses a newer toolkit', () => {
  python(`from ml.observe.vlm_eval_ray import choose_bnb_cuda
assert choose_bnb_cuda('13.2',['118','128','130']) == '130'
assert choose_bnb_cuda('13.2',['130','132']) == '132'
assert choose_bnb_cuda('12.8',['124','128','130']) == '128'
for version, available in [('13.2',['128']),('12.8',['130'])]:
 try: choose_bnb_cuda(version, available)
 except RuntimeError: pass
 else: raise AssertionError('incompatible CUDA binary selected')
`);
});

test('VLM schema prompt retains the teacher question/options and pins the output keys', () => {
  python(`import json
from ml.observe.vlm_eval import QUESTIONS
from ml.observe.vlm_eval_ray import prompt
item = {'id':'synthetic','set':'photos','questions':['smile','gaze'], 'images':{'full':'full.jpg','face':'face.jpg'}}
plain = prompt(item,0,QUESTIONS,1)
schema_text = prompt(item,0,QUESTIONS,1,'schema')
assert schema_text.startswith(plain)
schema = json.loads(schema_text.split('JSON 结构：',1)[1])
assert schema['required'] == ['smile','gaze'] and schema['additionalProperties'] is False
for key in item['questions']:
 assert set(schema['properties'][key]['enum']) == set(QUESTIONS[key]['options'].values())
`);
});
