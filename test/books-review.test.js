import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRulesRouter, applyRuleDecisions } from "../src/server/rules-routes.js";

const rule = (id, extra = {}) => ({
  id, title: id, statement: "可见判断", aspect: "framing", severity: "hint",
  check: { by: "teacher" }, sources: [], exceptions: [], ...extra,
});
const book = { slug: "sample", title: "合成书", author: "测试", format: "epub" };
const evidence = (locator, extra = {}) => ({ bookSlug: "sample", locator, paraphrase: "主体关系清楚", ...extra });

async function setup(t, { withBooks = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "books-review-"));
  const rulesDir = path.join(dir, "src/rules");
  await mkdir(path.join(rulesDir, "candidates"), { recursive: true });
  const put = (file, value) => writeFile(path.join(rulesDir, file), JSON.stringify(value));
  await put("portrait.json", { library: "portrait", version: "0.1.0", rules: [rule("P-ONE")] });
  await put("candidates/portrait-v0.2-candidates.json", { rules: [rule("P-VIDEO", {
    status: "proposed", evidence: [{ bvid: "BVTEST", segment: 1, text: "背景干扰" }],
  })] });
  for (const library of ["general", "landscape", "street"])
    await put(`${library}.json`, { library, rules: [rule(`${library}-ONE`)] });
  await put("candidates/xhs-candidates.json", { rules: [rule("XHS-ONE")] });
  if (withBooks) {
    await put("candidates/book-candidates.json", { contractVersion: 1, books: [book], rules: [
      rule("BOOK-P", { library: "portrait", status: "proposed", source: "book:sample", evidence: [evidence("第一讲"), evidence("第二讲")] }),
      rule("BOOK-G", { library: "general", status: "proposed", source: "book:sample", evidence: [evidence("第三讲")] }),
    ] });
    await put("candidates/book-evidence.json", { contractVersion: 1, books: [book], evidence:
      ["P-ONE", "P-VIDEO", "general-ONE", "landscape-ONE", "street-ONE", "XHS-ONE"].map((ruleId, i) =>
        evidence(`第${i + 1}讲`, { ruleId, kind: i % 2 ? "exception" : "source" })) });
  }
  const router = createRulesRouter({ projectRoot: dir });
  const server = http.createServer(async (req, res) => { if (!(await router(req, res))) res.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/rules/${route}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { dir, call };
}

test("book review API includes candidates and located evidence across all rule libraries", async (t) => {
  const { call } = await setup(t);
  const { status, body } = await call("data");
  assert.equal(status, 200);
  assert.equal(body.bookCandidates.rules.length, 2);
  assert.equal(body.bookEvidence.evidence.length, 6);
  assert.equal(body.rules.length, 4);
  assert.deepEqual(body.existingIds, ["P-ONE"]);
  assert.equal(body.rules.find((r) => r.id === "BOOK-P").bookEvidence.length, 2);
  for (const id of ["P-ONE", "P-VIDEO", "general-ONE", "landscape-ONE", "street-ONE", "XHS-ONE"]) {
    const found = [...body.rules, ...body.referenceRules].find((r) => r.id === id);
    assert.equal(found.bookEvidence[0].book.title, book.title);
    assert.ok(found.bookEvidence[0].locator);
  }
  assert.ok(body.referenceRules.every((r) => r.status === "reference"));
  assert.equal((await call("decisions", { ruleId: "general-ONE", action: "approve" })).status, 400);
});

test("book approvals export per library and cannot merge general books into portrait seed", async (t) => {
  const { dir, call } = await setup(t);
  assert.equal((await call("decisions", { ruleId: "BOOK-G", action: "merge", targetId: "P-ONE" })).status, 400);
  for (const ruleId of ["BOOK-P", "BOOK-G"])
    assert.equal((await call("decisions", { ruleId, action: "approve" })).status, 200);
  const exported = (await call("export", {})).body;
  assert.deepEqual(exported.draft.rules.map((r) => r.id), ["P-ONE", "BOOK-P"]);
  assert.deepEqual(exported.bookDrafts.general.rules.map((r) => r.id), ["BOOK-G"]);
  assert.equal(exported.bookDrafts.general.rules[0].status, undefined);
  const stored = JSON.parse(await readFile(path.join(dir, exported.path), "utf8"));
  assert.deepEqual(stored, exported.draft);
});

test("merging preserves distinct book locators and associated exceptions without inflating video frequency", () => {
  const first = evidence("第一讲");
  const second = evidence("第二讲");
  const existing = rule("P", {
    evidence: [{ bvid: "BVTEST", segment: 1, text: "点评" }],
    bookEvidence: [evidence("第三讲", { kind: "source" })],
  });
  const candidate = rule("B", { evidence: [first, second, first], bookEvidence: [evidence("第四讲", { kind: "exception" })] });
  const [merged] = applyRuleDecisions({ rules: [existing] }, { rules: [candidate] }, [{ ruleId: "B", action: "merge", targetId: "P" }]);
  assert.equal(merged.evidence.length, 3);
  assert.equal(merged.bookEvidence.length, 2);
  assert.equal(merged.frequency.videos, 1);
  assert.equal(merged.frequency.segments, 1);
  const [bookOnly] = applyRuleDecisions({ rules: [rule("P")] }, { rules: [candidate] }, [{ ruleId: "B", action: "merge", targetId: "P" }]);
  assert.equal(bookOnly.frequency.videos, 0);
  assert.equal(bookOnly.frequency.segments, 0);
});

test("missing book files preserve existing review behavior", async (t) => {
  const { call } = await setup(t, { withBooks: false });
  const { body } = await call("data");
  assert.equal(body.rules.length, 2);
  assert.deepEqual(body.referenceRules, []);
  assert.deepEqual(body.bookCandidates.rules, []);
  assert.deepEqual(body.bookEvidence.evidence, []);
});

test("book candidate merge API retains all chapter locators in destination detail", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("decisions", { ruleId: "BOOK-P", action: "merge", targetId: "P-ONE" })).status, 200);
  const state = (await call("data")).body;
  const target = state.rules.find((r) => r.id === "P-ONE");
  assert.deepEqual(target.bookEvidence.map((e) => e.locator), ["第1讲", "第一讲", "第二讲"]);
  assert.ok(target.bookEvidence.every((e) => e.book.title === book.title));
  assert.equal(target.frequency.videos, 0);
  assert.equal(target.frequency.segments, 0);
  assert.equal(state.rules.find((r) => r.id === "BOOK-P").status, "merged");
});

