import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, copyFile } from "node:fs/promises";
import { createRulesRouter, validateRulePatch, applyRuleDecisions } from "../src/server/rules-routes.js";

const script = await readFile(new URL("../src/plugin/rules-review.js", import.meta.url), "utf8");
const rule = (id, extra = {}) => ({
  id, title: id, statement: "背景避开干扰", aspect: "framing", severity: "hint",
  check: { by: "teacher", signal: "background" }, sources: ["test"], exceptions: [], ...extra,
});
const portrait = (id) => ({ contractVersion: 1, library: "portrait", version: "0.1.0", rules: [rule(id)] });
const book = { slug: "sample", title: "合成书", author: "测试", format: "epub" };
const bookEv = (locator, extra = {}) => ({ bookSlug: "sample", locator, paraphrase: "主体关系清楚", ...extra });
const paper = { slug: "sample", title: "合成论文", year: 2020, channel: "test", docType: "article" };
const paperEv = (slug = "sample", locator = "段落2") => ({ paperSlug: slug, locator, kind: "source", paraphrase: "主体关系清楚" });
const course = { slug: "sample", title: "合成课程", source: "test-source", episodes: 3 };
const courseEv = (episode = 1, extra = {}) => ({
  courseSlug: "sample", locator: { source: "test-source", episode, start: 65, end: 95 },
  kind: "source", paraphrase: "测试转述", ...extra,
});
const fixtures = {
  video: () => ({
    "portrait.json": portrait("P-BACKGROUND"),
    "candidates/portrait-v0.2-candidates.json": { rules: ["P-CAND-ONE", "P-CAND-TWO"].map((id) => rule(id, {
      status: "proposed", evidence: [{ bvid: "BV1TxLV6oE88", t: 12, text: "背景干扰人物", tier: "拉" }],
    })) },
  }),
  book: (withBooks = true) => ({
    "portrait.json": portrait("P-ONE"),
    "candidates/portrait-v0.2-candidates.json": { rules: [rule("P-VIDEO", {
      status: "proposed", evidence: [{ bvid: "BVTEST", segment: 1, text: "背景干扰" }],
    })] },
    ...Object.fromEntries(["general", "landscape", "street"].map((library) =>
      [`${library}.json`, { library, rules: [rule(`${library}-ONE`)] }])),
    "candidates/xhs-candidates.json": { rules: [rule("XHS-ONE")] },
    ...(withBooks && {
      "candidates/book-candidates.json": { contractVersion: 1, books: [book], rules: [
        rule("BOOK-P", { library: "portrait", status: "proposed", source: "book:sample", evidence: [bookEv("第一讲"), bookEv("第二讲")] }),
        rule("BOOK-G", { library: "general", status: "proposed", source: "book:sample", evidence: [bookEv("第三讲")] }),
      ] },
      "candidates/book-evidence.json": { contractVersion: 1, books: [book], evidence:
        ["P-ONE", "P-VIDEO", "general-ONE", "landscape-ONE", "street-ONE", "XHS-ONE"].map((ruleId, i) =>
          bookEv(`第${i + 1}讲`, { ruleId, kind: i % 2 ? "exception" : "source" })) },
    }),
  }),
  paper: () => {
    const papers = [paper, { ...paper, slug: "second", title: "第二篇" }];
    return {
      "portrait.json": portrait("P-ONE"),
      "candidates/portrait-v0.2-candidates.json": { rules: [rule("P-YD-ONE", { status: "proposed" })] },
      "street.json": { library: "street", rules: [rule("S-ONE")] },
      "candidates/xhs-candidates.json": { rules: [rule("X-ONE")] },
      "candidates/book-candidates.json": { books: [], rules: [
        rule("BOOK-S", { library: "street", source: "book:sample", status: "proposed" }),
      ] },
      "candidates/paper-candidates.json": { contractVersion: 1, papers, rules: [
        rule("P-PAPER", { library: "portrait", source: "paper", status: "proposed", evidence: [paperEv(), paperEv("second")] }),
        rule("S-PAPER", { library: "street", source: "paper", status: "proposed", evidence: [paperEv()] }),
      ] },
      "candidates/paper-evidence.json": { contractVersion: 1, papers, evidence: ["P-ONE", "P-YD-ONE", "S-ONE", "X-ONE"]
        .map((ruleId) => ({ ...paperEv(), ruleId, supportCount: 2, supports: [paperEv(), paperEv("second", "段落4")] })) },
    };
  },
  course: () => ({
    "portrait.json": portrait("P-ONE"),
    "general.json": { library: "general", rules: [rule("G-ONE")] },
    "candidates/portrait-v0.2-candidates.json": { rules: [rule("P-YD", { status: "proposed" })] },
    "candidates/course-candidates.json": { contractVersion: 1, rules: [
      rule("P-COURSE", { source: "course:sample", status: "proposed", evidence: [courseEv(1), courseEv(2)] }),
      rule("G-COURSE", { library: "general", source: "course:sample", status: "proposed", evidence: [courseEv(1)] }),
    ] },
    "candidates/course-evidence.json": { contractVersion: 1, courses: [course], evidence:
      ["P-ONE", "P-YD", "G-ONE", "P-COURSE"].map((ruleId) => ({ ...courseEv(1), ruleId, supportCount: 3 })) },
  }),
};

