import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeDecodeLimit } from '../src/core/native-image.js';
import { Readable, PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parsePerformanceMode, parsePoseThreads, poseThreads, withPerformanceMode,
  performanceWorkerCap, childLaunch } from '../src/core/performance-mode.js';
import { workerLimit, ExiftoolPool } from '../src/core/exiftool-pool.js';
import { PoseWorkerPool, POSE_CACHE_KEY } from '../src/core/pose.js';
import { AnalysisPipeline } from '../src/core/pipeline.js';
import { createRunsRouter } from '../src/server/runs-routes.js';

test('mode and CPU thread settings reject malformed values', () => {
  for (const v of ['1', '2', '8']) assert.equal(parsePoseThreads(v), Number(v));
  for (const v of ['', '0', '9', '1.5', '03', 'NaN', 3]) assert.throws(() => parsePoseThreads(v));
  for (const v of ['turbo', 'normal']) assert.equal(parsePerformanceMode(v), v);
  for (const v of [true, false, 1, null, 'TURBO', 'fast']) assert.throws(() => parsePerformanceMode(v));
  assert.equal(parsePerformanceMode(undefined), 'normal');
});
test('normal keeps caps and priority; turbo divides cores and is memory bounded', async () => {
  await withPerformanceMode('normal', async () => {
    assert.equal(workerLimit('UNCONFIGURED_TEST_WORKERS', 9), 2);
    assert.equal(new AnalysisPipeline({ concurrency: 8 }).concurrency, 2);
    const pool = new PoseWorkerPool({ size: 8 }); assert.equal(pool.options.size, 2);
    assert.ok(Number(pool.options.workerEnv(0).EAGLE_POSE_THREADS) * pool.options.size <= 6); pool.close();
    const exif = new ExiftoolPool({ size: 8 }); assert.equal(exif.size, 2); exif.close();
    assert.deepEqual(childLaunch('python', ['worker'], 'normal', 'darwin'), { command: 'nice', args: ['-n', '15', 'python', 'worker'] });
    assert.deepEqual(childLaunch('python', ['worker'], 'normal', 'win32'), { command: 'python', args: ['worker'] });
  });
  await withPerformanceMode('turbo', async () => {
    assert.equal(performanceWorkerCap('turbo', 36 * 1024 ** 3), 4);
    assert.equal(performanceWorkerCap('turbo', 8 * 1024 ** 3), 2);
    assert.equal(workerLimit('UNCONFIGURED_TEST_WORKERS', 1), performanceWorkerCap());
    assert.deepEqual([0,1,2,3].map(slot => poseThreads(4, 'turbo', slot)), [2,2,1,1]);
    const pool = new PoseWorkerPool({ size: 8 }); assert.equal(pool.options.size, performanceWorkerCap());
    assert.ok(Number(pool.options.env.EAGLE_WORKER_RSS_BYTES) * pool.options.size <= 3 * 1024 ** 3); pool.close();
    assert.deepEqual(childLaunch('python', ['worker']), { command: 'python', args: ['worker'] });
    assert.deepEqual(childLaunch('python', ['worker'], 'turbo', 'win32'), { command: 'python', args: ['worker'] });
  });
  assert.doesNotMatch(POSE_CACHE_KEY, /threads|turbo/);
});
test('explicit ordinary threads are clamped to the six-core budget; invalid ones fail before model jobs', () => {
  const saved = process.env.EAGLE_POSE_THREADS;
  try { process.env.EAGLE_POSE_THREADS='8';
    assert.equal(poseThreads(2, 'normal'),3); assert.equal(poseThreads(1, 'normal'),6);
    for(const value of ['0','9','invalid']) {
      process.env.EAGLE_POSE_THREADS=value;
      assert.throws(()=>new PoseWorkerPool({mode:'normal'}),/EAGLE_POSE_THREADS/);
    }
  } finally { if(saved===undefined) delete process.env.EAGLE_POSE_THREADS; else process.env.EAGLE_POSE_THREADS=saved; }
});
test('parallel async contexts and pipeline instances do not leak modes', async () => {
  const pipeline = new AnalysisPipeline({concurrency:2});
  pipeline.runAnalysis = async function () { await new Promise(resolve => setImmediate(resolve));
    return {concurrency:this.concurrency, launch:childLaunch('python',[]).command}; };
  const values = await Promise.all(['normal', 'turbo'].map(performanceMode => pipeline.run([], {performanceMode})));
  const normalLaunch = process.platform === 'win32' ? 'python' : 'nice';
  assert.deepEqual(values, [{concurrency:2,launch:normalLaunch},{concurrency:performanceWorkerCap('turbo'),launch:'python'}]);
  assert.equal(pipeline.concurrency,2);
});
test('pose pool transmits slot-specific threads and never adds them to cache keys', async () => {
  await withPerformanceMode('turbo', async () => {
    const envs=[];
    const pool=new PoseWorkerPool({size:4, spawnWorker:(_program,_args,options)=>{
      envs.push(options.env);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>setImmediate(()=>child.emit('close',0));
      child.stdin=new Writable({write(chunk,encoding,done){const {id}=JSON.parse(String(chunk));
        setImmediate(()=>child.stdout.write(JSON.stringify({id,available:true})+'\n'));done();}});
      return child;
    }});
    await pool.run([0,1,2,3].map(id=>({id})));pool.close();
    assert.deepEqual(envs.map(env=>Number(env.EAGLE_POSE_THREADS)),[2,2,1,1].slice(0,performanceWorkerCap()));
  });
});
test('server rejects invalid modes before persistence and forwards validated mode', async () => {
  let called = 0, actual;
  const router = createRunsRouter({ store: { list: async () => ({runs: []}), save: async () => {} },
    pipeline: { run: async (_, options) => { called++; actual = options.performanceMode;
      return {results: [], groups: [], progress: {stage:'done'}}; } } });
  async function invoke(value) {
    const req = Readable.from([Buffer.from(JSON.stringify({items: [], performanceMode: value}))]); req.method = 'POST';
    let status;
    await router(req, {writeHead: code => {status=code;}, end: () => {}}, new URL('http://localhost/runs'));
    await new Promise(resolve => setImmediate(resolve));return status;
  }
  for (const value of [true, 4, null, '', 'fast']) assert.equal(await invoke(value), 400);
  assert.equal(called,0);assert.equal(await invoke('turbo'),202);assert.equal(actual,'turbo');assert.equal(called,1);
});