test("review detail renders book title and locator without images or video links", async () => {
  class Element {
    constructor(tag, text = "", value = "") { this.tag = tag; this.textContent = text; this.value = value; this.children = []; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  const nodes = new Map(
    ["message", "version", "aspect", "status", "source", "list", "detail", "export"].map((id) => [id, new Element(id)]),
  );
  const document = { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag) };
  // A book record may carry unrelated cached fields; the book display must still never request a frame.
  const located = evidence("第二讲/树的姿态", { book, bvid: "BVTEST", t: 12, frame: "example.jpg", kind: "exception" });
  const candidate = rule("BOOK", {
    source: "book:sample", library: "landscape", status: "proposed", evidence: [located], bookEvidence: [located],
  });
  const context = vm.createContext({
    document, location: { protocol: "http:" },
    Option: class extends Element { constructor(text, value) { super("option", text, value); } },
    fetch: async () => ({ ok: true, json: async () => ({ rules: [candidate], existingIds: [], version: "0.1.0" }) }),
    setTimeout,
  });
  vm.runInContext(await readFile(new URL("../src/plugin/rules-review.js", import.meta.url), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const rendered = descendants(nodes.get("detail"));
  assert.ok(rendered.some((node) => node.textContent === "书籍出处/例外"));
  assert.ok(rendered.some((node) => node.textContent.includes("合成书") && node.textContent.includes("第二讲/树的姿态")));
  assert.ok(!rendered.some((node) => node.tag === "img" || node.tag === "a"));
  nodes.get("source").value = "other";
  nodes.get("source").onchange();
  assert.equal(nodes.get("list").children.length, 0);
  nodes.get("source").value = "book";
  nodes.get("source").onchange();
  assert.equal(nodes.get("list").children.length, 1);
});
