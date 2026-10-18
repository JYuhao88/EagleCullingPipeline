import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const fixture = `import copy, hashlib, json, tempfile
from pathlib import Path
from ml.observe import critique_report as m
from ml.observe.critique import split_statements

def write_rows(file, rows):
 file.parent.mkdir(parents=True,exist_ok=True)
 file.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\\n' for row in rows))

def setup(directory):
 root = Path(directory)/'data/cache/w36-vlm-critique'; root.mkdir(parents=True)
 m.CACHE_ROOT = root
 manifest = [{'id':'p1','set':'photos','specialist_facts':[{'id':'gaze','text':'看镜头'}]},
  {'id':'p2','set':'photos','specialist_facts':[]},{'id':'o1','set':'openimages','specialist_facts':[]}]
 write_rows(root/'prepared/manifest.jsonl',manifest)
 model = 'example/local-model'
 config = {'model':model,'prompt_sha256':'a'*64}
 performance = {'config':config,'wall_latency_by_variant':{'A':{'n':6,'p50_s':1,'p95_s':2}},
  'generation_latency_by_variant':{'A':{'n':6,'p50_s':.5,'p95_s':1.5}},
  'memory_by_variant':{'A':{'peak_allocated_gib':6,'peak_reserved_gib':7},
   'B':{'peak_allocated_gib':8,'peak_reserved_gib':9}},
  'sampled_memory':{'device_peak_gib':10},'memory_caveat':'allocator peak excludes CUDA context'}
 source = root/'minicpm-int4-4x-full'; source.mkdir()
 (source/'performance.json').write_text(json.dumps(performance))
 rows, judges = [], []
 for item in manifest:
  for variant in (['A','B'] if item['set']=='photos' else ['A']):
   for ask in [0,1]:
    critique = {'summary':'人物突出','strengths':[{'text':'人物突出'}],
     'issues':[{'category':'composition/crop','text':'右侧留白较多'}],
     'edits':[{'action':'crop/straighten','direction':'裁去右侧少量空白','reason':'突出人物'}],
     'verdict':'可修后保留'}
    if item['id']=='p1' and ask==1:
     critique['issues'] = [{'category':'exposure','text':'面部亮度偏暗'}]
    row = {'id':item['id'],'image_id':item['id'],'set':item['set'],'model':model,
     'variant':variant,'ask':ask,'prompt_sha256':'a'*64,'critique':critique,
     'content':json.dumps(critique,ensure_ascii=False),'statements':split_statements(critique),
     'wall_s':1+ask,'elapsed_s':.5+ask}
    rows.append(row)
    for family in ['flash','gpt','claude']:
     votes = [{'id':statement['id'],'correctness':'正确',
      'reasonableness':'合理' if statement['kind']=='edit' else '无法判断',
      'contradiction':'不矛盾','adds_information':'新增','novelty':'新增'} for statement in row['statements']]
     if item['id']=='p2' and variant=='A' and family in ['flash','gpt']:
      votes[1]['correctness'] = '错误'
     if item['id']=='o1' and variant=='A' and family=='claude':
      votes[-1]['correctness'] = '无法判断'
     judges.append({'item_id':item['id'],'model':model,'variant':variant,'ask':ask,
      'prompt_sha256':'a'*64,'critique_id':m.critique_id(row,critique,row['statements']),
      'teacher':family,'status':200,'valid':True,'statements':votes})
 write_rows(source/'predictions.jsonl',rows)
 write_rows(root/'judge-pilot/judgments.jsonl',judges)
 return root, rows, judges
`;

