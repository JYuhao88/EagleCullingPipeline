import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(lines) {
  const result = spawnSync('python3', ['-c', lines.join('\n')], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('two replicas keep one W36 job with two GPUs and unchanged generation', () => python([
  "import importlib.util,json,tempfile",
  "from pathlib import Path",
  "spec=importlib.util.spec_from_file_location('submit','scripts/observe-vlm-ray.py');"
    + "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)",
  "real_root=m.ROOT",
  "with tempfile.TemporaryDirectory() as tmp:",
  " m.ROOT=Path(tmp);prepared=Path(tmp)/'prepared';prepared.mkdir();(prepared/'manifest.jsonl').write_text('{}')",
  " captured={};m.package=lambda prepared,config:captured.update(config=config) or b'bounded'",
  " m.request=lambda *a,**kw:{};m.submit_locked=lambda body,**kw:captured.update(body=body) or {}",
  " m.setting=lambda *a,**kw:'';m.require_path=lambda *a:'/shared'",
  " args=m.arguments(['submit','--line','w36-vlm-critique','--task','critique','--replicas','2','--license','Apache-2.0',"
    + "'--prepared',str(prepared),'--output',str(Path(tmp)/'data/cache/w36-vlm-critique/two'),"
    + "'--critique-prompt',str(real_root/'ml/observe/prompts/critique-v1.md')])",
  " m.submit(args)",
  " assert captured['config']['replicas']==2 and captured['config']['asks']==2",
  " assert captured['config']['seeds']==[36001,36002] and captured['config']['temperature']==0",
  " assert captured['body']['entrypoint_num_gpus']==2 and captured['body']['entrypoint_num_cpus']==4",
  " assert 'ml.observe.vlm_eval_replicas' in captured['body']['entrypoint']",
  " args.line='w35-vlm-moe'",
  " try:m.submit(args)",
  " except ValueError:pass",
  " else:raise AssertionError('changed W35 execution')",
]));

test('two-replica packages contain the driver and pinned single-GPU worker', () => python([
  "import importlib.util,hashlib,io,json,tempfile,zipfile",
  "from pathlib import Path",
  "spec=importlib.util.spec_from_file_location('submit','scripts/observe-vlm-ray.py');"
    + "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)",
  "with tempfile.TemporaryDirectory() as tmp:",
  " prepared=Path(tmp);(prepared/'manifest.jsonl').write_text('{}')",
  " prompt=m.ROOT/'ml/observe/prompts/critique-v1.md'",
  " config={'task':'critique','replicas':2,'critique_prompt':str(prompt),'prompt_sha256':hashlib.sha256(prompt.read_bytes()).hexdigest()}",
  " archive=zipfile.ZipFile(io.BytesIO(m.package(prepared,config)))",
  " assert 'ml/observe/vlm_eval_replicas.py' in archive.namelist()",
  " assert 'ml/observe/vlm_eval_ray.py' in archive.namelist()",
]));

test('replica assignment requires exactly two distinct visible devices', () => python([
  "from ml.observe.vlm_eval_replicas import devices",
  "assert devices('3,7')==['3','7']",
  "for value in (None,'','0','0,0','0,1,2','0, 1'):",
  " try:devices(value)",
  " except ValueError:pass",
  " else:raise AssertionError('invalid GPU assignment accepted')",
]));

test('replica performance separates per-GPU peaks from their sum and retains call latency', () => python([
  "from ml.observe.vlm_eval_replicas import merge_performance",
  "config={'variants':['A','B'],'vram_limit_gib':12}",
  "def perf(peak):return {'items':1,'warmup_calls':1,'inference_wall_s':10,'peak_reserved_gib':peak,'peak_allocated_gib':peak-1,"
    + "'memory_by_variant':{v:{'peak_reserved_gib':peak,'peak_allocated_gib':peak-1} for v in ('A','B')}}",
  "predictions=[{'id':'a','variant':'A','set':'photos','elapsed_s':2,'wall_s':3},"
    + "{'id':'b','variant':'A','set':'photos','elapsed_s':4,'wall_s':5}]",
  "result=merge_performance(config,[perf(7),perf(9)],predictions,14)",
  "assert result['peak_reserved_gib']==9 and result['sum_replica_peak_reserved_gib']==16",
  "assert result['memory_by_variant']['A']['sum_replica_peak_reserved_gib']==16",
  "assert result['wall_latency_by_variant']['A']['p50_s']==4",
  "assert result['replica_count']==2 and result['warmup_calls']==2 and result['calls']==2",
  "assert result['within_12_gib_allocator'] is True",
]));

test('missing replica memory remains unknown and cannot claim to fit the deployment limit', () => python([
  "from ml.observe.vlm_eval_replicas import merge_performance",
  "config={'variants':['A','B'],'vram_limit_gib':12,'replicas':2}",
  "known={'peak_reserved_gib':7,'peak_allocated_gib':6,'process_gpu_gib_after_inference':8,"
    + "'memory_by_variant':{'A':{'peak_reserved_gib':7,'peak_allocated_gib':6}}}",
  "for measurements in ([],[known],[known,{}],[known,{'peak_reserved_gib':None}]):",
  " result=merge_performance(config,measurements,[],1)",
  " assert result['peak_reserved_gib'] is None and result['peak_allocated_gib'] is None",
  " assert result['sum_replica_peak_reserved_gib'] is None",
  " assert result['within_12_gib_allocator'] is None and result['within_configured_gib_allocator'] is None",
  " assert result['process_gpu_gib_after_inference'] is None",
  " assert result['memory_by_variant']['A']['peak_reserved_gib'] is None",
  " assert result['memory_by_variant']['B']['sum_replica_peak_reserved_gib'] is None",
  " both=merge_performance(config,[known,known],[],1)",
  " assert both['process_gpu_gib_after_inference']==8 and both['within_12_gib_allocator'] is True",
]));

test('merged token rates use all recorded calls and label the actual job wall-time denominator', () => python([
  "from ml.observe.vlm_eval_replicas import merge_performance",
  "config={'variants':['A'],'vram_limit_gib':12,'replicas':2}",
  "perf={'inference_wall_s':5,'generated_tokens_per_second':999}",
  "rows=[{'variant':'A','set':'photos','elapsed_s':2,'wall_s':3,'output_tokens':20},"
    + "{'variant':'A','set':'photos','elapsed_s':3,'wall_s':4,'output_tokens':30}]",
  "result=merge_performance(config,[perf,perf],rows,20)",
  "assert result['generated_tokens_per_second']==10 and result['generated_tokens_per_job_second']==2.5",
  "assert result['calls_per_second']==.1",
  "assert 'not job throughput' in result['generated_tokens_per_second_scope']",
  "assert 'including model load and warmup' in result['job_throughput_scope']",
  "rows[0].pop('output_tokens')",
  "missing=merge_performance(config,[perf,perf],rows,20)",
  "assert missing['generated_tokens_per_second'] is None and missing['generated_tokens_per_job_second'] is None",
]));

test('report telemetry normalizes legacy zero placeholders from the underlying replica samples', () => python([
  "from ml.observe.critique_report import telemetry",
  "config={'replicas':2}",
  "known={'process_gpu_gib_after_inference':None,'memory_by_variant':{'A':{'peak_reserved_gib':7,'peak_allocated_gib':6}}}",
  "performance={'config':config,'replica_count':2,'process_gpu_gib_after_inference':0,'replicas':[known,known],"
    + "'memory_by_variant':{'A':{'peak_reserved_gib':7,'peak_allocated_gib':6}}}",
  "result=telemetry(performance,'A')",
  "assert result['wholeJobProcessGiBAfterInference'] is None",
  "assert result['allocatorMemoryGiB']['peak_reserved_gib']==7"
    + " and result['allocatorMemoryGiB']['sum_replica_peak_reserved_gib']==14",
  "performance['replicas']=[known,{}]",
  "partial=telemetry(performance,'A')",
  "assert partial['allocatorMemoryGiB']['peak_reserved_gib'] is None and partial['wholeJobProcessGiBAfterInference'] is None",
  "performance['replicas']=[]",
  "assert telemetry(performance,'A')['allocatorMemoryGiB']['peak_reserved_gib'] is None",
  "assert telemetry({'process_gpu_gib_after_inference':0},'A')['wholeJobProcessGiBAfterInference']==0",
]));

const fake = [
  "import base64,hashlib,json,os,sys",
  "from pathlib import Path",
  "def emit(name,value):",
  " raw=json.dumps(value).encode();print('VLM_ARTIFACT '+json.dumps({'name':name,'index':0,'count':1,"
    + "'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}),flush=True)",
  "config=json.loads(Path('vlm-config.json').read_text());rows=[json.loads(s) for s in Path('manifest.jsonl').read_text().splitlines()]",
  "device=os.environ['CUDA_VISIBLE_DEVICES'];assert ',' not in device and config['limit_per_set']==0",
  "if config.get('fail_device')==device:sys.exit(3)",
  "for row in rows:",
  " for variant in ('A','B') if row['set']=='photos' else ('A',):",
  "  for ask in (0,1):",
  "   content=json.dumps({'summary':'人像','strengths':[],'issues':[],'edits':[],'verdict':'保留'},ensure_ascii=False)",
  "   print('VLM_ROW '+json.dumps({'id':row['id'],'variant':variant,'ask':ask,'seed':config['seeds'][ask],'set':row['set'],"
    + "'content':content,'elapsed_s':2,'wall_s':3,'fake_device':device}),flush=True)",
  "emit('performance.json',{'items':len(rows),'warmup_calls':1,'inference_wall_s':2,'peak_reserved_gib':7,'peak_allocated_gib':6,"
    + "'memory_by_variant':{v:{'peak_reserved_gib':7,'peak_allocated_gib':6} for v in ('A','B')}})",
].join('\n');

function processTest(fails, duplicate = false, reportFails = false) {
  python([
    "import contextlib,io,json,os,tempfile,base64",
    "from pathlib import Path",
    "import ml.observe.vlm_eval_replicas as module",
    "from ml.observe.vlm_eval_replicas import run,artifact",
    "worker=" + JSON.stringify(duplicate ? fake.replace("flush=True)\nemit('performance.json'",
      "flush=True)\n   if ask==0:print('VLM_ROW '+json.dumps({'id':row['id'],'variant':variant,'ask':ask,'seed':config['seeds'][ask],"
        + "'set':row['set'],'content':content,'elapsed_s':2,'wall_s':3,'fake_device':device}),flush=True)\nemit('performance.json'")
      : fake),
    ...(reportFails ? ["def broken_report(*args):raise RuntimeError('synthetic report failure')",
      "module.critique_report=broken_report"] : []),
    "original=Path.cwd()",
    "with tempfile.TemporaryDirectory() as tmp:",
    " root=Path(tmp);(root/'ml').mkdir();(root/'ml/__init__.py').write_text('');(root/'ml/fake.py').write_text(worker)",
    " (root/'images').mkdir();os.chdir(root);os.environ['CUDA_VISIBLE_DEVICES']='left,right'",
    " config={'task':'critique','replicas':2,'asks':2,'seeds':[36001,36002],'variants':['A','B'],'limit_per_set':1,"
      + "'vram_limit_gib':12,'prompt_sha256':'a'*64," + (fails ? "'fail_device':'right'," : '') + "}",
    " rows=[{'id':subset+str(i),'set':subset,'storage':'package','images':{'full':'images/view.jpg'}}"
      + " for subset in ('photos','openimages') for i in range(2)]",
    " output=io.StringIO()",
    " with contextlib.redirect_stdout(output):success=run(config,rows,worker_module='ml.fake')",
    " os.chdir(original);emitted={}",
    " for line in output.getvalue().splitlines():",
    "  if not line.startswith('VLM_ARTIFACT '):continue",
    "  value=json.loads(line.removeprefix('VLM_ARTIFACT '));entry=emitted.setdefault(value['name'],{**value,'parts':{}});"
      + "entry['parts'][value['index']]=value['data']",
    " raw=base64.b64decode(''.join(emitted['predictions.jsonl']['parts'][i]"
      + " for i in range(emitted['predictions.jsonl']['count']))).decode()",
    " predicted=[json.loads(s) for s in raw.splitlines()]",
    " assert success is " + (fails || duplicate || reportFails ? 'False' : 'True'),
    " assert len(predicted)==" + (duplicate ? 9 : fails ? 4 : 6),
    ...(!duplicate ? [" assert len({(r['id'],r['variant'],r['ask']) for r in predicted})==len(predicted)"] : []),
    " assert all(len({r['replica'] for r in predicted if r['id']==item})==1 for item in {r['id'] for r in predicted})",
    " assert all(r['seed']==config['seeds'][r['ask']] for r in predicted)",
    " assert ('failure.json' in emitted) is " + (fails || duplicate || reportFails ? 'True' : 'False'),
    " assert artifact(emitted,'performance.json')['replica_count']==" + (fails ? 1 : 2),
    ...((duplicate || reportFails) ? [" assert artifact(emitted,'report.json')['status']=='aggregation_failed'",
      " assert any(item['error']=='aggregation_failed' for item in artifact(emitted,'failure.json')['replicas'])"] : []),
  ]);
}

test('replica processes mask devices, keep paired asks and apply corpus limits globally', () => processTest(false));
test('a failed replica retains surviving rows and marks the combined job failed', () => processTest(true));
test('duplicate predictions retain artifacts and always emit an explicit failure', () => processTest(false, true));
test('an unexpected report exception retains performance and emits an explicit failure', () => processTest(false, false, true));
