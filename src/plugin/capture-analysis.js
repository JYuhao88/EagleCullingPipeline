import { buildCaptureIndex } from "./capture-units.js";
import { SCORING_VERSION } from "./analysis-version.js";

export function planCaptureAnalysis(catalogue, selected) {
  const captures = buildCaptureIndex(catalogue);
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const selectedById = new Map(selected.map((item) => [item.id, item]));
  const included = new Set();
  const entries = [];
  for (const item of selected) {
    if (included.has(item.id)) continue;
    const capture = captures.get(item.id);
    const members = (capture?.status === "paired" ? capture.itemIds : [item.id]).filter((id) => selectedById.has(id));
    const sourceId = capture?.status === "paired"
      ? capture.itemIds.find((id) => ["jpg", "jpeg", "heic", "heif"].includes(String(byId.get(id).ext).toLowerCase().replace(/^\./, "")))
      : item.id;
    const source = byId.get(sourceId);
    if (!source) throw new Error("分析来源不在当前目录中");
    for (const id of members) included.add(id);
    entries.push({ id: item.id, modifiedAt: item.modifiedAt ?? null, status: "pending", attempts: 0, result: {
      analysisPlan: { sourceId, sourceModifiedAt: source.modifiedAt ?? null, captureStatus: capture?.status || "single", captureItemIds: capture?.status === "paired" ? capture.itemIds : [item.id], members: members.map((id) => ({ id, modifiedAt: selectedById.get(id).modifiedAt ?? null })) },
    } });
  }
  return entries;
}

export function materializeCaptureAnalysis(result, members, sourceId, plan = {}) {
  return members.map((member) => ({
    ...result,
    ...member,
    // Keep the analysis metrics, but never replace original dimensions/metadata
    // with the paired JPEG's dimensions or its tags/star/folders.
    qualityScore: result.qualityScore,
    qualityFlags: result.qualityFlags,
    metrics: result.metrics,
    phash: result.phash,
    face: result.face,
    qualityMethod: result.qualityMethod || "heuristic-preview",
    confidence: result.confidenceCalibrated === true ? result.confidence : null,
    confidenceCalibrated: result.confidenceCalibrated === true,
    analysisSource: member.id === sourceId ? result.analysisSource : "paired-proxy",
    analysisSourceId: sourceId,
    analysisSourceModifiedAt: plan.sourceModifiedAt ?? result.analysisSourceModifiedAt ?? result.modifiedAt ?? null,
    resolutionVerified: member.id === sourceId ? result.resolutionVerified : false,
    captureStatus: plan.captureStatus,
    captureItemIds: plan.captureItemIds,
  }));
}

// Read again after inference: the Eagle UI may have changed metadata while the
// local service was working. No Item objects are cached across these reads.
export async function readCaptureAnalysisContext(plan, readItem) {
  const ids = [...new Set([plan.sourceId, ...plan.members.map((member) => member.id)])];
  const items = await Promise.all(ids.map((id) => readItem(id)));
  const byId = new Map(items.filter(Boolean).map((item) => [item.id, item]));
  const source = byId.get(plan.sourceId);
  const members = plan.members.map((member) => byId.get(member.id));
  const error = !source || members.some((member) => !member)
    ? "配对分析来源或成员缺失"
    : plan.sourceModifiedAt != null && source.modifiedAt !== plan.sourceModifiedAt || plan.members.some((member, index) => member.modifiedAt != null && members[index].modifiedAt !== member.modifiedAt)
    ? "配对成员已修改，未复用旧分析计划"
    : null;
  return { source, members, error };
}

export function overlayCachedAnalysis(current, cached, source) {
  if (!cached) return current;
  const [result] = materializeCaptureAnalysis(cached, [current], cached.analysisSourceId || cached.id, {
    captureStatus: cached.captureStatus, captureItemIds: cached.captureItemIds,
  });
  const staleReasons = [];
  if (cached.modifiedAt != null && cached.modifiedAt !== current.modifiedAt) staleReasons.push("item-modified");
  if (cached.scoringVersion !== SCORING_VERSION) staleReasons.push("scoring-version");
  if (cached.analysisSourceId && cached.analysisSourceId !== current.id && (!source || cached.analysisSourceModifiedAt == null || source.modifiedAt !== cached.analysisSourceModifiedAt)) staleReasons.push("source-modified");
  return { ...result, analysisStale: staleReasons.length > 0, analysisStaleReasons: staleReasons };
}
