import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { detectPose, PoseWorkerPool } from '../src/core/pose.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';

test('pose pool caps inference concurrency at two', () => {
  const pool=new PoseWorkerPool({size:8});
  assert.equal(pool.diagnostics().concurrency,2);
  pool.close();
});
test('pipeline persists optional signals/verdicts without changing score, and skips cached pose', async () => {
  const cached=[{contractVersion:1,unitId:'u',fingerprint:'f',previewPath:'/proxy.jpg',faces:[],metrics:{faces:0},flags:[],score:.7}];
  let calls=0;const writes=[];
  const pipeline=new AnalysisPipeline({store:{get:async()=>cached[0],put:async(k,v)=>writes.push(structuredClone(v))},
    poseDetector:async(items)=>{
    calls++;assert.equal(items[0].filePath,'/proxy.jpg');return [{available:true,persons:[],source:{width:10,height:20,
      proxyWidth:10,proxyHeight:20,kind:'jpeg'},provider:'CPUExecutionProvider',mode:'balanced',timingMs:{total:1}}];
  }});
  const first=await pipeline.run([{unitId:'u'}]);
  assert.deepEqual(first.results[0].signals.persons,[]);
  assert.equal(first.results[0].score,.7);
  assert.ok(first.results[0].verdicts.every(v=>v.verdict==='na'));
  await pipeline.run([{unitId:'u'}]);assert.equal(calls,1);
  assert.ok(writes.at(-1).signals);
});
test('missing preview skips pose and returns na rules', async () => {
  const pipeline=new AnalysisPipeline({analyzer:async()=>({metrics:{},score:.5}),poseDetector:async()=>assert.fail('no proxy')});
  const result=await pipeline.run([{unitId:'no-preview'}]);
  assert.equal(result.results[0].signals,undefined);
  assert.ok(result.results[0].verdicts.every(v=>v.verdict==='na'));
});
test('local pose worker JSONL smoke: upright blank image has no invented person', async t => {
  const python=process.env.EAGLE_PYTHON || 'python_worker/.venv/bin/python';
  try {await fs.access(python);await fs.access('models/pose/yolox_m_8xb8-300e_humanart-c2c7a14a.onnx');await
    fs.access('models/pose/rtmw-dw-x-l_simcc-cocktail14_270e-256x192_20231122.onnx');}
  catch {t.skip('local Python or pose models unavailable');return;}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pose-smoke-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'空白.jpg');await sharp({create:{width:128,height:256,channels:3,background:'white'}}).jpeg().toFile(file);
  const results=await detectPose([{id:'one',filePath:file},{id:'two',filePath:file}],{python,size:1});
  assert.deepEqual(results.map(r=>r.id),['one','two']);
  for(const r of results){assert.equal(r.available,true,JSON.stringify(r.error));assert.deepEqual(r.persons,[]);
    assert.equal(r.source.proxyHeight,256);assert.ok(r.provider);}
});

test('pose cancellation propagates without starting a model', async () => {
  const controller=new AbortController();controller.abort(new Error('pose cancelled'));
  await assert.rejects(detectPose([{id:'cancel',filePath:'/unused'}],{signal:controller.signal}),/pose cancelled/);
});

test('failed pose refresh invalidates old signals and does not fabricate current verdicts', async () => {
  const cached={contractVersion:1,unitId:'u',fingerprint:'f',previewPath:'/proxy.jpg',faces:[],metrics:{faces:0},flags:[],
    score:.7,signals:{contractVersion:1,persons:[]},pose:{cacheKey:'old'}};
  const pipeline=new AnalysisPipeline({store:{get:async()=>cached,put:async()=>{}},poseDetector:async()=>[{available:false,
    error:{message:'timeout'}}]});
  const result=await pipeline.run([{unitId:'u'}]);
  assert.equal(result.results[0].signals,undefined);
  assert.equal(result.results[0].pose,undefined);
  assert.ok(result.results[0].verdicts.every(v=>v.verdict==='na'));
  assert.match(result.warnings.join(),/timeout/);
});
