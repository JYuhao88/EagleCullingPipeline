import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (name) => JSON.parse(await readFile(
  new URL(`../src/rules/${name}`, import.meta.url), "utf8",
));

test("Chinese Photographer's Eye keeps full-book identity and PDF page bounds", async () => {
  const data = await read("candidates/book-evidence.json");
  const slug = "photographers-eye-zh";
  const book = data.books.find((item) => item.slug === slug);
  assert.equal(book.format, "pdf-ocr");
  assert.equal(book.scope, "full-book");
  assert.equal(book.sourceSha256, "d3ae934152d54ba88028cee746a5431fa9b00844ce2ec62508e515a43047acc7");
  assert.equal(data.books.find((item) => item.slug === "photographers-eye-press").scope, "press-release");
  assert.equal(data.books.find((item) => item.slug === "photographers-eye-excerpt").scope, "intro-excerpt");
  const items = data.evidence.filter((item) => item.bookSlug === slug);
  assert.ok(items.length > 0);
  for (const item of items) {
    const pages = item.locator.match(/^PDF第(\d+)(?:–(\d+))?页／/);
    assert.ok(pages, item.locator);
    assert.ok(Number(pages[1]) >= 1 && Number(pages[1]) <= 158);
    if (pages[2]) assert.ok(Number(pages[2]) >= Number(pages[1]) && Number(pages[2]) <= 158);
    assert.deepEqual(Object.keys(item).sort(), ["bookSlug", "kind", "locator", "paraphrase", "ruleId"]);
  }
});

test("book evidence has resolvable rule and book locators and short paraphrases", async () => {
  const evidence = await read("candidates/book-evidence.json");
  const candidates = await read("candidates/book-candidates.json");
  const libraries = await Promise.all([
    "portrait.json", "landscape.json", "street.json", "general.json",
    "candidates/portrait-v0.2-candidates.json", "candidates/xhs-candidates.json",
  ].map(read));
  const ids = new Set(libraries.flatMap((library) => library.rules.map((rule) => rule.id)));
  const otherCandidates = await Promise.all([
    "candidates/course-candidates.json", "candidates/paper-candidates.json",
    "candidates/landscape-street-v0.2-candidates.json",
  ].map(read));
  const resolvableIds = new Set([
    ...ids, ...candidates.rules.map((rule) => rule.id),
    ...otherCandidates.flatMap((library) => library.rules.map((rule) => rule.id)),
  ]);
  const books = new Set(evidence.books.map((book) => book.slug));
  assert.equal(evidence.contractVersion, 1);
  assert.equal(candidates.contractVersion, 1);
  assert.ok(evidence.evidence.length);
  for (const item of evidence.evidence) {
    assert.ok(resolvableIds.has(item.ruleId), item.ruleId);
    assert.ok(books.has(item.bookSlug), item.bookSlug);
    assert.ok(["source", "exception", "counterpoint"].includes(item.kind));
    assert.ok(item.locator && item.paraphrase);
    assert.ok([...item.paraphrase].length <= 40, item.paraphrase);
    assert.equal(item.frame, undefined);
  }
  for (const rule of candidates.rules) {
    assert.match(rule.id, /^[A-Z]+(-[A-Z0-9]+)+$/);
    assert.ok(!ids.has(rule.id), rule.id);
    ids.add(rule.id);
    assert.ok(rule.title && rule.statement && rule.aspect);
    assert.ok(["portrait", "landscape", "street", "general"].includes(rule.library));
    assert.equal(rule.status, "proposed");
    assert.equal(rule.severity, "hint");
    assert.equal(rule.check.by, "teacher");
    assert.ok(rule.source.startsWith("book:"));
    assert.ok(rule.sources.includes(rule.source));
    assert.ok(rule.evidence.length > 0 && rule.evidence.length <= 4);
    for (const item of rule.evidence) {
      assert.ok(books.has(item.bookSlug));
      assert.equal(rule.source, `book:${item.bookSlug}`);
      assert.ok(item.locator && item.paraphrase);
      assert.ok([...item.paraphrase].length <= 40);
      assert.equal(item.frame, undefined);
    }
  }
});

