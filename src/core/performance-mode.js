import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localSetting } from './local-config.js';

const context = new AsyncLocalStorage();
export const MODEL_BUDGET_BYTES = 3 * 1024 ** 3;
export const NODE_BUDGET_BYTES = 3 * 1024 ** 3;
export const PERFORMANCE_CORES = 6;
export function parsePerformanceMode(value) {
  if (value === undefined || value === '') return 'normal';
  if (value !== 'normal' && value !== 'turbo') throw new Error('performanceMode must be normal or turbo');
  return value;
}
export function configuredPerformanceMode() {
  return parsePerformanceMode(localSetting('EAGLE_PERFORMANCE_MODE'));
}
export function performanceMode() {
  return context.getStore()?.mode ?? configuredPerformanceMode();
}
export function performanceWorkerCap(mode = performanceMode(), memory = os.totalmem()) {
  // At least 4 GiB of system RAM per lane; maximum four model copies (3 GiB pool budget).
  return mode === 'turbo' ? Math.max(1, Math.min(4, Math.floor(memory / (4 * 1024 ** 3)))) : 2;
}
export function withPerformanceMode(mode, fn) {
  return context.run({ mode: parsePerformanceMode(mode) }, fn);
}
export function parsePoseThreads(value) {
  if (typeof value !== 'string' || !/^[1-8]$/.test(value))
    throw new Error('EAGLE_POSE_THREADS must be an integer from 1 to 8');
  return Number(value);
}
export function poseThreads(workers = 2, mode = performanceMode(), slot = 0) {
  const threads = parsePoseThreads(localSetting('EAGLE_POSE_THREADS', '3'));
  return mode === 'turbo' ? Math.floor(PERFORMANCE_CORES / workers) + (slot < PERFORMANCE_CORES % workers ? 1 : 0)
    : Math.min(threads, Math.floor(PERFORMANCE_CORES / workers));
}
export function childLaunch(program, args, mode = performanceMode(), platform = process.platform) {
  return platform === 'win32' || mode === 'turbo'
    ? { command: program, args } : { command: 'nice', args: ['-n', '15', program, ...args] };
}

export function nativeChildLaunch(program, args) {
  if (performanceMode() !== 'turbo') return childLaunch(program, args);
  const python = localSetting('EAGLE_PYTHON') || (process.platform === 'win32'
    ? 'python_worker/.venv/Scripts/python.exe' : 'python_worker/.venv/bin/python');
  const guard = fileURLToPath(new URL('../../python_worker/memory_guard.py', import.meta.url));
  return {command: python, args: [guard, String(Math.floor(MODEL_BUDGET_BYTES / performanceWorkerCap())), program, ...args]};
}
