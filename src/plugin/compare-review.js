const PREVIEW = new Set(["jpg","jpeg","heic","heif"]);

export function compareUnits(records = []) {
  const units = new Map();
  for (const record of records) {
    const key = record.captureStatus === "paired" && record.captureItemIds?.length > 1
      ? JSON.stringify([...record.captureItemIds].sort()) : JSON.stringify([record.id]);
    if (!units.has(key)) units.set(key, {id:key,records:[]});
    units.get(key).records.push(record);
  }
  return [...units.values()].map(unit=>({ ...unit, record: [...unit.records].sort((a,b)=>{
    const rank = item => (PREVIEW.has(String(item.ext || "").toLowerCase().replace(/^\./,"")) ? 2 : 0) + (item.thumbnailURL ? 4 : 0);
    return rank(b)-rank(a);
  })[0] }));
}

export function comparePair(units, {leftId,rightId} = {}) {
  const left = units.find(unit=>unit.id===leftId) || units[0];
  const right = units.find(unit=>unit.id===rightId && unit.id!==left?.id) || units.find(unit=>unit.id!==left?.id);
  return {left,right};
}