async function setup(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rules-review-test-"));
  await mkdir(path.join(dir, "src/rules/candidates"), { recursive: true });
  await mkdir(path.join(dir, "src/plugin"), { recursive: true });
  for (const ext of ["html", "js", "css"])
    await copyFile(new URL(`../src/plugin/rules-review.${ext}`, import.meta.url), path.join(dir, `src/plugin/rules-review.${ext}`));
  const put = (name, value) => writeFile(path.join(dir, "src/rules", name), JSON.stringify(value));
  for (const [name, value] of Object.entries(files)) await put(name, value);
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
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  };
  const read = async (file) => JSON.parse(await readFile(path.join(dir, file), "utf8"));
  return { dir, call, put, read };
}

// Exercise the actual browser script with a minimal DOM, without a server or media access.
async function renderReview(data, sort = "") {
  class Element {
    constructor(tag, text = "", value = "") { this.tag = tag; this.textContent = text; this.value = value; this.children = []; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const ids = ["message", "version", "aspect", "status", "source", "sort", "list", "detail", "export"];
  const nodes = new Map(ids.map((id) => [id, new Element(id)]));
  nodes.get("sort").value = sort;
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag) },
    location: { protocol: "http:" },
    Option: class extends Element { constructor(text, value) { super("option", text, value); } },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method });
      return { ok: true, json: async () => data };
    },
    setTimeout,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const choose = (field, value) => { nodes.get(field).value = value; nodes.get(field).onchange(); };
  const listed = () => nodes.get("list").children.map((node) => node.textContent);
  return { nodes, requests, choose, listed, detail: () => descendants(nodes.get("detail")) };
}
const noMedia = (rendered) => assert.ok(!rendered.some((node) => node.tag === "img" || node.tag === "a"));

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
  const files = fixtures.video();
  const { call, read } = await setup(t, files);
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
  assert.equal((await read("src/rules/review/decisions.json")).length, 3);
  const exported = await call("export", {});
  assert.equal(exported.status, 200);
  assert.equal(exported.body.draft.version, "0.2.0");
  assert.equal(exported.body.draft.rules.length, 2);
  const candidate = exported.body.draft.rules.find((rule) => rule.id === "P-CAND-ONE");
  assert.equal(candidate.statement, "背景要避免抢主体");
  assert.equal(candidate.check.signal, "background");
  assert.equal(candidate.check.by, "measure+teacher");
  assert.equal(candidate.status, undefined);
  assert.deepEqual(await read("src/rules/portrait.json"), files["portrait.json"]);
  assert.deepEqual(await read(exported.body.path), exported.body.draft);
});

test("review merges evidence into existing rule and rejects bad or stale decisions", async (t) => {
  const { call } = await setup(t, fixtures.video());
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
  const { call, dir, put } = await setup(t, fixtures.video());
  const frameDir = path.join(dir, "data/rules-review/frames/BV1TxLV6oE88");
  await mkdir(frameDir, { recursive: true });
  await writeFile(path.join(frameDir, "1.jpg"), "jpeg fixture");
  await symlink(path.join(dir, "src/rules/portrait.json"), path.join(frameDir, "2.jpg"));
  await put("candidates/existing-evidence.json", { rules: [{
    id: "P-BACKGROUND",
    evidence: [{ bvid: "BV1TxLV6oE88", segment: 1, text: "背景干扰" }],
    frequency: { segments: 1, videos: 1 },
  }] });
  const state = (await call("data")).body;
  assert.equal(state.rules.find((rule) => rule.id === "P-BACKGROUND").evidence.length, 1);
  assert.deepEqual(state.existingIds, ["P-BACKGROUND"]);
  assert.equal((await call("frames/BV1TxLV6oE88/2.jpg")).status, 400);
  assert.equal((await call("frames/BV1TxLV6oE88/../2.jpg")).status, 404);
  for (const route of ["review", "review.js", "review.css", "rules-review.js", "rules-review.css"])
    assert.equal((await call(route)).status, 200, route);
  assert.match((await call("review")).body, /rules-review\.js/);
  assert.equal((await call("frames/BV1TxLV6oE88/1.jpg")).body, "jpeg fixture");
});