test('critique report joins only ask0 judgments, retains splits and writes all six cells', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 result = m.report(root)
 assert len(result['cells']) == 6 and result['primaryAsk'] == 0
 a = next(cell for cell in result['cells'] if cell['modelSlug']=='minicpm-int4-4x' and cell['variant']=='A')
 assert a['status']=='judged' and a['fullyFormattedAndJudged'] is True
 assert a['preregisteredGatesPass'] is False
 stats = a['splits']['all']
 assert stats['photos']==3
 assert stats['statements']['correct']==10 and stats['statements']['wrong']==1 and stats['statements']['disputed']==1
 assert stats['statements']['judged']==11 and stats['statements']['precision']==10/11
 assert stats['edits']['judged']==3 and stats['edits']['precision']==1
 assert stats['hallucination']['wrongPhotos']==1 and stats['hallucination']['unresolvedPhotos']==1
 assert stats['descriptiveHallucination']['wrongValidPrimaryPhotos']==1
 assert stats['descriptiveHallucination']['validPrimaryPhotos']==3
 assert stats['descriptiveHallucination']['knownWrongRateAmongValidPrimaryPhotos']==1/3
 assert stats['descriptiveHallucination']['unresolvedValidPrimaryPhotos']==1
 assert stats['contradiction']['judged']==4 and stats['contradiction']['rate']==0
 assert stats['novelty']['judged']==12 and stats['novelty']['rate']==1
 assert a['splits']['photos']['photos']==2 and a['splits']['openimages']['photos']==1
 assert a['stability']['issues']['n']==3 and abs(a['stability']['issues']['jaccard']-2/3)<1e-12
 assert a['stability']['edits']['jaccard']==1
 assert a['telemetry']['wallLatencySeconds']['p50_s']==1
 assert a['telemetry']['allocatorMemoryGiB']['peak_reserved_gib']==7
 assert stats['peakVramMb']['p50'] is None
 missing = next(cell for cell in result['cells'] if cell['modelSlug']=='qwen36-bf16' and cell['variant']=='A')
 assert missing['status']=='missing_model' and missing['preregisteredGatesPass'] is False
 assert missing['coverage']['missingAsk0']==3 and missing['splits']['all']['photos']==3
 assert missing['splits']['all']['hallucination']['unresolvedPhotos']==3
 assert missing['splits']['all']['descriptiveHallucination']['knownWrongRateAmongValidPrimaryPhotos'] is None
 for slug in m.DEFAULT_MODELS:
  for variant in ['A','B']:
   assert (root/(slug+'-'+variant)/'results.json').is_file()
   merged = [json.loads(line) for line in (root/(slug+'-'+variant)/'predictions.jsonl').read_text().splitlines()]
   assert len(merged)==(6 if variant=='A' else 4)
 assert json.loads((root/'results.json').read_text())==result
`);
});

test('critique report preserves missing and invalid photos and repeat stability denominators', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 partial = copy.deepcopy(rows[0]); partial['model']='example/partial'
 invalid = copy.deepcopy(partial); invalid.update(id='p2',image_id='p2',content='not JSON',critique=None,statements=[])
 source = root/'qwen3-vl-8b-full'
 write_rows(source/'predictions.jsonl',[partial,invalid])
 (source/'failure.json').write_text(json.dumps({'error':'TimeoutError'}))
 result = m.report(root)
 a = next(cell for cell in result['cells'] if cell['modelSlug']=='qwen3-vl-8b' and cell['variant']=='A')
 assert a['status']=='incomplete_inference' and a['preregisteredGatesPass'] is False
 assert a['coverage']=={'expectedPhotos':3,'presentAsk0':2,'validAsk0':1,'missingAsk0':1,
  'failedAsk0':0,'invalidAsk0':1,'threeFamilyJudgedPhotos':0}
 assert a['splits']['all']['photos']==3 and a['splits']['all']['hallucination']['unresolvedPhotos']==3
 assert a['splits']['all']['statements']['disputed']==4
 assert a['splits']['all']['descriptiveHallucination']['validPrimaryPhotos']==1
 assert a['splits']['all']['descriptiveHallucination']['wrongValidPrimaryPhotos']==0
 assert a['splits']['all']['descriptiveHallucination']['unresolvedValidPrimaryPhotos']==1
 assert a['stability']['issues']['n']==0 and a['stability']['issues']['missingOrInvalid']==3
 assert a['failure']['error']=='TimeoutError'
 merged = [json.loads(line) for line in (root/'qwen3-vl-8b-A/predictions.jsonl').read_text().splitlines()]
 assert len(merged)==6 and sum(row.get('error')=='missing_prediction' for row in merged)==4
`);
});

