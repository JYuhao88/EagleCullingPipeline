import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const fixture = `import copy
from ml.observe.critique import split_statements
from ml.observe.critique_paired import compare

def row(image_id,variant,ask=0,correct=True,reasonable=True,contradiction=False,novel=True):
 critique={'summary':'人物突出','strengths':[{'text':'人物突出'}],
  'issues':[{'category':'composition/crop','text':'右侧留白较多'}],
  'edits':[{'action':'crop/straighten','direction':'裁去右侧少量空白','reason':'突出人物'}],
  'verdict':'可修后保留'}
 statements=split_statements(critique)
 judgments={family:[{'id':statement['id'],'correctness':'错误' if not correct and statement['kind']=='issue' else '正确',
  'reasonableness':'合理' if reasonable else '不合理','contradiction':'矛盾' if contradiction else '不矛盾',
  'novelty':'新增' if novel else '重复'} for statement in statements] for family in ['flash','gpt','claude']}
 return {'id':image_id,'variant':variant,'ask':ask,'critique':critique,'statements':statements,
  'judgments':judgments,'facts':[{'id':'gaze','text':'看镜头'}],'wall_s':2,'elapsed_s':1}
`;

test('photo-paired differences keep the full planned denominator and do not match statement positions', () => {
  python(fixture + `
a1=row('p1','A',correct=False,reasonable=False,novel=False)
b1=row('p1','B',contradiction=True)
b1['critique']['strengths']=[]
b1['critique']['issues'][0]['category']='exposure'
b1['critique']['edits'][0]['action']='exposure'
b1['statements']=split_statements(b1['critique'])
for family in b1['judgments']:
 b1['judgments'][family]=[vote for vote in b1['judgments'][family] if vote['id']!='strength-1']
a2=row('p2','A');b2=row('p2','B');b2['judgments'].pop('flash')
a_repeat=copy.deepcopy(a1);a_repeat['ask']=1
b_repeat=copy.deepcopy(b1);b_repeat['ask']=1;b_repeat['critique']['issues'][0]['category']='composition/crop'
result=compare({'A':[a1,a2,a_repeat], 'B':[b1,b2,b_repeat,row('p3','B')]},['p1','p2','p3','p4'])
assert result['plannedPhotos']==4
assert result['primaryFormatCoverage']=={'bothValid':2,'onlyAValid':0,'onlyBValid':1,'neitherValid':1,
 'bothThreeFamilyJudgedValid':1,'bothValidFractionOfCohort':.5}
precision=result['metrics']['statementPrecision']
assert precision['pairedPhotos']==1 and precision['excludedPhotos']==3
assert precision['photoMeanA']==.75 and precision['photoMeanB']==1 and precision['meanDifferenceBminusA']==.25
assert precision['pooledRateAOnSamePhotos']==.75 and precision['pooledRateBOnSamePhotos']==1
assert result['metrics']['editReasonableness']['meanDifferenceBminusA']==1
assert result['metrics']['wrongPhoto']['pairedPhotos']==1 and result['metrics']['wrongPhoto']['meanDifferenceBminusA']==-1
assert result['metrics']['wrongStatementRate']['meanDifferenceBminusA']==-.25
assert result['metrics']['contradiction']['meanDifferenceBminusA']==1
assert result['metrics']['novelty']['meanDifferenceBminusA']==1
assert result['crossVariantPrimaryCategoryJaccard']['issues']['meanJaccard']==.5
assert result['crossVariantPrimaryCategoryJaccard']['edits']['meanJaccard']==.5
assert result['metrics']['issuesRepeatStability']['pairedPhotos']==1
assert result['metrics']['issuesRepeatStability']['meanDifferenceBminusA']==-1
assert result['judgmentStates']['B']=={'clear':2,'unresolved':1,'missing_or_invalid':1}
assert 'no paired statistic is a gate' in result['meaning'].lower()
`);
});