const sources = [
  {
    name: "book", files: fixtures.book, title: book.title, reference: "general-ONE",
    attached: ["P-ONE", "P-VIDEO", "general-ONE", "landscape-ONE", "street-ONE", "XHS-ONE"],
    data(body) {
      assert.equal(body.bookEvidence.evidence.length, 6);
      assert.equal(body.rules.length, 4);
      assert.deepEqual(body.existingIds, ["P-ONE"]);
      assert.equal(body.rules.find((r) => r.id === "BOOK-P").bookEvidence.length, 2);
      assert.ok(this.attached.every((id) => [...body.rules, ...body.referenceRules].find((r) => r.id === id).bookEvidence[0].locator));
    },
    crossMerge: "BOOK-G", approve: ["BOOK-P", "BOOK-G"], portraitId: "BOOK-P", draft: ["general", ["BOOK-G"]],
    exported(body) {
      assert.deepEqual(body.draft.rules.map((r) => r.id), ["P-ONE", "BOOK-P"]);
    },
    merge: "BOOK-P",
    merged(target) {
      assert.deepEqual(target.bookEvidence.map((e) => e.locator), ["第1讲", "第一讲", "第二讲"]);
      assert.ok(target.bookEvidence.every((e) => e.book.title === book.title));
    },
  },
  {
    name: "paper", files: fixtures.paper, title: paper.title, reference: "S-ONE",
    attached: ["P-ONE", "P-YD-ONE", "S-ONE", "X-ONE"],
    data(body) {
      assert.equal(body.paperEvidence.evidence.length, 4);
      for (const id of this.attached) {
        const [citation] = [...body.rules, ...body.referenceRules].find((r) => r.id === id).paperEvidence;
        assert.equal(citation.supportCount, 2);
        assert.equal(citation.supports[1].paper.title, "第二篇");
      }
      assert.equal(body.rules.find((r) => r.id === "P-PAPER").paperEvidence.length, 2);
    },
    crossMerge: "S-PAPER", approve: ["P-PAPER", "S-PAPER", "BOOK-S"], portraitId: "P-PAPER", draft: ["street", ["S-PAPER"]],
    exported(body) {
      assert.deepEqual(body.bookDrafts.street.rules.map((r) => r.id), ["BOOK-S"]);
    },
    merge: "P-PAPER",
    merged(target) {
      assert.deepEqual(target.paperEvidence.map((item) => item.paperSlug), ["sample", "second"]);
      assert.equal(target.paperEvidence[0].supportCount, 2);
      assert.equal(target.paperEvidence[0].supports[1].locator, "段落4");
      assert.ok(target.paperEvidence.every((item) => item.paper.title));
    },
  },
  {
    name: "course", files: fixtures.course, title: course.title, reference: "G-ONE",
    attached: ["P-ONE", "P-YD", "G-ONE"],
    data(body) {
      assert.equal(body.courseEvidence.courses[0].episodes, 3);
      for (const id of this.attached)
        assert.equal([...body.rules, ...body.referenceRules].find((r) => r.id === id).courseEvidence[0].supportCount, 3);
      assert.deepEqual(body.rules.find((r) => r.id === "P-COURSE").courseEvidence.map((e) => e.locator.episode), [1, 2]);
    },
    crossMerge: "G-COURSE", approve: ["P-COURSE", "G-COURSE"], portraitId: "P-COURSE", draft: ["general", ["G-COURSE"]],
    exported(body) {
      assert.deepEqual(body.bookDrafts, {});
    },
    merge: "P-COURSE",
    merged(target) {
      assert.deepEqual(target.courseEvidence.map((e) => e.locator.episode), [1, 2]);
      assert.equal(target.courseEvidence[0].supportCount, 3);
    },
  },
];

