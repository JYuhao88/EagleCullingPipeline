import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, reportCsv, reportJson } from "../src/core/report.js";
import { formatApplyResult } from "../src/plugin/format.js";
import { createWritebackDialog } from "../src/plugin/writeback-dialog.js";
import { createStartView } from "../src/plugin/start-view.js";

class FakeElement {
  constructor() { this.listeners = {}; this.checked = false; this.hidden = false; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { return this.listeners.click?.(); }
  querySelector() { return { value: "" }; }
  replaceChildren() {}
  append() {}
}

function fakeRoot(ids) {
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  return { querySelector: id => elements[id], elements };
}

test("report uses applied tags and rounds numeric values", () => {
  const rows = buildReport({
    units: [{ id: "u1", itemIds: ["i1"] }],
    results: [{ unitId: "u1", score: 0.123456, metrics: { sharpness: 0.987654 } }],
    groups: [{ id: "g1", unitIds: ["u1"], ranking: [{ unitId: "u1", rank: 1, score: 0.123456 }] }],
    items: [{ id: "i1", name: "a.jpg", tags: ["手工"] }],
    decisions: [{ unitId: "u1", action: "selected", source: "human", flags: [] }],
    applied: [{ id: "i1", tags: ["手工", "AI精选"] }]
  });
  assert.equal(rows[0].score, 0.123);
  assert.equal(rows[0].sharpness, 0.988);
  assert.equal(rows[0].tags, "手工；AI精选");
  assert.equal(rows[0].tagsSource, "applied");
  assert.match(reportCsv(rows), /^\uFEFF/);
  assert.equal(JSON.parse(reportJson(rows))[0].score, 0.123);
});

test("report falls back to planned tags and emits null in JSON", () => {
  const rows = buildReport({
    units: [{ id: "u1", itemIds: ["i1"] }],
    results: [{ unitId: "u1", metrics: { sharpness: null }, flags: ["blurry"] }],
    groups: [{ id: "g1", unitIds: ["u1"], ranking: [{ unitId: "u1" }] }],
    items: [{ id: "i1", tags: [] }]
  });
  assert.equal(rows[0].tags, "AI候选；AI模糊");
  assert.equal(rows[0].tagsSource, "planned");
  assert.equal(rows[0].sharpness, null);
  assert.equal(JSON.parse(reportJson(rows))[0].sharpness, null);
});

test("apply result formatter summarizes failures, warning and report links", () => {
  const summary = formatApplyResult({
    summary: { changed: 2, unchanged: 1 },
    results: [{ id: "a", fileName: "a.jpg", ok: false, error: "权限不足" }],
    liveTags: false,
    warning: "预览标签可能过期",
    trash: { ids: ["b"] }
  }, { base: "http://localhost/", runId: "run-1" });
  assert.match(summary, /已修改 2 项/);
  assert.match(summary, /失败 1 项/);
  assert.match(summary, /a\.jpg：权限不足/);
  assert.match(summary, /移入回收站 1 项/);
  assert.match(summary, /使用 Eagle 实时标签：否/);
  assert.match(summary, /runs\/run-1\/report\?format=csv/);
});

test("writeback confirmation is re-entry safe", async () => {
  const root = fakeRoot([
    "#writeback", "#moveTrash", "#trashConfirm", "#writebackDialog", "#writebackSummary",
    "#confirmWriteback", "#dryRun", "#cancelWriteback", "#writebackDetails", "#revertWriteback"
  ]);
  const dialog = root.elements["#writebackDialog"];
  dialog.close = () => {};
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  createWritebackDialog({ root, api: async () => { calls += 1; await pending; return { summary: {} }; }, runId: "run-1" });
  const first = root.elements["#confirmWriteback"].click();
  const second = root.elements["#confirmWriteback"].click();
  assert.equal(calls, 1);
  release({});
  await Promise.all([first, second]);
  assert.equal(root.elements["#confirmWriteback"].disabled, false);
});

test("completed polling invokes onRun once", async () => {
  const root = fakeRoot(["#health", "#libraryPath", "#runId", "#progress", "#bar", "#progressText",
    "#analyzeSelected", "#analyzeAll", "#cancel", "#openRun", "#serviceGuide", "#repositoryPath", "#serviceCommand",
    "#copyServiceCommand", "#retryService", "#startService"]);
  root.elements["#libraryPath"].value = "/library";
  globalThis.localStorage = { setItem() {}, getItem() { return "[]"; } };
  let statusCalls = 0;
  let opened = 0;
  const api = async path => {
    if (path === "/health") return { service: "test" };
    if (path === "/runs") return { id: "run-1" };
    statusCalls += 1;
    return { id: "run-1", status: "completed", progress: { total: 1, completed: 1 } };
  };
  createStartView({ root, api, onRun: async () => { opened += 1; } });
  await root.elements["#analyzeAll"].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(statusCalls, 1);
  assert.equal(opened, 1);
});

test("disconnected start view exposes absolute command and retry hides guide after health succeeds", async () => {
  const root = fakeRoot(["#health", "#libraryPath", "#runId", "#progress", "#bar", "#progressText",
    "#analyzeSelected", "#analyzeAll", "#cancel", "#openRun", "#serviceGuide", "#repositoryPath", "#serviceCommand",
    "#copyServiceCommand", "#retryService", "#startService"]);
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => "/tmp/photo repo", setItem() {} };
  let connected = false;
  const api = async () => {
    if (!connected) throw new Error("offline");
    return { service: "eagle-culling" };
  };
  api.base = "http://127.0.0.1:43210";
  try {
    const view = createStartView({ root, api, onRun() {}, autoCheck: false });
    await view.checkHealth();
    assert.equal(root.elements["#serviceGuide"].hidden, false);
    assert.match(root.elements["#serviceCommand"].textContent, /cd '\/tmp\/photo repo'.*--concurrency 1 --port 43210/);
    assert.equal(root.elements["#startService"].hidden, true);
    connected = true;
    await root.elements["#retryService"].click();
    assert.equal(root.elements["#serviceGuide"].hidden, true);
  } finally { globalThis.localStorage = originalStorage; }
});

