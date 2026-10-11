import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fitPreferenceHead, evaluatePreferenceHead, learningCurve, driftReport } from "./preference-head.js";

export const DEFAULT_PROFILE = Object.freeze({ enabled: false, halfLifeDays: 90, recentGroups: 25,
  driftThreshold: 0.2, debiasEnabled: false, debiasRate: 0.05, pixelTier: 0 });

function profileName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error("Invalid preference profile ID");
  return value;
}

export class PreferenceStore {
  constructor(root) { this.root = root; this.pending = Promise.resolve(); }
  directory(id) { return path.join(this.root, "preferences", profileName(id)); }
  async json(file, fallback) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async atomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  }
  mutate(callback) {
    const job = this.pending.then(callback);
    this.pending = job.catch(() => {});
    return job;
  }
  async loadProfile(profileId = "default") {
    const directory = this.directory(profileId);
    const config = { ...DEFAULT_PROFILE, ...await this.json(path.join(directory, "config.json"), {}) };
    const current = await this.json(path.join(directory, "current.json"), null);
    let snapshots = [];
    try { snapshots = (await readdir(path.join(directory, "snapshots")))
      .filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).sort(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { profileId, config, head: current?.head || null, report: current?.report || null, snapshots,
      version: current?.head?.snapshotId || null, trainingData: current?.trainingData || null };
  }
  async listProfiles() {
    let ids = [];
    try { ids = await readdir(path.join(this.root, "preferences")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!ids.includes("default")) ids.push("default");
    const profiles = [];
    for (const id of ids.filter(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)).sort()) {
      const profile = await this.loadProfile(id);
      profiles.push({ id, ...profile.config, version: profile.version });
    }
    return profiles;
  }
  saveConfig(profileId, patch) {
    return this.mutate(async () => {
      const profile = await this.loadProfile(profileId);
      const config = { ...profile.config };
      for (const key of Object.keys(DEFAULT_PROFILE)) if (key in patch) config[key] = patch[key];
      for (const key of ["enabled", "debiasEnabled"]) if (typeof config[key] !== "boolean") throw new Error(`Invalid ${key}`);
      if (!Number.isFinite(config.halfLifeDays) || config.halfLifeDays <= 0 ||
        !Number.isInteger(config.recentGroups) || config.recentGroups < 2 || config.recentGroups > 1000 ||
        !Number.isFinite(config.driftThreshold) || config.driftThreshold <= 0 || config.driftThreshold > 1 ||
        !Number.isFinite(config.debiasRate) || config.debiasRate < 0 || config.debiasRate > 0.2 ||
        ![0, 1].includes(config.pixelTier)) throw new Error("Invalid preference configuration");
      await this.atomic(path.join(this.directory(profileId), "config.json"), config);
      return this.loadProfile(profileId);
    });
  }
  train(profileId, groups) {
    return this.mutate(async () => {
      const profile = await this.loadProfile(profileId);
      const selected = groups.filter(group => (group.profileId || "default") === profileId);
      const options = { halfLifeDays: profile.config.halfLifeDays };
      const head = fitPreferenceHead(selected, options);
      const report = { ...evaluatePreferenceHead(selected, options), learningCurve: learningCurve(selected, options),
        drift: driftReport(selected, profile.head || head, { recentGroups: profile.config.recentGroups,
          threshold: profile.config.driftThreshold }) };
      const stamp = new Date().toISOString();
      const digest = createHash("sha256").update(JSON.stringify({ head, stamp, nonce: randomUUID() })).digest("hex").slice(0, 12);
      head.snapshotId = `${stamp.replace(/[:.]/g, "-")}-${digest}`;
      head.profileId = profileId;
      head.createdAt = stamp;
      const trainingData = { groups: selected.length, samples: head.sampleCount,
        startTime: selected.map(group => group.time).sort()[0] || null,
        endTime: selected.map(group => group.time).sort().at(-1) || null,
        eventIds: selected.map(group => group.eventId).filter(Boolean),
        digest: createHash("sha256").update(JSON.stringify(selected)).digest("hex") };
      const snapshot = { schemaVersion: 1, head, report, trainingData };
      await this.atomic(path.join(this.directory(profileId), "snapshots", `${head.snapshotId}.json`), snapshot);
      await this.atomic(path.join(this.directory(profileId), "current.json"), snapshot);
      return this.loadProfile(profileId);
    });
  }
  snapshot(profileId = "default") { return this.loadProfile(profileId); }
  rollback(profileId, version) {
    return this.mutate(async () => {
      if (typeof version !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(version)) throw new Error("Invalid snapshot version");
      const snapshot = await this.json(path.join(this.directory(profileId), "snapshots", `${version}.json`), null);
      if (!snapshot?.head) throw new Error("Preference snapshot not found");
      await this.atomic(path.join(this.directory(profileId), "current.json"), snapshot);
      return this.loadProfile(profileId);
    });
  }
}
