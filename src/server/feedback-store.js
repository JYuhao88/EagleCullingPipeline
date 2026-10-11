import path from "node:path";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

export function libraryHash(libraryPath = "unknown-library") {
  return createHash("sha256").update(String(libraryPath)).digest("hex");
}

// Replay backwards so undoing an amendment restores the previous event.
export function effectiveFeedback(events) {
  const suppressed = new Set();
  const effective = [];
  for (const event of [...events].reverse()) {
    if (suppressed.has(event.id)) continue;
    if (event.action === "undo") { suppressed.add(event.undoOf); continue; }
    if (event.replaces) suppressed.add(event.replaces);
    effective.push(event);
  }
  return effective.reverse();
}

export function feedbackStats(events, reasons = []) {
  const active = effectiveFeedback(events);
  const byAction = Object.fromEntries(["keep", "reject", "winner-change", "undo"].map(action => [action, 0]));
  byAction.undo = events.filter(event => event.action === "undo").length;
  const byReason = {};
  const ruleMap = new Map(reasons.map(reason => [reason.id, reason.ruleIds || []]));
  let toolReject = 0, falseReject = 0, toolKeep = 0, userReject = 0, matched = 0, comparable = 0;
  for (const event of active) {
    byAction[event.action] = (byAction[event.action] || 0) + 1;
    for (const reason of event.reasons || []) byReason[reason] = (byReason[reason] || 0) + 1;
    if (["keep", "reject"].includes(event.action)) {
      if (event.toolSuggestion?.decision === "reject") { toolReject++; if (event.action === "keep") falseReject++; }
      if (event.toolSuggestion?.decision === "keep") { toolKeep++; if (event.action === "reject") userReject++; }
    }
    if (event.action === "reject") {
      const violations = new Set([...(event.toolSuggestion?.violations || []), ...(event.toolSuggestion?.gates || [])]);
      for (const reason of event.reasons || []) {
        const ids = ruleMap.get(reason) || [];
        if (!ids.length) continue;
        comparable++;
        const gateReason = {
          "R-G-BLUR": "blurry", "R-P-EYES": "eyes-closed",
          "R-L-HIGHLIGHT": "overexposed", "R-L-SHADOW": "underexposed" }[reason];
        if (ids.some(id => violations.has(id)) || (gateReason && violations.has(gateReason))) matched++;
      }
    }
  }
  const ratio = (numerator, denominator) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null });
  return {
    contractVersion: 1, totalEvents: events.length, activeEvents: active.length,
    byAction, undoEvents: byAction.undo, byReason,
    falseRejectProxy: ratio(falseReject, toolReject), keepRejectedProxy: ratio(userReject, toolKeep),
    reasonVerdictAgreement: ratio(matched, comparable),
    winnerChangeRatio: ratio(byAction["winner-change"], byAction.keep + byAction.reject + byAction["winner-change"]),
  };
}

const appendQueues = new Map();
export class FeedbackStore {
  constructor(root = "data/feedback") { this.root = path.resolve(root); this.pending = appendQueues; this.cached = new Map(); }
  file(libraryPath) { return path.join(this.root, `${libraryHash(libraryPath)}.jsonl`); }
  async read(libraryPath) {
    const files = libraryPath === undefined
      ? await readdir(this.root).catch(error => { if (error.code === "ENOENT") return []; throw error; })
      : [path.basename(this.file(libraryPath))];
    const events = [];
    for (const filename of files.filter(name => /^[a-f0-9]{64}\.jsonl$/.test(name))) {
      const file = path.join(this.root, filename);
      try {
        const metadata = await stat(file);
        const signature = [metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":");
        let cache = this.cached.get(file);
        if (cache?.signature !== signature) {
          const content = await readFile(file, "utf8");
          cache = { signature, rows: content.split("\n").filter(Boolean).map(JSON.parse) };
          this.cached.set(file, cache);
        }
        events.push(...cache.rows);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return structuredClone(events);
  }
  async append(libraryPath, event, validate = () => {}) {
    const file = this.file(libraryPath);
    const previous = this.pending.get(file) || Promise.resolve();
    const operation = previous.then(async () => {
      const events = await this.read(libraryPath);
      await validate(events);
      const record = { ...event, id: randomUUID(), contractVersion: 1, at: new Date().toISOString(), source: "review-ui" };
      await mkdir(this.root, { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
      const metadata = await stat(file);
      this.cached.set(file, { signature: [metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(":"),
        rows: structuredClone([...events, record]) });
      return record;
    });
    const queued = operation.catch(() => {});
    this.pending.set(file, queued);
    try { return await operation; }
    finally { if (this.pending.get(file) === queued) this.pending.delete(file); }
  }
}