for (const source of sources) {
  const evidenceKey = `${source.name}Evidence`;
  test(`${source.name} data attaches located citations to seed, YD and read-only reference rules`, async (t) => {
    const { call } = await setup(t, source.files());
    const { status, body } = await call("data");
    assert.equal(status, 200);
    assert.equal(body[`${source.name}Candidates`].rules.length, 2);
    for (const id of source.attached) {
      const found = [...body.rules, ...body.referenceRules].find((r) => r.id === id);
      assert.equal(found[evidenceKey][0][source.name].title, source.title, id);
    }
    source.data(body);
    assert.ok(body.referenceRules.every((r) => r.status === "reference"));
    assert.equal((await call("decisions", { ruleId: source.reference, action: "approve" })).status, 400);
  });

  test(`${source.name} approvals export separate library drafts and never modify the formal seed`, async (t) => {
    const { call, dir, read } = await setup(t, source.files());
    const seedPath = path.join(dir, "src/rules/portrait.json");
    const before = await readFile(seedPath, "utf8");
    assert.equal((await call("decisions", { ruleId: source.crossMerge, action: "merge", targetId: "P-ONE" })).status, 400);
    for (const ruleId of source.approve)
      assert.equal((await call("decisions", { ruleId, action: "approve" })).status, 200, ruleId);
    const exported = (await call("export", {})).body;
    assert.ok(exported.draft.rules.some((r) => r.id === source.portraitId));
    const [library, ids] = source.draft;
    const drafts = exported[`${source.name}Drafts`][library].rules;
    assert.deepEqual(drafts.map((r) => r.id), ids);
    assert.equal(drafts[0].status, undefined);
    source.exported(exported);
    assert.equal(await readFile(seedPath, "utf8"), before);
    assert.deepEqual(await read(exported.path), exported.draft);
  });

  test(`${source.name} merge API keeps every locator after reload without counting video evidence`, async (t) => {
    const { call } = await setup(t, source.files());
    assert.equal((await call("decisions", { ruleId: source.merge, action: "merge", targetId: "P-ONE" })).status, 200);
    const state = (await call("data")).body;
    const target = state.rules.find((r) => r.id === "P-ONE");
    source.merged(target);
    assert.equal(target.frequency.videos, 0);
    assert.equal(target.frequency.segments, 0);
    assert.equal(state.rules.find((r) => r.id === source.merge).status, "merged");
  });
}

test("missing book files preserve existing review behavior", async (t) => {
  const { call } = await setup(t, fixtures.book(false));
  const { body } = await call("data");
  assert.equal(body.rules.length, 2);
  assert.deepEqual(body.referenceRules, []);
  assert.deepEqual(body.bookCandidates.rules, []);
  assert.deepEqual(body.bookEvidence.evidence, []);
});

test("merging preserves distinct book locators and associated exceptions without inflating video frequency", () => {
  const first = bookEv("第一讲");
  const second = bookEv("第二讲");
  const existing = rule("P", {
    evidence: [{ bvid: "BVTEST", segment: 1, text: "点评" }],
    bookEvidence: [bookEv("第三讲", { kind: "source" })],
  });
  const candidate = rule("B", { evidence: [first, second, first], bookEvidence: [bookEv("第四讲", { kind: "exception" })] });
  const merge = [{ ruleId: "B", action: "merge", targetId: "P" }];
  const [merged] = applyRuleDecisions({ rules: [existing] }, { rules: [candidate] }, merge);
  assert.equal(merged.evidence.length, 3);
  assert.equal(merged.bookEvidence.length, 2);
  assert.equal(merged.frequency.videos, 1);
  assert.equal(merged.frequency.segments, 1);
  const [bookOnly] = applyRuleDecisions({ rules: [rule("P")] }, { rules: [candidate] }, merge);
  assert.equal(bookOnly.frequency.videos, 0);
  assert.equal(bookOnly.frequency.segments, 0);
});

