import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const read = async (name) => JSON.parse(await readFile(new URL(`../src/rules/${name}`, import.meta.url), "utf8"));
const GENRES = ["portrait", "landscape", "street", "general"];
const PREFIXES = { portrait: "P-", landscape: "L-", street: "S-", general: "G-" };
const ID = /^[A-Z]+(-[A-Z0-9]+)+$/;
const KINDS = ["source", "exception", "counterpoint"];
const short = (text, limit = 40) => typeof text === "string" && text.trim().length > 0 && [...text].length <= limit;
const FORMAL = ["portrait.json", "landscape.json", "street.json", "general.json"];
const PROPOSED = {
  yidao: "candidates/portrait-v0.2-candidates.json", wulin: "candidates/landscape-street-v0.2-candidates.json",
  book: "candidates/book-candidates.json", paper: "candidates/paper-candidates.json",
  course: "candidates/course-candidates.json", xhs: "candidates/xhs-candidates.json",
};
const load = async () => {
  const formal = await Promise.all(FORMAL.map(read));
  const proposed = Object.fromEntries(await Promise.all(Object.entries(PROPOSED).map(async ([key, file]) => [key, await read(file)])));
  const formalIds = new Set(formal.flatMap((library) => library.rules.map((rule) => rule.id)));
  const ids = new Set([...formalIds, ...Object.values(proposed).flatMap((library) => library.rules.map((rule) => rule.id))]);
  return { formal, formalIds, proposed, ids };
};

