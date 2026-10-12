import { performanceMode, performanceWorkerCap, poseThreads, MODEL_BUDGET_BYTES } from './performance-mode.js';
import { FaceWorkerPool } from './faces.js';
import { computeProxyMeasurements } from './signals.js';
import { workerLimit } from './exiftool-pool.js';

export function poseProvider(platform = process.platform, env = process.env) {
  return env.EAGLE_POSE_PROVIDER || (platform === 'darwin' ? 'CPUExecutionProvider' : 'auto');
}

export function poseWorkerLimit(concurrency = 2) {
  return workerLimit('EAGLE_POSE_WORKERS', concurrency);
}

// Only a CPU request is checked: it cannot fall back, so a mismatch means the result came
// from another provider. Other requests keep reusing results, including CPU fallbacks,
// so a machine that always falls back does not recompute pose on every run.
export function poseProviderMatches(pose, platform = process.platform, env = process.env) {
  if (!pose) return false;
  const expected = poseProvider(platform, env);
  if (expected !== 'CPUExecutionProvider') return true;
  return pose.provider === expected &&
    ['detector', 'pose'].every(name => pose.providers?.[name]?.[0] === expected);
}

// Reuse the tested JSONL protocol. Two models normally, up to four in turbo;
// model stages remain separate and pools close after every pipeline run.
export class PoseWorkerPool extends FaceWorkerPool {
  constructor(options = {}) {
    const mode = options.mode ?? performanceMode();
    const size = Math.min(performanceWorkerCap(mode), options.size ?? poseWorkerLimit());
    poseThreads(size, mode); // Reject invalid local settings before scheduling any model jobs.
    super({ timeoutMs: 300000, ...options, size, mode,
      workerEnv: slot => ({ EAGLE_POSE_THREADS: String(poseThreads(size, mode, slot)) }),
      env: { ...options.env,
        ...(mode === 'turbo' ? { EAGLE_WORKER_RSS_BYTES: String(Math.floor(MODEL_BUDGET_BYTES / size)) } : {}) },
      script: options.script || 'python_worker/pose_worker.py' });
  }
}
export async function detectPose(items, options = {}) {
  const pool = options.pool || new PoseWorkerPool(options);
  try {
    const results = await pool.run(items, { signal: options.signal, onItem: options.onItem });
    // Proxy measurements run sequentially after pose inference (no extra model).
    for (const [index, result] of results.entries()) {
      if (options.signal?.aborted) throw options.signal.reason || new Error('pose cancelled');
      if (!result.available || result.error || !items[index]?.filePath) continue;
      try {
        result.imageMeasurements = await computeProxyMeasurements(items[index].filePath,
          { faces: items[index].faces, persons: result.persons });
      } catch (error) {
        // Missing proxy measurements stay unknown; never replace them with an aesthetic score.
        result.measurementError = error.message;
      }
    }
    return results;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error;
    return items.map(({ id }) => ({ id, available: false, error: { message: error.message.replaceAll('Face',
      'Pose').replaceAll('face worker', 'pose worker') } }));
  } finally {
    if (!options.pool) pool.close();
  }
}
export const POSE_CACHE_KEY =
  `pose-v1:${process.env.EAGLE_POSE_MODE || 'balanced'}:${poseProvider()}:${process.env.EAGLE_POSE_MODEL ||
  'local-rtmw'}:${process.env.EAGLE_POSE_DETECTOR || 'local-yolox'}`;

export const POSE_SIGNALS_CACHE_KEY = 'signals-v3-proxy-joint-validity:measure-v3';
