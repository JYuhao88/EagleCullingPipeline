import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const load = `import importlib.util, json, tempfile, io, zipfile, os
from pathlib import Path
spec = importlib.util.spec_from_file_location('gguf_submit', 'scripts/observe-vlm-gguf-ray.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
revision = 'a' * 40
def arguments(*extra):
 return m.arguments(['submit','--model','example/model','--revision',revision,
   '--model-file','model-00001-of-00002.gguf','model-00002-of-00002.gguf',
   '--mmproj-file','mmproj-f16.gguf','--license','Apache-2.0','--llama-revision','b'*40,
   '--file-sha256','model-00001-of-00002.gguf='+'1'*64,
   '--file-sha256','model-00002-of-00002.gguf='+'2'*64,
   '--file-sha256','mmproj-f16.gguf='+'3'*64,*extra])
`;

test('GGUF configuration pins all repositories and preserves the W34 questionnaire policy', () => {
  python(load + `
c = m.configuration(arguments())
assert c['model_files'] == ['model-00001-of-00002.gguf','model-00002-of-00002.gguf']
assert c['mmproj_model'] == c['model'] == 'example/model'
assert c['mmproj_revision'] == c['revision'] == revision
assert c['llama_repo'] == 'ggml-org/llama.cpp' and c['llama_revision'] == 'b'*40
assert c['asks'] == 3 and c['seed'] == 20261017 and c['max_new_tokens'] == 256
assert c['context_size'] == 4096 and c['prompt_format'] == 'schema'
assert c['n_gpu_layers'] == 99 and c['batch_size'] == 512 and c['ubatch_size'] == 128
assert c['threads'] == 2 and c['parallel'] == 1 and c['cache_prompt'] is False and c['n_cpu_moe'] == 0
assert c['replicas'] == 1
replicated = m.configuration(arguments('--replicas','2'))
assert replicated['replicas'] == 2 and replicated['parallel'] == 1 and replicated['cache_prompt'] is False
assert c['line'] == 'w35-vlm-moe' and c['cache'] == 'shared' and c['mode'] == 'evaluate'
assert m.configuration(arguments('--cache','local'))['cache'] == 'local'
assert set(c['file_sha256']) == set(c['model_files']+[c['mmproj_file']])
c = m.configuration(arguments('--mmproj-model','example/projector','--mmproj-revision','c'*40,'--n-cpu-moe','4'))
assert c['mmproj_model'] == 'example/projector' and c['mmproj_revision'] == 'c'*40 and c['n_cpu_moe'] == 4
for action in ['probe','build']:
 c = m.configuration(m.arguments([action,'--llama-revision','b'*40]))
 assert c['mode'] == 'build' and c['model_files'] == [] and c['mmproj_file'] is None
`);
});

test('GGUF submission rejects mutable revisions, missing licenses and unsafe assets before network access', () => {
  python(load + `
bad = [('revision','main'),('llama_revision','latest'),('llama_repo','example/fork'),
       ('model','https://example.invalid/model'),('model_files',[]),
       ('model_files',['same.gguf','same.gguf']),('model_files',['/absolute.gguf']),
       ('model_files',['sub/../escape.gguf']),('model_files',['*.gguf']),
       ('model_files',['a.gguf;synthetic-command']),('mmproj_file','model-00001-of-00002.gguf'),
       ('license',None),('license',''),('license','a'*513),('asks',1),('limit_per_set',-1),
       ('n_cpu_moe',41),('replicas',0),('replicas',3),('replicas',True),('replicas',1.0),
       ('timeout',43201),('build_timeout_s',3601),('server_start_timeout_s',301),
       ('mmproj_model','example/projector'),('mmproj_revision','c'*40),
       ('file_sha256',[]),('file_sha256',['mmproj-f16.gguf='+'0'*63]),
       ('file_sha256',['mmproj-f16.gguf='+'0'*64]*2),
       ('file_sha256',['missing.gguf='+'0'*64]),('file_sha256',['../escape.gguf='+'0'*64])]
m.native.request = lambda *a, **k: (_ for _ in ()).throw(AssertionError('network used before validation'))
for key,value in bad:
 args = arguments(); setattr(args,key,value)
 try: m.submit(args)
 except ValueError: pass
 else: raise AssertionError('invalid GGUF setting accepted: '+key)
`);
});

