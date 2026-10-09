import { buildCaptureIndex } from "./capture-units.js";

export const REVIEW_STATES = {
  selected: { tag: "AI精选", legacyTag: "ai:selected", label: "精选" },
  candidate: { tag: "AI候选", legacyTag: "ai:candidate", label: "候选" },
  rejected: { tag: "待复核", legacyTag: "ai:rejected", label: "待复核" },
  unreviewed: { tag: null, label: "未标记" },
};

const REVIEW_TAGS = new Set(Object.values(REVIEW_STATES)
  .flatMap((entry) => [entry.tag, entry.legacyTag])
  .filter(Boolean));
const FLAG_LABELS = {
  "possibly-blurry": "清晰度偏低，可能失焦或存在运动模糊",
  "eyes-closed": "疑似闭眼，请重点复核人物表情；模型阈值尚未校准",
  overexposed: "高光溢出较多，可能过曝",
  underexposed: "暗部压黑较多，可能欠曝",
  "low-resolution": "分辨率偏低，不建议作为大尺寸输出首选",
};
const FLAG_TAGS = {
  "possibly-blurry": ["AI可能模糊", "ai:possibly-blurry"],
  "eyes-closed": ["AI闭眼", "ai:eyes-closed"],
  overexposed: ["AI过曝", "ai:overexposed"],
  underexposed: ["AI欠曝", "ai:underexposed"],
  "low-resolution": ["AI低分辨率", "ai:low-resolution"],
};
const hasTag = (tags, names) => names.some((name) => tags.includes(name));

export function reviewStateFromTags(tags = []) {
  for (const key of ["selected", "candidate", "rejected"]) {
    if (tags.includes(REVIEW_STATES[key].tag) || tags.includes(REVIEW_STATES[key].legacyTag)) return key;
  }
  return "unreviewed";
}

export function mergeReviewStateTags(tags = [], state) {
  if (!REVIEW_STATES[state]?.tag) throw new Error(`Unsupported review state: ${state}`);
  return [...new Set([...tags.filter((tag) => !REVIEW_TAGS.has(tag)), REVIEW_STATES[state].tag])];
}

export function qualityFlagsFor(item) {
  const fromAnalysis = Array.isArray(item.qualityFlags) ? item.qualityFlags : [];
  const fromTags = Object.keys(FLAG_LABELS).filter((flag) => hasTag(item.tags || [], FLAG_TAGS[flag] || [`ai:${flag}`]));
  return [...new Set([...fromAnalysis, ...fromTags])];
}

