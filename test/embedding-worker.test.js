import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runFaceWorker } from "../src/face-worker-client.js";
import { cosineSimilarity } from "../src/embedding.js";

test("offline DINO worker reuses a verified CPU session and survives one missing preview",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-dino-test-"));
  const filePath=path.join(root,"中文预览.png");
  await sharp({create:{width:96,height:64,channels:3,background:{r:70,g:110,b:130}}}).png().toFile(filePath);
  const stripPath=path.join(root,"strip.png");
  await sharp({create:{width:96,height:1,channels:3,background:{r:70,g:110,b:130}}}).png().toFile(stripPath);
  const rows=await runFaceWorker([{id:"one",filePath},{id:"missing",filePath:path.join(root,"missing.png")},{id:"strip",filePath:stripPath},{id:"two",filePath}],{script:"python_worker/embedding_worker.py"});
  assert.equal(rows[0].type,"ready");assert.deepEqual(rows[0].providers,["CPUExecutionProvider"]);
  const manifest=JSON.parse(await readFile("python_worker/model-manifest.json","utf8"));
  assert.equal(rows[0].modelSha256,manifest.models.find(model=>model.name==="dinov2-small").sha256);
  const byId=new Map(rows.filter(row=>row.id).map(row=>[row.id,row]));
  assert.equal(byId.get("missing").available,false);
  assert.equal(byId.get("strip").available,false);
  assert.match(byId.get("strip").error,/bounded model resize/);
  for(const id of ["one","two"]) {
    const result=byId.get(id);assert.equal(result.available,true);assert.equal(result.embedding.length,384);
    assert.ok(result.embedding.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...result.embedding)-1)<1e-6);
  }
  assert.ok(cosineSimilarity(byId.get("one").embedding,byId.get("two").embedding)>0.99999);
});
