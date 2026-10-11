import test from "node:test";
import assert from "node:assert/strict";
import {
  auc,
  evaluateSessions,
  evaluatePicks,
  starTruth,
  tagTruth,
  folderTruth,
  anyTruth,
  allTruth,
  parseTruth,
  formatMarkdown,
} from "../src/core/pick-eval.js";
import { parseArgs } from "../scripts/eval-picks.mjs";
const options = {
  bootstrap: 30,
  randomIterations: 50,
  budgets: [0.5, 1],
  seed: 42,
};
function sample() {
  return {
    items: ["a", "b", "c", "d"].map((id, i) => ({
      id,
      name: `${id}.jpg`,
      captureTime: [3, 4, 1, 2][i],
      star: id === "a" ? 4 : 0,
      tags: id === "c" ? ["good"] : [],
      folders: id === "d" ? ["f"] : [],
    })),
    units: ["a", "b", "c", "d"].map((id) => ({
      id,
      primaryItemId: id,
      itemIds: [id],
    })),
    groups: [
      {
        id: "g1",
        unitIds: ["a", "b"],
        ranking: [
          { unitId: "a", score: 4, rank: 1 },
          { unitId: "b", score: 3, rank: 2 },
        ],
        suggested: { a: "selected", b: "rejected" },
      },
      {
        id: "g2",
        unitIds: ["c", "d"],
        ranking: [
          { unitId: "d", score: 2, rank: 1 },
          { unitId: "c", score: 1, rank: 2 },
        ],
        suggested: { c: "rejected", d: "candidate" },
      },
    ],
    results: ["a", "b", "c", "d"].map((unitId, i) => ({
      unitId,
      metrics: {
        sharpness: [4, 3, 1, 2][i],
        quality: [4, 3, 1, 2][i],
        exposure: 1,
        faces: 1,
        eyesClosed: 0,
      },
      signals: { pose: i, missing: null, text: "no" },
    })),
  };
}
const fixture = {
  session: "小样",
  allStems: ["a", "b", "c", "d"],
  selectedStems: ["a", "c"],
};
test("AUC ties, reversed ordering and absent classes", () => {
  assert.equal(auc([1], [1]), 0.5);
  assert.equal(auc([2], [1]), 1);
  assert.equal(auc([1], [2]), 0);
  assert.equal(auc([], [1]), null);
});
test("metrics, global budget and grouped browse order", () => {
  const r = evaluatePicks(sample(), fixture, options),
    m = r.model;
  assert.equal(m.falseRejectionRate, 0.5);
  assert.deepEqual(m.budgetRecall, { 0.5: 0.5, 1: 1 });
  assert.deepEqual(m.browse, { count: 4, fraction: 1 });
  assert.equal(m.auc.rankingScore, 0.5);
  for (const key of ["sharpness", "quality", "exposure", "faces", "eyesOpen"])
    assert.equal(m.auc[key], 0.5);
  assert.equal(m.auc["signals.pose"], 0.25);
  assert.ok(!("signals.text" in m.auc));
  assert.ok(!("aesthetic" in m.auc));
  assert.deepEqual(m.top1, { hits: 1, total: 2, rate: 0.5 });
  assert.deepEqual(m.selected, { count: 1, precision: 1, recall: 0.5 });
  assert.deepEqual(m.kept, {
    count: 2,
    recall: 0.5,
    picksSuggestedRejected: 1,
  });
  // Group priority differs from global score order when groups interleave.
  const d = sample();
  d.groups[1].ranking[1].score = 3.5;
  assert.equal(evaluatePicks(d, fixture, options).model.budgetRecall["0.5"], 1);
  assert.equal(evaluatePicks(d, fixture, options).model.browse.count, 4);
  assert.equal(evaluatePicks(d, fixture, options).model.top1.rate, 0.5);
});
test("baselines: capture time, filename fallback, random expectation and quotas", () => {
  const r = evaluatePicks(sample(), fixture, {
    ...options,
    bootstrap: 1,
    randomIterations: 2000,
  });
  assert.equal(r.time.browse.count, 3);
  assert.equal(r.filename.browse.count, 3);
  assert.equal(r.time.auc.rankingScore, 0.75);
  assert.equal(r.time.top1.rate, 1);
  assert.ok(Math.abs(r.random.budgetRecall["0.5"] - 0.5) < 0.04);
  assert.ok(Math.abs(r.random.browse.count - 10 / 3) < 0.08);
  assert.ok(Math.abs(r.random.auc.rankingScore - 0.5) < 0.04);
  assert.ok(Math.abs(r.random.top1.rate - 0.5) < 0.04);
  assert.equal(r.random.selected.count, 1);
  assert.equal(r.random.kept.count, 2);
  const d = sample();
  d.items.forEach((x) => delete x.captureTime);
  const fallback = evaluatePicks(d, fixture, options);
  assert.deepEqual(fallback.time, fallback.filename);
});
test("group bootstrap is reproducible, has intervals on every metric, and preserves clusters", () => {
  const a = evaluatePicks(sample(), fixture, options),
    b = evaluatePicks(sample(), fixture, options);
  assert.deepEqual(a, b);
  assert.equal(a.model.ci["browse.count"].samples, 30);
  assert.deepEqual(
    [a.model.ci["kept.count"].low, a.model.ci["kept.count"].high],
    [2, 2],
  );
  assert.deepEqual(
    [
      a.model.ci["falseRejectionRate"].low,
      a.model.ci["falseRejectionRate"].high,
    ],
    [0, 1],
  );
  assert.ok(a.model.ci["auc.signals.pose"]);
  assert.notDeepEqual(
    a,
    evaluatePicks(sample(), fixture, { ...options, seed: 43 }),
  );
});
test("truth predicates combine and inspect paired run items without reading Eagle", () => {
  const item = { star: 4, tags: ["精选"], folders: ["f"] };
  assert.ok(starTruth(4)(item));
  assert.ok(tagTruth("精选")(item));
  assert.ok(folderTruth("f")(item));
  assert.ok(anyTruth(starTruth(5), tagTruth("精选"))(item));
  assert.ok(allTruth(starTruth(4), folderTruth("f"))(item));
  assert.equal(parseTruth("star>=5")(item), false);
  assert.throws(() => parseTruth("bad"));
  const d = sample();
  d.items.push({ id: "raw", star: 5, tags: ["good"], folders: ["f"] });
  d.units[0].itemIds.push("raw");
  assert.equal(
    evaluatePicks(d, undefined, {
      ...options,
      truth: ["star>=5", "tag=good", "folder=f"],
    }).picks,
    1,
  );
  assert.equal(
    evaluatePicks(d, fixture, { ...options, truth: ["tag=good"] }).picks,
    2,
  );
});
test("new top1 excludes multi-pick groups; legacy retained; scope filters groups", () => {
  const r = evaluatePicks(
    sample(),
    { ...fixture, selectedStems: ["a", "b", "c"] },
    options,
  );
  assert.equal(r.model.top1.total, 1);
  assert.equal(r.model.top1.hits, 0);
  assert.equal(r.legacyTop1.total, 2);
  assert.equal(r.legacyTop1.hits, 1);
  const filtered = evaluatePicks(
    sample(),
    { ...fixture, allStems: ["a", "c"] },
    options,
  );
  assert.equal(filtered.groups.multi, 0);
  assert.equal(filtered.model.top1.rate, null);
});
test("summary merges units and isolates duplicate session/group ids", () => {
  const f2 = { ...fixture, allStems: ["a"], selectedStems: ["a"] };
  const r = evaluateSessions(
    [
      { data: sample(), fixture },
      { data: sample(), fixture: f2 },
    ],
    options,
  );
  assert.equal(r.summary.units, 5);
  assert.equal(r.summary.picks, 3);
  assert.equal(r.summary.groups.total, 3);
  assert.equal(r.summary.model.falseRejectionRate, 1 / 3);
  assert.equal(r.summary.model.kept.recall, 2 / 3);
  assert.equal(r.summary.model.budgetRecall["0.5"], 2 / 3);
  assert.match(formatMarkdown(r), /95% CI/);
});
test("empty populations and invalid options", () => {
  const r = evaluatePicks(
    sample(),
    { allStems: [], selectedStems: [] },
    options,
  );
  assert.equal(r.units, 0);
  assert.equal(r.model.browse.count, 0);
  assert.equal(r.model.falseRejectionRate, null);
  assert.throws(() => evaluateSessions([], options));
  assert.throws(() => evaluatePicks(sample(), fixture, { budgets: [1.1] }));
  assert.throws(() =>
    evaluatePicks(sample(), fixture, { randomIterations: 0 }),
  );
});
test("CLI repeated pairs, budgets and strict option errors", () => {
  const r = parseArgs([
    "--run",
    "one",
    "--fixture",
    "a.json",
    "--run",
    "two",
    "--fixture",
    "b.json",
    "--budget",
    ".3,.5",
    "--truth",
    "tag=good",
  ]);
  assert.equal(r.sessions.length, 2);
  assert.deepEqual(r.budgets, [0.3, 0.5]);
  assert.deepEqual(r.truth, ["tag=good"]);
  assert.throws(() => parseArgs(["--run", "../x"]));
  assert.throws(() => parseArgs(["--fixture", "a"]));
  assert.throws(() => parseArgs(["--run", "one", "--bootstrap", "0"]));
});