test("paper merge deduplicates by paper identity, unions locators and never counts paper evidence as video", () => {
  const merge = [{ ruleId: "P-PAPER", action: "merge", targetId: "P-ONE" }];
  const both = () => [paperEv(), paperEv("second")];
  const item = rule("P-PAPER", { status: "proposed", evidence: both(), paperEvidence: both() });
  const seed = rule("P-ONE", { evidence: [paperEv()], paperEvidence: [paperEv()] });
  const rows = applyRuleDecisions({ rules: [seed] }, { rules: [item] }, merge);
  assert.equal(rows[0].evidence.length, 2);
  assert.equal(rows[0].paperEvidence.length, 2);
  assert.equal(rows[0].frequency.videos, 0);
  assert.equal(rows[0].frequency.segments, 0);
  const left = { ...paperEv(), supportCount: 2, supports: [paperEv(), paperEv("second", "段落4")] };
  const right = { ...paperEv(), supportCount: 2, supports: [paperEv("sample", "段落3"), paperEv("third", "段落8")] };
  const [aggregated] = applyRuleDecisions({ rules: [rule("P-ONE", { paperEvidence: [left] })] },
    { rules: [rule("P-PAPER", { paperEvidence: [right] })] }, merge);
  assert.equal(aggregated.paperEvidence.length, 1);
  assert.equal(aggregated.paperEvidence[0].supportCount, 3);
  assert.deepEqual(aggregated.paperEvidence[0].supports.map((entry) => entry.locator), ["段落2", "段落4", "段落3", "段落8"]);
});

test("course citations merge equivalent locators but keep seasons, workbook pages and documents distinct", async (t) => {
  const { call, put } = await setup(t, fixtures.course());
  const evidence = (citations) => put("candidates/course-evidence.json", { contractVersion: 1, courses: [course], evidence: citations });
  const citations = async (id) => (await call("data")).body.rules.find((r) => r.id === id).courseEvidence;
  const primary = courseEv(1, { locator: { end: 95, start: 65, episode: 1, source: "test-source" } });
  await put("candidates/course-candidates.json", { contractVersion: 1, rules: [rule("P-COURSE", {
    source: "course:sample", status: "proposed", evidence: [{ ...primary, supports: [courseEv(2)], supportCount: 2 }],
  })] });
  await evidence([{ ...courseEv(1), ruleId: "P-COURSE", supports: [courseEv(3)], supportCount: 2 }]);
  const merged = await citations("P-COURSE");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].supportCount, 3);
  assert.deepEqual(merged[0].supports.map((e) => e.locator.episode), [1, 2, 3]);
  await evidence(["season-2", "season-3"].map((season) => courseEv(1, {
    ruleId: "P-ONE", locator: { source: "test-source", course: season, episode: 1, start: 65, end: 95 },
  })));
  assert.deepEqual((await citations("P-ONE")).map((e) => e.locator.course), ["season-2", "season-3"]);
  const pages = [["workbook-a", 3], ["workbook-a", 5], ["workbook-b", 3]];
  await evidence(pages.map(([episodeId, page]) => courseEv(0, {
    ruleId: "P-ONE", locator: { source: "test-source", course: "sample", episode: 0, episodeId, page },
  })));
  assert.deepEqual((await citations("P-ONE")).map((e) => [e.locator.episodeId, e.locator.page]), pages);
});

test("book detail renders title and locator without images or video links and filters by source", async () => {
  // A book record may carry unrelated cached fields; the book display must still never request a frame.
  const located = bookEv("第二讲/树的姿态", { book, bvid: "BVTEST", t: 12, frame: "example.jpg", kind: "exception" });
  const candidate = rule("BOOK", {
    source: "book:sample", library: "landscape", status: "proposed", evidence: [located], bookEvidence: [located],
  });
  const { detail, choose, listed } = await renderReview({ rules: [candidate], existingIds: [], version: "0.1.0" });
  const rendered = detail();
  assert.ok(rendered.some((node) => node.textContent === "书籍出处/例外"));
  assert.ok(rendered.some((node) => node.textContent.includes("合成书") && node.textContent.includes("第二讲/树的姿态")));
  noMedia(rendered);
  choose("source", "other");
  assert.equal(listed().length, 0);
  choose("source", "book");
  assert.equal(listed().length, 1);
});

