import assert from "node:assert/strict";
import test from "node:test";
import { applyReview, buildUpdate } from "../src/review.js";

test("builds a non-destructive tag update while preserving user tags", () => {
  const update = buildUpdate({ id: "A", action: "selected", star: 5 }, { tags: ["travel", "ai:candidate"], folders: ["original"] }, { selected: "selected-folder" });
  assert.deepEqual(update, { id: "A", tags: ["travel", "ai:selected"], folders: ["original", "selected-folder"], star: 5 });
});

test("review application is dry-run by default and writes only when enabled", async () => {
  const calls = [];
  const api = { updateItem: async (update) => { calls.push(update); return update; } };
  const review = { decisions: [{ id: "A", action: "candidate" }, { id: "B", action: "rejected" }] };
  const dry = await applyReview(api, review);
  assert.equal(dry.applied, false);
  assert.equal(calls.length, 0);
  const applied = await applyReview(api, review, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(calls.length, 2);
});
