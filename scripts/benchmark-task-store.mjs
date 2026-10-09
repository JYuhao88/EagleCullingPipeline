import { TaskStore } from "../src/task-store.js";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "eagle-store-benchmark-"));
const filePath = path.join(root, "tasks.json");
const store = new TaskStore(filePath);
for (let task = 0; task < 4; task += 1) {
  await store.create({ taskId: `bench-${task}`, items: Array.from({ length: 8000 }, (_, id) => ({ id: String(id) })) });
}
const before = await stat(filePath).catch(() => ({ size: 0 }));
const start = performance.now();
const elapsed = [];
for (let batch = 0; batch < 40; batch += 1) {
  const tick = performance.now();
  await store.updateItems("bench-0", Array.from({ length: 25 }, (_, index) => ({ itemId: String(batch * 25 + index), status: "succeeded" })));
  elapsed.push(performance.now() - tick);
}
elapsed.sort((a, b) => a - b);
const reloaded = new TaskStore(filePath);
const recovered = await reloaded.get("bench-0");
console.log(JSON.stringify({ fixture: "4 tasks x 8000 items, 40 checkpoints x 25 items", totalMs: Math.round(performance.now() - start), p95Ms: Math.round(elapsed[Math.floor(elapsed.length * .95)]), snapshotBytes: before.size, journalBytes: (await stat(`${filePath}.journal`).catch(() => ({ size: 0 }))).size, recoveredSuccesses: recovered.summary.succeeded, rssMiB: Math.round(process.memoryUsage().rss / 1048576), temporaryDirectory: root }, null, 2));