test("corpus book records expose only bibliographic identity and located paraphrases", async () => {
  const data = await read("candidates/book-evidence.json");
  const candidates = await read("candidates/book-candidates.json");
  assert.deepEqual(candidates.books, data.books);
  const corpus = data.books.filter((book) => book.format === "corpus");
  assert.equal(corpus.length, 16);
  assert.equal(new Set(data.books.map((book) => book.slug)).size, data.books.length);
  for (const book of corpus) {
    assert.deepEqual(Object.keys(book.corpusRef).sort(), ["lang", "title", "year"]);
    assert.equal(book.corpusRef.lang, "en");
    assert.ok(book.corpusRef.title);
    const items = data.evidence.filter((item) => item.bookSlug === book.slug);
    assert.ok(items.length > 0, book.slug);
    assert.ok(items.every((item) => /章节\s*\d+.*段落\s*\d+/.test(item.locator)), book.slug);
  }
  const serialized = JSON.stringify([data, candidates]);
  assert.doesNotMatch(serialized, /row_group|\.parquet|\/tmp\//);
  const pilot = data.evidence.filter((item) => item.bookSlug === "photography-aesthetics-six-lectures");
  assert.equal(pilot.length, 38);
});

test("reference books preserve real identity, sample scope and page-only short evidence", async () => {
  const data = await read("candidates/book-evidence.json");
  const slugs = [
    "magnum-streetwise", "decisive-moment", "hurn-jay", "why-focus-sample",
    "posing-sample", "photographers-eye-press", "photographers-eye-excerpt",
  ];
  const books = data.books.filter((book) => slugs.includes(book.slug));
  assert.equal(books.length, 7);
  assert.match(books.find((book) => book.slug === "magnum-streetwise").title, /Streetwise/);
  assert.ok(!data.books.some((book) => book.slug === "magnum-contact-sheets"));
  for (const book of books) {
    assert.match(book.sourceSha256, /^[a-f0-9]{64}$/);
    assert.ok(["pdf", "pdf-ocr", "excerpt"].includes(book.format));
    if (book.slug.endsWith("sample")) assert.equal(book.scope, "sample");
    const items = data.evidence.filter((item) => item.bookSlug === book.slug);
    assert.ok(items.length, book.slug);
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["bookSlug", "kind", "locator", "paraphrase", "ruleId"]);
      assert.match(item.locator, /PDF第\d+|导言摘录／/);
      assert.ok([...item.paraphrase].length <= 40);
    }
  }
});

test("posing full books and checklists retain audited identities and bounded PDF evidence", async () => {
  const data = await read("candidates/book-evidence.json");
  const candidates = await read("candidates/book-candidates.json");
  const manifest = JSON.parse(await readFile(new URL("../ml/references/portrait_courses_manifest.json", import.meta.url), "utf8"));
  const bounds = new Map([
    ["adler-posing", 450], ["adler-pitfalls", 10], ["adler-pocket", 1],
    ["adler-hands", 103], ["adler-couples", 96], ["adler-teens", 81],
    ["adler-50-poses", 57], ["valenzuela-posing-zh", 351],
    ["valenzuela-practice-zh", 302], ["adler-boudoir", 54],
  ]);
  assert.deepEqual(candidates.books, data.books);
  for (const [slug, total] of bounds) {
    const book = data.books.find((item) => item.slug === slug);
    assert.ok(book, slug);
    assert.ok(["pdf", "pdf-ocr"].includes(book.format));
    const original = manifest.files.find((file) => file.source === "materials-books" && file.sha256 === book.sourceSha256);
    assert.ok(original, slug);
    assert.ok(original.remote_rel.endsWith(".pdf"));
    assert.ok(!original.remote_rel.includes("no_watermark"));
    assert.equal(book.scope, slug === "adler-pitfalls" || slug === "adler-pocket" ? "checklist" : "full-book");
    const items = data.evidence.filter((item) => item.bookSlug === slug);
    assert.ok(items.length, slug);
    for (const item of items) {
      const pages = item.locator.match(/^PDF第(\d+)(?:–(\d+))?页／/);
      assert.ok(pages, item.locator);
      assert.ok(Number(pages[1]) >= 1 && Number(pages[1]) <= total);
      if (pages[2]) assert.ok(Number(pages[2]) >= Number(pages[1]) && Number(pages[2]) <= total);
      assert.deepEqual(Object.keys(item).sort(), ["bookSlug", "kind", "locator", "paraphrase", "ruleId"]);
    }
  }
  assert.equal(data.books.find((item) => item.slug === "posing-sample").scope, "sample");
  assert.equal(data.evidence.filter((item) => item.bookSlug === "posing-sample").length, 7);
  for (const id of ["P-BOOK-EYE-WHITES", "P-BOOK-GROUP-HEAD-LAYERS"]) {
    const rule = candidates.rules.find((item) => item.id === id);
    assert.ok(rule && rule.check.by === "teacher" && rule.status === "proposed" && rule.severity === "hint");
    assert.ok(rule.exceptions.length >= 3);
  }
});