const integration = fixture + `
import hashlib,json,tempfile
from pathlib import Path
from ml.observe import critique_paired as paired
from ml.observe import critique_report as reports
from ml.observe.critique import GATES

def write_rows(file,rows):
 file.parent.mkdir(parents=True,exist_ok=True)
 file.write_text(''.join(json.dumps(value,ensure_ascii=False)+'\\n' for value in rows))

def setup(directory,open_images=1):
 root=Path(directory)/'data/cache/w36-vlm-critique';root.mkdir(parents=True)
 reports.CACHE_ROOT=root
 manifest=[{'id':'photo-'+str(i),'set':'photos','specialist_facts':[{'id':'gaze','text':'看镜头'}]} for i in range(291)]
 manifest+=[{'id':'oi-'+str(i+1),'set':'openimages','specialist_facts':[]} for i in range(open_images)]
 manifest_file=root/'prepared/manifest.jsonl';write_rows(manifest_file,manifest)
 digest=hashlib.sha256(manifest_file.read_bytes()).hexdigest()
 ids=sorted([item['id'] for item in manifest if item['set']=='photos'],
  key=lambda image_id:hashlib.sha256(('w36-candidates-v1|36200|'+image_id).encode()).hexdigest())[:200]
 cohort={'id':'w36-candidates-v1','version':1,'seed':36200,
  'selection':'sha256(w36-candidates-v1|seed|id), ascending, first 200 photos','manifestSha256':digest,'size':200,'ids':ids}
 (root/'candidate-cohort.json').write_text(json.dumps(cohort))
 gates={key:value for key,value in GATES.items() if key not in ['statementN','editN']}
 gates.update(minStatements=140,minEdits=140)
 revisions={'minicpm-int4-4x':'f'*40,'qwen36-bf16':'e'*40,'qwen3-vl-8b':'d'*40}
 (root/'preregistration.json').write_text(json.dumps({'gates':gates,'metadata':{
  'datasetSha256':digest,'photos':291,'openImages':open_images,'promptSha256':'a'*64,'modelRevisions':revisions}}))
 model='example/minicpm';config={'model':model,'revision':'f'*40,'prompt_sha256':'a'*64}
 rows=[]
 for image_id in ids[:2]:
  for variant in ['A','B']:
   for ask in [0,1]:
    value=row(image_id,variant,ask)
    value.update(image_id=image_id,set='photos',model=model,model_revision='f'*40,prompt_sha256='a'*64,
     content=json.dumps(value['critique'],ensure_ascii=False),wall_s=2,elapsed_s=1)
    value.pop('judgments');rows.append(value)
 outside=next(item['id'] for item in manifest if item['set']=='photos' and item['id'] not in ids)
 value=copy.deepcopy(rows[0]);value.update(id=outside,image_id=outside,wall_s=100,elapsed_s=99);rows.append(value)
 judgments=[]
 for value in rows:
  if value['ask']!=0:continue
  for teacher in ['flash','gpt','claude']:
   votes=[{'id':statement['id'],'correctness':'正确','reasonableness':'合理','contradiction':'不矛盾','novelty':'新增'}
    for statement in value['statements']]
   judgments.append({'item_id':value['id'],'model':model,'variant':value['variant'],'ask':0,'teacher':teacher,
    'valid':True,'prompt_sha256':'a'*64,'critique_id':reports.critique_id(value,value['critique'],value['statements']),'statements':votes})
 invalid=next(value for value in rows if value['id']==ids[0] and value['variant']=='B' and value['ask']==0)
 invalid.update(content='not JSON',critique=None,statements=[])
 source=root/'minicpm-int4-4x-full';write_rows(source/'predictions.jsonl',rows)
 (source/'performance.json').write_text(json.dumps({'config':config,'wall_latency_by_variant':{'A':{'n':999,'p50_s':999}},
  'memory_by_variant':{'A':{'peak_reserved_gib':7},'B':{'peak_reserved_gib':8}}}))
 write_rows(root/'judges/judgments.jsonl',judgments)
 (root/'results.json').write_text('full report sentinel')
 (root/'minicpm-int4-4x-A').mkdir()
 (root/'minicpm-int4-4x-A/results.json').write_text('full cell sentinel')
 return root,cohort
`;

