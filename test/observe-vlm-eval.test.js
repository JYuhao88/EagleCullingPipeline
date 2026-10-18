import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { QUESTIONS, POSITIVE } from '../scripts/observe-teacher.mjs';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const load = `import json, math
from ml.observe.vlm_eval import *
def item(identity='one', key='smile', label=1, **extra):
 return {'id': identity, 'set': 'openimages', 'questions': [key],
         'votes': {key: {'flash': [label]*3, 'gpt': [label], 'claude': [label]}}, **extra}
def asks(identity='one', key='smile', options=('微笑','微笑','微笑')):
 return [{'id':identity,'ask':i,'content':json.dumps({key: option})} for i,option in enumerate(options)]
def attr(report, key='smile', dataset='all'):
 return report['sets'][dataset]['attributes'][key]
`;

test('VLM questionnaire and positive semantics match the saved teacher questionnaire', () => {
  const actual = JSON.parse(python(load + 'print(json.dumps({"questions":QUESTIONS,"positive":POSITIVE}))'));
  assert.deepEqual(actual, { questions: QUESTIONS, positive: POSITIVE });
});

test('VLM parser accepts fixed choices and fenced JSON while preserving abstentions', () => {
  python(load + `
assert parse_answers('{"smile":"微笑","eyes":"看不清"}', ['smile','eyes']) == {'smile':'slight','eyes':'unsure'}
assert parse_answers('\u0060\u0060\u0060json\\n{"mouth":"closed"}\\n\u0060\u0060\u0060', ['mouth']) == {'mouth':'closed'}
assert parse_answers('{"smile":"invented"}', ['smile','mouth']) == {'smile':None,'mouth':None}
assert parse_answers('{"smile":true,"mouth":"张开"}', ['smile','mouth']) == {'smile':None,'mouth':'open'}
assert binary('eyes','half') == 1 and binary('others','quiet') == 0
assert binary('smile',None) is None and binary('smile','unsure') is None
`);
});

test('VLM parser rejects duplicate keys, prose, extra questions and malformed JSON', () => {
  python(load + `
for text in ['{"smile":"微笑","smile":"没有笑"}', '答案：{"smile":"微笑"}',
             '{"smile":"微笑","mouth":"张开"}', '[{"smile":"微笑"}]',
             '{"smile":NaN}', '{"smile":"微笑",}', '']:
 assert parse_answers(text, ['smile']) == {'smile':None}, text
try: parse_answers('{}',['missing'])
except ValueError: pass
else: raise AssertionError('unknown question accepted')
assert parse_group('{"choice":"左图"}') == 'left'
assert parse_group('{"choice":"左图","choice":"右图"}') is None
`);
});

test('VLM three-family reference requires repeated flash majority and both strong teachers', () => {
  python(load + `
row = item()
row['votes']['smile'] = {'gemini-3.8-flash':[1,None,1], 'gpt-6-sol':[1], 'claude-opus-5-5':[1]}
assert teacher_votes(row,'smile') == ({'flash':1,'gpt':1,'claude':1},1)
for votes in [{'flash':[1,None],'gpt':[1],'claude':[1]},
              {'flash':[1,1,1],'gpt':[1]}, {'flash':[1,1,1],'gpt':[0],'claude':[1]},
              {'flash':[1,1,1],'gpt':['1'],'claude':[1]}]:
 row['votes']['smile'] = votes
 assert teacher_votes(row,'smile')[1] is None
`);
});

test('VLM missing replicates and failed calls are abstentions, never zero flip or negative predictions', () => {
  python(load + `
rows = [item('missing'),item('flip'),item('error')]
predictions = asks('missing')[:1] + asks('flip', options=('微笑','没有笑','微笑')) + asks('error')
predictions[-1]['error'] = 'synthetic failure'
result = attr(evaluate(rows,predictions))
assert result['calls'] == {'expected':9,'present':7,'missing':2,'binaryAnswered':6,'abstentionN':3,
                         'explicitUnsureN':0,'missingInvalidOrErrorN':3,'abstentionRate':1/3}
assert result['ask3']['completeBinaryN'] == 1 and result['ask3']['flipRate'] == 1
assert result['ask3']['incompleteOrAbstainingN'] == 2
assert result['rawMajority']['abstentionN'] == 1
assert result['stable']['abstentionRate'] == 1
missing = attr(evaluate([item()],asks()[:1]))
assert missing['ask3']['flipRate'] is None
assert missing['stable']['consensus']['n'] == 0
assert missing['stable']['consensus']['accuracy'] is None
assert missing['stable']['consensus']['precision'] is None
`);
});