function assertPrivate(value, at = "output") {
  if (typeof value === "string") {
    assert.doesNotMatch(value, /(?:https?:\/\/|ftp:\/\/|www\.|xhslink\.|xiaohongshu\.com|@[\p{L}\p{N}_-]+)/iu, at);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivate(item, `${at}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const identity = /(?:user|username|nickname|handle|author|account|profile|avatar|email|phone|姓名|用户名|昵称|账号|身份)/iu;
      assert.doesNotMatch(key, identity, `${at}.${key}`);
      assertPrivate(item, `${at}.${key}`);
    }
  }
}

function videoEvidence(e, { numberedFrames = false } = {}) {
  assert.match(e.bvid, /^BV[A-Za-z0-9]+$/);
  assert.ok(Number.isInteger(e.segment) && e.segment >= 0);
  assert.ok(Number.isFinite(e.t) && e.t >= 0);
  assert.ok(short(e.paraphrase), e.paraphrase);
  assert.equal(e.text, e.paraphrase);
  assert.ok(e.tier === null || typeof e.tier === "string");
  assert.match(e.frame, /^frames\/BV[A-Za-z0-9]+\/[A-Za-z0-9_-]+\.jpg$/);
  if (numberedFrames) assert.equal(Number(path.basename(e.frame, ".jpg")), e.segment, e.frame);
  assert.ok(["issue", "praise"].includes(e.kind));
}

test("proposed candidates are hint-only reviewable rules with unique IDs and bounded evidence", async () => {
  const { formalIds, proposed } = await load();
  const seen = new Set(formalIds);
  for (const [key, library] of Object.entries(proposed)) {
    assert.equal(library.contractVersion, 1, key);
    for (const rule of library.rules) {
      assert.match(rule.id, ID, rule.id);
      assert.ok(!seen.has(rule.id), `duplicate or existing rule ID: ${rule.id}`);
      seen.add(rule.id);
      assert.ok(rule.title && rule.statement && rule.aspect, rule.id);
      assert.equal(rule.status, "proposed", rule.id);
      assert.equal(rule.severity, "hint", rule.id);
      assert.ok(["teacher", "measure"].includes(rule.check?.by), rule.id);
      if (rule.check.by === "measure") assert.ok(rule.check.signal, rule.id);
      assert.ok(Array.isArray(rule.exceptions), rule.id);
      assert.ok(rule.evidence.length > 0 && rule.evidence.length <= 4, rule.id);
      if (key !== "yidao" && key !== "xhs") assert.ok(GENRES.includes(rule.library), rule.id);
      if (key !== "yidao") assert.equal(rule.check.by, "teacher", rule.id);
    }
  }
});

test("video critique candidates and mapped evidence keep located short paraphrases and consistent synthesis", async () => {
  const { ids, proposed: { yidao, wulin } } = await load();
  const [existing, portraitNs, portraitIndex, wulinEvidence, wulinNs, wulinIndex, codebook] = await Promise.all([
    "existing-evidence.json", "portrait-non-selection.json", "portrait-synthesis-index.json", "wulin-evidence.json",
    "landscape-street-non-selection.json", "landscape-street-synthesis-index.json", "landscape-street-synthesis-codebook.json",
  ].map((name) => read(`candidates/${name}`)));
  for (const candidates of [yidao, wulin]) {
    assert.equal(candidates.extractionStatus, "complete");
    assert.equal(candidates.extractedSegments, candidates.inputSegments);
  }
  let previous = Infinity;
  for (const r of yidao.rules) {
    assert.match(r.id, /^P(-[A-Z0-9]+)+$/);
    assert.equal(r.source, "yidao-critiques");
    assert.ok(r.statement.length <= 80 && ["negative", "positive"].includes(r.polarity), r.id);
    assert.ok(r.frequency.episodes >= 2 || r.inclusionReason, r.id);
    assert.ok(r.frequency.episodes <= previous, r.id);
    previous = r.frequency.episodes;
    assert.equal(r.frequency.episodes, r.frequency.videos);
    assert.ok(r.frequency.segments >= r.frequency.episodes);
    assert.equal(r.tierContrast.low + r.tierContrast.high + r.tierContrast.unknown, r.frequency.segments);
    r.evidence.forEach((e) => videoEvidence(e));
  }
  for (const r of wulin.rules) {
    assert.match(r.id, /^[LS]-WL-[A-Z-]+$/);
    assert.equal(r.source, "wulin-critiques");
    assert.ok(r.supportEpisodes >= 3 && r.exceptions.length, r.id);
    assert.equal(r.supportEpisodes, r.frequency.episodes);
    assert.equal(r.supportSegments, r.frequency.segments);
    r.evidence.forEach((e) => videoEvidence(e, { numberedFrames: true }));
  }
  for (const [mapped, numberedFrames] of [[existing, false], [wulinEvidence, true]]) {
    const mappedIds = new Set();
    for (const r of mapped.rules) {
      assert.ok(ids.has(r.id) && !mappedIds.has(r.id), r.id);
      mappedIds.add(r.id);
      assert.ok(r.representatives.length <= 4, r.id);
      r.evidence.forEach((e) => videoEvidence(e, { numberedFrames }));
    }
    assert.equal(mapped.rules.reduce((sum, r) => sum + r.evidence.length, 0), mapped.mappedEvidenceAssignments);
  }
  assert.equal(existing.mappedEvidenceAssignments, yidao.synthesis.mappedEvidenceAssignments);
  assert.equal(wulinEvidence.mappedEvidenceAssignments, wulin.synthesis.mappedEvidenceAssignments);
  const labels = (index, valid) => {
    const entries = new Map(index.entries.map((e) => [e.paraphrase, e.assignments]));
    assert.equal(entries.size, index.entries.length);
    for (const [text, assignments] of entries) {
      assert.ok(short(text) && assignments.length > 0, text);
      assignments.forEach((id) => assert.ok(valid(id) || ["vague", "unresolved"].includes(id), id));
    }
    return entries;
  };
  const portraitLabels = labels(portraitIndex, (id) => ids.has(id) || id.startsWith("NS:"));
  const codes = new Set([...codebook.rules, ...codebook.nonSelection, ...codebook.observations].map((r) => r.id));
  const wulinLabels = labels(wulinIndex, (id) => codes.has(id));
  for (const [candidates, entries] of [[yidao, portraitLabels], [wulin, wulinLabels]])
    for (const r of candidates.rules) for (const e of r.evidence) assert.ok(entries.get(e.paraphrase).includes(r.id), r.id);
  codebook.crossEvidence.forEach((c) => {
    assert.ok(c.references.length);
    c.references.forEach((r) => assert.ok(r.locator && short(r.paraphrase)));
  });
  const s = yidao.synthesis;
  assert.equal(s.filteredVague + s.nonSelectionCount + s.unresolvedConcrete + s.selectionCount, s.commentaryItems);
  assert.ok(Math.abs(s.filteredVague / s.commentaryItems - s.filteredVagueRatio) < 0.000001);
  assert.equal(portraitNs.nonSelectionCount, s.nonSelectionCount);
  for (const r of portraitNs.nonSelection) {
    assert.ok(r.title && r.statement && r.frequency.episodes > 0);
    assert.ok(r.evidence.length > 0 && r.evidence.length <= 2);
    r.evidence.forEach((e) => videoEvidence(e));
  }
  assert.equal(Object.values(wulin.synthesis.counts).reduce((a, b) => a + b, 0), wulin.synthesis.commentaryItems);
  assert.equal(wulinNs.nonSelectionCount, wulin.synthesis.counts.nonSelection);
  assert.equal(wulinNs.nonSelection.reduce((n, r) => n + r.commentaryItems, 0), wulinNs.nonSelectionCount);
  wulinNs.nonSelection.forEach((r) => assert.ok(!("evidence" in r)));
});

test("book evidence resolves rules and books with short located paraphrases and only bibliographic identity", async () => {
  const { ids, proposed: { book: candidates } } = await load();
  const data = await read("candidates/book-evidence.json");
  assert.equal(data.contractVersion, 1);
  assert.deepEqual(candidates.books, data.books);
  const books = new Map(data.books.map((item) => [item.slug, item]));
  assert.equal(books.size, data.books.length);
  assert.ok(data.evidence.length);
  for (const item of data.evidence) {
    assert.deepEqual(Object.keys(item).sort(), ["bookSlug", "kind", "locator", "paraphrase", "ruleId"]);
    assert.ok(ids.has(item.ruleId), item.ruleId);
    assert.ok(books.has(item.bookSlug), item.bookSlug);
    assert.ok(KINDS.includes(item.kind));
    assert.ok(item.locator && short(item.paraphrase), item.paraphrase);
    const pages = item.locator.match(/^PDF第(\d+)(?:–(\d+))?页／/);
    if (pages) assert.ok(Number(pages[1]) >= 1 && (!pages[2] || Number(pages[2]) >= Number(pages[1])), item.locator);
  }
  for (const record of data.books) {
    const items = data.evidence.filter((item) => item.bookSlug === record.slug);
    assert.ok(items.length, record.slug);
    if (record.format === "corpus") {
      assert.deepEqual(Object.keys(record.corpusRef).sort(), ["lang", "title", "year"]);
      assert.equal(record.corpusRef.lang, "en");
      assert.ok(record.corpusRef.title);
      assert.ok(items.every((item) => /章节\s*\d+.*段落\s*\d+/.test(item.locator)), record.slug);
    } else {
      assert.ok(["pdf", "pdf-ocr", "excerpt", "epub"].includes(record.format), record.slug);
      if (record.sourceSha256 !== undefined) assert.match(record.sourceSha256, /^[a-f0-9]{64}$/);
    }
    if (record.slug.endsWith("sample")) assert.equal(record.scope, "sample");
  }
  assert.doesNotMatch(JSON.stringify([data, candidates]), /row_group|\.parquet|\/tmp\//);
  for (const rule of candidates.rules) {
    assert.ok(rule.source.startsWith("book:") && rule.sources.includes(rule.source), rule.id);
    for (const item of rule.evidence) {
      assert.ok(books.has(item.bookSlug));
      assert.equal(rule.source, `book:${item.bookSlug}`);
      assert.ok(item.locator && short(item.paraphrase));
      assert.equal(item.frame, undefined);
    }
  }
});

test("paper evidence resolves rules and citations and counts documents rather than paragraphs", async () => {
  const { ids, proposed: { paper: candidates } } = await load();
  const data = await read("candidates/paper-evidence.json");
  assert.equal(data.contractVersion, 1);
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
    assert.ok(KINDS.includes(item.kind));
    assert.ok(short(item.paraphrase));
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
    assert.equal(rule.source, "paper");
    for (const item of rule.evidence) {
      checkCitation(item);
      assert.ok(short(item.paraphrase));
    }
  }
});

test("course evidence cites known courses with short located paraphrases and no media", async () => {
  const { ids, proposed: { course: candidates } } = await load();
  const data = await read("candidates/course-evidence.json");
  assert.equal(data.contractVersion, 1);
  const courses = new Map(data.courses.map((item) => [item.slug, item]));
  const checkCitation = (item) => {
    assert.ok(courses.has(item.courseSlug), item.courseSlug);
    assert.equal(item.locator.source, courses.get(item.courseSlug).source);
    assert.ok(KINDS.includes(item.kind));
    assert.ok(short(item.paraphrase), item.paraphrase);
    assert.ok(Number.isInteger(item.supportCount) && item.supportCount >= 1);
    for (const field of ["text", "frame", "bvid"]) assert.equal(item[field], undefined, field);
  };
  assert.ok(data.evidence.length > 0);
  for (const item of data.evidence) {
    assert.ok(ids.has(item.ruleId), item.ruleId);
    checkCitation(item);
  }
  for (const rule of candidates.rules) {
    assert.ok(rule.source.startsWith("course:"), rule.id);
    rule.evidence.forEach(checkCitation);
  }
});

test("XHS candidates follow the rule contract and use anonymized evidence", async () => {
  const { proposed: { xhs: document } } = await load();
  assert.equal(document.library, "xhs-comments");
  assert.deepEqual(document.genres, GENRES);
  assert.ok(document.rules.length > 0);
  assertPrivate(document);
  for (const rule of document.rules) {
    assert.ok(GENRES.includes(rule.genre), rule.id);
    assert.ok(rule.id.startsWith(PREFIXES[rule.genre]), rule.id);
    assert.ok(rule.sources.length > 0 && rule.sources.every((source) => typeof source === "string" && source.trim()), rule.id);
    assert.equal(rule.source, "xiaohongshu-comments", rule.id);
    for (const field of ["notes", "points", "likes"]) {
      assert.ok(Number.isSafeInteger(rule.frequency?.[field]), `${rule.id}.frequency.${field}`);
      assert.ok(rule.frequency[field] >= (field === "likes" ? 0 : 1), rule.id);
    }
    assert.ok(rule.frequency.points >= rule.frequency.notes, rule.id);
    assert.ok(rule.frequency.notes >= 2 || rule.frequency.likes >= 20, `${rule.id}: requires repeated or high-like evidence`);
    for (const evidence of rule.evidence) {
      assert.deepEqual(Object.keys(evidence).sort(), ["noteId", "paraphrase"]);
      assert.match(evidence.noteId, /^N\d{2}$/);
      assert.ok(short(evidence.paraphrase, 30), `${rule.id}.evidence: exceeds 30 characters`);
    }
    assert.ok(new Set(rule.evidence.map((item) => item.noteId)).size <= rule.frequency.notes, rule.id);
  }
});
