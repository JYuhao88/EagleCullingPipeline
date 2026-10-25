import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "../core/feature-store.js";
import { ADJUSTMENT_RANGES, normalizeAdjustments } from "../plugin/adjust.js";

function unitId(value) {
  try { const decoded = decodeURIComponent(value); return decoded && !/[\\/\u0000]/.test(decoded) ? decoded : null; }
  catch { return null; }
}

async function readAdjustments(dir) {
  try { return JSON.parse(await readFile(path.join(dir, "adjustments.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

// Saves for different photos of one run rewrite the same file; they run one at a time so none is lost.
const writes = new Map();
export function serialized(key, task) {
  const run = (writes.get(key) || Promise.resolve()).then(task);
  const tail = run.catch(() => {}); writes.set(key, tail);
  tail.then(() => { if (writes.get(key) === tail) writes.delete(key); });
  return run;
}

export function validateAdjustments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("adjustments must be an object");
  for (const [name, number] of Object.entries(value)) {
    if (!Object.hasOwn(ADJUSTMENT_RANGES, name) || typeof number !== "number" || !Number.isFinite(number)) {
      throw new Error(`invalid adjustment: ${name}`);
    }
    const [min, max] = ADJUSTMENT_RANGES[name];
    if (number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return normalizeAdjustments(value);
}

// Adjustments made before a photo is analyzed: `item-adjustments.json` in the runs root, by library and Eagle item id.
// The first analysis covering the photo shows them until it gets its own.
const itemFile = root => path.join(root, "item-adjustments.json");
async function readItemFile(root) {
  try { return JSON.parse(await readFile(itemFile(root), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
export async function itemAdjustments(root, libraryPath, itemIds) {
  const library = (await readItemFile(root))[libraryPath] || {};
  for (const id of itemIds) if (library[id]) return library[id];
  return {};
}
export async function saveItemAdjustments(root, libraryPath, itemId, value) {
  await serialized(itemFile(root), async () => {
    const all = await readItemFile(root), library = all[libraryPath] || {};
    if (Object.keys(value).length) library[itemId] = value; else delete library[itemId];
    if (Object.keys(library).length) all[libraryPath] = library; else delete all[libraryPath];
    if (Object.keys(all).length) await atomicJson(itemFile(root), all);
    else await unlink(itemFile(root)).catch(error => { if (error.code !== "ENOENT") throw error; });
  });
  return value;
}

async function unitItemIds(ctx, run, unitId) {
  if (!run.libraryPath || !ctx.runStore.root || !ctx.runStore.unitData) return [];
  const unit = (await ctx.runStore.unitData(run.id, unitId).catch(() => null))?.units?.[0];
  return unit ? unit.itemIds || [unit.primaryItemId] : [];
}
async function carriedOver(ctx, run, unitId) {
  const ids = await unitItemIds(ctx, run, unitId);
  return ids.length ? itemAdjustments(ctx.runStore.root, run.libraryPath, ids) : {};
}
// Once the analyzed photo has its own value (or a reset), the earlier one is retired so it cannot come back.
async function retireItems(ctx, run, unitId) {
  const ids = await unitItemIds(ctx, run, unitId);
  if (!ids.length) return;
  const library = (await readItemFile(ctx.runStore.root))[run.libraryPath] || {};
  for (const id of ids.filter(id => library[id])) await saveItemAdjustments(ctx.runStore.root, run.libraryPath, id, {});
}

export async function handleAdjustmentsRoute(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)\/adjustments(?:\/([^/]+))?$/);
  if (!match) return false;
  const [, runId, rawUnit] = match;
  const dir = ctx.runStore.dir(runId);
  const run = await ctx.runStore.getRun(runId);
  if (!run) { ctx.json(res, 404, { error: "run not found" }); return true; }
  const all = await readAdjustments(dir);
  if (req.method === "GET" && !rawUnit) { ctx.json(res, 200, all); return true; }
  const id = unitId(rawUnit || "");
  if (!id) { ctx.json(res, 400, { error: "invalid unit id" }); return true; }
  if (req.method === "GET") { ctx.json(res, 200, all[id] || await carriedOver(ctx, { id: runId, ...run }, id)); return true; }
  if (req.method !== "PUT") return false;
  try {
    const value = validateAdjustments(await ctx.readBody(req));
    await serialized(dir, async () => {
      const latest = await readAdjustments(dir);
      if (Object.keys(value).length) latest[id] = value; else delete latest[id];
      if (Object.keys(latest).length) await atomicJson(path.join(dir, "adjustments.json"), latest);
      else await unlink(path.join(dir, "adjustments.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
    await retireItems(ctx, { id: runId, ...run }, id);
    ctx.json(res, 200, value);
  } catch (error) { ctx.json(res, 400, { error: error.message }); }
  return true;
}
