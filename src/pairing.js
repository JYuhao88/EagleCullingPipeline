const PAIR_DEFINITIONS = [
  { original: "arw", rendition: "jpg" },
  { original: "dng", rendition: "jpg" },
  { original: "3fr", rendition: "heic" },
];

const PAIR_TAGS = new Set(["ai:paired", "ai:pair-uncertain", "ai:original"]);

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
        ? ["ai:paired", ...(item.ext?.toLowerCase() === definition.original ? ["ai:original"] : [])]
        : ["ai:pair-uncertain"];
      updates.push({ id: item.id, additions, captureUnitId: unit.captureUnitId });
    }
  }
  return {
    units,
    updates,
    pairedUnits: units.filter((unit) => unit.status === "paired").length,
    uncertainUnits: units.filter((unit) => unit.status === "pair-uncertain").length,
  };
}

export function buildPairUpdate(current, planned) {
  const tags = (current.tags || []).filter((tag) => !PAIR_TAGS.has(tag));
  for (const tag of planned.additions) tags.push(tag);
  return { id: current.id, tags: [...new Set(tags)] };
}

export { PAIR_DEFINITIONS };
