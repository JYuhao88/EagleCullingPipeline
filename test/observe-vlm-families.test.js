import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const load = `from ml.observe.vlm_eval_ray import family_config, prepare_inputs
revision = 'a' * 40
messages = [{'role':'user','content':[{'type':'text','text':'固定问卷'},{'type':'image','image':'first'},{'type':'image','image':'second'}]}]
class Processor:
 def __init__(self): self.calls = []
 def apply_chat_template(self, supplied, **options):
  assert supplied is messages
  self.calls.append(options)
  return 'rendered' if not options['tokenize'] else {'input_ids':'native'}
 def __call__(self, **options):
  self.calls.append(options)
  return {'input_ids':'legacy'}
`;

test('VLM family adapters retain the existing Qwen preprocessing and generation settings', () => {
  python(load + `
p = Processor()
inputs, generation = prepare_inputs(p,messages,['first','second'],{'revision':revision})
assert inputs == {'input_ids':'legacy'} and generation == {}
assert p.calls == [{'tokenize':False,'add_generation_prompt':True},
                  {'text':['rendered'],'images':['first','second'],'padding':True,'return_tensors':'pt'}]
`);
});

test('MiniCPM compression agrees between native preprocessing and generation without changing the questionnaire', () => {
  python(load + `
for compression in (4,16):
 p = Processor()
 inputs, generation = prepare_inputs(p,messages,['first','second'],
                                    {'revision':revision,'family':'minicpm','compression':compression})
 assert inputs == {'input_ids':'native'}
 assert generation == {'downsample_mode':str(compression)+'x'}
 assert p.calls == [{'tokenize':True,'add_generation_prompt':True,'return_dict':True,
                    'return_tensors':'pt','enable_thinking':False,
                    'processor_kwargs':{'downsample_mode':str(compression)+'x','max_slice_nums':36}}]
`);
});

test('Qwen MoE uses native vision and disables thinking for the frozen short JSON protocol', () => {
  python(load + `
p = Processor()
inputs, generation = prepare_inputs(p,messages,['first','second'],{'revision':revision,'family':'qwen3_5_moe'})
assert inputs == {'input_ids':'native'} and generation == {}
assert p.calls == [{'tokenize':True,'add_generation_prompt':True,'return_dict':True,
                   'return_tensors':'pt','enable_thinking':False}]
`);
});

test('VLM family selection rejects unpinned remote code and unsupported compression before loading', () => {
  python(load + `
for config in [{'revision':'main'}, {'revision':revision,'family':'unknown'},
               {'revision':revision,'trust_remote_code':True},
               {'revision':revision,'trust_remote_code':True,'code_revision':'b'*40},
               {'revision':revision,'compression':16},
               {'revision':revision,'family':'minicpm','compression':8}]:
 try: family_config(config)
 except ValueError: pass
 else: raise AssertionError('invalid model configuration accepted')
assert family_config({'revision':revision,'trust_remote_code':True,'code_revision':revision}) == 'qwen-vl'
`);
});

const loader = `import sys, types, json
from ml.observe.vlm_eval_ray import load_model
revision = 'a' * 40
fields = ('missing_keys','unexpected_keys','mismatched_keys','error_msgs','conversion_errors')
class Loaded:
 def __init__(self): self.evaluated = False
 def eval(self): self.evaluated = True; return self
loaded = Loaded()
loading = types.ModuleType('transformers.modeling_utils')
def original(*args, **kwargs):
 if kwargs['loading_info'].conversion_errors: raise RuntimeError('synthetic conversion failure')
loading.log_state_dict_report = original
transformers = types.ModuleType('transformers'); transformers.modeling_utils = loading
sys.modules['transformers'] = transformers; sys.modules['transformers.modeling_utils'] = loading
clean = {key: {} if key == 'conversion_errors' else set() for key in fields}
class Model:
 details = clean
 calls = []
 @classmethod
 def from_pretrained(cls,path,**options):
  cls.calls.append((path,options))
  loading.log_state_dict_report(loading_info=types.SimpleNamespace(**cls.details))
  return loaded, {key:value for key,value in cls.details.items() if key != 'conversion_errors'}
config = {'family':'minicpm','revision':revision,'quantization':'native'}
`;

