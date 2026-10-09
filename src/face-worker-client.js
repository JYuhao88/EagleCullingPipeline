import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export function runFaceWorker(items, { python = process.env.EAGLE_PYTHON || ".venv/Scripts/python.exe", script = "python_worker/face_worker.py", cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    const results = [];
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { results.push(JSON.parse(line)); } catch { /* diagnostics stay in stderr */ }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`Unable to start face worker: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0 && results.length === 0) reject(new Error(`Face worker exited with code ${code}: ${stderr.trim()}`));
      else resolve(results);
    });
    child.stdin.end(items.map((item) => JSON.stringify(item)).join("\n") + "\n");
  });
}

// Request concurrency must not multiply loaded model copies. Each worker loads
// MediaPipe once and accepts successive JSONL records over the same process.
export class FaceWorkerPool {
  constructor({ size = 2, python = process.env.EAGLE_PYTHON || (process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"), script = "python_worker/face_worker.py", args = [], cwd = process.cwd(), timeoutMs = 60000, idleMs = 30000, spawnWorker = spawn } = {}) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("Model worker count must be a positive integer");
    this.options = { size, python, script, args, cwd, timeoutMs, idleMs, spawnWorker };
    this.workers = new Set();
    this.pending = [];
    this.starts = 0;
    this.closed = false;
    this.unavailable = null;
  }

  run(items, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const jobs = new Set();
    const promises = items.map((item) => new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("Face worker pool closed")); return; }
      if (this.unavailable) { reject(new Error(this.unavailable)); return; }
      const job = { item, resolve, reject };
      jobs.add(job);
      this.pending.push(job);
    }));
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
    return Promise.all(promises).catch((error) => { cancel(error); throw error; }).finally(() => signal?.removeEventListener("abort", abort));
  }

  pump() {
    if (this.closed || this.unavailable) return;
    for (const worker of this.workers) {
      if (!worker.active && !worker.stopping && this.pending.length) this.dispatch(worker);
    }
    while (this.pending.length && this.workers.size < this.options.size) this.dispatch(this.startWorker());
  }

  startWorker() {
    const { python, script, args, cwd, spawnWorker } = this.options;
    const child = spawnWorker(python, [script, ...args], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUTF8: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" } });
    const worker = { child, active: null, stderr: "", stopping: false };
    this.workers.add(worker);
    this.starts += 1;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (result.type === "ready") { worker.model = result; return; }
      if (!worker.active) return;
      if (result.id == null && result.error) {
        this.unavailable = result.error.message || "Face model unavailable";
        this.failWorker(worker, new Error(this.unavailable));
        for (const job of this.pending.splice(0)) job.reject(new Error(this.unavailable));
        return;
      }
      if (result.id !== worker.active.item.id) return;
      clearTimeout(worker.timer);
      const job = worker.active;
      worker.active = null;
      job.resolve(result);
      worker.idleTimer = setTimeout(() => { worker.stopping = true; child.stdin.end(); }, this.options.idleMs);
      worker.idleTimer.unref?.();
      this.pump();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { worker.stderr = (worker.stderr + chunk).slice(-4096); });
    child.stdin.on("error", (error) => this.failWorker(worker, error));
    child.on("error", (error) => {
      this.unavailable = `Unable to start face worker: ${error.message}`;
      this.failWorker(worker, new Error(this.unavailable));
      for (const job of this.pending.splice(0)) job.reject(new Error(this.unavailable));
    });
    child.on("close", (code) => {
      clearTimeout(worker.timer);
      clearTimeout(worker.idleTimer);
      this.workers.delete(worker);
      if (worker.active) worker.active.reject(new Error(`Face worker exited (${code}): ${worker.stderr}`));
      worker.active = null;
      lines.close();
      this.pump();
    });
    return worker;
  }

  dispatch(worker) {
    clearTimeout(worker.idleTimer);
    worker.active = this.pending.shift();
    worker.timer = setTimeout(() => this.failWorker(worker, new Error("Face inference timed out")), this.options.timeoutMs);
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
    for (const job of this.pending.splice(0)) job.reject(new Error("Face worker pool closed"));
    for (const worker of this.workers) this.failWorker(worker, new Error("Face worker pool closed"));
  }

  diagnostics() { return { modelProcesses: this.workers.size, active: [...this.workers].filter((worker) => worker.active).length, pending: this.pending.length, processStarts: this.starts, unavailable: this.unavailable, concurrency: this.options.size, models: [...this.workers].filter(worker=>worker.model).map(worker=>worker.model) }; }
}
