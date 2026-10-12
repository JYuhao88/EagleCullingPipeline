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

export async function handleAdjustmentsRoute(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/runs\/([^/]+)\/adjustments(?:\/([^/]+))?$/);
  if (!match) return false;
  const [, runId, rawUnit] = match;
  const dir = ctx.runStore.dir(runId);
  if (!(await ctx.runStore.getRun(runId))) { ctx.json(res, 404, { error: "run not found" }); return true; }
  const all = await readAdjustments(dir);
  if (req.method === "GET" && !rawUnit) { ctx.json(res, 200, all); return true; }
  const id = unitId(rawUnit || "");
  if (!id) { ctx.json(res, 400, { error: "invalid unit id" }); return true; }
  if (req.method === "GET") { ctx.json(res, 200, all[id] || {}); return true; }
  if (req.method !== "PUT") return false;
  try {
    const body = await ctx.readBody(req);
    const value = validateAdjustments(body);
    if (Object.keys(value).length) all[id] = value; else delete all[id];
    if (Object.keys(all).length) await atomicJson(path.join(dir, "adjustments.json"), all);
    else await unlink(path.join(dir, "adjustments.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
    ctx.json(res, 200, value);
  } catch (error) { ctx.json(res, 400, { error: error.message }); }
  return true;
}
