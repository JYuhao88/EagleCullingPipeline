import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('GGUF request uses the frozen shuffled questionnaire without schema-constrained decoding or sampling', () => {
  python(`from ml.observe.vlm_eval_gguf_ray import payload
from ml.observe.vlm_eval_ray import prompt
item = {'id':'fixture','set':'photos','questions':['Q1'],'images':{'full':'fixture.jpg','face':'face.jpg'}}
questions = {'Q1':{'text':'是否在笑','options':{'yes':'在笑','no':'没笑','unknown':'看不清'}}}
config = {'seed':20261017,'prompt_format':'schema','max_new_tokens':256}
for ask in range(3):
 body = payload(item,ask,questions,config,['data:image/png;base64,first','data:image/png;base64,second'])
 content = body['messages'][0]['content']
 assert content[0] == {'type':'text','text':prompt(item,ask,questions,20261017,'schema')}
 assert [entry['image_url']['url'] for entry in content[1:]] == ['data:image/png;base64,first','data:image/png;base64,second']
 assert body['seed'] == 20261017 and body['temperature'] == 0 and body['top_k'] == 1
 assert body['max_tokens'] == 256 and body['cache_prompt'] is False
 assert body['chat_template_kwargs'] == {'enable_thinking':False}
 assert 'response_format' not in body and 'grammar' not in body
`);
});

test('GGUF server stays on loopback with one slot, bounded context and explicit expert placement', () => {
  python(`from pathlib import Path
from ml.observe.vlm_eval_gguf_ray import server_args
config = {'model_files':['language.gguf'],'mmproj_file':'vision.gguf','context_size':4096,
          'n_gpu_layers':99,'n_cpu_moe':14,'batch_size':512,'ubatch_size':128,'threads':2}
args = server_args(Path('/server'),{'language.gguf':Path('/language'),'vision.gguf':Path('/vision')},config,48000)
for flag, value in [('--host','127.0.0.1'),('--port','48000'),('-lv','4'),('--parallel','1'),('-c','4096'),
                    ('-ngl','99'),('--n-cpu-moe','14'),('-ub','128'),('-b','512'),('-t','2'),('-tb','2'),
                    ('--reasoning','off'),('--reasoning-format','deepseek')]:
 assert args[args.index(flag)+1] == value
assert '--no-context-shift' in args and '--no-cont-batching' in args and '--no-warmup' in args
assert args[args.index('--chat-template-kwargs')+1] == '{"enable_thinking":false}'
assert '--reasoning-budget' not in args
`);
});

test('GGUF archive extraction rejects path escape and symbolic links before extracting', () => {
  python(`import io, tarfile, tempfile
from pathlib import Path
from ml.observe.vlm_eval_gguf_ray import unpack
with tempfile.TemporaryDirectory() as root:
 root = Path(root); destination = root/'out'; destination.mkdir()
 for name, link in [('../escape',False),('/absolute',False),('symlink',True)]:
  archive = root/'test.tar.gz'
  with tarfile.open(archive,'w:gz') as stream:
   member = tarfile.TarInfo(name)
   if link: member.type = tarfile.SYMTYPE; member.linkname = '../escape'
   else: member.size = 4
   stream.addfile(member,None if link else io.BytesIO(b'test'))
  try: unpack(archive,destination)
  except ValueError: pass
  else: raise AssertionError('unsafe archive accepted')
 assert not list(destination.iterdir())
`);
});

