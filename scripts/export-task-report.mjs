// Read-only task snapshot export, usable even while the legacy service runs.
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTaskReport, taskExceptionsCsv } from "../src/plugin/task-report.js";

const taskId=process.argv[2];
if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Usage: node scripts/export-task-report.mjs <task-id>");
const response=await fetch(`http://127.0.0.1:43125/tasks/${taskId}`,{signal:AbortSignal.timeout(10000)});
if (!response.ok) throw new Error(`Read-only task request failed: HTTP ${response.status}`);
const report=buildTaskReport(await response.json());
const root=await mkdtemp(path.join(os.tmpdir(),"eagle-task-report-"));
const jsonPath=path.join(root,"report.json");
const csvPath=path.join(root,"exceptions.csv");
await writeFile(jsonPath,JSON.stringify(report,null,2),"utf8");
await writeFile(csvPath,taskExceptionsCsv(report),"utf8");
console.log(JSON.stringify({taskId:report.taskId,status:report.status,snapshotAt:report.snapshotAt,taskUpdatedAt:report.taskUpdatedAt,
  counts:report.counts,jsonPath,csvPath,caveats:report.caveats},null,2));
