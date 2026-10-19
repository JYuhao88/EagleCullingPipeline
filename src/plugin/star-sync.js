export const STAR_SYNC_KEY = 'eagle-culling-star-sync';
export const STAR_HEADER = 'x-eagle-stars';
// 5/3/1 are the documented stars; 4 and 2 fold into the nearer decision so no rating is ignored.
export const STAR_ACTIONS = Object.freeze({ 0: 'clear', 1: 'rejected', 2: 'rejected', 3: 'candidate', 4: 'selected', 5: 'selected' });
export const ACTION_STARS = Object.freeze({ selected: 5, candidate: 3, rejected: 1, record: 0, clear: 0 });
// 留存 keeps a photo as a record of the day without judging it; in Eagle it is this tag, which you can also add yourself.
export const RECORD_TAG = '留存';
const hasRecordTag = item => Array.isArray(item?.tags) && item.tags.includes(RECORD_TAG);
export const starSyncEnabled = storage => storage?.getItem(STAR_SYNC_KEY) !== '0';

// Writes per item run in order and always save the newest wanted star and 留存 tag, so a slow older save never wins.
// What this page wrote is remembered so the watcher does not read it back as a new decision.
const latest = new Map(), chains = new Map(), ownWrites = new Map(), ownTagWrites = new Map();

export function takeOwnWrite(id, star) {
  if (ownWrites.get(id) !== star) return false;
  ownWrites.delete(id); return true;
}
function takeOwnTagWrite(id, tagged) {
  if (ownTagWrites.get(id) !== tagged) return false;
  ownTagWrites.delete(id); return true;
}

// Rows are { id, star?, record? }. Returns a warning instead of throwing: the decision is already saved.
export async function applyEagleStars(eagle, rows) {
  if (!rows?.length || !eagle?.item?.getByIds) return null;
  const errors = [];
  await Promise.all(rows.map(({ id, star, record }) => {
    latest.set(id, { ...latest.get(id), ...(star !== undefined ? { star } : {}), ...(record !== undefined ? { record } : {}) });
    const run = (chains.get(id) || Promise.resolve()).then(async () => {
      const wanted = latest.get(id) || {};
      const [item] = await eagle.item.getByIds([id]) || [];
      if (!item) return;
      let changed = false;
      if (wanted.star !== undefined && (Number(item.star) || 0) !== wanted.star) {
        ownWrites.set(id, wanted.star); item.star = wanted.star; changed = true;
      }
      if (wanted.record !== undefined && hasRecordTag(item) !== wanted.record) {
        const tags = Array.isArray(item.tags) ? item.tags.filter(tag => tag !== RECORD_TAG) : [];
        ownTagWrites.set(id, wanted.record); item.tags = wanted.record ? [...tags, RECORD_TAG] : tags; changed = true;
      }
      if (changed) await item.save();
    }).catch(error => { ownWrites.delete(id); ownTagWrites.delete(id); errors.push(error); });
    chains.set(id, run);
    return run.finally(() => { if (chains.get(id) === run) { chains.delete(id); latest.delete(id); } });
  }));
  return errors.length ? `决定已保存，但 Eagle 星级或标签未更新：${errors[0].message}` : null;
}

// The first star and 留存 tag seen for an item are its baseline; only later changes in Eagle become decisions,
// so ratings and tags made before culling never turn into decisions on their own.
export function createStarWatcher({ eagle, storage = globalThis.localStorage, post, interval = 800, recentLimit = 40,
  maxSelected = 300, seenLimit = 5000, onLargeSelection = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const seen = new Map(), seenTags = new Map();
  let recent = [], timer = null, running = false, busy = false, largeCount = 0;
  async function read(ids) {
    if (!ids.length) return [];
    if (eagle?.item?.getByIds) return await eagle.item.getByIds(ids) || [];
    if (eagle?.item?.get) return await eagle.item.get({ ids }) || [];
    return [];
  }
  function remember(map, id, value) {
    map.delete(id); map.set(id, value);
    while (map.size > seenLimit) map.delete(map.keys().next().value);
  }
  async function tick() {
    if (busy || !starSyncEnabled(storage) || !eagle?.item?.getSelected) return [];
    busy = true;
    try {
      const count = eagle.item.countSelected ? await eagle.item.countSelected() : null;
      const large = count !== null && count > maxSelected;
      if (large && count !== largeCount) onLargeSelection(count, maxSelected);
      largeCount = large ? count : 0;
      const selected = large ? [] : await eagle.item.getSelected() || [];
      const selectedIds = selected.map(item => item?.id).filter(Boolean);
      recent = [...new Set([...selectedIds, ...recent])].slice(0, recentLimit);
      const items = [...selected, ...await read(recent.filter(id => !selectedIds.includes(id)))];
      const changes = [];
      for (const item of items) {
        if (!item?.id) continue;
        const star = Number(item.star) || 0, tagged = hasRecordTag(item);
        const before = seen.get(item.id), beforeTag = seenTags.get(item.id);
        remember(seen, item.id, star); remember(seenTags, item.id, tagged);
        if (before !== undefined && before !== star && !takeOwnWrite(item.id, star)) {
          changes.push({ id: item.id, star, before, action: STAR_ACTIONS[star], via: 'eagle-star' });
        }
        if (beforeTag !== undefined && beforeTag !== tagged && !takeOwnTagWrite(item.id, tagged)) {
          changes.push({ id: item.id, tagged, before: beforeTag, action: tagged ? 'record' : 'clear', via: 'eagle-tag' });
        }
      }
      for (const change of changes) {
        // A failed post keeps the old baseline so the next tick retries it.
        try { await post(change); }
        catch { remember(change.via === 'eagle-tag' ? seenTags : seen, change.id, change.before); }
      }
      return changes;
    } finally { busy = false; }
  }
  function loop() {
    if (!running) return;
    void tick().catch(() => {}).finally(() => { if (running) timer = setTimer(loop, interval); });
  }
  return {
    tick,
    start() { if (!running) { running = true; loop(); } },
    stop() { running = false; clearTimer(timer); timer = null; },
    reset() { seen.clear(); seenTags.clear(); recent = []; }
  };
}