test('GGUF downloads only pinned explicit assets on the execution node and verifies their checksums', () => {
  python(`import hashlib, sys, tempfile, types
from pathlib import Path
from ml.observe.vlm_eval_gguf_ray import download
import ml.observe.vlm_eval_gguf_ray as worker
worker.gguf_metadata = lambda path, **kwargs: {}
with tempfile.TemporaryDirectory() as root:
 root = Path(root); language = root/'language'; language.write_bytes(b'language')
 vision = root/'vision'; vision.write_bytes(b'vision'); calls = []
 def fetch(repo,name,**options):
  calls.append((repo,name,options)); return str(language if name == 'language.gguf' else vision)
 hub = types.ModuleType('huggingface_hub'); hub.hf_hub_download = fetch; sys.modules['huggingface_hub'] = hub
 config = {'model':'public/language','revision':'a'*40,'model_files':['language.gguf'],
           'mmproj_file':'vision.gguf','mmproj_model':'public/vision','mmproj_revision':'b'*40,
           'file_sha256':{'language.gguf':hashlib.sha256(b'language').hexdigest(),'vision.gguf':hashlib.sha256(b'vision').hexdigest()}}
 performance = {}; files = download(config,performance)
 assert calls == [('public/language','language.gguf',{'revision':'a'*40,'token':False}),
                  ('public/vision','vision.gguf',{'revision':'b'*40,'token':False})]
 assert set(files) == {'language.gguf','vision.gguf'} and len(performance['weight_files']) == 2
 config['file_sha256']['vision.gguf'] = '0'*64
 try: download(config,{})
 except RuntimeError as exc: assert 'checksum mismatch' in str(exc)
 else: raise AssertionError('incorrect GGUF accepted')
`);
});

test('GGUF timings distinguish server compute from HTTP and reject missing accounting or context overflow', () => {
  python(`from copy import deepcopy
from ml.observe.vlm_eval_gguf_ray import response_record
config = {'context_size':4096,'max_new_tokens':256}
result = {'choices':[{'message':{'content':'{}'},'finish_reason':'stop'}],
          'usage':{'prompt_tokens':1000,'completion_tokens':25,'prompt_tokens_details':{'cached_tokens':0}},
          'timings':{'prompt_ms':1200.5,'predicted_ms':800.5}}
row = response_record(result,2.8,config)
assert row['elapsed_s'] == row['server_compute_s'] == 2.001 and row['http_s'] == 2.8
assert row['input_tokens'] == 1000 and row['output_tokens'] == 25
value = deepcopy(result); value['choices'][0]['message']['reasoning_content'] = ''
assert response_record(value,2.8,config)['reasoning_content'] == ''
value['choices'][0]['message']['reasoning_content'] = 'unexpected thought'
try: response_record(value,2.8,config)
except ValueError: pass
else: raise AssertionError('thinking enabled silently')
for bad in ('missing_timing','nonfinite_timing','missing_tokens','context_overflow','cached_prompt'):
 value = deepcopy(result)
 if bad == 'missing_timing': del value['timings']
 elif bad == 'nonfinite_timing': value['timings']['prompt_ms'] = float('nan')
 elif bad == 'missing_tokens': del value['usage']
 elif bad == 'cached_prompt': value['usage']['prompt_tokens_details']['cached_tokens'] = 100
 else: value['usage']['prompt_tokens'] = 3841
 try: response_record(value,2.8,config)
 except ValueError: pass
 else: raise AssertionError(bad+' accepted')
`);
});

test('GGUF smoke sanity uses the frozen parser and never repairs reasoning tags or invalid answers', () => {
  python(`from ml.observe.vlm_eval_gguf_ray import parse_sanity
items = [{'id':'face','set':'photos','questions':['smile']}, {'id':'group','set':'group','kind':'group'}]
rows = [{'id':'face','content':'<think>\\n\\n</think>\\n{"smile":"big"}'},
        {'id':'group','content':'{"choice":"left"}'}]
result = parse_sanity(items,rows)
assert result['photos'] == {'calls':1,'fully_parsed_calls':0}
assert result['group'] == {'calls':1,'fully_parsed_calls':1}
rows.extend([{'id':'face','content':'{"smile":"unsure"}'},
             {'id':'face','content':'{"smile":"big"}','error':'execution error'}])
assert parse_sanity(items,rows)['photos'] == {'calls':3,'fully_parsed_calls':1}
`);
});