test('reduced report preserves all 200 planned photos and source timing without overwriting full reports', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp)
 result=paired.report(root)
 assert result['plannedPhotosPerVariant']==200 and len(result['cells'])==4
 assert result['gates']==GATES
 assert not (root/'results-reduced.json').exists()
 a,b=result['cells'][:2]
 assert a['coverage']['expectedPhotos']==200 and b['coverage']['expectedPhotos']==200
 assert a['coverage']['validAsk0']==2 and a['coverage']['missingAsk0']==198
 assert b['coverage']['validAsk0']==1 and b['coverage']['invalidAsk0']==1 and b['coverage']['missingAsk0']==198
 assert a['splits']['all']['photos']==200 and b['splits']['all']['photos']==200
 assert a['splits']['openimages']['photos']==0
 assert a['stability']['issues']['n']==2 and a['stability']['issues']['missingOrInvalid']==198
 assert a['telemetry']['wallLatencySeconds']['p50_s']==2
 assert a['telemetry']['wallLatencySeconds']['n']==4
 assert a['telemetry']['allocatorMemoryGiB']['peak_reserved_gib']==7
 pair=result['paired'][0]
 assert pair['plannedPhotos']==200 and pair['primaryFormatCoverage']['bothValid']==1
 assert pair['primaryFormatCoverage']['onlyAValid']==1 and pair['primaryFormatCoverage']['neitherValid']==198
 assert pair['metrics']['statementPrecision']['pairedPhotos']==1 and pair['metrics']['statementPrecision']['excludedPhotos']==199
 assert result['baselineReference']['noAdditionalJudgingPlanned'] is True
 assert result['baselineReference']['cells'][0]['splits']['all']['photos']==292
 assert all(cell['coverage']['expectedPhotos']==200 for cell in result['cells'])
 paired.report(root,write=True)
 assert (root/'results.json').read_text()=='full report sentinel'
 assert (root/'minicpm-int4-4x-A/results.json').read_text()=='full cell sentinel'
 written=json.loads((root/'results-reduced.json').read_text())
 assert written==result
 output=[json.loads(line) for line in (root/'minicpm-int4-4x-B/predictions-reduced.jsonl').read_text().splitlines()]
 assert len(output)==400 and {value['id'] for value in output}==set(cohort['ids'])
 photo_rows=[json.loads(line) for line in (root/'minicpm-int4-4x-paired/photos-reduced.jsonl').read_text().splitlines()]
 assert len(photo_rows)==200
`);
});

test('cohort identities are checked against the original manifest and seeded selection before reporting', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp)
 file=root/'candidate-cohort.json'
 for patch in [{'ids':list(reversed(cohort['ids']))},{'size':199},{'seed':1},{'manifestSha256':'b'*64}]:
  file.write_text(json.dumps({**cohort,**patch}))
  try:paired.report(root,write=True)
  except ValueError:pass
  else:raise AssertionError('changed frozen cohort accepted')
  assert not (root/'results-reduced.json').exists()
 file.write_text(json.dumps(cohort))
 manifest=root/'prepared/manifest.jsonl'
 with manifest.open('a') as handle:handle.write(json.dumps({'id':'other','set':'photos'})+'\\n')
 try:paired.report(root)
 except ValueError:pass
 else:raise AssertionError('changed source manifest accepted')
`);
});

