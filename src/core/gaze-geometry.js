import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localSetting } from './local-config.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const validVector = vector => Array.isArray(vector) && vector.length === 228 && vector.every(Number.isFinite);

export class GazeGeometryBridge {
  constructor({ python = localSetting('EAGLE_PYTHON') || path.join(root, 'python_worker/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    script = path.join(root, 'python_worker/gaze_worker.py'), cwd = root,
    spawnWorker = spawn, timeoutMs = 60000, idleMs = 30000 } = {}) {
    Object.assign(this, { python, script, cwd, spawnWorker, timeoutMs, idleMs });
    this.worker = null;
    this.queue = [];
    this.sequence = 0;
    this.closed = false;
  }

  vector(file, model, { modelSha256 } = {}, signal) {
    signal?.throwIfAborted();
    if (this.closed || typeof file !== 'string' || !file || typeof model !== 'string' || !model
      || (modelSha256 !== undefined && (typeof modelSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(modelSha256)))) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const job = { record: { id: ++this.sequence, filePath: path.resolve(file), modelPath: path.resolve(model),
        ...(modelSha256 === undefined ? {} : { modelSha256 }) }, signal, resolve, reject };
      job.abort = () => {
        this.queue = this.queue.filter(queued => queued !== job);
        this.settle(job, null, signal.reason);
        if (this.worker?.active === job) this.retire(this.worker);
        else this.pump();
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  settle(job, value, error) {
    if (!job || job.done) return;
    job.done = true;
    job.signal?.removeEventListener('abort', job.abort);
    if (error !== undefined) job.reject(error);
    else job.resolve(value);
  }

  references(worker, active) {
    for (const handle of [worker.child, worker.child.stdin, worker.child.stdout, worker.child.stderr])
      handle?.[active ? 'ref' : 'unref']?.();
  }

  start() {
    const child = this.spawnWorker(this.python, [this.script], { cwd: this.cwd, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', OMP_NUM_THREADS: '1',
        OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' } });
    const worker = { child, active: null, stopping: false };
    this.worker = worker;
    worker.lines = createInterface({ input: child.stdout });
    worker.lines.on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { this.retire(worker); return; }
      if (!result || typeof result !== 'object') { this.retire(worker); return; }
      const job = worker.active;
      if (!job || result.id !== job.record.id) return;
      clearTimeout(worker.timeout);
      worker.active = null;
      const valid = result.available === true && validVector(result.features)
        && (!job.record.modelSha256 || result.modelSha256 === job.record.modelSha256);
      this.settle(job, valid ? result.features : null);
      worker.idle = setTimeout(() => this.retire(worker), this.idleMs);
      worker.idle.unref?.();
      this.references(worker, false);
      this.pump();
    });
    child.stderr.resume();
    child.stdin.on('error', () => this.retire(worker));
    child.on('error', () => this.retire(worker));
    child.on('close', () => {
      clearTimeout(worker.timeout);
      clearTimeout(worker.idle);
      worker.lines.close();
      this.settle(worker.active, null);
      worker.active = null;
      if (this.worker === worker) this.worker = null;
      this.pump();
    });
    return worker;
  }

  retire(worker) {
    if (worker.stopping) return;
    worker.stopping = true;
    clearTimeout(worker.timeout);
    clearTimeout(worker.idle);
    this.settle(worker.active, null);
    worker.active = null;
    worker.child.stdin.destroy();
    worker.child.kill();
  }

  pump() {
    if (this.closed || !this.queue.length || this.worker?.active || this.worker?.stopping) return;
    let worker;
    try { worker = this.worker || this.start(); }
    catch {
      for (const job of this.queue.splice(0)) this.settle(job, null);
      return;
    }
    clearTimeout(worker.idle);
    const job = this.queue.shift();
    worker.active = job;
    this.references(worker, true);
    worker.timeout = setTimeout(() => this.retire(worker), this.timeoutMs);
    try { worker.child.stdin.write(JSON.stringify(job.record) + '\n'); }
    catch { this.retire(worker); }
  }

  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) this.settle(job, null);
    if (this.worker) this.retire(this.worker);
  }
}

let bridge;
export async function gazeGeometryVector(file, model, options = {}, signal) {
  signal?.throwIfAborted();
  bridge ||= new GazeGeometryBridge();
  return bridge.vector(file, model, options, signal);
}

export function closeGazeGeometryWorker() {
  bridge?.close();
  bridge = null;
}

process.once('exit', closeGazeGeometryWorker);