test('GGUF metadata records the vision compression and skips tokenizer vocabulary without reading tensors', () => {
  python(`import struct, tempfile
from pathlib import Path
from ml.observe.vlm_eval_gguf_ray import gguf_metadata
pack = lambda fmt, value: struct.pack('<'+fmt,value)
def string(value):
 raw = value.encode(); return pack('Q',len(raw))+raw
entries = [(string('tokenizer.ggml.tokens')+pack('I',9)+pack('I',8)+pack('Q',2)+string('one')+string('two')),
           (string('clip.vision.projector.scale_factor')+pack('I',4)+pack('I',2)),
           (string('general.architecture')+pack('I',8)+string('clip'))]
raw = b'GGUF'+pack('I',3)+pack('Q',20)+pack('Q',len(entries))+b''.join(entries)
with tempfile.TemporaryDirectory() as root:
 file = Path(root)/'synthetic.gguf'; file.write_bytes(raw)
 result = gguf_metadata(file)
 assert result == {'tensor_count':20,'clip.vision.projector.scale_factor':2,'general.architecture':'clip'}
 file.write_bytes(raw[:-1])
 try: gguf_metadata(file)
 except ValueError: pass
 else: raise AssertionError('truncated metadata accepted')
`);
});

test('GGUF capacity metadata uses actual routed expert tensor spans and excludes shared experts', () => {
  python(`import struct, tempfile
from pathlib import Path
from ml.observe.vlm_eval_gguf_ray import gguf_metadata
pack = lambda fmt, value: struct.pack('<'+fmt,value)
def string(value):
 raw = value.encode(); return pack('Q',len(raw))+raw
def tensor(name,kind,offset):
 return string(name)+pack('I',1)+pack('Q',16)+pack('I',kind)+pack('Q',offset)
raw = b'GGUF'+pack('I',3)+pack('Q',3)+pack('Q',0)
raw += tensor('blk.0.ffn_up_exps.weight',11,0)+tensor('blk.0.ffn_down_exps.weight',11,32)+tensor('blk.0.ffn_up_shexp.weight',1,64)
raw += bytes((-len(raw))%32)+bytes(96)
with tempfile.TemporaryDirectory() as root:
 file = Path(root)/'synthetic.gguf'; file.write_bytes(raw)
 result = gguf_metadata(file,inspect_tensors=True)
 assert result['routed_expert_layers']['0']['serialized_span_bytes'] == 64
 assert len(result['routed_expert_layers']['0']['tensors']) == 2
 assert {row['type'] for row in result['routed_expert_layers']['0']['tensors']} == {11}
 assert len(result['tensor_descriptor_sha256']) == 64
`);
});

test('GGUF evaluation refuses silent CPU fallback or partial CUDA layer placement', () => {
  python(`from ml.observe.vlm_eval_gguf_ray import cuda_probe
result = cuda_probe('load_tensors: offloaded 41/41 layers to GPU\\nload_tensors: CUDA0 model buffer size = 14000 MiB')
assert result == {'offloaded_layers':41,'total_layers':41,'cuda_backend':True}
for text in ['no CUDA devices found','offloaded 0/41 layers to GPU\\nCUDA0',
             'offloaded 20/41 layers to GPU\\nCUDA0','offloaded 41/41 layers to GPU']:
 try: cuda_probe(text)
 except RuntimeError: pass
 else: raise AssertionError('missing full CUDA confirmation accepted')
`);
});

test('GGUF worker refuses local execution before opening configuration or downloading assets', () => {
  python(`import os
from unittest.mock import patch
from ml.observe.vlm_eval_gguf_ray import main
for platform,enabled in [('darwin','1'),('win32','1'),('linux','0')]:
 read=patch('pathlib.Path.read_text',side_effect=AssertionError('opened configuration'))
 with patch.dict(os.environ,{'ECP_RAY_WORKER':enabled}), patch('sys.platform',platform), read:
  try: main()
  except RuntimeError as exc: assert 'Linux Ray runtime' in str(exc)
  else: raise AssertionError('local GGUF execution accepted')
`);
});

