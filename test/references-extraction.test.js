import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("critique extraction validates schema, evidence timestamps, batching and resume cache", () => {
  const result = spawnSync(
    (process.env.EAGLE_PYTHON || "python3"),
    [
      "-c",
      String.raw`
import copy, importlib.util, json, pathlib, tempfile, types, unittest
path=pathlib.Path('ml/references/extract_critiques.py')
spec=importlib.util.spec_from_file_location('extract',path)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ExtractionTests(unittest.TestCase):
 def setUp(self):
  self.source={'bvid':'BVTest','segment':{'index':1,'start':10,'end':30},
   'intervals':[{'start':10,'end':15},{'start':20,'end':30}],
   'transcript':'姿势僵硬，手指不自然','tier':'NPC'}
  self.units=m.split_units(self.source)
  self.result={'results':[{'segmentKey':'1:0','verdict':'bad',
   'issues':[{'ruleId':'P-HAND-NATURAL','text':'手指显得僵硬','t':12}],'praises':[],'topics':['hands']}]}
 def test_preprocess(self):
  self.assertEqual(m.preprocess('手指不自然')['evaluation'],['bad'])
  self.assertTrue(m.preprocess('镜头器材')['skipSuggested'])
  self.assertTrue(m.preprocess('表情很好')['evaluationSpans'])
 def test_schema(self):
  schema=json.loads(m.SCHEMA.read_text())
  self.assertFalse(schema['additionalProperties'])
  self.assertEqual(schema['properties']['results']['items']['properties']['issues']['items']['properties']['text']['maxLength'],40)
  m.validate_result(self.result,self.units,{'P-HAND-NATURAL'})
  for field,value in [('ruleId','BAD'),('text','字'*41),('t',float('nan')),('t',True)]:
   bad=copy.deepcopy(self.result);bad['results'][0]['issues'][0][field]=value
   with self.assertRaises(ValueError):m.validate_result(bad,self.units,{'P-HAND-NATURAL'})
  outside=copy.deepcopy(self.result);outside['results'][0]['issues'][0]['t']=1e6
  m.validate_result(outside,self.units,{'P-HAND-NATURAL'})
  t=outside['results'][0]['issues'][0]['t']
  self.assertTrue(any(i['start']<=t<=i['end'] for i in self.units[0]['intervals']))
 def test_coverage(self):
  for bad in [{'results':[]},{'results':self.result['results']*2}]:
   with self.assertRaises(ValueError):m.validate_result(bad,self.units,{'P-HAND-NATURAL'})
 def test_keywords(self):
  self.assertIn('hands',m.preprocess(self.source['transcript'])['topics'])
  self.assertEqual(m.preprocess('后期蒙版修图')['skipSuggested'],True)
  self.assertEqual(m.preprocess('后期但表情僵硬')['skipSuggested'],False)
 def test_long_text_and_timeline(self):
  self.source['transcript']='字'*10000
  units=m.split_units(self.source,1000)
  self.assertEqual(''.join(u['transcript'] for u in units),self.source['transcript'])
  groups=list(m.batches(units,3000,3))
  self.assertEqual(sum(map(len,groups)),10)
  self.source['transcript_segments']=[{'start':11,'end':12,'text':'手指僵硬'}]
  self.assertIn('[11–12]',m.split_units(self.source)[0]['transcript'])
 def test_resume_and_invalidation(self):
  library={'library':'portrait','version':'0.1.0','rules':[{'id':'P-HAND-NATURAL'}]}
  calls=[]
  def fake(units,*args):
   calls.append(units)
   return [dict(self.result['results'][0],segmentKey=u['segmentKey']) for u in units]
  original=m.call_batch;m.call_batch=fake
  try:
   with tempfile.TemporaryDirectory() as temporary:
    data=pathlib.Path(temporary);(data/'critiques-v2').mkdir()
    source=data/'critiques-v2/BVTest.jsonl';source.write_text(json.dumps(self.source)+'\n')
    args=types.SimpleNamespace(data=data,part_chars=6000,batch_chars=18000,batch_size=8,max_batches=None,timeout=30)
    m.extract_video('BVTest',args,library);m.extract_video('BVTest',args,library)
    self.assertEqual(len(calls),1)
    files=list((data/'extracted/BVTest').glob('*.json'));cached=json.loads(files[0].read_text())
    self.assertNotIn('transcript',cached);self.assertEqual(cached['rulesVersion'],'portrait@0.1.0')
    library['rules'][0]['statement']='new meaning';m.extract_video('BVTest',args,library)
    self.assertEqual(len(calls),2)
  finally:m.call_batch=original
unittest.main(argv=['extraction'],exit=True)
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("genre manifests, Wulin parameters, lecture topics and checked text transfer", () => {
  const result = spawnSync(
    (process.env.EAGLE_PYTHON || "python3"),
    ["-m", "unittest", "discover", "-s", "ml/references", "-p", "test_*.py"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
