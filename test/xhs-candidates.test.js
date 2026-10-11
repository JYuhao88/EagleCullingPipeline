import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ruleDir = new URL("../src/rules/", import.meta.url);
const GENRES = ["portrait", "landscape", "street", "general"];
const PREFIXES = { portrait: "P-", landscape: "L-", street: "S-", general: "G-" };
const ID = /^[A-Z]+(-[A-Z0-9]+)+$/;
const SEVERITIES = new Set(["gate", "penalty", "hint"]);
const CHECKERS = new Set(["measure", "teacher", "measure+teacher"]);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, ruleDir), "utf8"));
}

async function existingRules() {
  const libraries = await Promise.all(
    GENRES.filter((genre) => genre !== "general").map(readJsonForGenre),
  );
  return new Map(libraries.flatMap((library) =>
    library.rules.map((rule) => [rule.id, { ...rule, genre: library.library }]),
  ));
}

function readJsonForGenre(genre) {
  return readJson(`${genre}.json`);
}

function assertPrivate(value, path = "output") {
  if (typeof value === "string") {
    assert.doesNotMatch(value, /(?:https?:\/\/|ftp:\/\/|www\.|xhslink\.|xiaohongshu\.com|@[\p{L}\p{N}_-]+)/iu, path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertPrivate(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const identity = /(?:user|username|nickname|handle|author|account|profile|avatar|email|phone|姓名|用户名|昵称|账号|身份)/iu;
      assert.doesNotMatch(key, identity, `${path}.${key}`);
      assertPrivate(item, `${path}.${key}`);
    }
  }
}

function assertShortText(value, path) {
  assert.equal(typeof value, "string", path);
  assert.ok(value.trim().length > 0, path);
  assert.ok([...value].length <= 30, `${path}: exceeds 30 characters`);
}

test("XHS candidates follow the rule contract and use anonymized evidence", async () => {
  const [document, existing] = await Promise.all([
    readJson("candidates/xhs-candidates.json"), existingRules(),
  ]);
  assert.equal(document.contractVersion, 1);
  assert.equal(document.library, "xhs-comments");
  assert.equal(document.version, "0.1.0");
  assert.deepEqual(document.genres, GENRES);
  assert.ok(Array.isArray(document.rules) && document.rules.length > 0);
  assertPrivate(document);
  const ids = new Set(existing.keys());
  for (const rule of document.rules) {
    assert.match(rule.id, ID);
    assert.ok(!ids.has(rule.id), `duplicate or existing rule ID: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(GENRES.includes(rule.genre), rule.id);
    assert.ok(rule.id.startsWith(PREFIXES[rule.genre]), rule.id);
    for (const field of ["title", "statement", "aspect"]) {
      assert.equal(typeof rule[field], "string", `${rule.id}.${field}`);
      assert.ok(rule[field].trim(), `${rule.id}.${field}`);
    }
    assert.ok(SEVERITIES.has(rule.severity), rule.id);
    assert.ok(CHECKERS.has(rule.check?.by), rule.id);
    assert.ok(Array.isArray(rule.sources) && rule.sources.length > 0, rule.id);
    assert.ok(rule.sources.every((source) => typeof source === "string" && source.trim()), rule.id);
    assert.equal(rule.status, "proposed", rule.id);
    assert.equal(rule.source, "xiaohongshu-comments", rule.id);
    for (const field of ["notes", "points", "likes"]) {
      assert.ok(Number.isSafeInteger(rule.frequency?.[field]), `${rule.id}.frequency.${field}`);
      assert.ok(rule.frequency[field] >= (field === "likes" ? 0 : 1), rule.id);
    }
    assert.ok(rule.frequency.points >= rule.frequency.notes, rule.id);
    assert.ok(rule.frequency.notes >= 2 || rule.frequency.likes >= 20, `${rule.id}: requires repeated or high-like evidence`);
    assert.ok(Array.isArray(rule.evidence) && rule.evidence.length >= 1 && rule.evidence.length <= 4, rule.id);
    for (const evidence of rule.evidence) {
      assert.deepEqual(Object.keys(evidence).sort(), ["noteId", "paraphrase"]);
      assert.match(evidence.noteId, /^N\d{2}$/);
      assertShortText(evidence.paraphrase, `${rule.id}.evidence`);
    }
    assert.ok(new Set(rule.evidence.map((item) => item.noteId)).size <= rule.frequency.notes, rule.id);
  }
});

test("XHS rejection reasons refer to compatible existing or proposed rules", async () => {
  const [document, candidates, existing] = await Promise.all([
    readJson("candidates/reject-reasons.json"),
    readJson("candidates/xhs-candidates.json"),
    existingRules(),
  ]);
  assert.equal(document.contractVersion, 1);
  assert.ok(Array.isArray(document.reasons));
  assert.ok(document.reasons.length >= 8 && document.reasons.length <= 15);
  assertPrivate(document);
  const rules = new Map([...existing, ...candidates.rules.map((rule) => [rule.id, rule])]);
  const ids = new Set();
  const labels = new Set();
  for (const reason of document.reasons) {
    assert.match(reason.id, ID);
    assert.ok(!ids.has(reason.id), `duplicate reason ${reason.id}`);
    assert.ok(!rules.has(reason.id), `reason ID conflicts with rule ${reason.id}`);
    ids.add(reason.id);
    assertShortText(reason.label, reason.id);
    assert.ok(!labels.has(reason.label), `duplicate label ${reason.label}`);
    labels.add(reason.label);
    assert.ok(GENRES.includes(reason.genre), reason.id);
    assert.ok(Array.isArray(reason.ruleIds) && reason.ruleIds.length > 0, reason.id);
    assert.equal(new Set(reason.ruleIds).size, reason.ruleIds.length, reason.id);
    for (const ruleId of reason.ruleIds) {
      assert.ok(rules.has(ruleId), `${reason.id}: unknown rule ${ruleId}`);
      const ruleGenre = rules.get(ruleId).genre;
      const compatible = reason.genre === "general" || ruleGenre === "general" || ruleGenre === reason.genre;
      assert.ok(compatible, `${reason.id}: incompatible genre for ${ruleId}`);
    }
    assert.ok(Array.isArray(reason.examples) && reason.examples.length >= 2 && reason.examples.length <= 3, reason.id);
    for (const example of reason.examples) assertShortText(example, `${reason.id}.examples`);
  }
});

test("privacy validation rejects nested identity fields and links", () => {
  assert.throws(() => assertPrivate({ evidence: [{ username: "someone" }] }));
  assert.throws(() => assertPrivate({ evidence: [{ paraphrase: "https://example.com" }] }));
  assert.throws(() => assertPrivate({ evidence: [{ paraphrase: "@someone" }] }));
  assert.doesNotThrow(() => assertPrivate({ evidence: [{ noteId: "N01", paraphrase: "画面过宽使主体显小" }] }));
});
