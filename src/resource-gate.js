import os from "node:os";

const GiB = 1024 ** 3;
export class ResourceGate {
  constructor({ concurrency = Number(process.env.EAGLE_IMAGE_WORKERS) || Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4))), freeMemory = os.freemem, reserveBytes = Math.min(4 * GiB, Math.max(GiB, os.totalmem() / 10)), jobBudgetBytes = GiB, pollMs = 100 } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isFinite(reserveBytes) || reserveBytes < 0 || !Number.isFinite(jobBudgetBytes) || jobBudgetBytes <= 0) throw new Error("Invalid image resource policy");
    Object.assign(this, { concurrency, freeMemory, reserveBytes, jobBudgetBytes, pollMs });
    this.active = 0;
    this.peak = 0;
    this.pending = [];
    this.closed = false;
  }
  capacity() {
    return Math.max(0, Math.min(this.concurrency, Math.floor((this.freeMemory() - this.reserveBytes) / this.jobBudgetBytes)));
  }
  diagnostics() {
    return { active: this.active, pending: this.pending.length, peak: this.peak, concurrency: this.concurrency, memoryCapacity: this.capacity(), freeMemoryBytes: this.freeMemory(), reserveBytes: this.reserveBytes, estimatedJobBudgetBytes: this.jobBudgetBytes };
  }
  run(operation, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("Image scheduler closed")); return; }
      if (signal?.aborted) { reject(signal.reason); return; }
      const job = { operation, resolve, reject, signal };
      job.abort = () => {
        const index = this.pending.indexOf(job);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal.removeEventListener("abort", job.abort);
        reject(signal.reason);
        this.drain();
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.drain();
    });
  }
  drain() {
    clearTimeout(this.timer);
    if (this.closed) return;
    const capacity = this.capacity();
    while (this.active < capacity && this.pending.length) {
      const job = this.pending.shift();
      job.signal?.removeEventListener("abort", job.abort);
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      Promise.resolve().then(job.operation).then(job.resolve, job.reject).finally(() => { this.active -= 1; this.drain(); });
    }
    if (this.pending.length && capacity < this.concurrency) this.timer = setTimeout(() => this.drain(), this.pollMs);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const job of this.pending.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(new Error("Image scheduler closed"));
    }
  }
}
