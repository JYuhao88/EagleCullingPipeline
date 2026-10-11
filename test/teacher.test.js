import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateLabel, budgetState, cost } from '../scripts/teacher-label.mjs';
import { kendall, samplePairs } from '../scripts/teacher-pilot.mjs';
import { expandedPairs, wilson, bootstrap, categories, semanticRanking } from '../scripts/teacher-expansion.mjs';

const valid = {
  ranking: ['I2', 'I1'],
  images: [{ id: 'I1', decision: 'reject', issues: ['模糊'], reason: '细节模糊' },
    { id: 'I2', decision: 'keep', issues: [], reason: '清晰自然' }],
};

test('teacher stratification covers every degradation and Kendall handles agreement and reversal', async () => {
  const manifest = JSON.parse(await readFile('test/fixtures/bench-syn-manifest.json', 'utf8'));
  const pairs = samplePairs(manifest);
  assert.equal(pairs.length, 40); assert.equal(new Set(pairs.map(pair => pair.id)).size, 40);
  for (const type of new Set(manifest.pairs.map(pair => pair.degradation))) {
    const n = pairs.filter(pair => pair.degradation === type).length;
    assert.ok(n === 3 || n === 4);
  }
  assert.deepEqual(samplePairs({ ...manifest, pairs: [...manifest.pairs].reverse() }), pairs);
  assert.equal(kendall(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(kendall(['a', 'b', 'c'], ['c', 'b', 'a']), -1);
  assert.equal(kendall(['a', 'b', 'c'], ['b', 'a', 'c']), 1 / 3);
  assert.throws(() => kendall(['a', 'b'], ['a', 'c']));
});

test('teacher validates complete permutations, decisions and short reasons', () => {
  assert.equal(validateLabel(valid, ['I1', 'I2']), true);
  assert.equal(validateLabel({ ...valid, ranking: ['I1', 'I1'] }, ['I1', 'I2']), false);
  assert.equal(validateLabel({ ...valid, images: valid.images.slice(0, 1) }, ['I1', 'I2']), false);
  for (const reason of ['字'.repeat(41), 'https://example.invalid', '/private/photo.jpg']) {
    assert.equal(validateLabel({ ...valid, images: [{ ...valid.images[0], reason }, valid.images[1]] }, ['I1', 'I2']), false);
  }
  assert.equal(validateLabel({ ...valid, images: [{ ...valid.images[0], decision: 'candidate' }, valid.images[1]] },
    ['I1', 'I2']), false);
});

test('teacher accounts actual usage, outstanding reservations and malformed-output charges', () => {
  assert.equal(cost({ prompt_tokens: 1e6, completion_tokens: 1e6 }, { input: 1, output: 1, usdToCny: 1 }), 2);
  assert.throws(() => cost({}, { input: 1, output: 1, usdToCny: 1 }));
  const events = [{ type: 'reserve', callId: 'a', estimateCny: 2 },
    { type: 'response', callId: 'a', costCny: 1, valid: false }, { type: 'reserve', callId: 'b', estimateCny: 3 }];
  const state = budgetState(events);
  assert.equal(state.spent, 1); assert.equal(state.reserved, 3); assert.equal(state.active.size, 1);
  assert.throws(() => budgetState([{ type: 'response', callId: 'unknown', costCny: 1 }]));
});

test('expanded teacher sample retains pilot, exhausts joint strata, and confidence intervals remain bounded', async () => {
  const manifest = JSON.parse(await readFile('test/fixtures/bench-syn-manifest.json', 'utf8'));
  const pairs = expandedPairs(manifest);
  assert.equal(pairs.length, 200); assert.equal(new Set(pairs.map(pair => pair.id)).size, 200);
  assert.deepEqual(pairs.slice(0, 40), samplePairs(manifest));
  assert.equal(pairs.filter(pair => pair.degradation.startsWith('joint-crop-')).length, 42);
  assert.deepEqual(expandedPairs({ ...manifest, pairs: [...manifest.pairs].reverse() }), pairs);
  const interval = wilson(95, 100);
  assert.ok(interval.low < 0.95 && interval.high > 0.95);
  assert.ok(wilson(0, 10).high > 0); assert.ok(wilson(10, 10).low < 1);
  assert.equal(wilson(0, 0), null);
  const result = bootstrap([[0, 1], [1], [0]], values => values.reduce((a, b) => a + b, 0) / values.length);
  assert.deepEqual(result, bootstrap([[0, 1], [1], [0]], values => values.reduce((a, b) => a + b, 0) / values.length));
  assert.ok(result.low >= 0 && result.high <= 1);
});

test('teacher order comparisons use photo identities and disagreement categories can overlap', () => {
  const first = { unitIds: ['photo-a', 'photo-b'], response: { result: { ranking: ['I2', 'I1'] } } };
  const reverse = { unitIds: ['photo-b', 'photo-a'], response: { result: { ranking: ['I1', 'I2'] } } };
  assert.deepEqual(semanticRanking(first), semanticRanking(reverse));
  assert.deepEqual(categories('曝光自然，笑容舒展，构图留白合理'), ['技术问题', '表情', '构图', '审美']);
  assert.deepEqual(categories('更喜欢这一张'), ['未归类']);
});

test('teacher privacy, billing, resume, retry cap and fail-closed transport in isolated process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'teacher-test-'));
  try {
    for (const name of ['config', 'data/cache/bench/syn', 'data/cache/previews']) {
      await mkdir(path.join(directory, name), { recursive: true });
    }
    await writeFile(path.join(directory, 'config/local.json'), JSON.stringify({
      aihub: { usdToCny: 1, pricing: { synthetic: { input: 1, output: 1 }, plain: { input: 1, output: 1 } },
        responseFormat: { plain: false }, retryDelayMs: 1000 },
    }));
    const moduleUrl = pathToFileURL(path.resolve('scripts/teacher-label.mjs')).href;
    const sharpUrl = pathToFileURL(path.resolve('node_modules/sharp/lib/index.js')).href;
    const script = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      const { default: sharp } = await import(${JSON.stringify(sharpUrl)});
      const { withTeacher, thumbnail, CACHE } = await import(${JSON.stringify(moduleUrl)});
      await sharp({create:{width:1200,height:900,channels:3,background:'#123456'}})
        .withMetadata({exif:{IFD0:{Artist:'Synthetic'},IFD2:{GPSLatitudeRef:'N'}}})
        .jpeg().toFile('data/cache/bench/syn/a.jpg');
      const jpeg = await thumbnail('data/cache/bench/syn/a.jpg');
      const metadata = await sharp(jpeg).metadata();
      assert.equal(Math.max(metadata.width,metadata.height),768);
      for(const key of ['exif','xmp','iptc','icc']) assert.equal(metadata[key],undefined);
      await assert.rejects(thumbnail('config/local.json'));
      const group={task:'比较质量',images:[{path:'data/cache/bench/syn/a.jpg'},{path:'data/cache/bench/syn/a.jpg'}]};
      const options={model:'synthetic',budget:30,enabled:true};
      let calls=0;
      const good=${JSON.stringify(valid)};
      await assert.rejects(withTeacher({...options,budget:101},()=>{}));
      await assert.rejects(withTeacher({...options,enabled:false},()=>{}));
      globalThis.fetch=async (_url,request)=>{
        calls++;
        const body=JSON.parse(request.body);
        assert.equal(body.response_format.type,'json_schema');
        assert.equal(body.messages[0].content.filter(x=>x.type==='image_url').length,2);
        assert.ok(!JSON.stringify(body).includes('a.jpg'));
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(calls===1?{ranking:[]}:good)}}]})};
      };
      await withTeacher(options,async label=>{await label(group);await label(group)});
      assert.equal(calls,2);
      await withTeacher(options,async label=>assert.equal((await label(group)).cached,true));
      assert.equal(calls,2);
      await assert.rejects(withTeacher({...options,budget:0.00001},label=>label({...group,task:'另一任务'})));
      assert.equal(calls,2);
      globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
        choices:[{message:{content:'{}'}}]})}};
      await assert.rejects(withTeacher(options,label=>label({...group,task:'非法输出'})));
      assert.equal(calls,5);
      await assert.rejects(withTeacher(options,label=>label({...group,task:'非法输出'})));
      assert.equal(calls,5);
      globalThis.fetch=async()=>{calls++;throw new Error('transport')};
      await assert.rejects(withTeacher(options,label=>label({...group,task:'中断任务'})));
      await assert.rejects(withTeacher(options,label=>label({...group,task:'中断任务'})));
      assert.equal(calls,6);
      globalThis.fetch=async (_url,request)=>{
        calls++;
        const body=JSON.parse(request.body);
        assert.equal(body.response_format,undefined);
        assert.ok(body.messages[0].content[0].text.includes('JSON结构'));
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(good)}}]})};
      };
      await withTeacher({...options,model:'plain'},label=>label(group));
      assert.equal(calls,7);
      globalThis.fetch=async()=>{
        calls++;const fence=String.fromCharCode(96).repeat(3);
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:fence+'json\\n'+JSON.stringify(good)+'\\n'+fence}}]})};
      };
      await withTeacher({...options,model:'plain'},async label=>{
        const response=await label({...group,task:'围栏输出'});
        assert.equal(response.valid,true);assert.equal(response.rawValid,false);
      });
      assert.equal(calls,8);
      let limited=0;
      globalThis.fetch=async()=>{
        calls++;limited++;
        if(limited===1)return {ok:false,status:429,text:async()=>'synthetic quota refusal'};
        return {ok:true,json:async()=>({usage:{prompt_tokens:100,completion_tokens:100},
          choices:[{message:{content:JSON.stringify(good)}}]})};
      };
      await withTeacher(options,label=>label({...group,task:'限流恢复'}));
      assert.equal(calls,10);
      const events=(await readFile(CACHE+'/ledger.jsonl','utf8')).trim().split('\\n').map(JSON.parse);
      assert.equal(events.filter(x=>x.type==='response').length,8);
      assert.equal(events.filter(x=>x.type==='reserve').length,10);
      assert.equal(events.filter(x=>x.type==='rejected').length,1);
    `;
    await promisify(execFile)(process.execPath, ['--max-old-space-size=512', '--input-type=module', '-e', script], {
      cwd: directory, env: { ...process.env, ECP_AIHUB_URL: 'https://example.invalid',
        ECP_AIHUB_KEY: 'synthetic', ECP_AIHUB_BUDGET_RMB: '500' }, timeout: 30000,
    });
    const ledger = await readFile(path.join(directory, 'data/cache/teacher/ledger.jsonl'), 'utf8');
    assert.ok(!ledger.includes('data:image')); assert.ok(!ledger.includes('Synthetic'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