test('thread-one pose cache remains reusable under the new default', async () => {
  const cached={contractVersion:1,unitId:'cached',fingerprint:'f',previewPath:'/unused-proxy.jpg',faces:[],
    metrics:{faces:0},flags:[],score:.7,signals:{contractVersion:1,persons:[]},pose:{
      cacheKey:'signals-v3-proxy-joint-validity:measure-v3',provider:'CPUExecutionProvider',
      providers:{detector:['CPUExecutionProvider'],pose:['CPUExecutionProvider']},diagnostics:{intraOpThreads:{pose:1}}}};
  const pipeline=new AnalysisPipeline({store:{get:async()=>cached,put:async()=>{}},
    poseDetector:async()=>assert.fail('must reuse thread-one cache')});
  const result=await pipeline.run([{unitId:'cached'}],{performanceMode:'normal'});
  assert.equal(result.results[0].pose.diagnostics.intraOpThreads.pose,1);
});

test('turbo native decode cap cannot be bypassed by configuration; normal is unchanged', async () => {
  const saved = process.env.EAGLE_NATIVE_CONCURRENCY;
  try {
    delete process.env.EAGLE_NATIVE_CONCURRENCY;
    assert.equal(withPerformanceMode('normal', nativeDecodeLimit), 1);
    assert.equal(withPerformanceMode('turbo', nativeDecodeLimit), Math.min(2, performanceWorkerCap()));
    process.env.EAGLE_NATIVE_CONCURRENCY = '8';
    assert.equal(withPerformanceMode('normal', nativeDecodeLimit), 2);
    assert.equal(withPerformanceMode('turbo', nativeDecodeLimit), Math.min(2, performanceWorkerCap()));
  } finally {
    if (saved === undefined) delete process.env.EAGLE_NATIVE_CONCURRENCY;
    else process.env.EAGLE_NATIVE_CONCURRENCY = saved;
  }
});

test('RSS timer cancels one server run, drains native waiters, and service survives strict rejections', async () => {
  const code = `
    import assert from 'node:assert/strict';
    import { Readable } from 'node:stream';
    import { mkdtemp, rm } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import sharp from 'sharp';
    import { AnalysisPipeline } from './src/core/pipeline.js';
    import { withNativeImage } from './src/core/native-image.js';
    import { createRunsRouter } from './src/server/runs-routes.js';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rss-cancel-'));
    const file = path.join(directory, 'test.jpg');
    await sharp({create:{width:8,height:8,channels:3,background:'red'}}).jpeg().toFile(file);
    const original = process.memoryUsage;
    let over = false, recovered = false, unhandled = 0;
    process.on('unhandledRejection', () => unhandled++);
    process.memoryUsage = () => ({...original(),rss:over ? 4 * 1024 ** 3 : 1000000});
    const pipeline = new AnalysisPipeline();
    pipeline.runAnalysis = async (_, {signal}) => {
      if (recovered) return {results:[],groups:[]};
      setTimeout(() => {over = true;}, 30);
      const jobs = Array.from({length:6}, () => withNativeImage({filePath:file,ext:'jpg'}, {signal}, async () => {
        await new Promise(resolve => setTimeout(resolve, 180));
        signal.throwIfAborted();
      }));
      const settled = await Promise.allSettled(jobs);
      assert.ok(settled.every(job => job.status === 'rejected'));
      throw settled[0].reason;
    };
    const saved = [];
    const router = createRunsRouter({pipeline,store:{list:async()=>({runs:[]}),save:async run=>saved.push({...run})}});
    async function start() {
      const req = Readable.from([Buffer.from(JSON.stringify({items:[],performanceMode:'turbo'}))]);req.method='POST';
      let status;
      await router(req,{writeHead:code=>status=code,end:()=>{}},new URL('http://localhost/runs'));
      assert.equal(status,202);
    }
    try {
      await start();
      for(let i=0;i<100 && !saved.some(run=>run.status==='failed');i++) await new Promise(r=>setTimeout(r,10));
      const failed = saved.find(run=>run.status==='failed');
      assert.ok(failed);assert.match(failed.error,/全速模式内存保护/);
      over=false;recovered=true;
      await start();await new Promise(r=>setTimeout(r,30));
      assert.ok(saved.some(run=>run.status==='completed'));
      assert.equal(unhandled,0);
      console.log('service survived; failed run persisted; recovery completed');
    } finally {process.memoryUsage=original;await rm(directory,{recursive:true,force:true});}
  `;
  const {stdout} = await promisify(execFile)(process.execPath,
    ['--unhandled-rejections=strict','--input-type=module','-e',code], {cwd:process.cwd(),timeout:10000});
  assert.match(stdout,/service survived/);
});