test('GGUF package reuses sanitized-image validation and adds only its worker', () => {
  python(load + `
from PIL import Image
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp); m.ROOT = root; m.native.ROOT = root
 sources = ['ml/observe/vlm_eval.py','ml/observe/vlm_eval_ray.py','ml/observe/vlm_eval_gguf_ray.py']
 for name in sources:
  file = root/name; file.parent.mkdir(parents=True,exist_ok=True); file.write_text('# synthetic source')
 prepared = root/'prepared'; prepared.mkdir()
 (prepared/'questions.json').write_text('{}')
 (prepared/'manifest.jsonl').write_text(json.dumps({'storage':'package','images':{'full':'view.jpg'}})+'\\n')
 file = prepared/'view.jpg'; Image.new('RGB',(768,384)).save(file,format='JPEG')
 (root/'unrelated-private.txt').write_text('synthetic-private-data')
 config = m.configuration(arguments())
 raw = m.package(prepared, config)
 with zipfile.ZipFile(io.BytesIO(raw)) as archive:
  assert set(archive.namelist()) == set(sources+['ml/__init__.py','ml/observe/__init__.py',
                                               'vlm-config.json','manifest.jsonl','questions.json','view.jpg'])
  assert json.loads(archive.read('vlm-config.json')) == config
 assert b'synthetic-private-data' not in raw
 for size, metadata in [((769,384),False),((32,32),True)]:
  exif = Image.Exif()
  if metadata: exif[270] = 'synthetic metadata'
  Image.new('RGB',size).save(file,format='JPEG',exif=exif)
  try: m.package(prepared, config)
  except ValueError: pass
  else: raise AssertionError('unsafe image accepted')
`);
});

test('GGUF runtime reserves one GPU and shares admission with native W35 jobs without sending credentials', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp); m.ROOT = root; m.native.ROOT = root
 m.native.LOCK = root/'lock'
 prepared = root/'prepared'; prepared.mkdir()
 (prepared/'manifest.jsonl').write_text('[]'); (prepared/'questions.json').write_text('{}')
 output = root/'data/cache/w35-vlm-moe/gguf'
 captured = {}; uploaded = []
 def package(prepared,config): captured['config'] = config; return b'synthetic package'
 m.package = package
 m.native.require_path = lambda name: '/shared'
 m.native.setting = lambda *a,**k: ''
 os.environ['UNRELATED_CREDENTIAL'] = 'synthetic-private-value'
 def request(path,body=None,data=None,method=None):
  if path.startswith('/api/packages/'):
   assert method == 'PUT' and data == b'synthetic package'; uploaded.append(path); return {}
  assert m.native.LOCK.exists()
  assert json.loads((m.native.LOCK/'owner.json').read_text())['line'] == 'w35-vlm-moe'
  if body is None: return []
  captured['body'] = body; return {'submitted':True}
 m.native.request = request
 args = arguments('--prepared',str(prepared),'--output',str(output))
 m.submit(args)
 body = captured['body']; runtime = body['runtime_env']; config = captured['config']
 assert len(uploaded) == 1 and not m.native.LOCK.exists()
 assert body['entrypoint_num_cpus'] == 2 and body['entrypoint_num_gpus'] == 1
 assert config['replicas'] == 1 and config['parallel'] == 1
 assert body['submission_id'].startswith('w35-vlm-moe-')
 assert body['entrypoint'].endswith('python -m ml.observe.vlm_eval_gguf_ray')
 assert runtime['pip'] == ['huggingface-hub==2.2.0','Pillow==11.3.0']
 assert runtime['env_vars']['HF_HOME'] == '/shared/research/w35-vlm-moe/gguf-cache'
 assert 'UNRELATED_CREDENTIAL' not in runtime['env_vars']
 assert 'synthetic-private-value' not in json.dumps(body)
 assert config['manifest_sha256'] and config['questions_sha256']
 assert json.loads((output/'job.json').read_text())['phase'] == 'submitted'
 m.submit(arguments('--prepared',str(prepared),'--output',str(output)+'-local','--cache','local'))
 assert captured['body']['runtime_env']['env_vars']['HF_HOME'] == '/tmp/w35-vlm-moe-gguf-hf-cache'
 m.native.request = lambda *a,**k: [{'submission_id':'w35-vlm-moe-'+'f'*12,'status':'RUNNING'}]
 try: m.native.submit_locked({},line=m.LINE)
 except RuntimeError: pass
 else: raise AssertionError('GGUF overlapped a native W35 job')
 assert not m.native.LOCK.exists()
