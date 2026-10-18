export const STAR_SYNC_KEY = 'eagle-culling-star-sync';
export const STAR_HEADER = 'x-eagle-stars';
// 5/3/1 are the documented stars; 4 and 2 fold into the nearer decision so no rating is ignored.
export const STAR_ACTIONS = Object.freeze({ 0: 'clear', 1: 'rejected', 2: 'rejected', 3: 'candidate', 4: 'selected', 5: 'selected' });
export const ACTION_STARS = Object.freeze({ selected: 5, candidate: 3, rejected: 1, clear: 0 });
export const starSyncEnabled = storage => storage?.getItem(STAR_SYNC_KEY) !== '0';

// Writes per item run in order and always save the newest wanted star, so a slow older save never wins.
// Stars this page wrote are remembered so the watcher does not read them back as new decisions.
const latest = new Map(), chains = new Map(), ownWrites = new Map();

export function takeOwnWrite(id, star) {
  if (ownWrites.get(id) !== star) return false;
  ownWrites.delete(id); return true;
}

// Returns a warning instead of throwing: the decision is already saved when stars are applied.
export async function applyEagleStars(eagle, rows) {
  if (!rows?.length || !eagle?.item?.getByIds) return null;
  const errors = [];
  await Promise.all(rows.map(({ id, star }) => {
    latest.set(id, star);
    const run = (chains.get(id) || Promise.resolve()).then(async () => {
      const wanted = latest.get(id);
      const [item] = await eagle.item.getByIds([id]) || [];
      if (!item || (Number(item.star) || 0) === wanted) return;
      ownWrites.set(id, wanted);
      item.star = wanted; await item.save();
    }).catch(error => { ownWrites.delete(id); errors.push(error); });
    chains.set(id, run);
    return run.finally(() => { if (chains.get(id) === run) { chains.delete(id); latest.delete(id); } });
  }));
  return errors.length ? `决定已保存，但 Eagle 星级未更新：${errors[0].message}` : null;
}

// The first star seen for an item is its baseline; only later changes in Eagle become decisions,
// so ratings made before culling never turn into decisions on their own.
export function createStarWatcher({ eagle, storage = globalThis.localStorage, post, interval = 800, recentLimit = 40,
  maxSelected = 300, seenLimit = 5000, onLargeSelection = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const seen = new Map();
  let recent = [], timer = null, running = false, busy = false, largeCount = 0;
  async function read(ids) {
    if (!ids.length) return [];
    if (eagle?.item?.getByIds) return await eagle.item.getByIds(ids) || [];
    if (eagle?.item?.get) return await eagle.item.get({ ids }) || [];
    return [];
  }
  function remember(id, star) {
    seen.delete(id); seen.set(id, star);
    while (seen.size > seenLimit) seen.delete(seen.keys().next().value);
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
        const star = Number(item.star) || 0;
        const before = seen.get(item.id);
        remember(item.id, star);
        if (before === undefined || before === star || takeOwnWrite(item.id, star)) continue;
        changes.push({ id: item.id, star, before, action: STAR_ACTIONS[star] });
      }
      for (const change of changes) {
        // A failed post keeps the old baseline so the next tick retries it.
        try { await post(change); } catch { remember(change.id, change.before); }
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
    reset() { seen.clear(); recent = []; }
  };
}
