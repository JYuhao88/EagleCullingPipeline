import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRulesRouter } from "../src/server/rules-routes.js";

const read = async (name) => JSON.parse(await readFile(new URL(`../src/rules/${name}`, import.meta.url), "utf8"));
const evidence = (e) => {
  assert.match(e.bvid, /^BV[A-Za-z0-9]+$/);
  assert.ok(Number.isInteger(e.segment) && e.segment >= 0);
  assert.ok(Number.isFinite(e.t) && e.t >= 0);
  assert.ok(e.paraphrase.length > 0 && [...e.paraphrase].length <= 40);
  assert.equal(e.text, e.paraphrase);
  assert.ok(e.tier === null || typeof e.tier === "string");
  assert.match(e.frame, /^frames\/BV[A-Za-z0-9]+\/[A-Za-z0-9_-]+\.jpg$/);
  assert.ok(["issue", "praise"].includes(e.kind));
};

test("semantic portrait candidates have unique IDs and reviewable bounded evidence", async () => {
  const c = await read("candidates/portrait-v0.2-candidates.json");
  const libs = await Promise.all(["portrait.json", "general.json", "candidates/xhs-candidates.json"].map(read));
  const known = new Set(libs.flatMap((l) => l.rules.map((r) => r.id)));
  const ids = new Set();
  assert.equal(c.contractVersion, 1);
  assert.equal(c.library, "portrait");
  assert.equal(c.extractionStatus, "complete");
  assert.equal(c.inputSegments, 6651);
  assert.equal(c.extractedSegments, c.inputSegments);
  assert.ok(c.rules.length >= 30 && c.rules.length <= 60);
  let previous = Infinity;
  for (const r of c.rules) {
    assert.match(r.id, /^P(-[A-Z0-9]+)+$/);
    assert.ok(!known.has(r.id) && !ids.has(r.id), r.id);
    ids.add(r.id);
    assert.ok(r.title && r.aspect && r.statement.length <= 80);
    assert.equal(r.status, "proposed");
    assert.equal(r.source, "yidao-critiques");
    assert.equal(r.severity, "hint");
    assert.ok(Array.isArray(r.exceptions));
    assert.ok(["negative", "positive"].includes(r.polarity));
    assert.ok(["teacher", "measure"].includes(r.check.by));
    if (r.check.by === "measure") assert.ok(r.check.signal);
    assert.ok(r.frequency.episodes >= 2 || r.inclusionReason);
    assert.ok(r.frequency.episodes <= previous);
    previous = r.frequency.episodes;
    assert.equal(r.frequency.episodes, r.frequency.videos);
    assert.ok(r.frequency.segments >= r.frequency.episodes);
    assert.equal(r.tierContrast.low + r.tierContrast.high + r.tierContrast.unknown, r.frequency.segments);
    assert.ok(r.evidence.length > 0 && r.evidence.length <= 4);
    r.evidence.forEach(evidence);
  }
  const index = await read("candidates/portrait-synthesis-index.json");
  const entries = new Map(index.entries.map((e) => [e.paraphrase, e.assignments]));
  assert.equal(entries.size, index.entries.length);
  for (const [text, assignments] of entries) {
    assert.ok([...text].length <= 40);
    assert.ok(assignments.length > 0);
    for (const id of assignments)
      assert.ok(known.has(id) || ids.has(id) || id.startsWith("NS:") || ["vague", "unresolved"].includes(id), id);
  }
  for (const r of c.rules) for (const e of r.evidence) assert.ok(entries.get(e.paraphrase).includes(r.id));
  assert.deepEqual(entries.get("构图不佳"), ["vague"]);
  assert.deepEqual(entries.get("构图很差"), ["vague"]);
  assert.deepEqual(entries.get("背景和肤色不应全局一起调整"), ["NS:RETOUCH-COLOR"]);
  assert.ok(entries.get("鼻影向上，鼻孔被照亮").includes("P-LIGHT-SHAPE"));
  const s = c.synthesis;
  assert.equal(s.method, "codex-semantic");
  assert.equal(s.filteredVague + s.nonSelectionCount + s.unresolvedConcrete + s.selectionCount, s.commentaryItems);
  assert.ok(Math.abs(s.filteredVague / s.commentaryItems - s.filteredVagueRatio) < 0.000001);
});

test("mapped evidence references existing libraries; non-selection topics stay separate", async () => {
  const [e, n, c, ...libs] = await Promise.all([
    "candidates/existing-evidence.json", "candidates/portrait-non-selection.json", "candidates/portrait-v0.2-candidates.json",
    "portrait.json", "general.json", "candidates/xhs-candidates.json",
  ].map(read));
  const known = new Set(libs.flatMap((l) => l.rules.map((r) => r.id)));
  const ids = new Set();
  for (const r of e.rules) {
    assert.ok(known.has(r.id) && !ids.has(r.id));
    ids.add(r.id);
    r.evidence.forEach(evidence);
    assert.ok(r.representatives.length <= 4);
  }
  assert.equal(e.rules.reduce((sum, r) => sum + r.evidence.length, 0), c.synthesis.mappedEvidenceAssignments);
  assert.ok(n.nonSelection.length >= 10 && n.nonSelection.length <= 30);
  assert.equal(n.nonSelectionCount, c.synthesis.nonSelectionCount);
  for (const r of n.nonSelection) {
    assert.ok(r.title && r.statement && r.frequency.episodes > 0);
    assert.ok(r.evidence.length > 0 && r.evidence.length <= 2);
    r.evidence.forEach(evidence);
  }
});

test("review API exposes cross-library evidence without adding those rules to portrait export", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portrait-synthesis-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/rules/candidates"), { recursive: true });
  const put = (file, data) => writeFile(path.join(root, "src/rules", file), JSON.stringify(data));
  await put("portrait.json", { rules: [{ id: "P-ORIGINAL" }], version: "0.1.0" });
  await put("general.json", { rules: [{ id: "G-REFERENCE", statement: "已有规则" }] });
  await put("candidates/existing-evidence.json", { rules: [{ id: "G-REFERENCE", evidence: [{ paraphrase: "背景干扰" }] }] });
  const router = createRulesRouter({ projectRoot: root });
  const call = async (url, method = "GET") => {
    let status, body;
    await router({ url: `/rules/${url}`, method }, { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } });
    assert.equal(status, 200);
    return body;
  };
  const data = await call("data");
  assert.deepEqual(data.existingIds, ["P-ORIGINAL"]);
  assert.equal(data.referenceRules[0].id, "G-REFERENCE");
  assert.equal(data.referenceRules[0].evidence[0].paraphrase, "背景干扰");
  assert.equal(data.referenceRules[0].status, "reference");
  const exported = await call("export", "POST");
  assert.deepEqual(exported.draft.rules.map((r) => r.id), ["P-ORIGINAL"]);
});
