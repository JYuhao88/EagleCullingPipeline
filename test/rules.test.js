import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const dir = new URL("../src/rules/", import.meta.url);
const SEVERITIES = new Set(["gate", "penalty", "hint"]);
const CHECKERS = new Set(["measure", "teacher", "measure+teacher"]);

test("rule libraries are well-formed", async () => {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0);
  const ids = new Set();
  for (const file of files) {
    const library = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    assert.equal(library.contractVersion, 1, file);
    for (const rule of library.rules) {
      assert.match(rule.id, /^[A-Z]+(-[A-Z0-9]+)+$/, rule.id);
      assert.ok(!ids.has(rule.id), `duplicate ${rule.id}`);
      ids.add(rule.id);
      assert.ok(rule.title && rule.statement && rule.aspect, rule.id);
      assert.ok(SEVERITIES.has(rule.severity), rule.id);
      assert.ok(CHECKERS.has(rule.check?.by), rule.id);
      assert.ok(rule.sources?.length, rule.id);
    }
  }
});