test('VLM kappa handles degenerate marginals and scoring does not invent truth for abstentions', () => {
  python(load + `
assert kappa([(1,1)]*10)['kappa'] is None
assert kappa([(None,1)]) == {'n':0,'agreement':None,'kappa':None,'reason':'no paired answers'}
assert kappa([(0,1),(1,0)]*10)['kappa'] == -1
assert kappa([(0,0),(1,1)]*10)['kappa'] == 1
s = score([(1,1),(1,None),(None,0),(0,0)])
assert s['n'] == 2 and s['positiveStatements'] == 2 and s['scoredPositiveStatements'] == 1
assert s['unreferencedPositiveStatements'] == 1 and s['precision'] == 1 and s['falseNegatives'] == 0
assert wilson_low(0,0) is None
assert math.isclose(wilson_low(90,100),.8256343384950866)
`);
});

test('VLM gates enforce count, Wilson lower bound and the stricter gaze precision separately', () => {
  python(load + `
def measured(n, correct, key='smile', option='微笑'):
 rows = [item(str(i),key,int(i < correct)) for i in range(n)]
 predictions = [prediction for row in rows for prediction in asks(row['id'],key,(option,)*3)]
 return attr(evaluate(rows,predictions),key)['stable']['gate']
assert measured(140,140)['passes']
assert not measured(139,139)['checks']['statements']
gate = measured(140,126)
assert gate['checks']['precision'] and not gate['checks']['wilson95Low'] and not gate['passes']
assert measured(140,133,'gaze','看镜头')['passes']
gate = measured(140,132,'gaze','看镜头')
assert gate['checks']['wilson95Low'] and not gate['checks']['precision'] and not gate['passes']
`);
});

test('VLM CelebA truth remains evaluation-only and public reference counts exclude tiny photo faces', () => {
  python(load + `
rows = [item('face','smile',0,set='celeba',truth={'smile':False}),
        item('tiny','smile',1,set='photos',faceHeight=.02),
        item('normal','smile',1,set='photos',faceHeight=.10),
        item('unknown','smile',1,set='celeba')]
report = evaluate(rows,[prediction for row in rows for prediction in asks(row['id'])])
s = attr(report)['stable']
assert s['celebaTruth']['n'] == 1 and s['celebaTruth']['accuracy'] == 0
assert s['gate']['scoredPositiveStatements'] == 1 and s['gate']['smallPhotoFacesExcluded'] == 1
assert attr(report,dataset='celeba')['stable']['gate']['scoredPositiveStatements'] == 0
assert attr(report,dataset='photos')['stable'].get('celebaTruth') is None
mouth = item('mouth','mouth',1,set='celeba',truth={'mouth':True})
assert attr(evaluate([mouth],asks('mouth','mouth',('微张',)*3)),'mouth')['single']['celebaTruth']['accuracy'] == 1
`);
});

test('VLM categorical changes are visible even when binary observation stays stable', () => {
  python(load + `
result = attr(evaluate([item()],asks(options=('微笑','明显笑（露齿或嘴角明显上扬）','微笑'))))
assert result['ask3']['flipRate'] == 0 and result['ask3']['categoricalFlipRate'] == 1
assert result['stable']['consensus']['precision'] == 1
`);
});

test('VLM flip rate includes transitions to a valid unsure answer, separately from missing calls', () => {
  python(load + `
result = attr(evaluate([item()],asks(options=('微笑','看不清','微笑'))))
assert result['ask3']['completeParsedN'] == 1 and result['ask3']['flipRate'] == 1
assert result['ask3']['completeBinaryN'] == 0 and result['ask3']['nonAbstainingFlipRate'] is None
assert result['stable']['abstentionN'] == 1
`);
});

