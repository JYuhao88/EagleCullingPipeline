import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from "node:fs/promises";
import { createRulesRouter, validateRulePatch } from "../src/server/rules-routes.js";

const rule = (id) => ({
  id,
  title: "背景简洁",
  statement: "背景避开干扰",
  aspect: "framing",
  severity: "penalty",
  check: { by: "teacher", signal: "background" },
  sources: ["test"],
  exceptions: [],
});
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rules-review-test-"));
  await mkdir(path.join(dir, "src/rules/candidates"), { recursive: true });
  await mkdir(path.join(dir, "src/plugin"), { recursive: true });
  for (const ext of ["html", "js", "css"])
    await copyFile(
      new URL(`../src/plugin/rules-review.${ext}`, import.meta.url),
      path.join(dir, `src/plugin/rules-review.${ext}`),
    );
  const seed = { contractVersion: 1, library: "portrait", version: "0.1.0", rules: [rule("P-BACKGROUND")] };
  await writeFile(path.join(dir, "src/rules/portrait.json"), JSON.stringify(seed));
  await writeFile(
    path.join(dir, "src/rules/candidates/portrait-v0.2-candidates.json"),
    JSON.stringify({
      rules: ["P-CAND-ONE", "P-CAND-TWO"].map((id) => ({
        ...rule(id),
        status: "proposed",
        evidence: [{ bvid: "BV1TxLV6oE88", t: 12, text: "背景干扰人物", tier: "拉" }],
      })),
    }),
  );
  const router = createRulesRouter({ projectRoot: dir });
  const server = http.createServer(async (req, res) => {
    if (!(await router(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/rules/${route}`,
      body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
    return { status: response.status, body: await response.json() };
  };
  return { dir, seed, call };
}

test("rules review validates editable fields", () => {
  assert.throws(() => validateRulePatch({ severity: "critical" }), /severity/);
  assert.throws(() => validateRulePatch({ statement: "" }), /statement/);
  assert.throws(() => validateRulePatch({ check: { by: "teacher", signal: "changed" } }), /check.by/);
  assert.throws(() => validateRulePatch({ id: "P-INJECT" }), /unsupported/);
  assert.throws(() => validateRulePatch({ exceptions: [null] }), /exceptions/);
  assert.deepEqual(validateRulePatch({ severity: "hint", exceptions: ["特写除外"] }), {
    severity: "hint",
    exceptions: ["特写除外"],
  });
});

test("review API appends decisions concurrently and exports approved draft without modifying seed", async (t) => {
  const { dir, seed, call } = await setup(t);
  assert.equal((await call("data")).body.rules.length, 3);
  const results = await Promise.all([
    call("decisions", {
      ruleId: "P-CAND-ONE",
      action: "modify",
      patch: {
        statement: "背景要避免抢主体",
        severity: "gate",
        check: { by: "measure+teacher" },
        exceptions: ["环境叙事除外"],
      },
    }),
    call("decisions", { ruleId: "P-CAND-TWO", action: "approve" }),
  ]);
  assert.ok(results.every((result) => result.status === 200));
  assert.ok(results.every((result) => !Number.isNaN(Date.parse(result.body.decision.timestamp))));
  await call("decisions", { ruleId: "P-CAND-TWO", action: "delete" });
  const decisions = JSON.parse(await readFile(path.join(dir, "src/rules/review/decisions.json"), "utf8"));
  assert.equal(decisions.length, 3);
  const exported = await call("export", {});
  assert.equal(exported.status, 200);
  assert.equal(exported.body.draft.version, "0.2.0");
  assert.equal(exported.body.draft.rules.length, 2);
  const candidate = exported.body.draft.rules.find((rule) => rule.id === "P-CAND-ONE");
  assert.equal(candidate.statement, "背景要避免抢主体");
  assert.equal(candidate.check.signal, "background");
  assert.equal(candidate.check.by, "measure+teacher");
  assert.equal(candidate.status, undefined);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "src/rules/portrait.json"), "utf8")), seed);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, exported.body.path), "utf8")),
    exported.body.draft,
  );
});

test("review merges evidence into existing rule and rejects bad or stale decisions", async (t) => {
  const { call } = await setup(t);
  for (const body of [
    { ruleId: "missing", action: "approve" },
    { ruleId: "P-CAND-ONE", action: "invent" },
    { ruleId: "P-CAND-ONE", action: "modify", patch: { severity: "invalid" } },
    { ruleId: "P-CAND-ONE", action: "merge", targetId: "P-CAND-TWO" },
    { ruleId: "P-CAND-ONE", action: "approve", timestamp: "forged" },
  ])
    assert.equal((await call("decisions", body)).status, 400);
  assert.equal(
    (await call("decisions", { ruleId: "P-CAND-ONE", action: "merge", targetId: "P-BACKGROUND" })).status,
    200,
  );
  assert.equal((await call("decisions", { ruleId: "P-CAND-ONE", action: "approve" })).status, 400);
  const draft = (await call("export", {})).body.draft;
  assert.equal(draft.rules.length, 1);
  assert.equal(draft.rules[0].evidence.length, 1);
  assert.equal((await call("frames/%2E%2E%2Fportrait.json")).status, 400);
  assert.equal((await call("frames/missing.jpg")).status, 404);
});

test("review serves independent page assets, existing evidence and safely contained thumbnails", async (t) => {
  const { call, dir } = await setup(t);
  const frameDir = path.join(dir, "data/rules-review/frames/BV1TxLV6oE88");
  await mkdir(frameDir, { recursive: true });
  await writeFile(path.join(frameDir, "1.jpg"), "jpeg fixture");
  await symlink(path.join(dir, "src/rules/portrait.json"), path.join(frameDir, "2.jpg"));
  await writeFile(
    path.join(dir, "src/rules/candidates/existing-evidence.json"),
    JSON.stringify({
      rules: [
        {
          id: "P-BACKGROUND",
          evidence: [{ bvid: "BV1TxLV6oE88", segment: 1, text: "背景干扰" }],
          frequency: { segments: 1, videos: 1 },
        },
      ],
    }),
  );
  const state = (await call("data")).body;
  assert.equal(state.rules.find((rule) => rule.id === "P-BACKGROUND").evidence.length, 1);
  assert.deepEqual(state.existingIds, ["P-BACKGROUND"]);
  assert.equal((await call("frames/BV1TxLV6oE88/2.jpg")).status, 400);
  assert.equal((await call("frames/BV1TxLV6oE88/../2.jpg")).status, 404);
  const router = createRulesRouter({ projectRoot: dir });
  async function resource(url) {
    let status, body;
    const res = {
      writeHead(code) {
        status = code;
      },
      end(value) {
        body = value?.toString();
      },
    };
    await router({ method: "GET", url }, res);
    return { status, body };
  }
  for (const route of ["review", "rules-review.js", "rules-review.css"])
    assert.equal((await resource(`/rules/${route}`)).status, 200);
  assert.match((await resource("/rules/review")).body, /rules-review\.js/);
  assert.equal((await resource("/rules/frames/BV1TxLV6oE88/1.jpg")).body, "jpeg fixture");
});

test("wulin API exposes mapped references and candidates, keeps exports separate from portrait", async (t) => {
  const { dir, call } = await setup(t);
  const evidence = { bvid: "BVWulin123", segment: 7, t: 42, frame: "frames/BVWulin123/0007.jpg", paraphrase: "边缘亮点分散注意", kind: "issue" };
  const candidates = { source: "wulin-critiques", rules: [
    { ...rule("L-WL-EDGE"), library: "landscape", source: "wulin-critiques",
      severity: "hint", status: "proposed", supportEpisodes: 4, supportSegments: 6,
      evidence: [evidence] },
    { ...rule("S-WL-RELATION"), library: "street", source: "wulin-critiques",
      severity: "hint", status: "proposed", supportEpisodes: 3, supportSegments: 4,
      evidence: [evidence] },
  ] };
  const mapped = { source: "wulin-critiques", rules: [{ id: "L-EDGE", frequency: { episodes: 5, segments: 8 }, evidence: [evidence] }] };
  await writeFile(path.join(dir, "src/rules/landscape.json"), JSON.stringify({ library: "landscape", rules: [rule("L-EDGE")] }));
  await writeFile(path.join(dir, "src/rules/candidates/landscape-street-v0.2-candidates.json"), JSON.stringify(candidates));
  await writeFile(path.join(dir, "src/rules/candidates/wulin-evidence.json"), JSON.stringify(mapped));
  // An existing teacher's evidence must survive addition of a second teacher.
  await writeFile(path.join(dir, "src/rules/candidates/existing-evidence.json"), JSON.stringify({ rules: [
    { id: "L-EDGE", evidence: [{ ...evidence, bvid: "BVYidao123", source: "yidao-critiques" }] },
  ] }));
  const state = (await call("data")).body;
  assert.equal(state.rules.length, 5);
  assert.deepEqual(state.wulinCandidates, candidates);
  assert.deepEqual(state.wulinEvidence, mapped);
  const reference = state.referenceRules.find(item => item.id === "L-EDGE");
  assert.equal(reference.status, "reference");
  assert.equal(reference.library, "landscape");
  assert.equal(reference.evidence.length, 2);
  assert.equal(reference.wulinEvidence[0].source, "wulin-critiques");
  assert.deepEqual(reference.wulinFrequency, { episodes: 5, segments: 8 });
  assert.equal((await call("decisions", { ruleId: "L-EDGE", action: "approve" })).status, 400);
  assert.equal((await call("decisions", { ruleId: "L-WL-EDGE", action: "merge", targetId: "P-BACKGROUND" })).status, 400);
  for (const ruleId of ["L-WL-EDGE", "S-WL-RELATION"])
    assert.equal((await call("decisions", { ruleId, action: "approve" })).status, 200);
  const exported = (await call("export", {})).body;
  assert.deepEqual(exported.draft.rules.map(item => item.id), ["P-BACKGROUND"]);
  assert.deepEqual(exported.bookDrafts, {});
  assert.deepEqual(exported.paperDrafts, {});
  assert.deepEqual(Object.keys(exported.wulinDrafts), ["landscape", "street"]);
  assert.equal(exported.wulinDrafts.landscape.rules[0].id, "L-WL-EDGE");
  assert.equal(exported.wulinDrafts.street.rules[0].id, "S-WL-RELATION");
  assert.equal(exported.wulinDrafts.street.rules[0].status, undefined);
});

test("wulin filter combines status/aspect and browser renders representative thumbnail", async () => {
  const { default: vm } = await import("node:vm");
  class Element {
    constructor(tag, text = "", value = "") { this.tag = tag; this.textContent = text; this.value = value; this.children = []; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const nodes = new Map(["message", "version", "aspect", "status", "source", "list", "detail", "export"].map(id => [id, new Element(id)]));
  const evidence = { bvid: "BVWulin123", segment: 7, t: 42, frame: "frames/BVWulin123/0007.jpg", paraphrase: "边缘亮点分散注意" };
  const data = { version: "0.1.0", rules: [
    { ...rule("P-OTHER"), status: "existing" },
    { ...rule("L-WL-EDGE"), source: "wulin-critiques", library: "landscape",
      status: "proposed", supportEpisodes: 4, supportSegments: 6, evidence: [evidence],
      bookEvidence: [{ bookSlug: "book", paraphrase: "边缘注意" }] },
  ], referenceRules: [{ ...rule("L-EDGE"), library: "landscape", status: "reference", wulinEvidence: [evidence], evidence: [evidence] }] };
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) },
    location: { protocol: "http:" }, Option: class extends Element { constructor(text, value) { super("option", text, value); } },
    fetch: async () => ({ ok: true, json: async () => data }), setTimeout,
  });
  vm.runInContext(await readFile(new URL("../src/plugin/rules-review.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  nodes.get("source").value = "wulin"; nodes.get("source").onchange();
  assert.deepEqual(nodes.get("list").children.map(node => node.textContent), ["背景简洁", "背景简洁"]);
  nodes.get("status").value = "proposed"; nodes.get("status").onchange();
  assert.equal(nodes.get("list").children.length, 1);
  nodes.get("aspect").value = "pose"; nodes.get("aspect").onchange();
  assert.equal(nodes.get("list").children.length, 0);
  nodes.get("aspect").value = ""; nodes.get("aspect").onchange();
  nodes.get("list").children[0].onclick();
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const detail = descendants(nodes.get("detail"));
  assert.equal(detail.find(node => node.tag === "img").src, "/rules/frames/BVWulin123/0007.jpg");
  assert.equal(detail.find(node => node.tag === "a").href, "https://www.bilibili.com/video/BVWulin123?t=42");
  assert.equal(detail.find(node => node.tag === "button" && node.textContent === "合并").disabled, true);
  assert.ok(detail.some(node => node.textContent.includes("单独下载武林草案")));
  assert.equal(nodes.get("message").textContent, "");
});

test("consolidation metadata never becomes decisions or exported rules", async (t) => {
  const { dir, call } = await setup(t);
  assert.equal((await call("data")).body.consolidatedReview, null);
  const consolidated = { isSuggestion: true, entries: [{
    id: "P-CAND-TWO", aliases: ["P-CAND-ONE"], mergeReason: "同一背景判断", recommendation: "approve",
    priority: { rank: 1, score: 85 },
  }], formalRules: [
    { id: "P-BACKGROUND", aliases: [], priority: { rank: 2, score: 70 } },
    { id: "L-REFERENCE", aliases: [], priority: { rank: 3, score: 60 } },
  ] };
  await writeFile(path.join(dir, "src/rules/landscape.json"), JSON.stringify({
    library: "landscape", rules: [rule("L-REFERENCE")],
  }));
  await writeFile(path.join(dir, "src/rules/candidates/existing-evidence.json"), JSON.stringify({ rules: [
    { id: "L-REFERENCE", evidence: [{ bvid: "BVReference123", segment: 1, text: "背景干扰" }] },
  ] }));
  await writeFile(path.join(dir, "src/rules/candidates/consolidated-review.json"), JSON.stringify(consolidated));
  const state = (await call("data")).body;
  assert.deepEqual(state.consolidatedReview, consolidated);
  assert.deepEqual(state.decisions, []);
  assert.equal(state.rules.find(item => item.id === "P-CAND-ONE").reviewSuggestion.mainId, "P-CAND-TWO");
  assert.equal(state.rules.find(item => item.id === "P-CAND-ONE").reviewSuggestion.isAlias, true);
  assert.equal(state.rules.find(item => item.id === "P-CAND-TWO").reviewSuggestion.rank, 1);
  assert.equal(state.rules.find(item => item.id === "P-BACKGROUND").reviewSuggestion.isSuggestion, true);
  assert.equal(state.referenceRules.find(item => item.id === "L-REFERENCE").reviewSuggestion.rank, 3);
  assert.equal((await call("decisions", {
    ruleId: "P-CAND-ONE", action: "merge", targetId: "P-CAND-TWO",
  })).status, 400);
  assert.equal((await call("decisions", { ruleId: "P-CAND-TWO", action: "approve" })).status, 200);
  const decisions = JSON.parse(await readFile(path.join(dir, "src/rules/review/decisions.json"), "utf8"));
  assert.deepEqual(Object.keys(decisions[0]).sort(), ["action", "ruleId", "timestamp"]);
  const draft = (await call("export", {})).body.draft;
  assert.ok(draft.rules.every(item => !item.reviewSuggestion));
});

test("priority browser sorting displays advisory merges without posting decisions", async () => {
  const { default: vm } = await import("node:vm");
  class Element {
    constructor(tag, text = "", value = "") {
      this.tag = tag; this.textContent = text; this.value = value; this.children = [];
    }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const ids = ["message", "version", "aspect", "status", "source", "sort", "list", "detail", "export"];
  const nodes = new Map(ids.map(id => [id, new Element(id)]));
  nodes.get("sort").value = "priority";
  const data = { version: "0.1.0", rules: [
    { ...rule("P-FREQUENT"), title: "高频", status: "proposed", frequency: { videos: 20 } },
    { ...rule("P-MAIN"), title: "主条目", status: "proposed", reviewSuggestion: {
      isSuggestion: true, mainId: "P-MAIN", aliases: ["P-ALIAS"], rank: 1,
      recommendation: "approve", mergeReason: "同一背景判断",
    } },
    { ...rule("P-ALIAS"), title: "别名", status: "proposed", reviewSuggestion: {
      isSuggestion: true, mainId: "P-MAIN", aliases: ["P-ALIAS"], rank: 1, isAlias: true, recommendation: "merge",
    } },
  ] };
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) },
    location: { protocol: "http:" },
    Option: class extends Element { constructor(text, value) { super("option", text, value); } },
    fetch: async (url, options) => {
      requests.push({ url, options }); return { ok: true, json: async () => data };
    }, setTimeout,
  });
  vm.runInContext(await readFile(new URL("../src/plugin/rules-review.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nodes.get("list").children.map(node => node.textContent), ["主条目", "别名", "高频"]);
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  assert.ok(descendants(nodes.get("detail")).some(node => node.textContent === "归并建议（非审核决定）"));
  nodes.get("list").children[1].onclick();
  assert.ok(descendants(nodes.get("detail")).some(node => node.textContent === "建议并入主条目：P-MAIN"));
  assert.ok(descendants(nodes.get("detail")).some(node => node.textContent.includes("候选间归并仅展示建议")));
  nodes.get("sort").value = "frequency"; nodes.get("sort").onchange();
  assert.equal(nodes.get("list").children[0].textContent, "高频");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, undefined);
});
