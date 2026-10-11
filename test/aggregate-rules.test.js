import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("critique aggregation clusters synonyms, counts episodes, and preserves negatives", () => {
  const script = String.raw`
import sys
sys.path.insert(0, 'ml/references')
from aggregate_rules import *
seed = {'rules': [{'id': 'P-FACE-EXPRESSION'}]}
def row(bvid, index, text, tier, kind='issues', rule=None, topics=None):
    return {'bvid': bvid, 'segment': {'index': index, 'start': 10}, 'tier': tier,
            'frame': 'frames/'+bvid+'/1.jpg', 'topics': topics or ['pose'],
            kind: [{'text': text, 't': 12, 'ruleId': rule}]}
assert similarity('姿势僵硬', '姿态生硬') == 1
assert len(cluster_items([{'aspect':'pose','text':'姿势僵硬'}, {'aspect':'pose','text':'姿态生硬'}])) == 1
rows = [row('A',1,'姿势僵硬','拉'), row('A',2,'姿态生硬','NPC'),
        row('B',1,'姿态生硬','夯','praises'), row('A',1,'姿势僵硬','拉'),
        row('C',1,'需要磨皮','NPC',topics=['retouch']),
        row('D',1,'表情僵硬',None,rule='P-FACE-EXPRESSION',topics=['face'])]
candidates, existing, excluded, negatives = build_outputs(rows, seed)
assert len(candidates['rules']) == 1
rule = candidates['rules'][0]
assert rule['frequency'] == {'videos':2,'segments':3,'positive':1,'negative':2}, rule
assert len(rule['evidence']) == 3
assert len(rule['representatives']) <= 4
assert len(excluded) == 1 and excluded[0]['text'] == '需要磨皮'
assert existing['rules'][0]['frequency']['negative'] == 1
assert next(r for r in negatives if r['bvid']=='D')['violatedRules'] == ['P-FACE-EXPRESSION']
assert next(r for r in negatives if r['bvid']=='C')['violatedRules'] == []
assert rule['id'] in next(r for r in negatives if r['bvid']=='A')['violatedRules']
assert classify('色彩搭配不和谐',['color']) == 'color'
assert classify('需要用曲线工具调色',['color','retouch']) is None
assert classify('建议换镜头',['gear']) is None
assert classify('建议换服装',['styling']) is None
named = {'clusterId':'0','title':'自然姿态','statement':'优先选择自然舒展的姿态。','severity':'hint','exceptions':[]}
assert validate_names({'clusters':[named]},1)['0'] == named
for result in [{'clusters':[named,named]}, {'clusters':[]},
               {'clusters':[{**named,'statement':'字'*81}]}]:
    try:validate_names(result,1)
    except ValueError:pass
    else:raise AssertionError('invalid naming accepted')

assert classify('服装和背景颜色不和谐',['styling','color']) == 'color'
named = {'0': {'title':'姿态自然','statement':'姿态应自然，避免僵硬。','severity':'hint','exceptions':['刻意的静态造型']}}
assert build_outputs(rows, seed, named)[0]['rules'][0]['namingStatus'] == 'codex'
`;
  const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
