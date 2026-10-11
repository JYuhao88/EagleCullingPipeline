import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_LINE = 140;
const ROOTS = ["src", "scripts", "test"];
const EXTENSIONS = new Set([".js", ".mjs", ".css", ".html"]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures") continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

test(`source files keep lines under ${MAX_LINE} characters`, async () => {
  const offenders = [];
  for (const root of ROOTS) {
    for await (const file of walk(root)) {
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.length > MAX_LINE) offenders.push(`${file}:${index + 1} (${line.length})`);
      });
    }
  }
  assert.deepEqual(offenders, [], `Overlong lines:\n${offenders.join("\n")}`);
});
