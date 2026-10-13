import test from "node:test";
import assert from "node:assert/strict";
import { defaultRepository, serviceCommand, serviceOptions, progressEstimate } from "../src/plugin/service-start.js";

test("default repository is derived from the file:// plugin location", () => {
  assert.equal(defaultRepository({ protocol: "file:", pathname: "/home/test-user/My%20Repo/src/plugin/index.html" }),
    "/home/test-user/My Repo");
  assert.equal(defaultRepository({ protocol: "http:", pathname: "/index.html" }), "");
  assert.equal(defaultRepository({ protocol: "file:", pathname: "/tmp/index.html" }), "");
});

test("service command quotes absolute repository paths and matches spawn port", () => {
  assert.equal(serviceCommand("/tmp/a'b", "http://127.0.0.1:54321", "darwin"),
    "cd '/tmp/a'\\''b' && nice -n 15 node src/cli.js serve --concurrency 1 --port 54321");
  assert.deepEqual(serviceOptions("/tmp/repo", "http://localhost:54321", "darwin"), { cwd: "/tmp/repo", port: 54321 });
  assert.throws(() => serviceOptions("relative", "http://localhost"), /绝对路径/);
  assert.throws(() => serviceOptions("/tmp/repo", "http://remote:43125", "darwin"), /本机/);
});

test("ETA uses server sliding-window measurement and keeps legacy estimates unknown", () => {
  const run = { startedAt: "2026-10-09T00:00:00Z", progress: { stage: "metrics", completed: 2, total: 10 } };
  const now = Date.parse(run.startedAt) + 10000;
  assert.equal(progressEstimate(run, now), null);
  assert.equal(progressEstimate({ ...run, progress: { ...run.progress, remainingSeconds: 40.1 } }), 41);
  assert.equal(progressEstimate({ ...run, progress: { stage: "focus", remainingSeconds: 12 } }), 12);
  assert.equal(progressEstimate({ ...run, progress: { remainingSeconds: -1 } }), null);
  assert.equal(progressEstimate({ progress: run.progress }, now), null);
});

test("Windows plugin paths use PowerShell literal quoting and reject drive-relative paths", () => {
  assert.equal(defaultRepository({ protocol: "file:", pathname: "/D:/photo%20repo/src/plugin/index.html" }), "D:/photo repo");
  assert.equal(serviceOptions("D:\\photo repo", "http://localhost:43125").cwd, "D:\\photo repo");
  assert.match(serviceCommand("D:/a'b"), /Set-Location -LiteralPath 'D:\/a''b'/);
  assert.match(serviceCommand("D:/repo"), /PriorityClass='BelowNormal'/);
  assert.throws(() => serviceOptions("D:repo", "http://localhost"), /绝对路径/);
  assert.throws(() => serviceOptions("D:/repo\nnode bad", "http://localhost"), /绝对路径/);
});
