import { detectPose, POSE_CACHE_KEY, POSE_SIGNALS_CACHE_KEY } from "./pose.js";
import { computeSignals } from "./signals.js";
import { evaluateRules } from "./rules-engine.js";
import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { choosePreview } from "./previews.js";
import { analyzeImage, normalizeMetrics, exposureSuitability, measureFaceExposure } from "./metrics.js";
import { groupResultsAsync, recallCrossDayDuplicates, readCaptureTimes } from "./grouping.js";
import { groupConfidence, rankGroup, suggestDecision, gateFlags } from "./ranking.js";
import { CONTRACT_VERSION } from "./contracts.js";
import { embedImage } from "./embeddings.js";
import { detectFaces } from "./faces.js";
import { score, SCORER_CACHE_KEY } from "./scorer.js";
import { measureCandidates } from "./candidate-measurements.js";
import { buildCandidateSet } from "./candidates.js";
import { withNativeImage } from "./native-image.js";
import { analyzeFocus, readMakerFocus } from "./focus.js";
export class AnalysisPipeline {
  constructor({
    concurrency = 2, store, analyzer = analyzeImage, faceDetector = detectFaces,
    poseDetector = detectPose,
    root = process.cwd(), cacheRoot = "data/cache",
  } = {}) {
    this.concurrency = Math.max(1, Math.min(2, concurrency));
    this.store = store;
    this.analyzer = analyzer;
    this.faceDetector = faceDetector;
    this.poseDetector = poseDetector;
    this.root = root;
    this.cacheRoot = cacheRoot;
  }
  async run(
    records,
    { id = `run-${Date.now()}`, signal, onProgress = () => {} } = {},
  ) {
    const results = new Array(records.length);
    const recordsByUnit = new Map(records.map(record => [record.unitId || record.id, record]));
    let cursor = 0;
    let completed = 0;
    let cached = 0;
    const warnings = [];
    const worker = async () => {
      while (true) {
        if (signal?.aborted) throw signal.reason || new Error("cancelled");
        const index = cursor++;
        if (index >= records.length) return;
        const record = records[index];
        const preview = await choosePreview(record, { cacheDir: path.join(this.cacheRoot, "previews") });
        const fingerprint = crypto
          .createHash("sha256")
          .update(
            JSON.stringify([
              record.path || record.filePath,
              record.size || 0,
              record.mtimeMs || 0,
              record.itemIds || [],
              preview || "",
              "analysis-v6-exposure-gates",
              POSE_CACHE_KEY,
              SCORER_CACHE_KEY,
            ]),
          )
          .digest("hex");
        let result = this.store ? await this.store.get(fingerprint) : null;
        if (result) {
          cached += 1;
          // Retain model caches while upgrading preview-gradient normalization.
          if (this.analyzer === analyzeImage && result.metrics?.raw?.previewSharpness == null && preview) {
            const refreshed = await this.analyzer({ ...record, analysisPath: preview });
            result.metrics.sharpness = normalizeMetrics(refreshed.metrics, { sharpnessScale: 100 }).sharpness;
            result.metrics.raw.previewSharpness = refreshed.metrics.sharpness;
          }
        }
        else {
          if (!preview) {
            warnings.push(
              record.previewWarning || `单元 ${record.unitId} 没有可用预览`,
            );
          }
          result = await this.analyzer({ ...record, analysisPath: preview });
          const analyzed = result;
          const scorerResult = (
            await score([preview], { root: this.root })
          )[0];
          const metrics = normalizeMetrics({
            ...(analyzed.metrics || {}),
            quality: scorerResult.quality,
            aesthetic: scorerResult.aesthetic,
          }, { sharpnessScale: analyzed.scoringVersion ? 100 : undefined });
          let embedding = null;
          try {
            embedding = await embedImage(preview, {
              fingerprint, cacheDir: path.join(this.cacheRoot, "embeddings")
            });
          } catch (error) {
            warnings.push(`DINOv2 embedding 不可用：${error.message}`);
          }
          if (
            !embedding &&
            !warnings.some((warning) => warning.includes("模型文件"))
          ) {
            warnings.push("DINOv2 模型文件不存在，已降级为 hash + 时间分组");
          }
          result = {
            contractVersion: CONTRACT_VERSION,
            unitId: record.unitId || record.id,
            fingerprint,
            previewPath: preview,
            previewSource: record.previewSource || "generated",
            previewWarning: record.previewWarning || null,
            sourcePath: record.filePath || record.path || null,
            source: { ...(record.sourceMapping || {}),
              width: record.sourceMapping?.width || record.width || null,
              height: record.sourceMapping?.height || record.height || null,
              proxyWidth: record.sourceMapping?.proxyWidth || null,
              proxyHeight: record.sourceMapping?.proxyHeight || null },
            metrics,
            faces: [],
            scorer: scorerResult,
            flags: analyzed.qualityFlags || analyzed.flags || [],
            score: Number.isFinite(analyzed.score)
              ? analyzed.score
              : Number.isFinite(analyzed.qualityScore)
                ? Math.max(0, Math.min(1, analyzed.qualityScore / 100))
                : 0,
            phash: analyzed.phash,
            dhash: analyzed.dhash,
            embedding: embedding || analyzed.embedding,
            captureTime: record.captureTime,
            name: record.name,
          };
          if (scorerResult.warning) warnings.push(scorerResult.warning);
          if (this.store) await this.store.put(fingerprint, result);
        }
        result.sourcePath ||= record.filePath || record.path || null;
        results[index] = result;
        completed += 1;
        onProgress({
          completed,
          total: records.length,
          cached,
          stage: "metrics",
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrency, records.length || 1) },
        worker,
      ),
    );
    onProgress({ completed, total: records.length, cached, stage: "faces" });
    const faceTargets = results.filter(
      (result) => result.previewPath && (
        !Array.isArray(result.faces) || result.metrics.faces == null || result.metrics.faces > result.faces.length
      ),
    );
    for (const result of results) {
      if (!Array.isArray(result.faces)) result.faces = [];
    }
    if (faceTargets.length) {
      const faces = await this.faceDetector(faceTargets.map((result) => result.previewPath));
      for (const [index, result] of faceTargets.entries()) {
        const face = faces[index];
        if (!face) continue;
        result.faces = face.faceDetails || [];
        result.metrics.faces = face.faces;
        result.metrics.eyesClosed = face.eyesClosed;
        if (face.eyesClosed > 0)
          result.flags = [...new Set([...result.flags, "eyes-closed"])];
        if (face.warning) warnings.push(face.warning);
      }
      if (this.store) {
        await Promise.all(
          results.map((result) => this.store.put(result.fingerprint, result)),
        );
      }
    }
    const captureTimes = await readCaptureTimes(records);
    for (const [index, result] of results.entries()) {
      result.sessionId = records[index].sessionId;
      result.captureTime = records[index].captureTime ?? captureTimes.get(records[index].filePath) ?? result.captureTime;
      if (this.analyzer === analyzeImage && Number.isFinite(result.metrics?.raw?.meanLuma)) {
        // Derived gates must follow current thresholds even when metrics are cached.
        result.flags = result.flags.filter((flag) => !["blurry", "overexposed", "underexposed"].includes(flag));
        delete result.metrics.raw.faceExposure;
        result.metrics.exposure = exposureSuitability({ ...result.metrics.raw,
          clippedHigh: result.metrics.clippedHighlights ?? 0, clippedLow: result.metrics.clippedShadows ?? 0 });
      }
      try {
        const faceExposure = await measureFaceExposure(result.previewPath, result.faces);
        if (faceExposure) {
          result.metrics.raw.faceExposure = faceExposure;
          result.metrics.exposure = exposureSuitability({ faceExposure, ...result.metrics.raw });
          // In portraits the subject, not dark background or lamps, defines severe exposure.
          result.flags = result.flags.filter((flag) => !["overexposed", "underexposed"].includes(flag));
        }
      } catch (error) {
        warnings.push(`人脸曝光不可用：${error.message}`);
      }
      result.flags = gateFlags(result);
    }
    const poseTargets = results.filter((result) => result.previewPath && (!result.signals || result.pose?.cacheKey !==
      POSE_SIGNALS_CACHE_KEY));
    if (poseTargets.length) {
      // Invalidate before inference: a failed refresh must not leave stale
      // measurements looking current in the new run or result cache.
      for (const result of poseTargets) { delete result.signals; delete result.pose; }
      const poses = await this.poseDetector(poseTargets.map((result) => ({
        id: result.unitId, filePath: result.previewPath, faces: result.faces,
      })), { cwd: this.root, size: Math.min(2, this.concurrency), signal });
      for (const [index, result] of poseTargets.entries()) {
        const pose = poses[index];
        if (!pose?.available || pose.error) {
          warnings.push(`姿态模型不可用：${pose?.error?.message || "未返回结果"}`);
          continue;
        }
        const record = recordsByUnit.get(result.unitId);
        result.signals = computeSignals(pose, { source: {
          ...pose.source, width: record.width || pose.source.width,
          height: record.height || pose.source.height,
        } });
        result.pose = { cacheKey: POSE_SIGNALS_CACHE_KEY, provider: pose.provider, providers: pose.providers,
          mode: pose.mode, timingMs: pose.timingMs,
          ...(pose.fallbackReason ? { fallbackReason: pose.fallbackReason } : {}) };
      }
    }
    for (const result of results) {
      // Opt-in only; reuse model outputs and compute small-raster hints serially.
      if (result.signals?.imageMeasurements?.candidates) delete result.signals.imageMeasurements.candidates;
      if (process.env.EAGLE_W5_HINTS === "1" && result.previewPath) {
        try {
          const candidates = await measureCandidates(result.previewPath, result);
          result.signals ??= { contractVersion: 1, persons: [] };
          result.signals.imageMeasurements ??= {};
          result.signals.imageMeasurements.candidates = candidates;
        } catch (error) { warnings.push(`W5 实验测量不可用：${error.message}`); }
      }
      result.verdicts = evaluateRules(result.signals || { contractVersion: 1, persons: [] }, { faces: result.faces });
      if (this.store) await this.store.put(result.fingerprint, result);
    }
    // Native-resolution focus is an opt-in, serial, transient decode. Missing
    // embedded JPEG/rawpy is represented as na and never guessed from proxy sharpness.
    for (const [index, result] of results.entries()) {
      if (!result.sourcePath || !result.faces?.length) continue;
      try {
        const sourceStat = await stat(result.sourcePath);
        const focusKey = crypto.createHash("sha256").update(JSON.stringify([
          "focus-v2", result.sourcePath, sourceStat.size, sourceStat.mtimeMs, result.faces,
        ])).digest("hex");
        const focusFile = path.join(this.cacheRoot, "focus", `${focusKey}.json`);
        let focus;
        try {
          focus = JSON.parse(await readFile(focusFile, "utf8"));
        } catch {
          const maker = await readMakerFocus(result.sourcePath);
          const nativeRecord = { ...records[index], filePath: result.sourcePath };
          focus = await withNativeImage(nativeRecord,
            { pairedItems: records[index].pairedItems }, async ({ image, source }) => {
              const buffer = await image().jpeg({ quality: 96, chromaSubsampling: "4:4:4" }).toBuffer();
              return analyzeFocus({ nativeBuffer: buffer,
                nativeSize: { width: source.width, height: source.height,
                  orientation: source.orientation, rawWidth: source.rawWidth, rawHeight: source.rawHeight },
                faces: result.faces, makerFocus: maker });
            });
          await mkdir(path.dirname(focusFile), { recursive: true });
          await writeFile(focusFile, JSON.stringify(focus));
        }
        result.focus = focus;
        result.source = { ...(result.source || {}),
          width: focus.nativeSize?.width || result.source?.width || null,
          height: focus.nativeSize?.height || result.source?.height || null,
          proxyWidth: null, proxyHeight: null, kind: focus.source?.kind || undefined };
        if (focus.status === "na") result.focusNaReason = focus.naReason;
        if (focus.afPointOnSubject === false || focus.afPointOnEye === false)
          result.flags = [...new Set([...(result.flags || []), "focus-miss"] )];
      } catch (error) {
        warnings.push(`原生对焦不可用：${error.message}`);
        result.focus = { status: "na", naReason: "native-focus-error" };
      }
      if (this.store) await this.store.put(result.fingerprint, result);
    }
    onProgress({ completed, total: records.length, cached, stage: "grouping" });
    const groups = await groupResultsAsync(results, undefined, { signal });
    const duplicateCandidates = await recallCrossDayDuplicates(results, { signal });
    const resultsByUnit = new Map(results.map(result => [result.unitId || result.id, result]));
    onProgress({ completed, total: records.length, cached, stage: "ranking" });
    const rankedGroups = groups.map((group) => {
      const ranking = rankGroup(group.items, undefined, {
        averageSimilarity: group.averageSimilarity,
      });
      return {
        contractVersion: 1,
        id: group.id,
        unitIds: group.unitIds,
        ranking,
        ...groupConfidence({ unitIds: group.unitIds, ranking }, group.items),
        suggested: (() => {
          const decisions = ranking.map((entry) => {
            const item = resultsByUnit.get(entry.unitId) || {};
            return [entry.unitId, suggestDecision(entry, item, ranking.length)];
          });
          if (
            ranking.length > 1 &&
            !decisions.some(([, value]) => value === "selected")
          ) {
            const fallback = decisions.findIndex(
              ([, value]) => value !== "rejected",
            );
            if (fallback >= 0) decisions[fallback][1] = "selected";
          }
          return Object.fromEntries(decisions);
        })(),
        // Additive field: legacy ranking/suggestions remain the default UI.
        candidateSet: buildCandidateSet(group.items),
      };
    });
    return {
      contractVersion: 1,
      id,
      status: "completed",
      progress: { completed, total: records.length, cached, stage: "done" },
      results,
      groups: rankedGroups,
      duplicateCandidates: Object.fromEntries(duplicateCandidates),
      warnings: [...new Set(warnings)],
    };
  }
}
