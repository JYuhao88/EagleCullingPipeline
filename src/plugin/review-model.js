export const REVIEW_STATES = {
  selected: { tag: "ai:selected", label: "精选保留" },
  candidate: { tag: "ai:candidate", label: "候选" },
  rejected: { tag: "ai:rejected", label: "待删除复核" },
  unreviewed: { tag: null, label: "未标记" },
};

const REVIEW_TAGS = new Set(Object.values(REVIEW_STATES).map((entry) => entry.tag).filter(Boolean));
const FLAG_LABELS = {
  "possibly-blurry": "清晰度偏低，可能失焦或存在运动模糊",
  "eyes-closed": "检测到闭眼，请重点复核人物表情",
  overexposed: "高光溢出较多，可能过曝",
  underexposed: "暗部压黑较多，可能欠曝",
  "low-resolution": "分辨率偏低，不建议作为大尺寸输出首选",
};

export function reviewStateFromTags(tags = []) {
  for (const key of ["selected", "candidate", "rejected"]) {
    if (tags.includes(REVIEW_STATES[key].tag)) return key;
  }
  return "unreviewed";
}

export function mergeReviewStateTags(tags = [], state) {
  if (!REVIEW_STATES[state]?.tag) throw new Error(`Unsupported review state: ${state}`);
  return [...new Set([...tags.filter((tag) => !REVIEW_TAGS.has(tag)), REVIEW_STATES[state].tag])];
}

export function qualityFlagsFor(item) {
  const fromAnalysis = Array.isArray(item.qualityFlags) ? item.qualityFlags : [];
  const fromTags = Object.keys(FLAG_LABELS).filter((flag) => (item.tags || []).includes(`ai:${flag}`));
  return [...new Set([...fromAnalysis, ...fromTags])];
}

export function recommendationFor(item, group) {
  if (group?.size > 1) return group.representativeId === item.id ? "selected" : "rejected";
  return "candidate";
}

function percentage(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : null;
}

export function chineseReasons(item, group) {
  const flags = qualityFlagsFor(item);
  const reasons = flags.map((flag) => {
    if (flag === "overexposed" && percentage(item.metrics?.clippedHigh)) return `${FLAG_LABELS[flag]}（高光溢出 ${percentage(item.metrics.clippedHigh)}）`;
    if (flag === "underexposed" && percentage(item.metrics?.clippedLow)) return `${FLAG_LABELS[flag]}（暗部压黑 ${percentage(item.metrics.clippedLow)}）`;
    return FLAG_LABELS[flag] || `检测提示：${flag}`;
  });

  if (group?.size > 1) {
    reasons.push(group.representativeId === item.id
      ? `同组共 ${group.size} 张相似照片，本张综合质量分最高`
      : `同组共 ${group.size} 张相似照片，建议与组内首选并排比较`);
  }
  if ((item.tags || []).includes("ai:original")) reasons.push("RAW/原始格式已作为母片保护，不建议仅因 JPEG 更好看而删除");
  if ((item.tags || []).includes("ai:paired")) reasons.push("已找到对应 RAW/JPEG 或 3FR/HEIC 拍摄配对");
  if ((item.tags || []).includes("ai:pair-uncertain")) reasons.push("同名文件超过一组，配对关系不唯一，需要人工确认");
  if ((item.tags || []).includes("ai:unpaired-original")) reasons.push("未找到对应预览成片，原始母片应优先保留并复核");
  if (item.analysisSource === "proxy") reasons.push("本次使用 Eagle 预览图分析，未解码或修改原片");
  if (reasons.length === 0 && Number.isFinite(item.qualityScore)) reasons.push("未发现明显技术问题，仍需人工判断瞬间、内容和审美价值");
  if (reasons.length === 0) reasons.push("尚未执行本次质量分析；当前只展示 Eagle 已有标签和配对信息");
  return reasons;
}

export function makeReviewRecord(item, group = null) {
  const state = reviewStateFromTags(item.tags);
  const recommendation = recommendationFor(item, group);
  return {
    ...item,
    state,
    stateLabel: REVIEW_STATES[state].label,
    recommendation,
    recommendationLabel: REVIEW_STATES[recommendation].label,
    qualityFlags: qualityFlagsFor(item),
    reasons: chineseReasons(item, group),
    groupId: group?.groupId || null,
    groupSize: group?.size || 1,
    representativeId: group?.representativeId || item.id,
  };
}

export function buildReviewSections(items = [], groups = []) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const included = new Set();
  const sections = [];
  for (const group of groups.filter((entry) => entry.size > 1)) {
    const records = group.items.map((entry) => byId.get(entry.id) || entry).filter(Boolean).map((item) => makeReviewRecord(item, group));
    records.forEach((record) => included.add(record.id));
    sections.push({
      id: group.groupId,
      title: `相似组 ${group.groupId.replace(/^phash-/, "")}`,
      note: `${records.length} 张，已按综合质量排序`,
      records: records.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)),
    });
  }
  const remaining = items.filter((item) => !included.has(item.id)).map((item) => makeReviewRecord(item));
  if (remaining.length) sections.push({ id: "other", title: groups.length ? "其他照片" : "当前选择", note: `${remaining.length} 张`, records: remaining });
  return sections;
}

export function summarize(records = []) {
  return {
    total: records.length,
    selected: records.filter((item) => item.state === "selected").length,
    candidate: records.filter((item) => item.state === "candidate").length,
    rejected: records.filter((item) => item.state === "rejected").length,
    issues: records.filter((item) => item.qualityFlags.length > 0 || (item.tags || []).some((tag) => ["ai:pair-uncertain", "ai:unpaired-original"].includes(tag))).length,
  };
}

export function matchesReviewFilter(record, filter, query = "") {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const haystack = [record.name, record.ext, ...(record.tags || []), ...record.reasons].join(" ").toLocaleLowerCase("zh-CN");
  if (normalized && !haystack.includes(normalized)) return false;
  if (filter === "all") return true;
  if (filter === "issues") return record.qualityFlags.length > 0 || (record.tags || []).some((tag) => ["ai:pair-uncertain", "ai:unpaired-original"].includes(tag));
  return record.state === filter;
}
