import assert from "node:assert/strict";
import test from "node:test";
import { detectFaces } from "../src/face.js";

test("face analysis reports an explicit availability state on Node", async () => {
  const result = await detectFaces("missing-image.jpg", { modelPath: "missing-face-model.task" });
  assert.ok([true, false].includes(result.available));
  assert.ok(result.available || result.error);
});