test('full-photo reporting preserves 291 A/B pairs and separate Open Images references without overwriting prior reports', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp,open_images=200)
 source=root/'minicpm-int4-4x-full/predictions.jsonl'
 raw=[json.loads(line) for line in source.read_text().splitlines()]
 votes_file=root/'judges/judgments.jsonl'
 votes=[json.loads(line) for line in votes_file.read_text().splitlines()]
 for ask in (0,1):
  value=copy.deepcopy(raw[0]);value.update(id='oi-1',image_id='oi-1',set='openimages',ask=ask)
  raw.append(value)
  if ask==0:
   for teacher in ['flash','gpt','claude']:
    statements=[{'id':statement['id'],'correctness':'正确','reasonableness':'合理',
     'contradiction':'无法判断','novelty':'新增'} for statement in value['statements']]
    votes.append({'item_id':'oi-1','model':value['model'],'variant':'A','ask':0,'teacher':teacher,
     'valid':True,'prompt_sha256':'a'*64,'critique_id':reports.critique_id(value,value['critique'],value['statements']),
     'statements':statements})
 write_rows(source,raw);write_rows(votes_file,votes)
 (root/'results-reduced.json').write_text('old reduced report sentinel')
 (root/'minicpm-int4-4x-A/results-reduced.json').write_text('old reduced cell sentinel')
 (root/'candidate-cohort.json').unlink()
 result=paired.report(root,full_photos=True)
 assert result['reportScope']=='frozen_full_photos' and result['plannedPhotosPerVariant']==291
 assert result['gates']==GATES and result['cohort']['size']==291
 assert result['cohort']['ids']==['photo-'+str(i) for i in range(291)]
 assert 'seed' not in result['cohort'] and result['runtimeAcceptance']=='not_evaluated'
 assert not (root/'results-full-paired.json').exists()
 a,b=result['cells'][:2]
 assert a['coverage']['expectedPhotos']==291 and b['coverage']['expectedPhotos']==291
 assert a['coverage']['validAsk0']==3 and a['coverage']['missingAsk0']==288
 assert b['coverage']['validAsk0']==1 and b['coverage']['invalidAsk0']==1 and b['coverage']['missingAsk0']==289
 assert a['splits']['all']['photos']==291 and b['splits']['all']['photos']==291
 assert a['splits']['photos']['photos']==291 and a['splits']['openimages']['photos']==0
 assert a['stability']['issues']['n']==2 and a['stability']['issues']['missingOrInvalid']==289
 assert a['coverageByAsk']['0']=={'planned':291,'valid':3,'missing':288,'inferenceFailed':0,'invalidFormat':0}
 assert a['coverageByAsk']['1']['planned']==291 and a['coverageByAsk']['1']['missing']==289
 pair=result['paired'][0]
 assert pair['plannedPhotos']==291 and pair['validPrimaryPairs']==1 and pair['judgedPrimaryPairs']==1
 assert pair['primaryFormatCoverage']['onlyAValid']==2 and pair['primaryFormatCoverage']['neitherValid']==288
 assert pair['metrics']['statementPrecision']['plannedPhotos']==291 and pair['metrics']['statementPrecision']['excludedPhotos']==290
 full=result['fullManifestReference']
 assert full['manifestPhotos']=={'photos':291,'openimages':200}
 assert full['cells'][0]['splits']['all']['photos']==491
 assert full['cells'][0]['splits']['openimages']['photos']==200
 assert full['cells'][0]['splits']['openimages']['statements']['judged']==4
 assert full['cells'][0]['coverage']['validAsk0']==4
 assert full['cells'][1]['splits']['openimages']['photos']==0
 assert result['baselineReference']['noAdditionalJudgingPlanned'] is True
 assert len(result['cells'])==4 and all(cell['coverage']['expectedPhotos']==291 for cell in result['cells'])
 paired.report(root,full_photos=True,write=True)
 assert json.loads((root/'results-full-paired.json').read_text())==result
 assert (root/'results.json').read_text()=='full report sentinel'
 assert (root/'results-reduced.json').read_text()=='old reduced report sentinel'
 assert (root/'minicpm-int4-4x-A/results.json').read_text()=='full cell sentinel'
 assert (root/'minicpm-int4-4x-A/results-reduced.json').read_text()=='old reduced cell sentinel'
 for slug in paired.CANDIDATES:
  for variant in ['A','B']:
   output=root/(slug+'-'+variant)
   assert (output/'results-full-photos.json').is_file()
   values=[json.loads(line) for line in (output/'predictions-full-photos.jsonl').read_text().splitlines()]
   assert len(values)==582 and {value['id'] for value in values}==set(result['cohort']['ids'])
   assert all(value['set']=='photos' for value in values)
  pair_dir=root/(slug+'-paired')
  assert (pair_dir/'results-full.json').is_file()
  assert len((pair_dir/'photos-full.jsonl').read_text().splitlines())==291
 paired.main(['--root',str(root),'--full-photos'])
