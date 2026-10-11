import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (file) => JSON.parse(await readFile(new URL(`../src/rules/${file}`, import.meta.url), "utf8"));

test("paper evidence resolves rules and citations and counts documents rather than paragraphs", async () => {
  const files = [
    "portrait.json", "landscape.json", "street.json", "general.json",
    "candidates/portrait-v0.2-candidates.json", "candidates/xhs-candidates.json", "candidates/book-candidates.json",
  ];
  const libraries = await Promise.all(files.map(read));
  const ids = new Set(libraries.flatMap((library) => library.rules.map((rule) => rule.id)));
  const data = await read("candidates/paper-evidence.json");
  const candidates = await read("candidates/paper-candidates.json");
  assert.equal(data.contractVersion, 1);
  assert.equal(candidates.contractVersion, 1);
  assert.deepEqual(candidates.papers, data.papers);
  const papers = new Map(data.papers.map((paper) => [paper.slug, paper]));
  assert.equal(papers.size, data.papers.length);
  for (const paper of papers.values()) {
    assert.ok(paper.title && paper.channel && paper.docType);
    assert.match(paper.slug, /^paper-[a-f0-9]{16}$/);
    assert.ok(paper.year === null || Number.isInteger(paper.year));
    assert.equal(paper.text, undefined);
  }
  const checkCitation = (item) => {
    assert.ok(papers.has(item.paperSlug), item.paperSlug);
    assert.match(item.locator, /^段落[1-9][0-9]*(／.*)?$/);
    assert.equal(item.text, undefined);
    assert.equal(item.frame, undefined);
  };
  const groups = new Set();
  assert.ok(data.evidence.length > 0);
  for (const item of data.evidence) {
    assert.ok(ids.has(item.ruleId), item.ruleId);
    assert.ok(["source", "exception", "counterpoint"].includes(item.kind));
    assert.ok(item.paraphrase && [...item.paraphrase].length <= 40);
    const key = JSON.stringify([item.ruleId, item.kind, item.paraphrase]);
    assert.ok(!groups.has(key), "duplicate viewpoint must be aggregated");
    groups.add(key);
    checkCitation(item);
    assert.ok(item.supports.length > 0);
    item.supports.forEach(checkCitation);
    assert.equal(item.supportCount, new Set(item.supports.map((support) => support.paperSlug)).size);
    const locators = new Set(item.supports.map((support) => JSON.stringify([support.paperSlug, support.locator])));
    assert.equal(locators.size, item.supports.length);
    assert.ok(locators.has(JSON.stringify([item.paperSlug, item.locator])));
  }
  for (const rule of candidates.rules) {
    assert.ok(!ids.has(rule.id));
    ids.add(rule.id);
    assert.equal(rule.status, "proposed");
    assert.equal(rule.source, "paper");
    assert.equal(rule.severity, "hint");
    assert.equal(rule.check.by, "teacher");
    assert.ok(["portrait", "landscape", "street", "general"].includes(rule.library));
    assert.ok(rule.evidence.length > 0 && rule.evidence.length <= 4);
    for (const item of rule.evidence) {
      checkCitation(item);
      assert.ok(item.paraphrase && [...item.paraphrase].length <= 40);
    }
  }
});
