import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const load = `import copy, hashlib, json, math, tempfile
from pathlib import Path
from ml.observe.critique import *
def critique(**changes):
 return {'summary':'人物自然，背景略杂', 'strengths':[{'text':'表情自然'}],
         'issues':[{'category':'background/distraction','text':'右侧路人抢眼','region':'右侧'}],
         'edits':[{'action':'crop/straighten','direction':'裁去右侧少许','amount':'约百分之五','reason':'减少路人干扰'}],
         'verdict':'可修后保留', **changes}
def votes(statements, label='正确', reasonable='合理', **extra):
 return {family:[{'id':s['id'],'correctness':label,'reasonableness':reasonable,
                  'contradiction':'不矛盾','novelty':'新增', **extra} for s in statements] for family in FAMILIES}
`;

test('critique prompt is versioned, hashed from exact bytes, and enforces two fixed zero-temperature asks', () => {
  python(load + `
artifact = load_prompt()
assert artifact['sha256'] == hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()
assert artifact['generation'] == {'temperature':0,'asks':2,'seeds':[36001,36002],'max_new_tokens':768}
assert artifact['version'] == '1.0.1' and artifact['id'] == 'single-photo-critique'
with tempfile.TemporaryDirectory() as directory:
 path = Path(directory) / 'prompt.md'
 path.write_bytes(PROMPT_PATH.read_bytes() + b'\\n')
 assert load_prompt(path)['sha256'] != artifact['sha256']
 path.write_text(PROMPT_PATH.read_text().replace('[36001, 36002]', '[36001, 36001]'))
 try: load_prompt(path)
 except ValueError: pass
 else: raise AssertionError('duplicate repeat seed accepted')
`);
});

test('critique variants share schema and hash while only B contains reliable specialist facts', () => {
  python(load + `
artifact = load_prompt()
facts = [{'id':'gaze','text':'看镜头'}]
a, b = build_prompt(artifact,facts,'A'), build_prompt(artifact,facts,'B')
assert a['system'] == b['system'] and a['prompt_hash'] == b['prompt_hash'] == artifact['sha256']
assert '看镜头' not in a['user'] and '看镜头' in b['user'] and '已知事实' in b['user']
assert '不得矛盾' in b['user'] and '未知' in b['user']
assert '无已知事实' in build_prompt(artifact,[],'B')['user']
try: build_prompt(artifact, [], 'C')
except ValueError: pass
else: raise AssertionError('unknown variant accepted')
`);
});

test('critique parser enforces the Chinese schema, finite strict JSON, enums and character limits', () => {
  python(load + `
raw = critique()
assert parse_critique(json.dumps(raw)) == raw
assert parse_critique('\u0060\u0060\u0060json\\n' + json.dumps(raw) + '\\n\u0060\u0060\u0060') == raw
assert parse_critique(critique(strengths=[],issues=[],edits=[],verdict='看不清')) is not None
for bad in [critique(summary='甲'*31), critique(summary='English only'), critique(summary=' '),
            critique(issues=[{'category':'unknown','text':'背景略杂'}]),
            critique(edits=[{'action':'exposure','direction':'增加曝光'}]),
            critique(strengths=[{'text':'甲'*13}]), critique(strengths=[{'text':'自然'}]*4),
            critique(verdict='删除'), {**raw,'confidence':.9}, {key:value for key,value in raw.items() if key != 'summary'}]:
 assert parse_critique(bad) is None, bad
for bad in ['答案：' + json.dumps(raw), '[]', '{}', '', '{"summary":NaN}',
            json.dumps(raw)[:-1] + ',"summary":"重复"}']:
 assert parse_critique(bad) is None, bad
`);
});

test('critique statements retain typed issue regions, edit parameters and verdict with stable ids', () => {
  python(load + `
statements = split_statements(critique())
assert [s['id'] for s in statements] == ['strength-1','issue-1','edit-1','verdict']
assert statements[1]['region'] == '右侧' and statements[1]['category'] == 'background/distraction'
assert statements[2]['action'] == 'crop/straighten' and statements[2]['amount'] == '约百分之五'
assert '减少路人干扰' in statements[2]['text'] and statements[3]['text'] == '可修后保留'
assert len(split_statements(critique(strengths=[],issues=[],edits=[]))) == 1
try: split_statements({})
except ValueError: pass
else: raise AssertionError('invalid critique split')
`);
});

