import { localSetting } from './local-config.js';
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
function lowerWindowsPriority(child) {
  if (process.platform !== "win32") return;
  child.once("spawn", () => {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
    catch (error) { child.kill(); child.emit("error", error); }
  });
}
export function runFaceWorker(
  items,
  {
    python = localSetting("EAGLE_PYTHON") ||
      (process.platform === "win32"
        ? "python_worker/.venv/Scripts/python.exe"
        : "python_worker/.venv/bin/python"),
    script = "python_worker/face_worker.py",
    cwd = process.cwd(),
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    lowerWindowsPriority(child);
    const results = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        results.push(JSON.parse(line));
      } catch {
        /* diagnostics stay in stderr */
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      reject(new Error(`Unable to start face worker: ${error.message}`)),
    );
    child.on("close", (code) => {
      if (code !== 0 && results.length === 0)
        reject(
          new Error(`Face worker exited with code ${code}: ${stderr.trim()}`),
        );
      else resolve(results);
    });
    child.stdin.end(
      items.map((item) => JSON.stringify(item)).join("\n") + "\n",
    );
  });
}

// Request concurrency must not multiply loaded model copies. Each worker loads
// MediaPipe once and accepts successive JSONL records over the same process.
export class FaceWorkerPool {
  constructor({
    size = 2,
    python = localSetting("EAGLE_PYTHON") ||
      (process.platform === "win32"
        ? "python_worker/.venv/Scripts/python.exe"
        : "python_worker/.venv/bin/python"),
    script = "python_worker/face_worker.py",
    args = [],
    cwd = process.cwd(),
    timeoutMs = 60000,
    idleMs = 30000,
    spawnWorker = spawn,
  } = {}) {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new Error("Model worker count must be a positive integer");
    this.options = {
      size,
      python,
      script,
      args,
      cwd,
      timeoutMs,
      idleMs,
      spawnWorker,
    };
    this.workers = new Set();
    this.pending = [];
    this.starts = 0;
    this.closed = false;
    this.unavailable = null;
  }

  run(items, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const jobs = new Set();
    const promises = items.map(
      (item) =>
        new Promise((resolve, reject) => {
          if (this.closed) {
            reject(new Error("Face worker pool closed"));
            return;
          }
          if (this.unavailable) {
            reject(new Error(this.unavailable));
            return;
          }
          const job = { item, resolve, reject };
          jobs.add(job);
          this.pending.push(job);
        }),
    );
    const cancel = (error) => {
      this.pending = this.pending.filter((job) => !jobs.has(job));
      // Inference already dispatched may finish. Keep its worker/ID association
      // intact, but reject abandoned callers and do not start their pending work.
      for (const job of jobs) job.reject(error);
      this.pump();
    };
    const abort = () => cancel(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    this.pump();
    return Promise.all(promises)
      .catch((error) => {
        cancel(error);
        throw error;
      })
      .finally(() => signal?.removeEventListener("abort", abort));
  }

  pump() {
    if (this.closed || this.unavailable) return;
    for (const worker of this.workers) {
      if (!worker.active && !worker.stopping && this.pending.length)
        this.dispatch(worker);
    }
    while (this.pending.length && this.workers.size < this.options.size)
      this.dispatch(this.startWorker());
  }

  startWorker() {
    const { python, script, args, cwd, spawnWorker } = this.options;
    const child = spawnWorker(python, [script, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
      },
    });
    lowerWindowsPriority(child);
    const worker = { child, active: null, stderr: "", stopping: false };
    this.workers.add(worker);
    this.starts += 1;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        return;
      }
      if (result.type === "ready") {
        worker.model = result;
        return;
      }
      if (!worker.active) return;
      if (result.id == null && result.error) {
        this.unavailable = result.error.message || "Face model unavailable";
        this.failWorker(worker, new Error(this.unavailable));
        for (const job of this.pending.splice(0))
          job.reject(new Error(this.unavailable));
        return;
      }
      if (result.id !== worker.active.item.id) return;
      clearTimeout(worker.timer);
      const job = worker.active;
      worker.active = null;
      job.resolve(result);
      worker.idleTimer = setTimeout(() => {
        worker.stopping = true;
        child.stdin.end();
      }, this.options.idleMs);
      worker.idleTimer.unref?.();
      this.pump();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      worker.stderr = (worker.stderr + chunk).slice(-4096);
    });
    child.stdin.on("error", (error) => this.failWorker(worker, error));
    child.on("error", (error) => {
      this.unavailable = `Unable to start face worker: ${error.message}`;
      this.failWorker(worker, new Error(this.unavailable));
      for (const job of this.pending.splice(0))
        job.reject(new Error(this.unavailable));
    });
    child.on("close", (code) => {
      clearTimeout(worker.timer);
      clearTimeout(worker.idleTimer);
      this.workers.delete(worker);
      if (worker.active)
        worker.active.reject(
          new Error(`Face worker exited (${code}): ${worker.stderr}`),
        );
      worker.active = null;
      lines.close();
      this.pump();
    });
    return worker;
  }

  dispatch(worker) {
    clearTimeout(worker.idleTimer);
    worker.active = this.pending.shift();
    worker.timer = setTimeout(
      () => this.failWorker(worker, new Error("Face inference timed out")),
      this.options.timeoutMs,
    );
    worker.child.stdin.write(JSON.stringify(worker.active.item) + "\n");
  }

  failWorker(worker, error) {
    if (worker.stopping) return;
    worker.stopping = true;
    clearTimeout(worker.timer);
    clearTimeout(worker.idleTimer);
    worker.active?.reject(error);
    worker.active = null;
    worker.child.kill();
  }

  close() {
    this.closed = true;
    for (const job of this.pending.splice(0))
      job.reject(new Error("Face worker pool closed"));
    for (const worker of this.workers)
      this.failWorker(worker, new Error("Face worker pool closed"));
  }

  diagnostics() {
    return {
      modelProcesses: this.workers.size,
      active: [...this.workers].filter((worker) => worker.active).length,
      pending: this.pending.length,
      processStarts: this.starts,
      unavailable: this.unavailable,
      concurrency: this.options.size,
      models: [...this.workers]
        .filter((worker) => worker.model)
        .map((worker) => worker.model),
    };
  }
}

