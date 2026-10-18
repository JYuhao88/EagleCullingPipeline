import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, reportCsv, reportJson } from "../src/core/report.js";
import { createWritebackDialog } from "../src/plugin/writeback-dialog.js";

class FakeElement {
  constructor() { this.listeners = {}; this.checked = false; this.hidden = false; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { return this.listeners.click?.(); }
  querySelector() { return { value: "" }; }
  replaceChildren() {}
  append() {}
}

function dialogRoot() {
  const ids = ["#writeback", "#moveTrash", "#trashConfirm", "#writebackDialog", "#writebackSummary",
    "#confirmWriteback", "#dryRun", "#cancelWriteback", "#writebackDetails", "#revertWriteback"];
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

test("report CSV has Chinese columns and ranking reasons", () => {
  const csv = reportCsv(buildReport({
    units: [{ id: "unit:a", itemIds: ["a"], pairing: "single" }],
    results: [{ unitId: "unit:a", flags: [], metrics: {} }],
    groups: [{ id: "group:a", unitIds: ["unit:a"], ranking: [{ unitId: "unit:a", rank: 1, score: 1, reasons: ["清晰"] }] }],
    items: [{ id: "a", name: "照片", ext: "jpg", tags: [] }]
  }));
  assert.match(csv, /itemId,.*decisionSource/);
  assert.match(csv, /清晰/);
});

test("free reason included in JSON/CSV export with quote escaping", () => {
  const rows = buildReport({ units: [{ id: "unit:a", itemIds: ["a"] }], results: [{ unitId: "unit:a" }],
    groups: [{ unitIds: ["unit:a"], ranking: [{ unitId: "unit:a" }] }], items: [{ id: "a" }],
    decisions: [{ unitId: "unit:a", action: "selected", reason: '手势 "自然"' }] });
  assert.equal(rows[0].decisionReason, '手势 "自然"'); assert.match(reportCsv(rows), /手势 ""自然""/);
});

test("writeback confirmation is re-entry safe", async () => {
  const root = dialogRoot();
  const dialog = root.elements["#writebackDialog"];
  dialog.close = () => {};
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const view = createWritebackDialog({ root, api: async (_path, options) => {
    if (!JSON.parse(options.body).apply) return { summary: { tags: {} }, results: [] };
    calls += 1; await pending; return { summary: {} };
  }, runId: "run-1" });
  await view.dryRun();
  const first = root.elements["#confirmWriteback"].click();
  const second = root.elements["#confirmWriteback"].click();
  assert.equal(calls, 1);
  release({});
  await Promise.all([first, second]);
  assert.equal(root.elements["#confirmWriteback"].disabled, false);
});

test("slow writeback preview shows progress, blocks repeat clicks and reports failures", async () => {
  const root = dialogRoot();
  let calls = 0;
  let fail;
  const pending = new Promise((_, reject) => { fail = reject; });
  createWritebackDialog({ root, api: async () => { calls += 1; return pending; }, runId: "run-1" });
  const first = root.elements["#dryRun"].click();
  root.elements["#dryRun"].click();
  assert.equal(calls, 1);
  assert.equal(root.elements["#dryRun"].disabled, true);
  assert.match(root.elements["#writeback"].textContent, /正在生成写回预览/);
  fail(new Error("服务未响应"));
  await first;
  assert.equal(root.elements["#dryRun"].disabled, false);
  assert.equal(root.elements["#writeback"].textContent, "无法生成写回预览：服务未响应");
});

test("writeback preview renders counts and only first 50 changed names without executing", async () => {
  const root = dialogRoot();
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