test('three-family statements require unanimous correct or two wrong and never impute missing labels', () => {
  python(load + `
statements = split_statements(critique())
panel = votes(statements)
assert all(s['correctness'] == 'correct' for s in aggregate_judges(statements,panel))
panel['claude'][0]['correctness'] = '错误'
assert aggregate_judges(statements,panel)[0]['correctness'] == 'disputed'
panel['gpt'][0]['correctness'] = '错误'
assert aggregate_judges(statements,panel)[0]['correctness'] == 'wrong'
del panel['claude']
assert aggregate_judges(statements,panel)[1]['correctness'] == 'disputed'
assert all(s['correctness'] == 'disputed' for s in aggregate_judges(statements,{}))
for malformed in [{'flash':panel['flash']*2}, {'flash':[{'id':'unknown'}]}, {'gpt-alias':[]}]:
 try: aggregate_judges(statements,malformed)
 except ValueError: pass
 else: raise AssertionError('invalid teacher response accepted')
`);
});

test('edit reasonableness and specialist contradiction/novelty require their own judge labels', () => {
  python(load + `
statements = split_statements(critique())
panel = votes(statements)
for family in ('flash','gpt'):
 panel[family][2].update(reasonableness='不合理',contradiction='矛盾',novelty='重复')
result = aggregate_judges(statements,panel)
assert result[2]['correctness'] == 'correct' and result[2]['reasonableness'] == 'wrong'
assert result[2]['contradiction'] is True and result[2]['novelty'] is False
assert result[0]['reasonableness'] is None and result[0]['contradiction'] is False
del panel['claude']
assert aggregate_judges(statements,panel)[0]['novelty'] is None
`);
});

test('critique gates enforce measured statement and substantive-edit counts with honest missing coverage', () => {
  python(load + `
statements = split_statements(critique())
rows = [{'id':str(index),'statements':statements,'judgments':votes(statements),
         'facts':[{'text':'看镜头'}],'latencyMs':index,'peakVramMb':100} for index in range(140)]
report = summarize(rows)
assert report['gate']['passes'] and report['statements']['judged'] == 560 and report['edits']['judged'] == 140
assert report['hallucination']['rate'] == 0 and report['contradiction']['rate'] == 0 and report['novelty']['rate'] == 1
assert report['latencyMs']['p50'] == 69.5 and math.isclose(report['latencyMs']['p95'],132.05)
assert 'issue:background/distraction' in report['categories']
assert not summarize(rows[:-1])['gate']['passes']
single_edit = [statements[2]]
near_gate = [{'id':str(i),'statements':single_edit,
              'judgments':votes(single_edit,'正确' if i < 126 else '错误')} for i in range(140)]
report = summarize(near_gate)
assert report['statements']['precision'] == .9 and report['gate']['checks']['statementPrecision']
assert not report['gate']['checks']['statementWilsonLow'] and not report['gate']['passes']
for i, row in enumerate(near_gate): row['judgments'] = votes(single_edit, reasonable='合理' if i < 119 else '不合理')
report = summarize(near_gate)
assert report['edits']['precision'] == .85 and report['gate']['checks']['editReasonableness']
assert not report['gate']['checks']['editWilsonLow'] and not report['gate']['passes']
rows[0]['judgments'] = votes(statements,'错误')
rows.append({'id':'missing','statements':[]})
report = summarize(rows)
assert report['hallucination']['wrongPhotos'] == 1 and report['hallucination']['unresolvedPhotos'] == 1
assert report['hallucination']['rate'] == 1/140 and report['hallucination']['coverage'] == 140/141
assert not summarize([])['gate']['passes'] and summarize([])['statements']['precision'] is None
assert summarize([{'id':'one','statements':statements}])['hallucination']['rate'] is None
assert summarize([{'id':'one','statements':statements}])['contradiction']['rate'] is None
no_op = split_statements(critique(edits=[{'action':'none','direction':'无需调整','reason':'维持自然'}]))
report = summarize([{'id':str(i),'statements':no_op,'judgments':votes(no_op)} for i in range(140)])
assert report['noOpEdits'] == 140 and report['edits']['judged'] == 0 and not report['gate']['passes']
`);
});

test('critique stability uses category sets, empty sets agree, and incomplete repeats remain missing', () => {
  python(load + `
first, second = critique(), critique(issues=[{'category':'exposure','text':'画面略暗'}])
assert stability(first,second) == {'issues':0,'edits':1}
second['issues'] += first['issues']
assert stability(first,second)['issues'] == .5
assert stability(critique(issues=[],edits=[]),critique(issues=[],edits=[])) == {'issues':1,'edits':1}
predictions = [{'id':'one','ask':0,'content':json.dumps(first)}, {'id':'one','ask':1,'content':json.dumps(second)},
               {'id':'missing','ask':0,'content':json.dumps(first)}]
result = critique_stability(predictions)
assert result['issues'] == {'n':1,'missingOrInvalid':1,'jaccard':.5}
predictions.append({'id':'one','ask':1,'content':json.dumps(second)})
try: critique_stability(predictions)
except ValueError: pass
else: raise AssertionError('duplicate ask accepted')
`);
});