test('VLM comparison treats ties and abstentions separately and labels user preferences as weak evidence', () => {
  python(load + `
rows = [{'id':'manual','kind':'group','truth':'left'},
        {'id':'accepted','kind':'group','preferred':'right','acceptedAi':True},
        {'id':'tie','kind':'group','truth':'left'}, {'id':'abstain','kind':'group'}]
predictions = [{'id':row['id'],'ask':ask,'content':json.dumps({'choice':choice})}
               for row,choice in zip(rows,['左图','左图','相当','看不清']) for ask in range(3)]
groups = evaluate(rows,predictions)['groups']
assert 'weak' in groups['interpretation']
assert groups['stable']['all']['comparedN'] == 2 and groups['stable']['all']['agreement'] == .5
assert groups['stable']['all']['ties'] == 1 and groups['stable']['all']['abstentionN'] == 1
assert groups['stable']['independentUser']['agreement'] == 1
assert groups['stable']['acceptedAi']['agreement'] == 0
assert groups['ask3']['completeN'] == 3 and groups['ask3']['flipRate'] == 0
`);
});

test('VLM duplicate prediction identities are ambiguous and CLI emits finite JSON', () => {
  python(load + `
import subprocess, tempfile, sys
from pathlib import Path
predictions = asks() + [asks()[0],{'id':'missing','ask':0,'content':'{}'}]
report = evaluate([item()],predictions)
assert report['counts']['duplicateIdentities'] == 1 and report['counts']['ignoredPredictions'] == 1
assert attr(report)['single']['abstentionN'] == 1
assert attr(report)['stable']['abstentionN'] == 1
with tempfile.TemporaryDirectory() as tmp:
 root = Path(tmp)
 (root/'items.jsonl').write_text(json.dumps(item())+'\\n')
 (root/'predictions.json').write_text(json.dumps(asks()))
 subprocess.run([sys.executable,'-m','ml.observe.vlm_eval','--manifest',str(root/'items.jsonl'),
                 '--predictions',str(root/'predictions.json'),'--output',str(root/'report.json')],check=True)
 assert json.loads((root/'report.json').read_text())['counts']['items'] == 1
`);
});

test('opposite statements keep the same gaze gate and abstentions never become claims', () => {
  python(load + `
rows = [item(str(i),'gaze',0) for i in range(140)]
predictions = [p for row in rows for p in asks(row['id'],'gaze',('看别处',)*3)]
plain = attr(evaluate(rows,predictions),'gaze')
assert 'negativeGate' not in plain['stable']
both = attr(evaluate(rows,predictions,statements=True),'gaze')['stable']
negative = both['negativeGate']
assert negative['passes'] and negative['scoredPositiveStatements'] == 140
assert negative['minimum'] == both['gate']['minimum'] == {'statements':140,'precision':.95,'wilson95Low':.85}
assert negative['choices'] == ['away'] and len(negative['candidateText']) <= 12
assert both['gate']['scoredPositiveStatements'] == 0 and not both['gate']['passes']
predictions[0]['error'] = 'synthetic failure'
negative = attr(evaluate(rows,predictions,statements=True),'gaze')['stable']['negativeGate']
assert negative['scoredPositiveStatements'] == 139 and not negative['passes']
`);
});

test('opposite statements expose the constant baseline and keep unknown references and CelebA out of the gate', () => {
  python(load + `
rows = [item(str(i),'gaze',i%2) for i in range(280)]
predictions = [p for i,row in enumerate(rows) for p in asks(row['id'],'gaze',(('看镜头' if i%2 else '看别处'),)*3)]
negative = attr(evaluate(rows,predictions,statements=True),'gaze')['stable']['negativeGate']
assert negative['precision'] == 1 and negative['constantBaselinePrecision'] == .5
assert negative['statementCoverage'] == negative['referenceStatementCoverage'] == .5
rows += [item('unknown','gaze',0),item('public','gaze',0,set='celeba'),item('tiny','gaze',0,set='photos',faceHeight=.01)]
rows[-3]['votes'] = {}
for identity in ['unknown','public','tiny']: predictions += asks(identity,'gaze',('看别处',)*3)
negative = attr(evaluate(rows,predictions,statements=True),'gaze')['stable']['negativeGate']
assert negative['scoredPositiveStatements'] == 140 and negative['unreferencedPositiveStatements'] == 1
assert negative['positiveStatements'] == 141 and negative['smallPhotoFacesExcluded'] == 1
`);
});
