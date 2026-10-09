// Read-only: reconciles task records with the current Eagle catalogue.
// A persisted "running" record does not prove its executor is still alive.
import { EagleApi } from "../src/eagle-api.js";

const taskId = process.argv[2];
if (!taskId || !/^task-[a-zA-Z0-9-]+$/.test(taskId)) throw new Error("Usage: node scripts/audit-restoration.mjs task-ID");
const response = await fetch(`http://127.0.0.1:43125/tasks/${taskId}`, { signal: AbortSignal.timeout(10000) });
if (!response.ok) throw new Error(`Task service HTTP ${response.status}`);
const task = await response.json();
const api = new EagleApi();
const catalogue = new Map();
for await (const item of api.items({ limit: 1000 })) catalogue.set(item.id, item);
const remaining = task.items.filter((item) => !["succeeded", "skipped"].includes(item.status));
const skipped = task.items.filter((item) => item.status === "skipped");
console.log(JSON.stringify({
  taskId, recordedStatus: task.status, lastCheckpoint: task.updatedAt,
  secondsSinceCheckpoint: Math.round((Date.now() - Date.parse(task.updatedAt)) / 1000),
  summary: task.summary,
  skippedAbsentFromCurrentCatalogue: skipped.filter((item) => !catalogue.has(item.id)).length,
  remaining: remaining.map((item) => {
    const current = catalogue.get(item.id);
    return { id: item.id, recordedStatus: item.status, present: Boolean(current), name: current?.name, ext: current?.ext, width: current?.width, height: current?.height };
  }),
}, null, 2));
