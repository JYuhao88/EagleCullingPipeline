import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { FaceWorkerPool, normalizeFaceDetails, normalizeFaceResult } from "../src/core/faces.js";
import { AnalysisPipeline } from "../src/core/pipeline.js";
import { SCORER_CACHE_KEY } from "../src/core/scorer.js";

const workerFace = {
  box: [0.2, 0.1, 0.4, 0.5], eyesClosed: true, eyesAssessed: true,
  eyeBlinkLeft: 0.8, eyeBlinkRight: 0.2,
};

test("face details preserve normalized boxes and rename blink scores", () => {
  const details = normalizeFaceDetails([workerFace]);
  assert.deepEqual(details, [{
    box: [0.2, 0.1, 0.4, 0.5], eyesClosed: true, eyesAssessed: true, blinkLeft: 0.8, blinkRight: 0.2,
  }]);
  assert.notEqual(details[0].box, workerFace.box);
  assert.deepEqual(normalizeFaceDetails(undefined), []);
  assert.deepEqual(normalizeFaceDetails([{ box: [0.4, 0.1, 0.2, 0.5] }, { box: [NaN, 0, 1, 1] }]), []);
  assert.deepEqual(normalizeFaceDetails([{ box: [-1, 0, 1.2, 1] }]), [{
    box: [0, 0, 1, 1], eyesClosed: false, eyesAssessed: false, blinkLeft: null, blinkRight: null,
  }]);
});

test("face worker failure stays unknown rather than reporting zero faces", () => {
  for (const result of [undefined, { available: false, faces: [workerFace] }, { error: { message: "missing model" } }]) {
    const normalized = normalizeFaceResult(result);
    assert.equal(normalized.faces, null);
    assert.equal(normalized.eyesClosed, null);
    assert.deepEqual(normalized.faceDetails, []);
    assert.match(normalized.warning, /人脸模型不可用/);
  }
  assert.equal(normalizeFaceResult({ available: true, faces: [workerFace] }).eyesClosed, 1);
});

test("pipeline associates the face subset with the correct cached units and upgrades missing details", async () => {
  const cached = [
    { unitId: "known", previewPath: "/known.jpg", metrics: { faces: 0, eyesClosed: 0 }, faces: [] },
    { unitId: "missing-preview", metrics: { faces: null } },
    { unitId: "legacy", previewPath: "/legacy.jpg", metrics: { faces: 1, eyesClosed: 0 } },
    { unitId: "unknown", previewPath: "/unknown.jpg", metrics: { faces: null } },
  ].map((result) => ({ ...result, flags: [], score: 0.5, fingerprint: result.unitId }));
  let cursor = 0;
  const written = new Map();
  const pipeline = new AnalysisPipeline({
    concurrency: 1,
    store: { get: async () => cached[cursor++], put: async (key, value) => written.set(key, structuredClone(value)) },
    faceDetector: async (paths) => {
      assert.deepEqual(paths, ["/legacy.jpg", "/unknown.jpg"]);
      return [normalizeFaceResult({ faces: [workerFace] }), normalizeFaceResult({ available: false })];
    },
    poseDetector: async (items) => items.map(() => ({ available: false, error: { message: "pose unavailable" } })),
  });
  const run = await pipeline.run(cached.map(({ unitId }) => ({ unitId })));
  assert.deepEqual(run.results[0].faces, []);
  assert.equal(run.results[0].metrics.faces, 0);
  assert.deepEqual(run.results[1].faces, []);
  assert.equal(run.results[2].faces[0].blinkLeft, 0.8);
  assert.equal(run.results[2].metrics.eyesClosed, 1);
  assert.deepEqual(run.results[2].flags, []); // Blink count without reliable pose is a warning, not a gate.
  assert.ok(run.groups.some(g => g.ranking.some(e => e.unitId === "legacy" &&
    e.reasons.some(reason => reason.includes("闭眼待复核")))));
  assert.equal(run.results[3].metrics.faces, null);
  assert.deepEqual(run.results[3].faces, []);
  assert.deepEqual(written.get("legacy").faces, run.results[2].faces);
});

test("fresh units without previews still expose faces and use the new analysis fingerprint", async () => {
  let actualKey;
  const pipeline = new AnalysisPipeline({
    root: "/tmp/eagle-no-face-models",
    analyzer: async () => ({ metrics: {}, score: 0.5 }),
    faceDetector: async () => assert.fail("no preview must not be sent to face detection"),
    store: { get: async (key) => { actualKey = key; return null; }, put: async () => {} },
  });
  const run = await pipeline.run([{ unitId: "no-preview" }]);
  const oldKey = crypto.createHash("sha256")
    .update(JSON.stringify([undefined, 0, 0, [], "", "analysis-v3", SCORER_CACHE_KEY])).digest("hex");
  assert.notEqual(actualKey, oldKey);
  assert.deepEqual(run.results[0].faces, []);
  assert.equal(run.results[0].metrics.faces, null);
});


test("face normalization preserves actual landmark eye boxes and drops malformed ones", () => {
  const eyeBoxes = [[0.2, 0.2, 0.25, 0.23], [0.3, 0.2, 0.35, 0.23]];
  const details = normalizeFaceDetails([{ box: [0.1, 0.1, 0.5, 0.5], eyeBoxes: [...eyeBoxes, [-1, 0, 1, 1]] }]);
  assert.deepEqual(details[0].eyeBoxes, eyeBoxes);
});

function fakeSpawn({ hold = new Set() } = {}) {
  return () => {
    const child = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit("close", null));
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const { id } = JSON.parse(line);
        if (!hold.has(id)) setImmediate(() => child.stdout.write(`${JSON.stringify({ id, faces: 0 })}\n`));
      }
      done();
    }, final(done) { setImmediate(() => child.emit("close", 0)); done(); } });
    return child;
  };
}

test("worker pool reports each finished photo as it completes", async () => {
  const pool = new FaceWorkerPool({ size: 2, spawnWorker: fakeSpawn(), idleMs: 10 });
  const seen = [];
  const results = await pool.run(["a", "b", "c"].map(id => ({ id })), { onItem: result => seen.push(result.id) });
  pool.close();
  assert.deepEqual(results.map(result => result.id), ["a", "b", "c"]);
  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
});

test("cancelled photos never report progress, and a throwing progress callback cannot fail inference", async () => {
  const pool = new FaceWorkerPool({ size: 1, spawnWorker: fakeSpawn({ hold: new Set(["slow"]) }), idleMs: 10 });
  const controller = new AbortController();
  const seen = [];
  const pending = pool.run([{ id: "slow" }, { id: "queued" }], { signal: controller.signal, onItem: result => seen.push(result.id) });
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.deepEqual(seen, []);
  pool.close();
  const next = new FaceWorkerPool({ size: 1, spawnWorker: fakeSpawn(), idleMs: 10 });
  const results = await next.run([{ id: "x" }], { onItem() { throw new Error("ui"); } });
  next.close();
  assert.equal(results[0].id, "x");
});