export function normalizeFaceDetails(faces) {
  if (!Array.isArray(faces)) return [];
  return faces.flatMap((face) => {
    if (!Array.isArray(face?.box) || face.box.length !== 4 || !face.box.every(Number.isFinite)) return [];
    const box = face.box.map((value) => Math.max(0, Math.min(1, value)));
    if (box[2] <= box[0] || box[3] <= box[1]) return [];
    const blink = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
    return [{
      box,
      ...(Array.isArray(face.eyeBoxes) ? { eyeBoxes: face.eyeBoxes.filter(box =>
        Array.isArray(box) && box.length === 4 && box.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
          && box[2] > box[0] && box[3] > box[1]) } : {}),
      eyesClosed: face.eyesClosed === true,
      eyesAssessed: face.eyesAssessed === true,
      blinkLeft: blink(face.blinkLeft ?? face.eyeBlinkLeft),
      blinkRight: blink(face.blinkRight ?? face.eyeBlinkRight),
    }];
  });
}

export function normalizeFaceResult(result) {
  const unavailable = !result || result.available === false || Boolean(result.error);
  const faceDetails = unavailable ? [] : normalizeFaceDetails(result.faces);
  return {
    faces: unavailable ? null : (result.faceCount ?? faceDetails.length),
    eyesClosed: unavailable ? null : faceDetails.filter((face) => face.eyesClosed).length,
    faceDetails,
    detail: result,
    ...(unavailable ? { warning: `人脸模型不可用：${result?.error?.message || "未返回检测结果"}` } : {}),
  };
}

export async function detectFaces(previews, options = {}) {
  try {
    const results = await runFaceWorker(
      previews.map((filePath) => ({ id: filePath, filePath })),
      options,
    );
    const byPath = new Map(results.map((result) => [result.id, result]));
    return previews.map((filePath) => normalizeFaceResult(byPath.get(filePath)));
  } catch (error) {
    return previews.map(() => ({
      faces: null,
      eyesClosed: null,
      faceDetails: [],
      warning: `人脸模型不可用：${error.message}`,
    }));
  }
}
