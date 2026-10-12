import { assignCaptureSessions } from "./capture-metadata.js";
import { isRaw } from './image-formats.js';

const RENDITIONS = new Set(["jpg", "jpeg", "png", ...['heic', 'heif', 'hif']]);
const stem = (item) =>
  String(item.name || "")
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLocaleLowerCase();
const captureTime = (item) => {
  const value =
    item.captureTime ||
    item.metadata?.dateTimeOriginal ||
    item.metadata?.DateTimeOriginal;
  const parsed = typeof value === "number" ? value : value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
function pair(renditions, raws) {
  if (renditions.length === 1 && raws.length === 1)
    return {
      rendition: renditions[0],
      raw: raws[0],
      pairing: "paired",
      pairingNote: "",
    };
  const candidates = renditions.flatMap((rendition) =>
    raws.map((raw) => ({
      rendition,
      raw,
      timeGap:
        captureTime(rendition) === null || captureTime(raw) === null
          ? 0
          : Math.abs(captureTime(rendition) - captureTime(raw)),
      sizeGap: Math.abs(
        (rendition.width || 0) * (rendition.height || 0) -
          (raw.width || 0) * (raw.height || 0),
      ),
    })),
  );
  candidates.sort((a, b) => a.timeGap - b.timeGap || a.sizeGap - b.sizeGap);
  const best = candidates[0];
  const ties = candidates.filter(
    (candidate) =>
      candidate.timeGap === best?.timeGap &&
      candidate.sizeGap === best?.sizeGap,
  );
  return best && ties.length === 1
    ? { ...best, pairing: "paired", pairingNote: "按拍摄时间和尺寸配对" }
    : { pairing: "ambiguous", pairingNote: "存在多个候选文件，无法唯一配对" };
}
export function buildCaptureUnits(items = []) {
  assignCaptureSessions(items);
  const groups = new Map();
  for (const item of items.filter((entry) => !entry.isDeleted)) {
    const key = JSON.stringify([item.sessionId || "legacy-no-time", stem(item) || item.id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].flatMap((members) => {
    const renditions = members.filter((item) =>
      RENDITIONS.has(String(item.ext || "").toLowerCase()),
    );
    const raws = members.filter((item) =>
      isRaw(item.ext),
    );
    const makeUnit = (selected, selectedPair) => {
      const primary = selectedPair?.rendition || selected.find(item => RENDITIONS.has(String(item.ext || "").toLowerCase())) || selected[0];
      return {
        contractVersion: 1,
        id: `unit:${primary.id}`,
        primaryItemId: primary.id,
        itemIds: selected.map(item => item.id),
        formats: selected.map(item => String(item.ext || "").toLowerCase()),
        ...(primary.sessionId ? { sessionId: primary.sessionId } : {}),
        ...(primary.captureTime ? { captureTime: primary.captureTime } : {}),
        pairing: selectedPair?.pairing || (selected.length === 1 ? "single" : "ambiguous"),
        pairingNote: selectedPair?.pairingNote || (selected.length > 1 ? "同名文件未找到唯一的 JPG/RAW 配对" : ""),
      };
    };
    const units = [];
    let remaining = members;
    let availableRenditions = renditions, availableRaws = raws;
    while (availableRenditions.length && availableRaws.length) {
      const selectedPair = pair(availableRenditions, availableRaws);
      if (selectedPair.pairing !== "paired") break;
      const selected = [selectedPair.rendition, selectedPair.raw];
      units.push(makeUnit(selected, selectedPair));
      const used = new Set(selected);
      remaining = remaining.filter(item => !used.has(item));
      availableRenditions = availableRenditions.filter(item => !used.has(item));
      availableRaws = availableRaws.filter(item => !used.has(item));
    }
    if (remaining.length) units.push(makeUnit(remaining));
    return units;
  });
}
export function buildPairPlan(items) {
  const units = buildCaptureUnits(items);
  return {
    units,
    updates: [],
    pairedUnits: units.filter((u) => u.pairing === "paired").length,
    uncertainUnits: units.filter((u) => u.pairing === "ambiguous").length,
    unpairedOriginals: units.filter((u) => u.pairing === "single").length,
  };
}
export function buildPairUpdate(current, planned) {
  return {
    id: current.id,
    tags: [...new Set([...(current.tags || []), ...(planned.additions || [])])],
  };
}
export function buildPairedReviewUpdates() {
  return [];
}