test('inference failures, invalid JSON and missing judge votes remain distinct', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 selected = [copy.deepcopy(row) for row in rows if row['variant']=='A' and row['ask']==0]
 selected[0].update(content='',critique=None,statements=[],error='OutOfMemoryError',parse_error='invalid_critique_json')
 selected[1].update(content='not JSON',critique=None,statements=[],parse_error='invalid_critique_json')
 source=root/'minicpm-int4-4x-full/predictions.jsonl'
 write_rows(source,selected)
 # The remaining formatted photo has only two valid independent judge responses.
 votes=[vote for vote in judges if vote['item_id']=='o1' and vote['variant']=='A' and vote['ask']==0 and vote['teacher']!='flash']
 write_rows(root/'judge-pilot/judgments.jsonl',votes)
 result=m.report(root,models=['minicpm-int4-4x'])
 cell=result['cells'][0]
 assert cell['coverage']['expectedPhotos']==3 and cell['coverage']['presentAsk0']==3
 assert cell['coverage']['failedAsk0']==1 and cell['coverage']['invalidAsk0']==1
 assert cell['coverage']['validAsk0']==1 and cell['coverage']['threeFamilyJudgedPhotos']==0
 assert cell['splits']['all']['statements']['disputed']==4
 merged=[json.loads(line) for line in (root/'minicpm-int4-4x-A/predictions.jsonl').read_text().splitlines()]
 failure=next(row for row in merged if row['id']=='p1' and row['ask']==0)
 invalid=next(row for row in merged if row['id']=='p2' and row['ask']==0)
 unjudged=next(row for row in merged if row['id']=='o1' and row['ask']==0)
 assert failure['error']=='OutOfMemoryError' and failure['parse_error'] is None
 assert invalid.get('error') is None and invalid['parse_error']=='invalid_critique_json'
 assert unjudged['critique'] is not None and unjudged.get('parse_error') is None
 assert set(unjudged['judgments'])=={'gpt','claude'}
`);
});

test('critique report rejects stale receipts and disputes conflicting independent-family votes', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 base = next(row for row in judges if row['item_id']=='p1' and row['variant']=='A' and row['ask']==0 and row['teacher']=='flash')
 conflict = copy.deepcopy(base); conflict['statements'][0]['correctness']='错误'
 stale = copy.deepcopy(base); stale.update(teacher='gpt',prompt_sha256='b'*64)
 write_rows(root/'judge-full/judgments.jsonl',[conflict,stale])
 result = m.report(root,models=['minicpm-int4-4x'])
 cell = result['cells'][0]
 assert cell['status']=='awaiting_judges' and cell['preregisteredGatesPass'] is False
 assert cell['coverage']['threeFamilyJudgedPhotos']==2
 assert any(row['error']=='stale_judgment' for row in result['diagnostics'])
 assert any(row['error']=='conflicting_judgment' for row in result['diagnostics'])
 merged = [json.loads(line) for line in (root/'minicpm-int4-4x-A/predictions.jsonl').read_text().splitlines()]
 primary = next(row for row in merged if row['id']=='p1' and row['ask']==0)
 assert set(primary['judgments'])=={'gpt','claude'}
`);
});

test('critique report cannot write outside its line, traverse prefixes or follow escaped output links', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 outside = Path(tmp)/'outside'; outside.mkdir()
 for operation in [lambda:m.report(outside),lambda:m.report(root,models=['../outside'])]:
  try: operation()
  except ValueError: pass
  else: raise AssertionError('escaped report accepted')
 (root/'minicpm-int4-4x-A').symlink_to(outside,target_is_directory=True)
 try: m.report(root)
 except ValueError: pass
 else: raise AssertionError('escaped output link accepted')
 assert not (outside/'results.json').exists() and not (root/'results.json').exists()
`);
});

test('critique report CLI is repeatable and refuses a malformed or duplicate corpus manifest', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 m.main(['--root',str(root),'--models','minicpm-int4-4x'])
 first = (root/'results.json').read_bytes()
 m.main(['--root',str(root),'--models','minicpm-int4-4x'])
 assert (root/'results.json').read_bytes()==first
 manifest = root/'prepared/manifest.jsonl'
 with manifest.open('a') as out: out.write('not JSON\\n')
 try: m.report(root)
 except ValueError: pass
 else: raise AssertionError('malformed corpus accepted')
 assert (root/'results.json').read_bytes()==first
 write_rows(manifest,[{'id':'p1','set':'photos'},{'id':'p1','set':'openimages'}])
 try: m.report(root)
 except ValueError: pass
 else: raise AssertionError('duplicate corpus id accepted')
`);
});