export function recommendationFor(item, group) {
  if (item.analysisStale) return "candidate";
  if (group?.size > 1) return group.representativeId === item.id || item.captureItemIds?.includes(group.representativeId) ? "selected" : "rejected";
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
  if (item.face?.available === false) reasons.unshift("人脸/闭眼检测未完成，不能据此判断眼睛正常；需人工复核");
  else if (item.face?.eyeAssessment === "not-detected" || item.face?.available === true && item.face.faceCount === 0) reasons.push("当前预览未检出人脸，无法判断闭眼；不代表画面无人或眼睛正常，不因此扣分");
  else if (item.face?.eyeAssessment === "incomplete") reasons.push("检测到人脸但眼部结果不完整，需人工复核；不能判断眼睛正常");
  else if (item.face?.eyeAssessment === "no-closed-signal") reasons.push("已检测的人脸未出现闭眼信号；不保证所有人物眼睛正常，仍需检查表情");
  if (item.face?.detectionMethod === "whole-plus-tiles-v1") reasons.push("整图未检出后进行了局部人脸复查；同脸去重为启发式，人物总数与闭眼仍需人工确认");
  if (item.semantic?.available === false) reasons.push("DINO 场景分析不可用，本张未参与语义分组；可查看诊断，不影响原片");
  if (item.modelPreview?.source === "jpeg-original-preview") reasons.push(`人脸/场景模型使用原 JPEG 的独立 ${item.modelPreview.width}×${item.modelPreview.height} 分析预览，不是 RAW 解码，也未替换 Eagle 缩略图`);
  else if (item.modelPreview?.reason) reasons.push(item.modelPreview.reason);
  if (group?.similarityMethod === "embedding-pairwise-v2") reasons.push("DINO 判断场景相似，不代表重复照片；表情、动作和构图差异请人工比较");
  if (item.qualityMethod === "heuristic-preview") reasons.push(item.metrics?.compositionScore == null && item.metrics?.subjectScore == null
    ? "当前仅作预览图技术粗排，不是审美模型评分；构图与主体质量尚未评估，不参与分数，准确率尚未校准"
    : "历史构图/主体值只是纹理与对比度代理，不是审美模型评分；请重新分析后人工比较");
  if (item.analysisStale) reasons.unshift(item.analysisStaleReasons?.includes("item-modified") || !item.analysisStaleReasons
    ? "缓存分析早于当前项目修改，建议重新分析；当前人工标签和星级保留"
    : item.analysisStaleReasons.includes("scoring-version")
    ? "评分算法已更新，历史评分不可作为当前留存建议；请重新分析，人工标签和星级保留"
    : "配对分析来源已修改、缺失或无法核验，历史评分仅供参考；请重新分析");

  if (group?.size > 1) {
    reasons.push(item.id !== group.representativeId && item.captureItemIds?.includes(group.representativeId)
      ? "本张与组内首选是同一次拍摄的配对格式，留存结论一致"
      : group.representativeId === item.id
      ? `同组共 ${group.size} 张相似照片，本张综合质量分最高`
      : `同组共 ${group.size} 张相似照片，建议与组内首选并排比较`);
  }
  if (hasTag(item.tags || [], ["AI原片", "ai:original"])) reasons.push("RAW/原始格式已作为母片保护，不建议仅因 JPEG 更好看而删除");
  if (hasTag(item.tags || [], ["AI已配对", "ai:paired"])) reasons.push("已找到对应 RAW/JPEG 或 3FR/HEIC 拍摄配对");
  if (hasTag(item.tags || [], ["AI配对待确认", "ai:pair-uncertain"])) reasons.push("同名文件超过一组，配对关系不唯一，需要人工确认");
  if (hasTag(item.tags || [], ["AI未配对原片", "ai:unpaired-original"])) reasons.push("未找到对应预览成片，原始母片应优先保留并复核");
  if (item.analysisSource === "proxy") reasons.push("本次使用 Eagle 预览图分析，未解码或修改原片");
  if (item.resolutionVerified === false) reasons.push("原片分辨率未核验；小预览图不作为原片低分辨率的依据");
  if (item.analysisSource === "paired-proxy") reasons.push("复用同次拍摄的预览成片评分；不代表 RAW 解码质量或原始动态范围");
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

export function buildReviewSections(items = [], groups = [], captureIndex = buildCaptureIndex(items)) {
  const withCapture = (item) => {
    const unit = captureIndex.get(item.id);
    const captureStatus = item.captureStatus || unit?.status || "single";
    return { ...item, captureUnitId: unit?.id || `single:${item.id}`, captureStatus, captureItemIds: captureStatus === "paired" ? item.captureItemIds || unit.itemIds : [item.id], captureFormats: unit?.formats || [] };
  };
  const byId = new Map(items.map((item) => [item.id, withCapture(item)]));
  const included = new Set();
  const sections = [];
  for (const group of groups.filter((entry) => entry.size > 1)) {
    const groupIds = new Set(group.items.flatMap((entry) => byId.get(entry.id)?.captureItemIds || [entry.id]));
    const records = [...groupIds].map((id) => byId.get(id)).filter(Boolean).map((item) => makeReviewRecord(item, group));
    records.forEach((record) => included.add(record.id));
    sections.push({
      id: group.groupId,
      title: `${group.similarityMethod === "embedding-pairwise-v2" ? "场景相似组" : "相似组"} ${group.groupId.replace(/^(phash|embedding)-/, "")}`,
      note: `${group.size} 个分析单元 · ${records.length} 个文件，已按粗排参考分排序${group.similarityMethod === "embedding-pairwise-v2" ? "；场景相似不等于重复" : ""}`,
      records: records.sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0)),
    });
  }
  const remaining = items.filter((item) => !included.has(item.id)).map((item) => makeReviewRecord(withCapture(item)));
  if (remaining.length) sections.push({ id: "other", title: groups.length ? "其他照片" : "当前选择", note: `${remaining.length} 张`, records: remaining });
  return sections;
}

export function summarize(records = []) {
  return {
    total: records.length,
    selected: records.filter((item) => item.state === "selected").length,
    candidate: records.filter((item) => item.state === "candidate").length,
    rejected: records.filter((item) => item.state === "rejected").length,
    issues: records.filter((item) => item.analysisStale || item.face?.available === false || item.face?.eyeAssessment === "incomplete" || item.qualityFlags.length > 0 || hasTag(item.tags || [], ["AI配对待确认", "AI未配对原片", "ai:pair-uncertain", "ai:unpaired-original"])).length,
  };
}

export function matchesReviewFilter(record, filter, query = "") {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const haystack = [record.name, record.ext, ...(record.tags || []), ...record.reasons].join(" ").toLocaleLowerCase("zh-CN");
  if (normalized && !haystack.includes(normalized)) return false;
  if (filter === "all") return true;
  if (filter === "issues") return Boolean(record.analysisStale) || record.face?.available === false || record.face?.eyeAssessment === "incomplete" || record.qualityFlags.length > 0 || hasTag(record.tags || [], ["AI配对待确认", "AI未配对原片", "ai:pair-uncertain", "ai:unpaired-original"]);
  return record.state === filter;
}
