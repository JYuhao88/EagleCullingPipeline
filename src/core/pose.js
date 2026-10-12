import { FaceWorkerPool } from './faces.js';
import { computeProxyMeasurements } from './signals.js';

// Reuse the tested JSONL scheduling/timeout/cancellation protocol. Max two
// persistent models, irrespective of batch size; close after a pipeline run.
export class PoseWorkerPool extends FaceWorkerPool {
  constructor(options = {}) {
    super({ timeoutMs: 300000, ...options, size: Math.min(2, options.size || 2), script: options.script ||
      'python_worker/pose_worker.py' });
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
  `pose-v1:${process.env.EAGLE_POSE_MODE || 'balanced'}:${process.env.EAGLE_POSE_PROVIDER ||
  'auto'}:${process.env.EAGLE_POSE_MODEL || 'local-rtmw'}:${process.env.EAGLE_POSE_DETECTOR || 'local-yolox'}`;

export const POSE_SIGNALS_CACHE_KEY = 'signals-v3-proxy-joint-validity:measure-v3';