test('critique receipt identity matches the existing JavaScript teacher path exactly', () => {
  python(fixture + `
import subprocess
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 row = rows[0]
 code = r"""
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import sharp from 'sharp';
import {prepareRequests,preregister,TEACHERS} from './scripts/observe-critique-judge.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;const row=JSON.parse(input);
const root=await mkdtemp(path.join(os.tmpdir(),'critique-identity-'));
try{
 const cache=path.join(root,'cache'),prepared=path.join(root,'prepared'),output=path.join(cache,'pilot'),
  ledgerFile=path.join(root,'ledger.jsonl');
 await mkdir(path.join(prepared,'images'),{recursive:true});await preregister(cache);
 await sharp({create:{width:12,height:12,channels:3,background:'#abc'}}).jpeg()
  .toFile(path.join(prepared,'images/view.jpg'));
 await writeFile(ledgerFile,
  Object.values(TEACHERS).map(model=>JSON.stringify({model,pricing:{input:1,output:2,usdToCny:7}})+'\\n').join(''));
 await prepareRequests({cache,prepared,output,ledgerFile,cap:1200,rows:[row],
  manifest:[{id:row.id,set:'photos',storage:'package',images:{full:'images/view.jpg'}}]});
 const batch=JSON.parse(await readFile(path.join(output,'judge-batch.json'),'utf8'));process.stdout.write(batch.entries[0].critique_id);
}finally{await rm(root,{recursive:true,force:true})}
"""
 actual = subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(row,ensure_ascii=False),
  text=True,capture_output=True,check=True).stdout
 assert m.critique_id(row,row['critique'],row['statements'])==actual
`);
});

test('partial model artifacts do not prevent other model summaries', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 partial = root/'qwen36-bf16-full'; partial.mkdir()
 (partial/'performance.json').write_text('{truncated')
 (partial/'job.json').write_text('[]')
 (partial/'predictions.jsonl').write_text('{truncated\\n')
 result = m.report(root)
 assert len(result['cells'])==6
 assert next(cell for cell in result['cells'] if cell['modelSlug']=='minicpm-int4-4x' and cell['variant']=='A')['status']=='judged'
 assert any(row['error']=='invalid_json_object' for row in result['diagnostics'])
 assert any(row['error']=='invalid_json_row' for row in result['diagnostics'])
 assert all(cell['preregisteredGatesPass'] is False for cell in result['cells'] if cell['modelSlug']=='qwen36-bf16')
`);
});

test('pilot and smoke reports use the full frozen corpus and never overwrite full artifacts', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 full = m.report(root,models=['minicpm-int4-4x'])
 frozen_files = [root/'results.json',root/'minicpm-int4-4x-A/results.json',root/'minicpm-int4-4x-A/predictions.jsonl']
 originals = {file:file.read_bytes() for file in frozen_files}
 for phase in ['pilot','smoke']:
  source = root/('minicpm-int4-4x-'+phase); source.mkdir()
  write_rows(source/'predictions.jsonl',[row for row in rows if row['id']=='p1'])
  result = m.report(root,models=['minicpm-int4-4x'],source_phase=phase)
  assert result['sourcePhase']==phase and result['manifestPhotos']=={'photos':2,'openimages':1}
  a = result['cells'][0]
  assert a['sourcePhase']==phase and a['sourceDirectory']=='minicpm-int4-4x-'+phase
  assert a['coverage']['expectedPhotos']==3 and a['coverage']['missingAsk0']==2
  assert a['splits']['all']['photos']==3 and a['fullyFormattedAndJudged'] is False
  assert a['runtimeAcceptance']=='not_evaluated' and 'accepted' not in a
  assert (root/('results-'+phase+'.json')).is_file()
  assert (root/('minicpm-int4-4x-A/results-'+phase+'.json')).is_file()
  merged = [json.loads(line) for line in (root/('minicpm-int4-4x-A/predictions-'+phase+'.jsonl')).read_text().splitlines()]
  assert len(merged)==6 and all(row['sourcePhase']==phase for row in merged)
  assert all(file.read_bytes()==content for file,content in originals.items())
 m.main(['--root',str(root),'--models','minicpm-int4-4x','--source-phase','pilot'])
 pilot_manifest = root/'prepared-pilot/manifest.jsonl'
 write_rows(pilot_manifest,[{'id':'p1','set':'photos'}])
 for phase in ['full','pilot','smoke']:
  try: m.report(root,models=['minicpm-int4-4x'],manifest_file=pilot_manifest,source_phase=phase)
  except ValueError: pass
  else: raise AssertionError('partial corpus allowed to replace frozen denominator')
 try: m.report(root,models=['minicpm-int4-4x'],source_phase='../other')
 except ValueError: pass
 else: raise AssertionError('unsafe source phase admitted')
`);
});

