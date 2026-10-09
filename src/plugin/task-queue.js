export async function runBoundedQueue({ items, process, concurrency = 8, delayMs = 0, maxAttempts = 3, shouldSkip = () => false, shouldPause = () => false, shouldCancel = () => false, onProgress = () => {} } = {}) {
  const queue = [...items];
  const results = [];
  let cursor = 0;
  let stopped = false;
  const requested = Number(concurrency);
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("并发数必须为正整数");
  const limit = Math.min(queue.length, requested);
  const sleep = (ms) => ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  async function worker() {
    while (true) {
      if (stopped || shouldPause() || shouldCancel()) return;
      const item = queue[cursor++];
      if (!item) return;
      if (shouldSkip(item)) {
        // Preserve completed records on resume; do not rewrite success as skipped.
        continue;
      }
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (stopped || shouldPause() || shouldCancel()) return;
        try {
          const outcome = await process(item, attempt);
          item.queueOutcome = outcome;
          lastError = null;
          item.queueAttempts = attempt;
          break;
        } catch (error) {
          if (error.interrupted) return;
          if (error.fatal) { stopped = true; throw error; }
          lastError = error;
          if (attempt < maxAttempts) await sleep(Math.max(delayMs, delayMs * attempt));
        }
      }
      const result = { item, status: lastError ? "failed" : item.queueOutcome?.status || "succeeded", attempts: lastError ? maxAttempts : item.queueAttempts, error: lastError?.message || item.queueOutcome?.error };
      delete item.queueOutcome;
      delete item.queueAttempts;
      results.push(result);
      // Persistence failure is not an image failure: never retry an already applied mutation.
      try { await onProgress(result); } catch (error) { stopped = true; throw error; }
      await sleep(delayMs);
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: limit }, worker));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  return { results, succeeded: results.filter((result) => result.status === "succeeded").length, skipped: results.filter((result) => result.status === "skipped").length, failed: results.filter((result) => result.status === "failed").length };
}
