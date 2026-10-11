import test from "node:test";
import assert from "node:assert/strict";
import {
  initialState,
  reduceState,
  filteredGroups,
  reviewProgress,
  undoDecision,
  decisionSnapshot
  , resolveBase
} from "../src/plugin/state.js";
import { keyboardAction } from "../src/plugin/keyboard.js";
import { rankedUnitIds, toggleSelection, groupStatus, groupIssues } from "../src/plugin/selection.js";
import { decisionRequests, issueUnitIds } from "../src/plugin/batch.js";
import { formatTotalScore, scoreParts } from "../src/plugin/score.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { RunStore } from "../src/server/run-store.js";
import { createRunsRouter } from "../src/server/runs-routes.js";

const data = {
  groups: [
    { id: "g1", unitIds: ["u1", "u2"], suggested: { u1: "selected", u2: "candidate" } },
    { id: "g2", unitIds: ["u3"] }
  ],
  results: [
    { unitId: "u1", flags: ["blurry"] },
    { unitId: "u2", flags: [] },
    { unitId: "u3", flags: ["eyes-closed"] }
  ]
};

test("state filters groups and counts fully reviewed groups", () => {
  let state = {
    ...initialState,
    data,
    decisions: [
      { unitId: "u1", source: "human", action: "selected" },
      { unitId: "u2", source: "human", action: "candidate" }
    ]
  };
  assert.deepEqual(reviewProgress(state), { reviewed: 1, total: 1 });
  state = reduceState(state, { type: "filter", value: "blurry" });
  assert.deepEqual(filteredGroups(state).map(group => group.id), ["g1"]);
});

test("keyboard mapping ignores inputs and supports review shortcuts", () => {
  assert.equal(keyboardAction({ key: "1" }, true), null);
  assert.deepEqual(keyboardAction({ key: "S" }), { type: "selectBest" });
  assert.deepEqual(
    keyboardAction({ key: "Enter", shiftKey: true }),
    { type: "group", delta: -1 }
  );
  assert.deepEqual(keyboardAction({ key: " " }), { type: "zoom" });
});

test("undo reducer restores a previous decision", () => {
  const state = {
    ...initialState,
    decisions: [{ unitId: "u1", action: "selected", source: "human" }],
    history: [[{ unitId: "u1", decision: { unitId: "u1", action: "candidate", source: "human" } }]]
  };
  const result = undoDecision(state);
  assert.equal(result.state.decisions[0].action, "candidate");
  assert.deepEqual(result.requests[0].action, "candidate");
});

test("select-best batch updates every unit and records one history entry", () => {
  const state = {
    ...initialState,
    data,
    decisions: [{ unitId: "u1", action: "selected", source: "human" }]
  };
  const previous = [
    { unitId: "u1", decision: state.decisions[0] },
    { unitId: "u2", decision: null }
  ];
  const next = reduceState(state, {
    type: "decisionBatch",
    decisions: [
      { unitId: "u1", action: "candidate", source: "human" },
      { unitId: "u2", action: "selected", source: "human" }
    ],
    previous
  });
  assert.deepEqual(next.decisions.map(item => item.action), ["candidate", "selected"]);
  assert.equal(next.history.length, 1);
});

test("undo restores suggestion by producing a clear request", () => {
  const state = {
    ...initialState,
    decisions: [{ unitId: "u1", action: "rejected", source: "human" }],
    history: [[{ unitId: "u1", decision: null }]]
  };
  const result = undoDecision(state);
  assert.deepEqual(result.requests, [{ unitId: "u1", clear: true }]);
  assert.equal(result.state.decisions.length, 0);
});


test("snapshot treats server-provided suggestions as no human decision", () => {
  const state = {
    ...initialState,
    decisions: [
      { unitId: "u1", action: "selected", source: "suggested" },
      { unitId: "u2", action: "rejected", source: "human" }
    ]
  };
  const snapshot = decisionSnapshot(state, ["u1", "u2"]);
  assert.equal(snapshot[0].decision, null);
  assert.equal(snapshot[1].decision.action, "rejected");
});

test("unit focus stays inside the current group", () => {
  let state = { ...initialState, data, groupIndex: 0, unitIndex: 0 };
  state = reduceState(state, { type: "unit", index: 5 });
  assert.equal(state.unitIndex, 1);
  state = reduceState(state, { type: "unit", index: -3 });
  assert.equal(state.unitIndex, 0);
});