test('frozen report provenance checks dataset bytes, set counts and unchanged preregistered gates', () => {
  python(fixture + `
def freeze(root):
 metadata = {'datasetSha256':hashlib.sha256((root/'prepared/manifest.jsonl').read_bytes()).hexdigest(),
  'photos':2,'openImages':1,'promptSha256':'a'*64,'modelRevisions':{'minicpm-int4-4x':'d'*40}}
 gates = {key:value for key,value in m.GATES.items() if key not in ('statementN','editN')}
 gates.update(minStatements=140,minEdits=140)
 (root/'preregistration.json').write_text(json.dumps({'metadata':metadata,'gates':gates}))
 return metadata,gates
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 metadata,gates = freeze(root)
 source = root/'minicpm-int4-4x-full'
 performance = json.loads((source/'performance.json').read_text())
 performance['config']['revision'] = 'd'*40
 (source/'performance.json').write_text(json.dumps(performance))
 for row in rows: row['model_revision'] = 'd'*40
 write_rows(source/'predictions.jsonl',rows)
 result = m.report(root,models=['minicpm-int4-4x'])
 assert result['frozenProvenance']['datasetSha256']==metadata['datasetSha256']
 frozen_result = (root/'results.json').read_bytes()
 for changes in [{'datasetSha256':'b'*64},{'photos':3},{'openImages':2}]:
  (root/'preregistration.json').write_text(json.dumps({'metadata':{**metadata,**changes},'gates':gates}))
  try: m.report(root,models=['minicpm-int4-4x'])
  except ValueError as error: assert 'dataset hash or set counts' in str(error)
  else: raise AssertionError('mismatched preregistered corpus accepted')
  assert (root/'results.json').read_bytes()==frozen_result
 (root/'preregistration.json').write_text(json.dumps({'metadata':metadata,'gates':{**gates,'minEdits':139}}))
 try: m.report(root,models=['minicpm-int4-4x'])
 except ValueError as error: assert 'statistical gates differ' in str(error)
 else: raise AssertionError('changed preregistered gate accepted')
`);
});

