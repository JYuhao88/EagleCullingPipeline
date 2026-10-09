import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runFaceWorker, FaceWorkerPool } from "../src/face-worker-client.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

test("face worker client round-trips a real local image", async (t) => {
  const python = path.resolve(".venv/Scripts/python.exe");
  if (!existsSync(python)) { t.skip("optional Python worker environment is not installed"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-face-client-"));
  const filePath = path.join(root, "sample.jpg");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(filePath);
  const [result] = await runFaceWorker([{ id: "sample", filePath }], { python, cwd: process.cwd() });
  assert.equal(result.id, "sample");
  assert.equal(result.faceCount, 0);
  assert.equal(result.available, true);
});

test("cancelled batches remove queued inference but keep already loaded models reusable", async (t) => {
  let dispatched=0;
  const factory=fakeWorkerFactory();
  const pool=new FaceWorkerPool({size:2,spawnWorker:()=>{
    const child=factory();const write=child.stdin.write.bind(child.stdin);
    child.stdin.write=(...args)=>{dispatched++;return write(...args);};return child;
  }});
  t.after(()=>pool.close());
  const controller=new AbortController();
  const running=pool.run(Array.from({length:128},(_,index)=>({id:String(index),filePath:"fixture"})),{signal:controller.signal});
  controller.abort(new Error("paused"));
  await assert.rejects(running,/paused/);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(dispatched,2);assert.equal(pool.diagnostics().pending,0);
  await pool.run([{id:"next",filePath:"fixture"}]);
  assert.equal(dispatched,3);assert.equal(pool.diagnostics().processStarts,2);
});

function fakeWorkerFactory({ fail = false, hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stopped = false;
    child.kill = () => {
      if (stopped) return;
      stopped = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0));
    };
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const item = JSON.parse(chunk.toString());
      if (!hang) setTimeout(() => {
        if (stopped) return;
        const line = JSON.stringify(fail ? { error: { code: "model_unavailable", message: "Missing model" } } : { id: item.id, faceCount: 0 });
        // Deliberately split JSON across stream chunks.
        child.stdout.write(line.slice(0, 5));
        child.stdout.write(line.slice(5) + "\n");
      }, 1);
      callback();
    }, final(callback) { child.kill(); callback(); } });
    return child;
  };
}

test("128 simultaneous jobs reuse two model workers and parse fragmented JSONL", async (t) => {
  const pool = new FaceWorkerPool({ size: 2, spawnWorker: fakeWorkerFactory() });
  t.after(() => pool.close());
  const results = await pool.run(Array.from({ length: 128 }, (_, id) => ({ id: String(id) })));
  assert.equal(results.length, 128);
  assert.equal(pool.diagnostics().processStarts, 2);
  assert.equal(pool.diagnostics().pending, 0);
  assert.equal((await pool.run([{ id: "again" }]))[0].id, "again");
  assert.equal(pool.diagnostics().processStarts, 2);
});

test("missing models reject queued jobs rather than creating a process storm", async (t) => {
  const pool = new FaceWorkerPool({ size: 2, spawnWorker: fakeWorkerFactory({ fail: true }) });
  t.after(() => pool.close());
  await assert.rejects(pool.run(Array.from({ length: 128 }, (_, id) => ({ id: String(id) }))), /Missing model/);
  await assert.rejects(pool.run([{ id: "later" }]), /Missing model/);
  assert.equal(pool.diagnostics().processStarts, 2);
});

test("worker timeout rejects, terminates the worker, and close rejects queued work", async () => {
  const pool = new FaceWorkerPool({ size: 1, timeoutMs: 10, spawnWorker: fakeWorkerFactory({ hang: true }) });
  await assert.rejects(pool.run([{ id: "timeout" }]), /timed out/);
  pool.close();
  await assert.rejects(pool.run([{ id: "closed" }]), /closed/);
});

test("real model process is reused across successive photos", async (t) => {
  const python = path.resolve(".venv/Scripts/python.exe");
  if (!existsSync(python)) { t.skip("optional Python environment absent"); return; }
  const { root, filePath } = await (async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eagle-reuse-model-"));
    const filePath = path.join(root, "sample.jpg");
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888888" } }).jpeg().toFile(filePath);
    return { root, filePath };
  })();
  const pool = new FaceWorkerPool({ python, size: 1 });
  t.after(() => pool.close());
  const firstStart = performance.now();
  assert.equal((await pool.run([{ id: "first", filePath }]))[0].faceCount, 0);
  const firstMs = performance.now() - firstStart;
  const oversized=path.join(root,"oversized.png");
  await sharp({create:{width:4001,height:4001,channels:3,background:"#888888"}}).png().toFile(oversized);
  const rejected=(await pool.run([{id:"oversized",filePath:oversized}]))[0];
  assert.equal(rejected.available,false);assert.match(rejected.error.message,/bounded preview/);
  const secondStart = performance.now();
  assert.equal((await pool.run([{ id: "second", filePath }]))[0].faceCount, 0);
  t.diagnostic(`Real model cold ${Math.round(firstMs)}ms, warm ${Math.round(performance.now() - secondStart)}ms; fixture ${root}`);
  assert.equal(pool.diagnostics().processStarts, 1);
});
