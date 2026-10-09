import test from "node:test";
import assert from "node:assert/strict";
import { reviewPage } from "../src/plugin/review-page.js";

test("8000 selected photos remain reachable with no more than 80 rendered rows", () => {
  const sections = [{ id: "one", records: Array.from({ length: 8000 }, (_, id) => ({ id })) }];
  const visited = new Set();
  for (let page = 0; page < 100; page += 1) {
    const result = reviewPage(sections, page);
    assert.equal(result.total, 8000);
    assert.equal(result.pages, 100);
    assert.equal(result.sections[0].records.length, 80);
    for (const item of result.sections[0].records) visited.add(item.id);
  }
  assert.equal(visited.size, 8000);
});

test("groups spanning pages preserve identity, filtering clamps the page", () => {
  const groups = [{ id: "a", records: Array.from({ length: 70 }, (_, id) => ({ id })) }, { id: "b", records: Array.from({ length: 30 }, (_, id) => ({ id: id + 70 })) }];
  const first = reviewPage(groups);
  assert.equal(first.sections[1].records.length, 10);
  const last = reviewPage(groups, 1);
  assert.equal(last.sections[0].id, "b");
  assert.equal(last.sections[0].records[0].id, 80);
  assert.equal(reviewPage(groups, 99).page, 1);
  assert.equal(reviewPage([], 99).total, 0);
});