test('frozen provenance accepts only the pre-judge format amendment and pinned config and row identities', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 metadata = {'datasetSha256':hashlib.sha256((root/'prepared/manifest.jsonl').read_bytes()).hexdigest(),
  'photos':2,'openImages':1,'promptSha256':'b'*64,'modelRevisions':{'minicpm-int4-4x':'d'*40}}
 gates = {key:value for key,value in m.GATES.items() if key not in ('statementN','editN')}
 gates.update(minStatements=140,minEdits=140)
 (root/'preregistration.json').write_text(json.dumps({'metadata':metadata,'gates':gates}))
 amendment = {'originalPromptSha256':'b'*64,'promptSha256':'a'*64,'beforeTeacherCalls':True,
  'schemaUnchanged':True,'gatesUnchanged':True}
 (root/'prompt-format-amendment.json').write_text(json.dumps(amendment))
 source = root/'minicpm-int4-4x-full'
 performance = json.loads((source/'performance.json').read_text())
 performance['config']['revision'] = 'd'*40
 (source/'performance.json').write_text(json.dumps(performance))
 for row in rows: row['model_revision'] = 'd'*40
 write_rows(source/'predictions.jsonl',rows)
 result = m.report(root,models=['minicpm-int4-4x'])
 assert result['frozenProvenance']['acceptedPromptSha256']==['a'*64]
 frozen_result = (root/'results.json').read_bytes()
 for key,value in [('beforeTeacherCalls',False),('schemaUnchanged',False),('gatesUnchanged',False),
                   ('originalPromptSha256','c'*64),('promptSha256','bad')]:
  (root/'prompt-format-amendment.json').write_text(json.dumps({**amendment,key:value}))
  try: m.report(root,models=['minicpm-int4-4x'])
  except ValueError as error: assert 'format amendment' in str(error)
  else: raise AssertionError('invalid prompt amendment accepted')
 (root/'prompt-format-amendment.json').write_text(json.dumps(amendment))
 for config in [{**performance['config'],'revision':'e'*40},{**performance['config'],'prompt_sha256':'b'*64}]:
  (source/'performance.json').write_text(json.dumps({**performance,'config':config}))
  try: m.report(root,models=['minicpm-int4-4x'])
  except ValueError as error: assert 'model config differs' in str(error)
  else: raise AssertionError('mismatched saved model config accepted')
 (source/'performance.json').write_text(json.dumps(performance))
 for changes in [{'model_revision':'e'*40},{'model_revision':None},{'prompt_sha256':'b'*64},{'model':'other/model'}]:
  changed = copy.deepcopy(rows); changed[0].update(changes)
  write_rows(source/'predictions.jsonl',changed)
  try: m.report(root,models=['minicpm-int4-4x'])
  except ValueError as error: assert 'prediction differs' in str(error)
  else: raise AssertionError('mismatched prediction identity accepted')
  assert (root/'results.json').read_bytes()==frozen_result
 write_rows(source/'predictions.jsonl',rows)
 (source/'job.json').write_text(json.dumps({'config':{**performance['config'],'revision':'e'*40}}))
 try: m.report(root,models=['minicpm-int4-4x'])
 except ValueError as error: assert 'model config differs' in str(error)
 else: raise AssertionError('conflicting secondary config accepted')
 (source/'job.json').unlink()
 smoke = root/'minicpm-int4-4x-smoke'; smoke.mkdir()
 original_rows = copy.deepcopy(rows)
 for row in original_rows: row['prompt_sha256']='b'*64
 write_rows(smoke/'predictions.jsonl',original_rows)
 (smoke/'performance.json').write_text(json.dumps({**performance,'config':{**performance['config'],'prompt_sha256':'b'*64}}))
 result = m.report(root,models=['minicpm-int4-4x'],source_phase='smoke')
 assert result['frozenProvenance']['acceptedPromptSha256']==['a'*64,'b'*64]
 assert result['cells'][0]['promptSha256']==['b'*64]
 assert (root/'results.json').read_bytes()==frozen_result
`);
});

test('a missing teacher stays disputed without adding a 100 percent statistical gate', () => {
  python(fixture + `
with tempfile.TemporaryDirectory() as tmp:
 root, rows, judges = setup(tmp)
 manifest = [{'id':'photo-'+str(index),'set':'photos','specialist_facts':[]} for index in range(150)]
 write_rows(root/'prepared/manifest.jsonl',manifest)
 pilot_rows, pilot_judges = [], []
 template = rows[0]
 for index in range(141):
  row = copy.deepcopy(template); row.update(id='photo-'+str(index),image_id='photo-'+str(index))
  pilot_rows.append(row)
  for teacher in ['flash','gpt','claude']:
   malformed = index==0 and teacher=='flash'
   votes = [{'id':statement['id'],'correctness':'正确','reasonableness':'合理',
    'contradiction':'无法判断','novelty':'新增'} for statement in row['statements']]
   pilot_judges.append({'item_id':row['id'],'model':row['model'],'variant':'A','ask':0,
    'prompt_sha256':row['prompt_sha256'],'critique_id':m.critique_id(row,row['critique'],row['statements']),
    'teacher':teacher,'status':200,'valid':not malformed,'statements':[] if malformed else votes})
 write_rows(root/'minicpm-int4-4x-pilot/predictions.jsonl',pilot_rows)
 write_rows(root/'judge-real-pilot/judgments.jsonl',pilot_judges)
 result = m.report(root,models=['minicpm-int4-4x'],source_phase='pilot')
 a = result['cells'][0]
 assert a['coverage']['expectedPhotos']==150 and a['coverage']['missingAsk0']==9
 assert a['coverage']['threeFamilyJudgedPhotos']==140
 assert a['splits']['all']['edits']['judged']==140 and a['splits']['all']['edits']['disputed']==1
 assert a['splits']['all']['statements']['disputed']==4
 assert a['preregisteredGatesPass'] is True and a['splits']['all']['gate']['passes'] is True
 assert a['fullyFormattedAndJudged'] is False and a['runtimeAcceptance']=='not_evaluated'
 assert a['status']=='incomplete_inference'
 assert result['gates']=={'statementPrecision':.9,'statementWilsonLow':.85,'statementN':140,
  'editReasonableness':.85,'editWilsonLow':.8,'editN':140}
`);
});
