const fallbackBase = "http://127.0.0.1:43125";
import { rankedUnitIds } from "./selection.js";

export const initialState = {
  base: globalThis.localStorage?.getItem("eagle-culling-base") || fallbackBase,
  runId: null,
  run: null,
  data: null,
  decisions: [],
  groupIndex: 0,
  unitIndex: 0,
  filter: "multi",
  history: [],
  zoomed: false,
  faceCompare: false,
  selected: [],
  candidateMode: false
};

export function reviewPageQuery(state) {
  const page = state.data?.page;
  return page ? `?limit=20&cursor=${page.cursor || 0}&filter=${encodeURIComponent(state.filter || 'all')}` : '';
}

export async function resolveBase({ locationRef = globalThis.location,
  storage = globalThis.localStorage, fetchImpl = globalThis.fetch } = {}) {
  const origin = locationRef?.protocol === "http:" ? locationRef.origin : "";
  if (origin && typeof fetchImpl === "function") {
    try {
      const response = await fetchImpl(`${origin}/health`);
      const body = await response.json();
      if (response.ok && body.service === "eagle-culling") return origin;
    } catch {
      // The plugin may be served by a static web server.
    }
  }
  return storage?.getItem("eagle-culling-base") || fallbackBase;
}

const indexes = new WeakMap();
const filtered = new WeakMap();
export function reviewIndex(state) {
  let index = indexes.get(state);
  if (!index) {
    index = { results: new Map((state.data?.results || []).map(row => [row.unitId, row])),
      units: new Map((state.data?.units || []).map(row => [row.id, row])),
      items: new Map((state.data?.items || []).map(row => [row.id, row])),
      decisions: new Map((state.decisions || []).map(row => [row.unitId, row])),
      human: new Set((state.decisions || []).filter(row => row.source === "human").map(row => row.unitId)) };
    indexes.set(state, index);
  }
  return index;
}
export function decisionFor(state, unitId, group) {
  return reviewIndex(state).decisions.get(unitId) || {
    unitId,
    action: group?.suggested?.[unitId] || "candidate",
    source: "suggested",
    flags: []
  };
}

export function isIssue(result) {
  return (result?.flags || []).length > 0;
}

function groupMatchesFilter(group, state) {
  if (state.filter === "confirm") return group.confidence === "low";
  if (state.filter === "multi" || state.filter === "low-first") return group.unitIds.length > 1;
  if (state.filter === "unreviewed") {
    return group.unitIds.some(unitId => !reviewIndex(state).human.has(unitId));
  }
  if (state.filter === "reviewed") {
    return group.unitIds.every(unitId => reviewIndex(state).human.has(unitId));
  }
  if (!["issues", "eyes-closed", "blurry"].includes(state.filter)) return true;
  return group.unitIds.some(unitId => {
    const result = reviewIndex(state).results.get(unitId);
    const flags = result?.flags || [];
    if (state.filter === "issues") return flags.length > 0;
    if (state.filter === "eyes-closed") return flags.includes("eyes-closed");
    return flags.includes("blurry") || flags.includes("possibly-blurry");
  });
}

export function filteredGroups(state) {
  if (filtered.has(state)) return filtered.get(state);
  const groups = (state.data?.groups || []).filter(group => groupMatchesFilter(group, state));
  const value = state.filter === "low-first"
    ? groups.sort((a, b) => Number(b.confidence === "low") - Number(a.confidence === "low"))
    : groups;
  filtered.set(state, value);
  return value;
}

export function reviewProgress(state) {
  const groups = filteredGroups(state);
  const reviewed = groups.filter(group => group.unitIds.every(unitId =>
    reviewIndex(state).human.has(unitId)
  )).length;
  return { reviewed, total: groups.length };
}

export function decisionSnapshot(state, unitIds) {
  return unitIds.map(unitId => {
    const decision = state.decisions.find(item => item.unitId === unitId && item.source === "human");
    return { unitId, decision: decision ? { ...decision } : null };
  });
}

export function applyDecisionBatch(state, decisions, previous) {
  const changed = new Map(state.decisions.map(item => [item.unitId, item]));
  for (const decision of decisions) {
    if (decision.clear) changed.delete(decision.unitId);
    else changed.set(decision.unitId, decision);
  }
  return {
    ...state,
    decisions: [...changed.values()],
    history: previous ? [...state.history, previous] : state.history
  };
}

export function undoDecision(state) {
  const previous = state.history.at(-1);
  if (!previous) return { state, requests: [] };
  const decisions = new Map(state.decisions.map(item => [item.unitId, item]));
  const requests = previous.map(item => {
    if (item.decision) {
      decisions.set(item.unitId, item.decision);
      return item.decision;
    }
    decisions.delete(item.unitId);
    return { unitId: item.unitId, clear: true };
  });
  return {
    state: { ...state, decisions: [...decisions.values()], history: state.history.slice(0, -1) },
    requests
  };
}

export function reduceState(state, action) {
  if (action.type === "load") {
    return {
      ...state,
      runId: action.runId,
      data: action.data,
      decisions: action.decisions,
      groupIndex: 0,
      unitIndex: 0,
      history: [],
      faceCompare: false,
      selected: [],
      candidateMode: false
    };
  }
  if (action.type === "decisionBatch") {
    return applyDecisionBatch(state, action.decisions, action.previous);
  }
  if (action.type === "group") {
    return {
      ...state,
      groupIndex: Math.max(0, Math.min(action.index, filteredGroups(state).length - 1)),
      faceCompare: false,
      unitIndex: 0
    };
  }
  if (action.type === "unit") {
    const last = Math.max(0, currentGroup(state).unitIds.length - 1);
    return { ...state, unitIndex: Math.max(0, Math.min(action.index, last)) };
  }
  if (action.type === "filter") {
    return { ...state, filter: action.value, groupIndex: 0, unitIndex: 0, faceCompare: false };
  }
  if (action.type === "faceCompare") return { ...state, faceCompare: action.value ?? !state.faceCompare };
  if (action.type === "zoom") {
    return { ...state, zoomed: action.value ?? !state.zoomed };
  }
  if (action.type === "selection") return { ...state, selected: action.selected };
  if (action.type === "candidateMode") return { ...state, candidateMode: Boolean(action.value) };
  return state;
}

export function currentGroup(state) {
  const group = filteredGroups(state)[state.groupIndex] || { unitIds: [], ranking: [] };
  const candidateIds = state.candidateMode && group.candidateSet?.unitIds?.length
    ? new Set(group.candidateSet.unitIds) : null;
  return { ...group, unitIds: rankedUnitIds(group).filter(id => !candidateIds || candidateIds.has(id)) };
}

export function refreshGroups(state, data, decisions, focusUnitId = null) {
  const next = { ...state, data, decisions, selected: [] };
  const groups = filteredGroups(next);
  const focusedGroup = groups.findIndex(group => group.unitIds.includes(focusUnitId));
  next.groupIndex = focusedGroup >= 0 ? focusedGroup : Math.max(0, Math.min(next.groupIndex, groups.length - 1));
  next.unitIndex = Math.max(0, currentGroup(next).unitIds.indexOf(focusUnitId));
  return next;
}