test('GGUF replicas partition whole items deterministically and reject duplicate, missing or cross-shard answers', () => {
  python(`from copy import deepcopy
from ml.observe.vlm_eval_gguf_ray import shard_rows, combine_predictions
rows = [{'id':str(i)} for i in range(9)]
assert [r['id'] for r in shard_rows(rows,0,2)] == ['0','2','4','6','8']
assert [r['id'] for r in shard_rows(rows,1,2)] == ['1','3','5','7']
parts = [[{'id':r['id'],'ask':ask,'replica_index':i} for r in shard_rows(rows,i,2) for ask in range(3)] for i in range(2)]
result = combine_predictions(rows,[list(reversed(p)) for p in parts],3)
assert [(r['id'],r['ask']) for r in result] == [(r['id'],a) for r in rows for a in range(3)]
for kind in ('duplicate','missing','cross_shard','wrong_replica'):
 bad = deepcopy(parts)
 if kind == 'duplicate': bad[0].append(bad[0][0])
 elif kind == 'missing': bad[0].pop()
 elif kind == 'cross_shard': bad[0][0],bad[1][0] = bad[1][0],bad[0][0]
 else: bad[0][0]['replica_index'] = 1
 try: combine_predictions(rows,bad,3)
 except ValueError: pass
 else: raise AssertionError(kind+' accepted')
try: shard_rows(rows+rows[:1],0,2)
except ValueError: pass
else: raise AssertionError('duplicate manifest identity accepted')
`);
});

test('GGUF replica concurrency preserves isolated server and request options', () => {
  python(`from ml.observe.vlm_eval_gguf_ray import server_args, payload, prediction_metrics
from pathlib import Path
config = {'model_files':['m.gguf'],'mmproj_file':'v.gguf','seed':20261017,'prompt_format':'schema','max_new_tokens':256}
files = {'m.gguf':Path('/m'),'v.gguf':Path('/v')}
first = server_args(Path('/server'),files,config,49000)
second = server_args(Path('/server'),files,config,49001)
second[second.index('--port')+1] = '49000'
assert first == second and first[first.index('--parallel')+1] == '1'
item = {'id':'same','set':'photos','questions':['smile'],'images':{'full':'image.jpg'}}
questions = {'smile':{'text':'主体是否在笑','options':{'big':'明显笑','none':'没有笑'}}}
for ask in range(3):
 assert payload(item,ask,questions,config,['image']) == payload(item,ask,questions,{**config,'replicas':2},['image'])
perf = {}; predictions = [{'id':'same','ask':0,'content':'{"smile":"big"}','elapsed_s':1,'wall_s':2}]
prediction_metrics(perf,[item],predictions)
assert perf['calls'] == 1 and perf['failed_calls'] == 0 and perf['parse_sanity']['photos']['fully_parsed_calls'] == 1
`);
});

test('GGUF replica coordinator stages once, isolates CUDA devices and emits one merged artifact set', () => {
  python(`import io, json
from pathlib import Path
from unittest.mock import patch
import ml.observe.vlm_eval_gguf_ray as worker
rows = [{'id':str(i),'set':'photos','questions':['smile']} for i in range(4)]
config = {'replicas':2,'asks':3,'limit_per_set':0}
emitted, launches = {}, []
class Child:
 def __init__(self,args,**kwargs):
  spec = json.loads(Path(args[-1]).read_text()); launches.append((spec,kwargs))
  self.pid = 123456+spec['_replica_index']
  index = spec['_replica_index']; root = Path(spec['_result_dir'])
  predictions = [{'id':r['id'],'ask':a,'replica_index':index,'content':'{"smile":"big"}',
                  'elapsed_s':1.0,'wall_s':1.1} for r in worker.shard_rows(rows,index,2) for a in range(3)]
  (root/'predictions.jsonl').write_text(''.join(json.dumps(p)+'\\n' for p in predictions))
  perf = {'gpu':'fixture GPU','cuda_placement':{'cuda_backend':True},'sampled_memory':{'device_peak_gib':10+index},
          'build':{'binary_sha256':'b'*64},'weight_files':[{'name':'fixture'}],'chat_template_sha256':'c'*64,
          'inference_started_monotonic':100+index,'inference_ended_monotonic':110+index}
  (root/'performance.json').write_text(json.dumps(perf))
  self.stdout = io.StringIO(''.join('VLM_ROW '+json.dumps(p)+'\\n' for p in predictions))
 def wait(self,timeout=None): return 0
 def poll(self): return 0
def build(config,performance,workspace):
 performance['build'] = {'revision':'a'*40,'binary_sha256':'b'*64}; return workspace/'binary'
def download(config,performance):
 performance['weight_files'] = [{'name':'fixture'}]; return {'fixture':Path('/fixture')}
with patch.object(worker,'build',side_effect=build) as b, patch.object(worker,'download',side_effect=download) as d, \\
     patch.object(worker.subprocess,'Popen',Child), patch.object(worker.os,'killpg'), \\
     patch.object(worker,'emit',side_effect=lambda n,v: emitted.setdefault(n,v)), \\
     patch('sys.stdout',io.StringIO()):
 worker.replicas_main(config,rows,['GPU-first','GPU-second'])
 assert b.call_count == d.call_count == 1
assert len(launches) == 2 and [k['env']['CUDA_VISIBLE_DEVICES'] for s,k in launches] == ['GPU-first','GPU-second']
assert all(s['replicas']==1 and s['_replica_count']==2 and k['start_new_session'] for s,k in launches)
assert set(emitted) == {'report.json','performance.json','predictions.jsonl'}
predictions = [json.loads(line) for line in emitted['predictions.jsonl'].splitlines()]
assert len(predictions) == 12 and len({(p['id'],p['ask']) for p in predictions}) == 12
assert emitted['performance.json']['sampled_memory']['device_peak_gib'] == 11
assert emitted['performance.json']['inference_wall_s'] == 11
`);
});

