export const DISPLAY_EDGES = Object.freeze([1024, 2048, 3072, 4096, 6144]);

export function snapDisplayEdge(value, sourceLongEdge = Infinity) {
  const requested = Number.isFinite(Number(value)) ? Math.max(1, Number(value)) : DISPLAY_EDGES[0];
  const cap = Number.isFinite(sourceLongEdge) && sourceLongEdge > 0 ? sourceLongEdge : Infinity;
  if (cap < DISPLAY_EDGES[0]) return Math.max(1, Math.floor(cap));
  return Math.min(cap, DISPLAY_EDGES.find(edge => edge >= requested) || DISPLAY_EDGES.at(-1));
}

export function displayEdgeForViewport(width, height, dpr = 1) {
  return snapDisplayEdge(Math.max(Number(width) || 0, Number(height) || 0) * Math.max(1, Number(dpr) || 1));
}

export function displayUrl(base, runId, unitId, cssWidth, cssHeight, dpr = 1) {
  const edge = displayEdgeForViewport(cssWidth, cssHeight, dpr);
  return `${base}/runs/${runId}/display/${encodeURIComponent(unitId)}?edge=${edge}`;
}