`);
});

test('GGUF replicas share one admitted W35 job and request one GPU per independent server', () => {
  python(load + `
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp); m.ROOT = root; m.native.ROOT = root; m.native.LOCK = root/'lock'
 prepared = root/'prepared'; prepared.mkdir()
 (prepared/'manifest.jsonl').write_text('[]'); (prepared/'questions.json').write_text('{}')
 output = root/'data/cache/w35-vlm-moe/replicas'
 captures = []; config = {}
 def package(prepared,supplied): config.update(supplied); return b'synthetic package'
 m.package = package
 m.native.require_path = lambda name: '/shared'
 m.native.setting = lambda *a,**k: ''
 active = []
 def request(path,body=None,data=None,method=None):
  if path.startswith('/api/packages/'): return {}
  assert m.native.LOCK.exists()
  assert json.loads((m.native.LOCK/'owner.json').read_text())['line'] == m.LINE
  if body is None: return active
  captures.append(body); return {'submitted':True}
 m.native.request = request
 m.submit(arguments('--replicas','2','--prepared',str(prepared),'--output',str(output)))
 assert len(captures) == 1 and captures[0]['entrypoint_num_gpus'] == 2
 assert captures[0]['entrypoint_num_cpus'] == 4 and captures[0]['entrypoint_memory'] == 48 * 1024 ** 3
 assert config['replicas'] == 2 and config['parallel'] == 1 and config['cache_prompt'] is False
 assert config['revision'] == revision and config['llama_revision'] == 'b'*40
 assert len(config['file_sha256']) == 3 and config['asks'] == 3 and config['seed'] == 20261017
 receipt = json.loads((output/'job.json').read_text())
 assert receipt['config']['replicas'] == 2 and receipt['phase'] == 'submitted'
 assert not m.native.LOCK.exists()
 active = [{'submission_id':captures[0]['submission_id'],'status':'RUNNING'}]
 try: m.native.submit_locked({'submission_id':m.LINE+'-'+'f'*12},line=m.LINE)
 except RuntimeError: pass
 else: raise AssertionError('second own job bypassed the replica admission guard')
 assert len(captures) == 1 and not m.native.LOCK.exists()
 active = [{'submission_id':'w1-project','status':'RUNNING'},{'submission_id':'w39-project','status':'PENDING'}]
 try: m.native.submit_locked({},wait_seconds=0,line=m.LINE)
 except TimeoutError: pass
 else: raise AssertionError('replica submission bypassed the shared project job limit')
 assert len(captures) == 1 and not m.native.LOCK.exists()
`);
});

test('GGUF collection uses existing checksum and own-line guards', () => {
  python(load + `
import hashlib, base64
with tempfile.TemporaryDirectory() as tmp:
 m.native.ROOT = Path(tmp)
 out = Path(tmp)/'data/cache/w35-vlm-moe/gguf'
 raw = b'{}'
 part = {'name':'performance.json','index':0,'count':1,'sha256':hashlib.sha256(raw).hexdigest(),
         'data':base64.b64encode(raw).decode()}
 m.native.request = lambda path: {'logs':'VLM_ARTIFACT '+json.dumps(part)} if path.endswith('/logs') else {'status':'SUCCEEDED'}
 job = m.LINE+'-'+'0'*12
 m.native.collect(job,out,m.LINE)
 assert (out/'performance.json').read_bytes() == raw
 part['sha256'] = '0'*64
 try: m.native.collect(job,out,m.LINE)
 except ValueError: pass
 else: raise AssertionError('corrupt GGUF artifact accepted')
 for foreign in ['w34-vlm-'+'0'*12,'w36-'+'0'*12]:
  try: m.native.checked_job(foreign,m.LINE)
  except ValueError: pass
  else: raise AssertionError('foreign job accepted')
 try: m.native.checked_output(Path(tmp)/'data/cache/w34-vlm/gguf',m.LINE)
 except ValueError: pass
 else: raise AssertionError('foreign output accepted')
`);
});