`);
});

test('full-photo mode cannot silently reuse a reduced cohort or incomplete source manifest', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp,open_images=200)
 for options in [{'cohort_file':root/'candidate-cohort.json'},{'source_phase':'reduced'}]:
  try:paired.report(root,full_photos=True,**options)
  except ValueError:pass
  else:raise AssertionError('reduced identities or source accepted for full mode')
 manifest_file=root/'prepared/manifest.jsonl'
 manifest=[json.loads(line) for line in manifest_file.read_text().splitlines()]
 for changed in [[item for item in manifest if item['id']!='photo-0'],
                 [item for item in manifest if item['id']!='oi-1']]:
  try:paired.full_photo_cohort(manifest_file,changed)
  except ValueError:pass
  else:raise AssertionError('incomplete full-photo source accepted')
 assert not (root/'results-full-paired.json').exists()
`);
});

test('full-photo outputs reject escaped links before writing a report', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp,open_images=200)
 outside=Path(tmp)/'outside';outside.mkdir()
 (root/'minicpm-int4-4x-paired').symlink_to(outside,target_is_directory=True)
 try:paired.report(root,full_photos=True,write=True)
 except ValueError:pass
 else:raise AssertionError('escaped full output accepted')
 assert not (root/'results-full-paired.json').exists() and not (root/'minicpm-int4-4x-A/results-full-photos.json').exists()
 assert not (outside/'results-full.json').exists()
`);
});

test('reduced output rejects escaped symlinks before writing any result', () => {
  python(integration + `
with tempfile.TemporaryDirectory() as tmp:
 root,cohort=setup(tmp)
 outside=Path(tmp)/'outside';outside.mkdir()
 (root/'minicpm-int4-4x-paired').symlink_to(outside,target_is_directory=True)
 try:paired.report(root,write=True)
 except ValueError:pass
 else:raise AssertionError('escaped output link accepted')
 assert not (root/'results-reduced.json').exists() and not (root/'minicpm-int4-4x-A/results-reduced.json').exists()
 assert not (outside/'results-reduced.json').exists()
`);
});

test('unresolved photo error labels remain unknown while descriptive observed errors are explicit lower bounds', () => {
  python(fixture + `
a=row('p1','A');b=row('p1','B')
b['judgments'].pop('flash')
result=compare({'A':[a],'B':[b]},['p1','p2'])
assert result['metrics']['statementPrecision']['pairedPhotos']==0
assert result['metrics']['editReasonableness']['pairedPhotos']==0
assert result['metrics']['wrongPhoto']['pairedPhotos']==0
assert result['metrics']['observedWrongPhoto']['pairedPhotos']==1
assert result['metrics']['observedWrongPhoto']['meanDifferenceBminusA']==0
assert result['photos'][0]['B']['values']['wrongPhoto'] is None
assert result['photos'][0]['B']['judgmentState']=='unresolved'
assert result['photos'][1]['A']['validPrimary'] is False
assert result['crossVariantPrimaryCategoryJaccard']['issues']['plannedPhotos']==2
`);
});

test('empty categories agree but no-op edits supply no reasonableness sample', () => {
  python(fixture + `
a=row('p1','A');b=row('p1','B')
for value in [a,b]:
 value['critique']['issues']=[]
 value['critique']['edits'][0]['action']='none'
 value['statements']=split_statements(value['critique'])
 for family in value['judgments']:
  value['judgments'][family]=[vote for vote in value['judgments'][family] if vote['id']!='issue-1']
result=compare({'A':[a],'B':[b]},['p1'])
assert result['metrics']['editReasonableness']['pairedPhotos']==0
assert result['crossVariantPrimaryCategoryJaccard']['issues']['meanJaccard']==1
assert result['crossVariantPrimaryCategoryJaccard']['edits']['meanJaccard']==1
`);
});

test('paired statistics reject duplicate asks or duplicate cohort identities', () => {
  python(fixture + `
a=row('p1','A')
for values, ids in [({'A':[a,a]},['p1']),({'A':[a]},['p1','p1'])]:
 try:compare(values,ids)
 except ValueError:pass
 else:raise AssertionError('duplicate pair admitted')
`);
});
