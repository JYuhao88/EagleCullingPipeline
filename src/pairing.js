const PAIR_DEFINITIONS = [
  { original: "arw", rendition: "jpg" },
  { original: "dng", rendition: "jpg" },
  { original: "3fr", rendition: "heic" },
];

const PAIR_TAGS = new Set([
  "AI已配对", "AI配对待确认", "AI原片", "AI未配对原片",
  "ai:paired", "ai:pair-uncertain", "ai:original", "ai:unpaired-original",
]);
const LEGACY_PAIR_TAGS = {
  "ai:paired": "AI已配对",
  "ai:pair-uncertain": "AI配对待确认",
  "ai:original": "AI原片",
  "ai:unpaired-original": "AI未配对原片",
};
const REVIEW_SYNC_TAGS = new Set([
  "AI精选", "AI候选", "待复核",
  "ai:selected", "ai:candidate", "ai:rejected",
]);
const QUALITY_SYNC_TAGS = new Set([
  "AI闭眼", "AI过曝", "AI欠曝", "AI可能模糊", "AI低分辨率",
  "ai:eyes-closed", "ai:overexposed", "ai:underexposed", "ai:possibly-blurry", "ai:low-resolution",
]);
const ORIGINAL_EXTENSIONS = new Set(PAIR_DEFINITIONS.map((definition) => definition.original));

function normalizedName(item) {
  return String(item.name || "").trim().toLocaleLowerCase();
}

export function buildPairPlan(items) {
  const groups = new Map();
  for (const item of items) {
    const key = normalizedName(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const updates = [];
  const units = [];
  for (const [key, members] of groups) {
    const matching = PAIR_DEFINITIONS.filter(({ original, rendition }) =>
      members.some((item) => item.ext?.toLowerCase() === original)
      && members.some((item) => item.ext?.toLowerCase() === rendition));
    if (matching.length === 0) continue;

    const definition = matching[0];
    const originals = members.filter((item) => item.ext?.toLowerCase() === definition.original);
    const renditions = members.filter((item) => item.ext?.toLowerCase() === definition.rendition);
    const exact = matching.length === 1 && members.length === 2 && originals.length === 1 && renditions.length === 1;
    const unit = {
      captureUnitId: `pair:${key}`,
      name: members[0].name,
      formats: [...new Set(members.map((item) => item.ext?.toLowerCase()))].sort(),
      confidence: exact ? 1 : 0,
      status: exact ? "paired" : "pair-uncertain",
      itemIds: members.map((item) => item.id),
    };
    units.push(unit);

    for (const item of members) {
      const additions = exact
        ? ["AI已配对", ...(item.ext?.toLowerCase() === definition.original ? ["AI原片"] : [])]
        : ["AI配对待确认"];
      updates.push({ id: item.id, additions, captureUnitId: unit.captureUnitId });
    }
  }
  const plannedIds = new Set(updates.map((update) => update.id));
  for (const item of items) {
    if (!plannedIds.has(item.id) && ORIGINAL_EXTENSIONS.has(item.ext?.toLowerCase())) {
      units.push({
        captureUnitId: `unpaired:${item.id}`,
        name: item.name,
        formats: [item.ext.toLowerCase()],
        confidence: 1,
        status: "unpaired-original",
        itemIds: [item.id],
      });
      updates.push({ id: item.id, additions: ["AI原片", "AI未配对原片"], captureUnitId: `unpaired:${item.id}` });
    }
  }
  return {
    units,
    updates,
    pairedUnits: units.filter((unit) => unit.status === "paired").length,
    uncertainUnits: units.filter((unit) => unit.status === "pair-uncertain").length,
    unpairedOriginals: units.filter((unit) => unit.status === "unpaired-original").length,
  };
}

export function buildPairUpdate(current, planned) {
  const tags = (current.tags || []).filter((tag) => !PAIR_TAGS.has(tag));
  for (const tag of planned.additions) tags.push(LEGACY_PAIR_TAGS[tag] || tag);
  return { id: current.id, tags: [...new Set(tags)] };
}

// Copy the JPG's review and quality decision to its exact one-to-one RAW pair.
// Pair-specific tags such as AI原片 remain owned by the RAW item itself.
export function buildPairedReviewUpdates(items) {
  const plan = buildPairPlan(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  const updates = [];
  for (const unit of plan.units.filter((entry) => entry.status === "paired")) {
    const rendition = unit.itemIds.map((id) => byId.get(id)).find((item) => ["jpg", "heic"].includes(item?.ext?.toLowerCase()));
    const raw = unit.itemIds.map((id) => byId.get(id)).find((item) => {
      const ext = item?.ext?.toLowerCase();
      return rendition?.ext?.toLowerCase() === "heic" ? ext === "3fr" : ["arw", "dng"].includes(ext);
    });
    if (!rendition || !raw) continue;
    const sourceTags = (rendition.tags || []).filter((tag) => REVIEW_SYNC_TAGS.has(tag) || QUALITY_SYNC_TAGS.has(tag));
    if (sourceTags.length === 0) continue;
    const targetTags = (raw.tags || []).filter((tag) => !REVIEW_SYNC_TAGS.has(tag) && !QUALITY_SYNC_TAGS.has(tag));
    const nextTags = [...new Set([...targetTags, ...sourceTags.map((tag) => ({
      "ai:selected": "AI精选", "ai:candidate": "AI候选", "ai:rejected": "待复核",
      "ai:eyes-closed": "AI闭眼", "ai:overexposed": "AI过曝", "ai:underexposed": "AI欠曝",
      "ai:possibly-blurry": "AI可能模糊", "ai:low-resolution": "AI低分辨率",
    }[tag] || tag))])];
    if (JSON.stringify(nextTags) !== JSON.stringify(raw.tags || [])) {
      updates.push({ id: raw.id, tags: nextTags, sourceId: rendition.id, captureUnitId: unit.captureUnitId, syncTags: sourceTags });
    }
  }
  return updates;
}

export { PAIR_DEFINITIONS };