test("writeback preview renders counts and only first 50 changed names without executing", async () => {
  const root = fakeRoot([
    "#writeback", "#moveTrash", "#trashConfirm", "#writebackDialog", "#writebackSummary",
    "#confirmWriteback", "#dryRun", "#cancelWriteback", "#writebackDetails", "#revertWriteback"
  ]);
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => {
    const element = new FakeElement();
    element.children = [];
    element.append = child => element.children.push(child);
    return element;
  } };
  const sections = [];
  root.elements["#writebackDetails"].append = section => sections.push(section);
  const requests = [];
  const api = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return { summary: { changed: 51, unchanged: 3, addedTags: 51, removedTags: 51, tags: {}, byAction: {
      rejected: { changed: 51, unchanged: 3, addedTags: 51, removedTags: 51 }
    } }, results: Array.from({ length: 51 }, (_, index) => ({
      id: `file-${index}`, fileName: `<file-${index}>`, action: "rejected", changed: true,
      addedTags: ["AI淘汰"], removedTags: ["AI精选"]
    })) };
  };
  try {
    const view = createWritebackDialog({ root, api, runId: "run-test" });
    await view.dryRun();
    assert.deepEqual(requests, [{ apply: false }]);
    assert.match(root.elements["#writebackSummary"].textContent, /无变化 3 个文件/);
    assert.match(sections[0].children[0].textContent, /新增 51 \/ 移除 51/);
    const names = sections[0].children[1].textContent;
    assert.match(names, /<file-49>.*新增 AI淘汰；移除 AI精选/);
    assert.doesNotMatch(names, /<file-50>/);
    assert.match(names, /仅显示前 50 条，共 51 条/);
  } finally { globalThis.document = originalDocument; }
});