test('GGUF replica coordinator cleans detached children on TERM and preserves streamed partial answers', () => {
  python(`import io, json, signal, threading
from pathlib import Path
from unittest.mock import patch
import ml.observe.vlm_eval_gguf_ray as worker
emitted, children = {}, []
seen = threading.Event(); previous = signal.getsignal(signal.SIGTERM)
row = {'id':'partial','ask':0,'replica_index':0,'content':'{}'}
class Stream(io.StringIO):
 def __next__(self):
  value = super().__next__(); seen.set(); return value
class Child:
 def __init__(self,args,**kwargs):
  if children:
   assert seen.wait(2)
   signal.raise_signal(signal.SIGTERM)
  self.pid = 123456; self.code = None
  self.stdout = Stream('VLM_ROW '+json.dumps(row)+'\\n'); children.append(self)
 def poll(self): return self.code
 def wait(self,timeout=None): return self.code
def kill(pid,sig):
 assert pid == 123456 and sig == signal.SIGKILL; children[0].code = -9
def build(config,performance,workspace):
 performance['build'] = {}; return workspace/'binary'
def download(config,performance):
 performance['weight_files'] = []; return {}
with patch.object(worker,'build',side_effect=build), patch.object(worker,'download',side_effect=download), \\
     patch.object(worker.subprocess,'Popen',Child), patch.object(worker.os,'killpg',side_effect=kill) as k, \\
     patch.object(worker,'emit',side_effect=lambda n,v: emitted.setdefault(n,v)), patch('sys.stdout',io.StringIO()):
 try: worker.replicas_main({'replicas':2,'asks':3},[{'id':'partial'}],['0','1'])
 except RuntimeError as exc: assert 'terminated' in str(exc)
 else: raise AssertionError('TERM did not fail the coordinator')
 assert k.call_count >= 1
assert signal.getsignal(signal.SIGTERM) == previous
assert 'report.json' not in emitted and 'failure.json' in emitted
assert [json.loads(s) for s in emitted['predictions.jsonl'].splitlines()] == [row]
`);
});

test('GGUF cleanup kills descendant groups even when their replica leader already exited', () => {
  python(`import signal
from types import SimpleNamespace
from unittest.mock import patch
from ml.observe.vlm_eval_gguf_ray import kill_replica_groups
children = [SimpleNamespace(pid=101,poll=lambda:1),SimpleNamespace(pid=102,poll=lambda:None)]
seen = []
def kill(pid,sig):
 seen.append((pid,sig))
 if pid == 101: raise ProcessLookupError()
with patch('os.killpg',side_effect=kill): kill_replica_groups(children)
assert seen == [(101,signal.SIGKILL),(102,signal.SIGKILL)]
`);
});