test("group cards sort by ascending rank and expose status/issues", () => {
  const group = { unitIds: ["u2", "u1"], ranking: [{ unitId: "u1", rank: 1 }, { unitId: "u2", rank: 2 }] };
  assert.deepEqual(rankedUnitIds(group), ["u1", "u2"]);
  assert.equal(groupStatus(group, [{ unitId: "u1", source: "human" }, { unitId: "u2", source: "human" }]), "已审");
});

test("selection supports toggle and shift range", () => {
  assert.deepEqual(toggleSelection([], "u2"), ["u2"]);
  assert.deepEqual(toggleSelection(["u2"], "u4", { range: true, orderedIds: ["u1", "u2", "u3", "u4"] }), ["u2", "u3", "u4"]);
});

test("score formatting keeps missing metrics distinct from zero", () => {
  assert.equal(formatTotalScore(0.876), "88 分");
  assert.equal(scoreParts({ metrics: { sharpness: null, exposure: 0 } })[0].display, "—");
  assert.equal(scoreParts({ metrics: { sharpness: null, exposure: 0 } })[1].display, "0");
  const eyes = metrics => scoreParts({ metrics }).find(part => part.key === "eyesOpen").display;
  assert.equal(eyes({ faces: 2, eyesClosed: 1 }), "50");
  assert.equal(eyes({ faces: 0, eyesClosed: 0 }), "—");
});

test("batch decisions produce one request per selected unit", () => {
  assert.deepEqual(decisionRequests(["u1", "u3"], "rejected"), [
    { unitId: "u1", action: "rejected", flags: [], source: "human" },
    { unitId: "u3", action: "rejected", flags: [], source: "human" }
  ]);
});

test("group issue markers and issue batch targets use result flags", () => {
  assert.deepEqual(groupIssues(data.groups[0], data.results), ["blurry"]);
  assert.deepEqual(issueUnitIds(data.groups, data.results, "eyes-closed"), ["u3"]);
  const tentative = [{ unitId: "u1", flags: ["possibly-blurry"] }];
  assert.deepEqual(issueUnitIds([{ unitIds: ["u1"] }], tentative, "blurry"), []);
});

test("keyboard maps sync zoom, full preview and undo shortcuts", () => {
  assert.deepEqual(keyboardAction({ key: "z" }), { type: "syncZoom" });
  assert.deepEqual(keyboardAction({ key: " " }), { type: "zoom" });
  assert.deepEqual(keyboardAction({ key: "z", ctrlKey: true }), { type: "undo" });
  assert.deepEqual(keyboardAction({ key: "Escape" }), { type: "clearSelection" });
});

test("base resolution prefers Eagle service health over static page origin", async () => {
  const calls = [];
  const base = await resolveBase({
    locationRef: { protocol: "http:", origin: "http://static:43128" },
    storage: { getItem: () => "http://saved:43125" },
    fetchImpl: async url => {
      calls.push(url);
      return { ok: true, json: async () => ({ service: "eagle-culling" }) };
    }
  });
  assert.equal(base, "http://static:43128");
  assert.deepEqual(calls, ["http://static:43128/health"]);
});

test("issue batch excludes units with human decisions", () => {
  assert.deepEqual(issueUnitIds(data.groups, data.results, "blurry", [
    { unitId: "u1", source: "human", action: "selected" }
  ]), []);
});

test("detail route generates and caches a 2048-bound JPEG", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eagle-detail-"));
  const source = path.join(root, "source.png");
  await sharp({ create: { width: 2600, height: 1200, channels: 3, background: "#336699" } })
    .png().toFile(source);
  const store = new RunStore(path.join(root, "runs"));
  const run = { id: "run-detail", status: "completed" };
  await store.save(run, {
    run,
    units: [{ id: "unit:a", primaryItemId: "a" }],
    results: [{ unitId: "unit:a", previewPath: path.join(root, "preview.png") }],
    groups: [],
    items: [{ id: "a", filePath: source }]
  });
  await sharp({ create: { width: 800, height: 400, channels: 3, background: "#cc3311" } })
    .png().toFile(path.join(root, "preview.png"));
  const route = createRunsRouter({ store, pipeline: {} });
  let body;
  const response = { writeHead: (status, headers) => { response.status = status; response.headers = headers; },
    end: value => { body = value; } };
  await route({ method: "GET", url: "/runs/run-detail/detail/unit%3Aa" }, response,
    new URL("http://localhost/runs/run-detail/detail/unit%3Aa"));
  assert.equal(response.status, 200);
  const metadata = await sharp(body).metadata();
  assert.equal(Math.max(metadata.width, metadata.height), 2048);
});