test("paper detail shows support counts and every title/year/channel/locator without requesting media", async () => {
  // Even stale video cache fields on a paper citation must not turn it into media evidence.
  const support = { ...paperEv(), paper, bvid: "BVTEST", t: 12, frame: "example.jpg" };
  const second = { ...paperEv("second", "小标题：决定性瞬间/段落4"), paper: { ...paper, slug: "second", title: "第二篇" } };
  const aggregate = { ...support, supportCount: 2, supports: [support, second] };
  const fallback = { ...support, kind: "exception", locator: "段落8", paraphrase: "叙事需要时可保留干扰" };
  const candidate = rule("S-PAPER", {
    library: "street", source: "paper", status: "proposed",
    evidence: [aggregate, fallback], paperEvidence: [aggregate, fallback],
  });
  const { nodes, requests, detail } = await renderReview({ rules: [candidate], version: "0.1.0", existingIds: [] });
  const rendered = detail();
  for (const text of ["论文出处/例外", "出处 · 支持 2 篇", "例外 · 支持 1 篇", "合成论文 · 2020 · test · 段落2",
    "第二篇 · 2020 · test · 小标题：决定性瞬间/段落4", "合成论文 · 2020 · test · 段落8"])
    assert.ok(rendered.some((node) => node.textContent === text), text);
  assert.ok(rendered.some((node) => node.textContent.includes("单独下载论文草案")));
  assert.equal(rendered.find((node) => node.tag === "button" && node.textContent === "合并").disabled, true);
  noMedia(rendered);
  assert.deepEqual(requests, [{ url: "/rules/data", method: undefined }]);
  assert.equal(nodes.get("message").textContent, "");
});

test("paper filter includes supported YD and read-only references and combines with status/aspect", async () => {
  const located = { ...paperEv(), paper };
  const data = { version: "0.1.0", existingIds: ["P-ONE"], rules: [
    rule("P-ONE", { status: "existing" }),
    rule("P-YD", { status: "proposed", paperEvidence: [located] }),
    rule("P-PAPER", { status: "proposed", source: "paper", aspect: "pose", paperEvidence: [located] }),
    rule("BOOK", { status: "proposed", source: "book:sample", bookEvidence: [{ bookSlug: "sample" }] }),
  ], referenceRules: [
    rule("S-REF", { status: "reference", library: "street", paperEvidence: [located] }),
  ] };
  const { nodes, detail, choose, listed } = await renderReview(data);
  choose("source", "paper");
  assert.deepEqual(listed(), ["P-YD", "P-PAPER", "S-REF"]);
  choose("status", "proposed");
  assert.deepEqual(listed(), ["P-YD", "P-PAPER"]);
  choose("aspect", "pose");
  assert.deepEqual(listed(), ["P-PAPER"]);
  nodes.get("aspect").value = "";
  choose("status", "reference");
  nodes.get("list").children[0].onclick();
  assert.ok(detail().filter((node) => ["textarea", "button"].includes(node.tag)).every((node) => node.disabled));
  assert.equal(detail().filter((node) => node.tag === "select" && node.disabled).length, 2);
  assert.ok(detail().some((node) => node.textContent.includes("正式规则只读")));
  nodes.get("status").value = "";
  choose("source", "book");
  assert.deepEqual(listed(), ["BOOK"]);
  choose("source", "other");
  assert.deepEqual(listed(), ["P-ONE"]);
});

test("course detail displays episode ranges, workbook pages and support counts without media access", async () => {
  const citation = courseEv(2, { course, supportCount: 3, kind: "counterpoint", bvid: "BVTEST", t: 12, frame: "example.jpg",
    supports: [courseEv(3), courseEv(4)] });
  const candidate = rule("P-COURSE", { source: "course:sample", status: "proposed", evidence: [citation], courseEvidence: [citation] });
  const episodes = await renderReview({ rules: [candidate], existingIds: [], version: "0.1.0" });
  assert.ok(episodes.detail().some((n) => n.textContent === "课程出处/例外"));
  assert.ok(episodes.detail().some((n) => n.textContent === "反向提醒 · 合成课程 · 支持 3 集"));
  for (const episode of [2, 3, 4])
    assert.ok(episodes.detail().some((n) => n.textContent === `第 ${episode} 集 · 1:05–1:35`));
  noMedia(episodes.detail());
  assert.deepEqual(episodes.requests, [{ url: "/rules/data", method: undefined }]);
  const locator = { source: "test-source", course: "sample", episode: 9, episodeId: "workbook", page: 3 };
  const page = courseEv(9, { course, locator, supports: [{ locator: { ...locator, page: 5 } }] });
  const workbook = await renderReview({ rules: [rule("P-COURSE", { courseEvidence: [page] })], existingIds: [], version: "0.1.0" });
  for (const number of [3, 5])
    assert.ok(workbook.detail().some((n) => n.textContent === `sample · 第 9 集 · workbook · 讲义第 ${number} 页`));
  assert.ok(!workbook.detail().some((n) => n.textContent.includes("—–—")));
  noMedia(workbook.detail());
  assert.deepEqual(workbook.requests, [{ url: "/rules/data", method: undefined }]);
});

