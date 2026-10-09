import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { analyzeImage, applyFaceQuality, clusterByPhash, hammingDistance, listEagleImages, scoreQuality } from "../src/image-analyzer.js";

test("unassessed composition/subject values never affect technical ranking, including grayscale inputs",async()=>{
  const input={sharpness:8,clippedHigh:0.01,clippedLow:0.02,width:6000,height:4000,resolutionVerified:false};
  const expected=scoreQuality(input);
  assert.equal(scoreQuality({...input,subjectScore:100,compositionScore:100}),expected);
  assert.equal(scoreQuality({...input,subjectScore:0,compositionScore:0}),expected);
  const root=await mkdtemp(path.join(os.tmpdir(),"eagle-gray-quality-"));
  const filePath=path.join(root,"gray.png");
  await sharp({create:{width:96,height:96,channels:3,background:"#777777"}}).greyscale().png().toFile(filePath);
  const result=await analyzeImage({id:"gray",filePath});
  assert.equal(result.metrics.subjectScore,null);assert.equal(result.metrics.compositionScore,null);
  assert.equal(result.scoringVersion,"preview-v3-technical-only");
  for (const key of ["sharpness","meanLuma","lumaVariance"]) assert.equal(Number.isFinite(result.metrics[key]),true,key);
  assert.equal(Number.isFinite(result.qualityScore),true);
});

async function fixtureLibrary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-culling-"));
  const info = path.join(root, "images", "TESTITEM000001.info");
  await mkdir(info, { recursive: true });
  const buffer = await sharp({ create: { width: 96, height: 96, channels: 3, background: { r: 220, g: 80, b: 40 } } }).png().toBuffer();
  await writeFile(path.join(info, "sample.png"), buffer);
  await writeFile(path.join(info, "metadata.json"), JSON.stringify({ id: "TESTITEM000001", name: "sample", ext: "png", width: 96, height: 96 }));
  const duplicate = path.join(root, "images", "TESTITEM000002.info");
  await mkdir(duplicate, { recursive: true });
  await cp(path.join(info, "sample.png"), path.join(duplicate, "sample-copy.png"));
  await writeFile(path.join(duplicate, "metadata.json"), JSON.stringify({ id: "TESTITEM000002", name: "sample-copy", ext: "png", width: 96, height: 96 }));
  return root;
}

test("lists Eagle .info image records and analyzes a local sample", async () => {
  const root = await fixtureLibrary();
  const records = await listEagleImages(root);
  assert.equal(records.length, 2);
  const result = await analyzeImage(records[0]);
  assert.equal(result.sha256.length, 64);
  assert.equal(result.phash.length, 63);
  assert.ok(result.qualityScore >= 0 && result.qualityScore <= 100);
  assert.ok(result.metrics.sharpness >= 0);
  assert.equal(result.qualityMethod,"heuristic-preview");
  assert.equal(result.confidence,null);
  assert.equal(result.confidenceCalibrated,false);
});

test("analyzes an Eagle proxy while preserving the original item dimensions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-proxy-"));
  const originalPath = path.join(root, "capture.3fr");
  const proxyPath = path.join(root, "capture_thumbnail.png");
  await writeFile(originalPath, "not decoded in the interactive plugin");
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 80, g: 100, b: 120 } } }).png().toFile(proxyPath);
  const result = await analyzeImage({ id: "raw", name: "capture", filePath: originalPath, analysisPath: proxyPath, width: 11656, height: 8742 });
  assert.equal(result.analysisSource, "proxy");
  assert.equal(result.width, 11656);
  assert.equal(result.height, 8742);
  assert.equal(result.filePath, originalPath);
});

test("clusters exact duplicates and reports a zero hash distance", async () => {
  const root = await fixtureLibrary();
  const records = await listEagleImages(root);
  const analyzed = await Promise.all(records.map(analyzeImage));
  assert.equal(hammingDistance(analyzed[0].phash, analyzed[1].phash), 0);
  const groups = clusterByPhash(analyzed, 8);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 2);
});

test("missing SHA values never turn unrelated pHashes into duplicates", () => {
  const groups = clusterByPhash([{id:"a",phash:"0".repeat(63)},{id:"b",phash:"1".repeat(63)}],8);
  assert.equal(groups.length,2);
  assert.equal(clusterByPhash([{id:"a"},{id:"b"}]).length,2);
  assert.equal(clusterByPhash([{id:"a",sha256:"a".repeat(64)},{id:"b",sha256:"a".repeat(64)}]).length,1);
});