test('VLM native loading records complete diagnostics without altering the pinned loader options', () => {
  python(loader + `
performance = {}
options = {'revision':revision,'trust_remote_code':False,'local_files_only':True}
assert load_model(Model,'local-model',options,config,performance) is loaded
assert loaded.evaluated and loading.log_state_dict_report is original
assert Model.calls == [('local-model',{**options,'output_loading_info':True})]
assert set(performance['loading_info']) == set(fields)
assert not any(performance['loading_info'].values())
json.dumps(performance)
`);
});

test('VLM native loading rejects every nonempty integrity diagnostic and retains failure details', () => {
  python(loader + `
failures = {'missing_keys':{'model.language_model.layers.0.mlp.experts.gate_up_proj'},
            'unexpected_keys':{'model.language_model.layers.0.mlp.experts.0.weight_packed'},
            'mismatched_keys':{('model.vision_tower.weight',(2,3),(3,2))},
            'error_msgs':['synthetic loading error'],
            'conversion_errors':{'model.language_model.layers.0.mlp.experts':'synthetic conversion details'}}
for field, failure in failures.items():
 Model.details = {**clean,field:failure}
 performance = {}; loaded.evaluated = False
 try: load_model(Model,'local-model',{},config,performance)
 except RuntimeError: pass
 else: raise AssertionError('corrupt or incomplete weights accepted: '+field)
 assert performance['loading_info'][field]
 assert not loaded.evaluated and loading.log_state_dict_report is original
 json.dumps(performance)
assert performance['loading_info']['conversion_errors'] == failures['conversion_errors']
`);
});

test('VLM native loading refuses incomplete diagnostics and restores its report hook on early failure', () => {
  python(loader + `
class Incomplete:
 @classmethod
 def from_pretrained(cls,*args,**kwargs): return loaded, {}
try: load_model(Incomplete,'local-model',{},config,{})
except RuntimeError as exc: assert 'incomplete' in str(exc)
else: raise AssertionError('missing diagnostics accepted')
assert loading.log_state_dict_report is original
class Broken:
 @classmethod
 def from_pretrained(cls,*args,**kwargs): raise OSError('synthetic checkpoint read failure')
try: load_model(Broken,'local-model',{},config,{})
except OSError: pass
else: raise AssertionError('loader failure swallowed')
assert loading.log_state_dict_report is original
`);
});

test('VLM loading hardening preserves the default Qwen loader call and checks all new families', () => {
  python(loader + `
class Legacy:
 calls = []
 @classmethod
 def from_pretrained(cls,*args,**kwargs): cls.calls.append((args,kwargs)); return loaded
options = {'revision':revision,'trust_remote_code':False}
performance = {}
assert load_model(Legacy,'local-model',options,{'revision':revision,'quantization':'bnb4'},performance) is loaded
assert Legacy.calls == [(('local-model',),options)] and performance == {}
for family, quantization in [('minicpm','none'),('qwen3_5_moe','none'),('qwen-vl','native')]:
 performance = {}; Model.details = clean
 load_model(Model,'local-model',options,{'family':family,'revision':revision,'quantization':quantization},performance)
 assert set(performance['loading_info']) == set(fields)
`);
});


test('MiniCPM native processor keeps pinned assets and supplies its native config for stale quantized class names', () => {
  python(`import sys, types
from ml.observe.vlm_eval_ray import load_processor
revision = 'a' * 40
calls = []
class Native:
 @classmethod
 def from_pretrained(cls,path,**options): calls.append(('native',path,options)); return 'native'
class Auto:
 @classmethod
 def from_pretrained(cls,path,**options): calls.append(('auto',path,options)); return 'auto'
transformers = types.ModuleType('transformers'); transformers.MiniCPMV4_7Processor = Native
sys.modules['transformers'] = transformers
options = {'revision':revision,'local_files_only':True,'trust_remote_code':False}
model_config = object()
assert load_processor(Auto,'pinned-local',options,{'family':'minicpm','revision':revision},model_config) == 'native'
assert calls == [('native','pinned-local',{**options,'config':model_config})]
assert 'config' not in options
for family in ('qwen-vl','qwen3_5_moe'):
 assert load_processor(Auto,'pinned-local',options,{'family':family,'revision':revision},model_config) == 'auto'
 assert calls[-1] == ('auto','pinned-local',options)
`);
});