test("course filter includes supported YD/reference rules and combines with status and aspect", async () => {
  const data = { version: "0.1.0", existingIds: [], rules: [
    rule("P-YD", { status: "proposed", courseEvidence: [courseEv()] }),
    rule("P-COURSE", { status: "proposed", source: "course:sample", aspect: "lighting", courseEvidence: [courseEv()] }),
    rule("OTHER", { status: "proposed" }),
  ], referenceRules: [rule("G-ONE", { status: "reference", courseEvidence: [courseEv()] })] };
  const { nodes, choose, listed } = await renderReview(data);
  choose("source", "course");
  assert.deepEqual(listed(), ["P-YD", "P-COURSE", "G-ONE"]);
  choose("status", "proposed");
  assert.deepEqual(listed(), ["P-YD", "P-COURSE"]);
  choose("aspect", "lighting");
  assert.deepEqual(listed(), ["P-COURSE"]);
  nodes.get("aspect").value = "";
  nodes.get("status").value = "";
  choose("source", "other");
  assert.deepEqual(listed(), ["OTHER"]);
});

test("wulin API exposes mapped references and candidates, keeps exports separate from portrait", async (t) => {
  const { call, put } = await setup(t, fixtures.video());
  const evidence = { bvid: "BVWulin123", segment: 7, t: 42, frame: "frames/BVWulin123/0007.jpg", paraphrase: "边缘亮点分散注意", kind: "issue" };
  const candidates = { source: "wulin-critiques", rules: [
    rule("L-WL-EDGE", { library: "landscape", source: "wulin-critiques", status: "proposed",
      supportEpisodes: 4, supportSegments: 6, evidence: [evidence] }),
    rule("S-WL-RELATION", { library: "street", source: "wulin-critiques", status: "proposed",
      supportEpisodes: 3, supportSegments: 4, evidence: [evidence] }),
  ] };
  const mapped = { source: "wulin-critiques", rules: [{ id: "L-EDGE", frequency: { episodes: 5, segments: 8 }, evidence: [evidence] }] };
  await put("landscape.json", { library: "landscape", rules: [rule("L-EDGE")] });
  await put("candidates/landscape-street-v0.2-candidates.json", candidates);
  await put("candidates/wulin-evidence.json", mapped);
  // An existing teacher's evidence must survive addition of a second teacher.
  await put("candidates/existing-evidence.json", { rules: [
    { id: "L-EDGE", evidence: [{ ...evidence, bvid: "BVYidao123", source: "yidao-critiques" }] },
  ] });
  const state = (await call("data")).body;
  assert.equal(state.rules.length, 5);
  assert.deepEqual(state.wulinCandidates, candidates);
  assert.deepEqual(state.wulinEvidence, mapped);
  const reference = state.referenceRules.find((item) => item.id === "L-EDGE");
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
  assert.deepEqual(exported.draft.rules.map((item) => item.id), ["P-BACKGROUND"]);
  assert.deepEqual(exported.bookDrafts, {});
  assert.deepEqual(exported.paperDrafts, {});
  assert.deepEqual(Object.keys(exported.wulinDrafts), ["landscape", "street"]);
  assert.equal(exported.wulinDrafts.landscape.rules[0].id, "L-WL-EDGE");
  assert.equal(exported.wulinDrafts.street.rules[0].id, "S-WL-RELATION");
  assert.equal(exported.wulinDrafts.street.rules[0].status, undefined);
});

test("wulin filter combines status/aspect and browser renders representative thumbnail", async () => {
  const evidence = { bvid: "BVWulin123", segment: 7, t: 42, frame: "frames/BVWulin123/0007.jpg", paraphrase: "边缘亮点分散注意" };
  const data = { version: "0.1.0", rules: [
    rule("P-OTHER", { status: "existing" }),
    rule("L-WL-EDGE", { source: "wulin-critiques", library: "landscape", status: "proposed", supportEpisodes: 4,
      supportSegments: 6, evidence: [evidence], bookEvidence: [{ bookSlug: "book", paraphrase: "边缘注意" }] }),
  ], referenceRules: [rule("L-EDGE", { library: "landscape", status: "reference", wulinEvidence: [evidence], evidence: [evidence] })] };
  const { nodes, detail, choose, listed } = await renderReview(data);
  choose("source", "wulin");
  assert.deepEqual(listed(), ["L-WL-EDGE", "L-EDGE"]);
  choose("status", "proposed");
  assert.equal(listed().length, 1);
  choose("aspect", "pose");
  assert.equal(listed().length, 0);
  choose("aspect", "");
  nodes.get("list").children[0].onclick();
  const rendered = detail();
  assert.equal(rendered.find((node) => node.tag === "img").src, "/rules/frames/BVWulin123/0007.jpg");
  assert.equal(rendered.find((node) => node.tag === "a").href, "https://www.bilibili.com/video/BVWulin123?t=42");
  assert.equal(rendered.find((node) => node.tag === "button" && node.textContent === "合并").disabled, true);
  assert.ok(rendered.some((node) => node.textContent.includes("单独下载武林草案")));
  assert.equal(nodes.get("message").textContent, "");
});

