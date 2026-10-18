import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyPersonalization } from '../core/personalize.js';

const FILENAME = 'personalize-undo.json';

export async function readPersonalizeUndo(runStore, runId) {
  try {
    return JSON.parse(await readFile(path.join(runStore.dir(runId), FILENAME), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function appliedPersonalization(snapshot) {
  return snapshot ? { at: snapshot.at, changedGroups: snapshot.changedGroups } : null;
}

export async function applyWithUndo(runStore, data, decisions, at = new Date().toISOString()) {
  const result = applyPersonalization(data, decisions);
  const { data: updated, ...report } = result;
  let snapshot = await readPersonalizeUndo(runStore, data.run.id);
  if (result.ready && result.changedGroups) {
    const originals = new Map((snapshot?.groups || []).map(group => [group.id, group]));
    const updatedGroups = new Map(updated.groups.map(group => [group.id, group]));
    for (const group of data.groups) {
      const changed = updatedGroups.get(group.id);
      const keys = [...new Set([...Object.keys(group), ...Object.keys(changed)])]
        .filter(key => JSON.stringify(group[key]) !== JSON.stringify(changed[key]));
      if (!keys.length) continue;
      const original = originals.get(group.id) || { id: group.id, fields: {}, absent: [] };
      for (const key of keys) {
        if (Object.hasOwn(original.fields, key) || original.absent.includes(key)) continue;
        if (Object.hasOwn(group, key)) original.fields[key] = group[key];
        else original.absent.push(key);
      }
      originals.set(group.id, original);
    }
    snapshot = { at: snapshot?.at || at, changedGroups: originals.size, groups: [...originals.values()] };
    // Persist originals first so a failed result save still leaves a safe recovery path.
    await runStore.writeAtomic(data.run.id, FILENAME, snapshot);
    await runStore.save(data.run, updated);
  }
  return { ...report, applied: appliedPersonalization(snapshot) };
}

export async function undoPersonalization(runStore, data) {
  const snapshot = await readPersonalizeUndo(runStore, data.run.id);
  if (!snapshot) return { applied: null, changedGroups: 0 };
  const originals = new Map(snapshot.groups.map(group => [group.id, group]));
  const groups = data.groups.map(group => {
    const original = originals.get(group.id);
    if (!original) return group;
    const restored = { ...group, ...original.fields };
    for (const key of original.absent) delete restored[key];
    return restored;
  });
  await runStore.save(data.run, { ...data, groups });
  await rm(path.join(runStore.dir(data.run.id), FILENAME));
  return { applied: null, changedGroups: snapshot.changedGroups };
}
