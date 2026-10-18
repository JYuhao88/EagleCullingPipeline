import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("private settings propagate to Ray submissions and workers fail closed", () => {
  const result = spawnSync(
    (process.env.EAGLE_PYTHON || "python3"),
    ["-m", "unittest", "discover", "-s", "ml/references", "-p", "test_private_*.py"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