test("consolidation metadata never becomes decisions or exported rules", async (t) => {
  const { call, put, read } = await setup(t, fixtures.video());
  assert.equal((await call("data")).body.consolidatedReview, null);
  const consolidated = { isSuggestion: true, entries: [{
    id: "P-CAND-TWO", aliases: ["P-CAND-ONE"], mergeReason: "同一背景判断", recommendation: "approve",
    priority: { rank: 1, score: 85 },
  }], formalRules: [
    { id: "P-BACKGROUND", aliases: [], priority: { rank: 2, score: 70 } },
    { id: "L-REFERENCE", aliases: [], priority: { rank: 3, score: 60 } },
  ] };
  await put("landscape.json", { library: "landscape", rules: [rule("L-REFERENCE")] });
  await put("candidates/existing-evidence.json", { rules: [
    { id: "L-REFERENCE", evidence: [{ bvid: "BVReference123", segment: 1, text: "背景干扰" }] },
  ] });
  await put("candidates/consolidated-review.json", consolidated);
  const state = (await call("data")).body;
  assert.deepEqual(state.consolidatedReview, consolidated);
  assert.deepEqual(state.decisions, []);
  const suggestion = (id) => [...state.rules, ...state.referenceRules].find((item) => item.id === id).reviewSuggestion;
  assert.equal(suggestion("P-CAND-ONE").mainId, "P-CAND-TWO");
  assert.equal(suggestion("P-CAND-ONE").isAlias, true);
  assert.equal(suggestion("P-CAND-TWO").rank, 1);
  assert.equal(suggestion("P-BACKGROUND").isSuggestion, true);
  assert.equal(state.referenceRules.find((item) => item.id === "L-REFERENCE").reviewSuggestion.rank, 3);
  assert.equal((await call("decisions", { ruleId: "P-CAND-ONE", action: "merge", targetId: "P-CAND-TWO" })).status, 400);
  assert.equal((await call("decisions", { ruleId: "P-CAND-TWO", action: "approve" })).status, 200);
  const decisions = await read("src/rules/review/decisions.json");
  assert.deepEqual(Object.keys(decisions[0]).sort(), ["action", "ruleId", "timestamp"]);
  const draft = (await call("export", {})).body.draft;
  assert.ok(draft.rules.every((item) => !item.reviewSuggestion));
});

test("priority browser sorting displays advisory merges without posting decisions", async () => {
  const data = { version: "0.1.0", rules: [
    rule("P-FREQUENT", { title: "高频", status: "proposed", frequency: { videos: 20 } }),
    rule("P-MAIN", { title: "主条目", status: "proposed", reviewSuggestion: {
      isSuggestion: true, mainId: "P-MAIN", aliases: ["P-ALIAS"], rank: 1,
      recommendation: "approve", mergeReason: "同一背景判断",
    } }),
    rule("P-ALIAS", { title: "别名", status: "proposed", reviewSuggestion: {
      isSuggestion: true, mainId: "P-MAIN", aliases: ["P-ALIAS"], rank: 1, isAlias: true, recommendation: "merge",
    } }),
  ] };
  const { nodes, requests, detail, choose, listed } = await renderReview(data, "priority");
  assert.deepEqual(listed(), ["主条目", "别名", "高频"]);
  assert.ok(detail().some((node) => node.textContent === "归并建议（非审核决定）"));
  nodes.get("list").children[1].onclick();
  assert.ok(detail().some((node) => node.textContent === "建议并入主条目：P-MAIN"));
  assert.ok(detail().some((node) => node.textContent.includes("候选间归并仅展示建议")));
  choose("sort", "frequency");
  assert.equal(listed()[0], "高频");
  assert.deepEqual(requests, [{ url: "/rules/data", method: undefined }]);
});