test("similarity chains cannot recommend keeping one shot for dissimilar endpoints", () => {
  const items = [{id:"a",phash:"0".repeat(63),qualityScore:90},
    {id:"b",phash:"1".repeat(8)+"0".repeat(55),qualityScore:80},
    {id:"c",phash:"1".repeat(16)+"0".repeat(47),qualityScore:70}];
  const groups = clusterByPhash(items,8);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].items.map(item=>item.id),["a","b"]);
  assert.equal(groups[0].items[1].phashDistance,8);
  assert.equal(groups[0].similarityMethod,"phash-pairwise-v2");
  assert.deepEqual(clusterByPhash([...items].reverse(),8),groups);
  for (const group of groups) for (const a of group.items) for (const b of group.items) assert.ok(hammingDistance(a.phash,b.phash)<=8);
});

test("packed clustering distance agrees with binary hamming distances", () => {
  let seed=17;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const items = Array.from({length:250},(_,index)=>({id:String(index),phash:random().toString(2).padStart(32,"0")+random().toString(2).padStart(32,"0")}));
  const groups = clusterByPhash(items,20);
  for (const group of groups) for (const member of group.items) assert.equal(member.phashDistance,hammingDistance(member.phash,group.items[0].phash));
  for (const group of groups) for (const a of group.items) for (const b of group.items) assert.ok(hammingDistance(a.phash,b.phash)<=20);
  assert.throws(()=>clusterByPhash(items,-1),/threshold/);
});

test("closed eyes become an explicit quality flag and score penalty", () => {
  const result = applyFaceQuality({ qualityScore: 80, confidence: 0.78, qualityFlags: [] }, {
    faceCount: 1,
    faces: [{ eyesClosed: true }],
  });
  assert.equal(result.qualityFlags.includes("eyes-closed"), true);
  assert.equal(result.qualityScore, 55);
});

test("unavailable face results never penalize photos using untrusted partial detections", () => {
  const result = applyFaceQuality({qualityScore:80,qualityFlags:[]},{available:false,faces:[{eyesClosed:true}]});
  assert.equal(result.qualityScore,80);
  assert.deepEqual(result.qualityFlags,[]);
});

test("eye penalties do not invent confidence when the baseline is uncalibrated", () => {
  const result = applyFaceQuality({qualityScore:80,confidence:null,qualityFlags:[]},{available:true,faces:[{eyesClosed:true}]});
  assert.equal(result.qualityScore,55);
  assert.equal(result.confidence,null);
  assert.equal(result.confidenceCalibrated,false);
});

test("face availability and eye assessment distinguish absence, incomplete and no closed signal without penalties", () => {
  const base={qualityScore:80,qualityFlags:[]};
  for (const [face,expected] of [
    [{available:true,faceCount:0,faces:[]},"not-detected"],
    [{available:true,faceCount:2,faces:[{eyesClosed:false}]},"incomplete"],
    [{available:true,faceCount:1,faces:[{eyesAssessed:false,eyesClosed:false}]},"incomplete"],
    [{available:true,faceCount:1,faces:[{eyesClosed:false}]},"no-closed-signal"],
    [{error:"failed"},"unavailable"],
  ]) {
    const result=applyFaceQuality(base,face);
    assert.equal(result.face.eyeAssessment,expected);assert.equal(result.qualityScore,80);assert.deepEqual(result.qualityFlags,[]);
  }
  assert.equal(applyFaceQuality(base,{available:true,faceCount:1,faces:[{eyesClosed:true}]}).face.eyeAssessment,"possible-closed");
});

test("small proxy dimensions never become an original-resolution defect or score penalty", async () => {
  const root=await fixtureLibrary();
  const [record]=await listEagleImages(root);
  const proxy=record.filePath;
  const small=await analyzeImage({...record,filePath:path.join(root,"not-read-original.raw"),analysisPath:proxy,width:320,height:480});
  const large=await analyzeImage({...record,filePath:path.join(root,"not-read-original.raw"),analysisPath:proxy,width:8000,height:6000});
  assert.equal(small.resolutionVerified,false);
  assert.equal(small.qualityFlags.includes("low-resolution"),false);
  assert.equal(small.qualityScore,large.qualityScore);
  const original=await analyzeImage({...record,analysisPath:proxy,width:8000,height:6000});
  assert.equal(original.resolutionVerified,true);
  assert.equal(original.width,96);
  assert.equal(original.qualityFlags.includes("low-resolution"),true);
});