test("CLI loads relative config fixtures and writes JSON/Markdown for merged sessions", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(path.join(tmpdir(), "w1-eval-cli-"));
  try {
    await mkdir(path.join(root, "data/runs/a"), { recursive: true });
    await mkdir(path.join(root, "config"));
    await writeFile(
      path.join(root, "data/runs/a/results.json"),
      JSON.stringify(sample()),
    );
    await writeFile(
      path.join(root, "config/picks.json"),
      JSON.stringify(fixture),
    );
    await writeFile(
      path.join(root, "config/sessions.json"),
      JSON.stringify([
        { run: "a", fixture: "picks.json" },
        { run: "a", fixture: "picks.json" },
      ]),
    );
    const cli = path.resolve("scripts/eval-picks.mjs");
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        cli,
        "--config",
        "config/sessions.json",
        "--bootstrap",
        "5",
        "--random-iterations",
        "3",
        "--out",
        "out.json",
        "--md",
        "out.md",
      ],
      { cwd: root },
    );
    const r = JSON.parse(stdout);
    assert.equal(r.summary.units, 8);
    assert.equal(r.summary.picks, 4);
    assert.equal(r.sessions.length, 2);
    assert.equal(stdout, await readFile(path.join(root, "out.json"), "utf8"));
    assert.equal(stderr, await readFile(path.join(root, "out.md"), "utf8"));
    const truth = await promisify(execFile)(
      process.execPath,
      [
        cli,
        "--run",
        "a",
        "--truth",
        "star>=4",
        "--bootstrap",
        "5",
        "--random-iterations",
        "3",
      ],
      { cwd: root },
    );
    assert.equal(JSON.parse(truth.stdout).summary.picks, 1);
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, "--run", "a"], { cwd: root }),
      (error) => /显式 --truth/.test(error.stderr) && error.stdout === "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation does not mutate input snapshots, fixture or options", () => {
  const data = sample(),
    f = structuredClone(fixture),
    opts = structuredClone(options);
  const before = structuredClone({ data, f, opts });
  evaluatePicks(data, f, opts);
  assert.deepEqual({ data, f, opts }, before);
});


test("camera sample inventories require explicit truth and never infer picks from folders", async () => {
  const { readFile } = await import("node:fs/promises");
  const inventory = JSON.parse(await readFile(
    new URL("./fixtures/shantou-20260718-samples.json", import.meta.url), "utf8",
  ));
  assert.equal(inventory.kind, "unlabeled-camera-samples");
  assert.ok(!("selectedStems" in inventory));
  assert.equal(inventory.allStems.length, 253);
  assert.equal(inventory.folders[0].stems.length, 40);
  assert.equal(inventory.folders[0].meaning, "unknown-folder, not photographer picks");
  assert.throws(() => evaluatePicks(sample(), inventory, options), /直出样本清单不是真值/);
  assert.throws(() => evaluatePicks(sample(), undefined, options), /显式 --truth/);
  const scoped = { ...inventory, allStems: ["a", "b", "c", "d"] };
  assert.equal(evaluatePicks(sample(), scoped, { ...options, truth: ["star>=4"] }).picks, 1);
});
